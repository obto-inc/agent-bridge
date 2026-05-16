'use strict';

const { loadConfig } = require('./config');
const { startStream } = require('./stream-client');
const { loadState, saveState, getBinding, setBinding } = require('./state');
const { drive, tryResolvePermission, activeAgent } = require('./driver');
const { postAgentActivity } = require('./bridge-http');

const log = (level, msg, data) => {
  const line = { ts: new Date().toISOString(), level, msg };
  if (data !== undefined) line.data = data;
  console.log(JSON.stringify(line));
};

// Fire-and-forget activity ping. The "agent is working" indicator is a UX
// nicety — a failed ping must never interfere with the actual turn, so we
// swallow every error and never await it in the hot path. We still log both
// failure modes: a rejected promise (network error) AND a resolved-but-non-ok
// response (4xx/5xx) — fetch does not throw on HTTP errors, so a 404/401 would
// otherwise pass silently.
const emitActivity = (threadId, activityState) => {
  postAgentActivity(threadId, activityState)
    .then((res) => {
      if (!res || !res.ok) {
        log('warn', 'agent-activity ping rejected', {
          threadId,
          state: activityState,
          status: res && res.status,
          body: res && res.data,
        });
      }
    })
    .catch((err) => {
      log('warn', 'agent-activity ping failed', {
        threadId,
        state: activityState,
        error: err && err.message ? err.message : String(err),
      });
    });
};

let cfg;
try {
  cfg = loadConfig();
} catch (err) {
  log('error', 'config load failed', { error: err && err.message });
  process.exit(1);
}

const state = loadState();
let stopped = false;
let stream = null;

const handleEvent = async (sseEvent) => {
  if (sseEvent.event !== 'reply') return;
  let payload;
  try {
    payload = JSON.parse(sseEvent.data);
  } catch (e) {
    log('error', 'unparseable sse data', { error: e.message });
    return;
  }

  const threadId = String(payload.threadId || '').trim();
  if (!threadId) {
    log('warn', 'event missing threadId — dropping', { messageId: payload.messageId });
    return;
  }

  const binding = getBinding(state, threadId);
  log('event', 'reply received', {
    threadId,
    author: payload.author,
    messageId: payload.messageId,
    hasBinding: !!binding,
  });

  // Permission-relay replies: resolve the pending request inside the driver and
  // skip starting a new turn.
  if (tryResolvePermission(threadId, payload.body || '', log)) {
    return;
  }

  // Tell the browser a turn has started. Cleared in the finally below so the
  // indicator drops whether the turn succeeds, skips, or throws.
  emitActivity(threadId, 'working');
  try {
    const result = await drive({
      threadId,
      projectDir: cfg.projectDir,
      binding,
      payload,
      log,
    });

    if (
      result &&
      result.sessionId &&
      (!binding || binding.sessionId !== result.sessionId)
    ) {
      setBinding(state, threadId, {
        sessionId: result.sessionId,
        projectDir: result.projectDir,
        jsonlPath: result.jsonlPath,
        lastJsonlMtimeMs: result.lastJsonlMtimeMs || null,
        agentId: cfg.agentId,
        createdAt: new Date().toISOString(),
        lastDriveAt: new Date().toISOString(),
      });
      log('info', 'binding created', { threadId, sessionId: result.sessionId });
    } else if (binding && !result.skipped) {
      binding.lastDriveAt = new Date().toISOString();
      if (result && result.lastJsonlMtimeMs) {
        binding.lastJsonlMtimeMs = result.lastJsonlMtimeMs;
      }
      saveState(state);
    }
  } catch (err) {
    log('error', 'handle failed', {
      threadId,
      error: err && err.message ? err.message : String(err),
    });
  } finally {
    emitActivity(threadId, 'idle');
  }
};

const start = () => {
  log('info', 'starting daemon', {
    baseUrl: cfg.baseUrl,
    accountId: cfg.accountId,
    agentId: cfg.agentId,
    agent: activeAgent(),
    projectDir: cfg.projectDir,
    boundThreads: Object.keys(state.bindings || {}),
  });

  const url = cfg.baseUrl.replace(/\/$/, '') + '/api/bridge/stream';
  stream = startStream({
    url,
    // Re-read config on every (re)connect so a rotated token (via
    // `obto-bridge rotate-token`, which rewrites config.json) is picked up
    // automatically without restarting the daemon.
    getHeaders: () => {
      const fresh = loadConfig();
      return {
        'OBTO-ORIGIN-HOST': fresh.originHost,
        Authorization: 'Bearer ' + fresh.apiToken,
      };
    },
    onEvent: (ev) => {
      handleEvent(ev).catch((err) => {
        log('error', 'handleEvent threw', { error: err && err.message });
      });
    },
    log,
  });
};

const shutdown = (signal) => {
  if (stopped) return;
  stopped = true;
  log('info', 'shutting down', { signal });
  try { stream && stream.stop(); } catch (_) {}
  setTimeout(() => process.exit(0), 200);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start();
