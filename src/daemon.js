'use strict';

const { loadConfig } = require('./config');
const { startStream } = require('./stream-client');
const { loadState, saveState, getAgentSession, setAgentSession } = require('./state');
const { drive, tryResolvePermission, agentFor } = require('./driver');
const { postAgentActivity, claimThread, postExternalSync } = require('./bridge-http');
const { detect: detectCapabilities } = require('./capabilities');
const { scanAll: scanExternalSessions } = require('./external-scanner');
// Phase 6.5 — OpenCode desktop/CLI uses SQLite instead of JSONL; separate
// scanner reads ~/.local/share/opencode/opencode.db read-only via the
// sqlite3 CLI subprocess. Empty array when SQLite or the DB isn't present.
const { scanAll: scanOpencodeSessions } = require('./opencode-sqlite-scanner');
// Phase 6.6 — full-history backfill for adopted threads (fire-and-forget).
const { backfillFullHistory } = require('./history');

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

  // Phase 2b — multi-daemon race check. The thread's target machine is
  // included on the event when known (postReply publishes it). If it's set
  // and isn't us, skip. If null, attempt the atomic first-touch claim — only
  // the winning daemon handles the event; the rest skip cleanly.
  const targetAgentId = payload.agentId ? String(payload.agentId).trim() : null;
  if (targetAgentId && targetAgentId !== cfg.agentId) {
    log('event', 'skip — claimed by other daemon', {
      threadId,
      targetAgentId,
      messageId: payload.messageId,
    });
    return;
  }
  if (!targetAgentId) {
    try {
      const r = await claimThread(threadId, cfg.agentId);
      if (!r || !r.ok || !r.data || !r.data.won) {
        log('info', 'claim lost or failed', {
          threadId,
          winner: r && r.data && r.data.winner,
          status: r && r.status,
        });
        return;
      }
      log('info', 'claim won', { threadId, agentId: cfg.agentId });
    } catch (e) {
      log('error', 'claim threw', { threadId, error: e && e.message });
      return; // conservative — skip on uncertainty rather than double-drive
    }
  }

  // v1.1 — which agent this thread is bound to (server-set, on the event).
  const agent = agentFor(payload);
  let session = getAgentSession(state, threadId, agent);
  let wasAdoption = false;

  // Phase 6.2 — adopt external session on first turn. The bridge attaches
  // `externalAdoption: {sessionId, projectDir, projectName, source}` to the
  // reply payload for adopted threads. With no prior session for this
  // (thread, agent), synthesize a binding pointing at the original engine
  // session so the driver resumes it instead of first-touching fresh —
  // context preserved end-to-end. After the first successful drive, the
  // session is persisted to state.json and externalAdoption stops mattering.
  if (!session && payload.externalAdoption && payload.externalAdoption.sessionId) {
    const ea = payload.externalAdoption;
    // Prefer projectName (already-decoded absolute path) for the SDK's cwd.
    // Code-review (2026-06-06): the prior fallback to cfg.projectDir was a
    // silent foot-gun — if the external record carried no usable cwd (e.g.,
    // a Codex session whose meta line didn't include `cwd`), we'd resume the
    // session in the daemon's working dir, NOT the original project. The
    // agent would find unrelated files and the conversation would lose its
    // grounding. Now we validate the path looks absolute; if it doesn't, we
    // log loudly and decline to fake a resume — the driver first-touches in
    // cfg.projectDir, which is the only honest behavior when the original
    // cwd is unknown.
    let resumeCwd = ea.projectName || ea.projectDir || '';
    if (typeof resumeCwd === 'string' && resumeCwd.startsWith('//')) {
      resumeCwd = '/' + resumeCwd.replace(/^\/+/, '');
    }
    const looksAbsolute = typeof resumeCwd === 'string' && resumeCwd.startsWith('/');
    if (!looksAbsolute) {
      // The external adoption record didn't carry a real filesystem path —
      // we will NOT synthesize a binding pointing at the daemon's working
      // dir, since that would silently misroute the agent to unrelated
      // files. Skip the synthetic binding; the driver will first-touch
      // fresh, which is honest about losing the original context.
      log('warn', 'external adoption skipped: no usable cwd in adoption record — first-touching fresh', {
        threadId,
        agent,
        sessionId: ea.sessionId,
        gotProjectName: ea.projectName,
        gotProjectDir: ea.projectDir,
      });
    } else {
      session = {
        sessionId: ea.sessionId,
        projectDir: resumeCwd,
        jsonlPath: null,
        lastJsonlMtimeMs: null,
        createdAt: new Date().toISOString(),
        lastDriveAt: null,
      };
      wasAdoption = true;
      log('info', 'adopting external session on first touch', {
        threadId,
        agent,
        sessionId: ea.sessionId,
        cwd: resumeCwd,
        source: ea.source,
      });
    }
    // Phase 6.6 — ship the FULL local session history to the bridge so the
    // web thread shows the whole conversation, not the ~10-turn adoption
    // preview. Runs off the hot path; idempotent server-side. Fired even
    // when the cwd guard above declined the resume binding — history is
    // about what the user SEES, independent of whether we can resume.
    backfillFullHistory({ threadId, externalAdoption: ea, log });
  }

  log('event', 'reply received', {
    threadId,
    agent,
    author: payload.author,
    messageId: payload.messageId,
    hasSession: !!session,
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
    // The driver receives a flat per-agent session as `binding` — the v1
    // driver contract is unchanged. v1.1 just keeps one such session per
    // agent on the thread, so a claude<->codex switch resumes each side.
    const result = await drive({
      threadId,
      projectDir: cfg.projectDir,
      binding: session,
      payload,
      log,
    });

    if (
      result &&
      result.sessionId &&
      (!session || session.sessionId !== result.sessionId || wasAdoption)
    ) {
      setAgentSession(
        state,
        threadId,
        agent,
        {
          sessionId: result.sessionId,
          projectDir: result.projectDir,
          jsonlPath: result.jsonlPath,
          lastJsonlMtimeMs: result.lastJsonlMtimeMs || null,
          createdAt: new Date().toISOString(),
          lastDriveAt: new Date().toISOString(),
        },
        { agentId: cfg.agentId },
      );
      log('info', 'session bound', { threadId, agent, sessionId: result.sessionId });
    } else if (session && !result.skipped) {
      session.lastDriveAt = new Date().toISOString();
      if (result && result.lastJsonlMtimeMs) {
        session.lastJsonlMtimeMs = result.lastJsonlMtimeMs;
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
  // Phase 2b — advertise capabilities to the bridge on connect so the UI
  // picker can offer just the agents that are actually installable here.
  const capabilities = detectCapabilities();

  log('info', 'starting daemon', {
    baseUrl: cfg.baseUrl,
    accountId: cfg.accountId,
    agentId: cfg.agentId,
    capabilities,
    projectDir: cfg.projectDir,
    boundThreads: Object.keys(state.bindings || {}),
  });

  const url = cfg.baseUrl.replace(/\/$/, '') +
    '/api/bridge/stream' +
    '?agentId=' + encodeURIComponent(cfg.agentId) +
    '&capabilities=' + encodeURIComponent(capabilities.join(','));
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

  // Phase 6.1 — kick off the External Thread Discovery scanner. 10s startup
  // delay (lets the SSE handshake settle first), then 30s ticks. Was defined
  // but not invoked in beta.9 — fixed in beta.10.
  startExternalSync();
};

// Phase 6.1 — External Thread Discovery. Every 30s, scan ~/.claude/projects
// and ~/.codex/sessions for sessions that didn't originate from the bridge
// and POST them to /api/bridge/external/sync. Fire-and-forget; failures log
// and the next tick retries. The bridge dedups by (accountId, sessionId).
const EXTERNAL_SCAN_INTERVAL_MS = 30000;
let externalScanTimer = null;
const ownedSessionIdsFromState = () => {
  const ids = new Set();
  const bindings = (state && state.bindings) || {};
  for (const tid of Object.keys(bindings)) {
    const b = bindings[tid] || {};
    const sessions = b.sessions && typeof b.sessions === 'object'
      ? b.sessions
      : (b.sessionId ? { _flat: b } : {});
    for (const k of Object.keys(sessions)) {
      const s = sessions[k] || {};
      if (s.sessionId) ids.add(String(s.sessionId));
    }
  }
  return ids;
};
const externalScanTick = async () => {
  try {
    // Phase 6.5 — fold opencode SQLite sessions into the same external sync
    // payload. Both scanners are best-effort and return [] on failure, so a
    // dead SQLite CLI or missing DB never breaks the JSONL path.
    const fromJsonl = scanExternalSessions();
    let fromOpencode = [];
    let scanDegraded = false;
    try {
      fromOpencode = scanOpencodeSessions();
    } catch (e) {
      // Phase 6.7 — a failed sub-scan means our inventory is INCOMPLETE this
      // tick; sending it would falsely mark that source's sessions vanished.
      scanDegraded = true;
      log('warn', 'opencode sqlite scan failed', { error: e && e.message ? e.message : String(e) });
    }
    const all = fromJsonl.concat(fromOpencode);
    const owned = ownedSessionIdsFromState();
    const external = all.filter((s) => s && s.sessionId && !owned.has(String(s.sessionId)));
    // Phase 6.7 — full inventory (external + owned) so the bridge can mark
    // rows whose local file vanished. Sent even when `external` is empty;
    // the bridge ignores empty inventories, so a glitched scan is harmless.
    const presentSessionIds = scanDegraded
      ? [] // incomplete inventory — skip reconciliation this tick
      : all.filter((s) => s && s.sessionId).map((s) => String(s.sessionId));
    if (external.length === 0 && presentSessionIds.length === 0) return;
    const r = await postExternalSync(cfg.agentId, external, presentSessionIds);
    if (!r || !r.ok) {
      log('warn', 'external sync rejected', {
        status: r && r.status,
        body: r && r.data,
        count: external.length,
      });
    } else {
      log('debug', 'external sync ok', {
        sent: external.length,
        upserted: (r.data && r.data.count) || 0,
        vanished: (r.data && r.data.vanished) || 0,
        restored: (r.data && r.data.restored) || 0,
      });
    }
  } catch (e) {
    log('warn', 'external scan failed', { error: e && e.message ? e.message : String(e) });
  }
};
const startExternalSync = () => {
  // Wait 10s after daemon start before the first scan so the SSE connection
  // is established first. Reduces "cold start everything at once" noise.
  setTimeout(() => {
    externalScanTick();
    externalScanTimer = setInterval(externalScanTick, EXTERNAL_SCAN_INTERVAL_MS);
  }, 10000);
};

const shutdown = (signal) => {
  if (stopped) return;
  stopped = true;
  log('info', 'shutting down', { signal });
  try { stream && stream.stop(); } catch (_) {}
  if (externalScanTimer) { try { clearInterval(externalScanTimer); } catch (_) {} }
  setTimeout(() => process.exit(0), 200);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start();
