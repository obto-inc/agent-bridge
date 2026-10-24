'use strict';

// Services installed before 0.1.0-beta.30 run without USER / LOGNAME (launchd
// does not set them). Claude Code finds its macOS Keychain login by user name,
// so fill them in before any engine is spawned.
(() => {
  try {
    const u = require('os').userInfo().username;
    if (u && !process.env.USER) process.env.USER = u;
    if (u && !process.env.LOGNAME) process.env.LOGNAME = u;
  } catch (_) {}
})();

const { loadConfig, authHeaders } = require('./config');
const { startStream } = require('./stream-client');
const { createCursor } = require('./stream-cursor');
const { loadState, saveState, getAgentSession, setAgentSession } = require('./state');
const { drive, tryResolvePermission, agentFor } = require('./driver');
const { postAgentActivity, claimThread, postExternalSync } = require('./bridge-http');
const { detect: detectCapabilities } = require('./capabilities');
// Phase 6.1/6.5 — external discovery: Claude/Codex JSONL + the opencode
// SQLite DB. beta.31: both scanners run in a worker thread (scan-host.js) so
// a slow scan never stalls the SSE reader.
const { scanExternal, stopScanWorker } = require('./scan-host');
// Phase 6.6 — full-history backfill for adopted threads (fire-and-forget).
const { backfillFullHistory, recordReplyConsent } = require('./history');
const { resolveResumeCwd } = require('./resume-cwd');
const { selectSyncSessions } = require('./sync-select');
// Phase 6.8 — advertise the daemon's own version to the bridge (SSE connect
// + every sync heartbeat) so the UI can show what each machine is running.
const DAEMON_VERSION = (() => {
  try { return require('../package.json').version || 'unknown'; } catch (_) { return 'unknown'; }
})();

const log = (level, msg, data) => {
  const line = { ts: new Date().toISOString(), level, msg };
  if (data !== undefined) line.data = data;
  console.log(JSON.stringify(line));
};

// One Thread OT-7b — health file for `obto-bridge status`. Rewritten on every
// stream / sync state change; tiny JSON, atomic rename. Never carries the
// token.
const fs = require('fs');
const { STATUS_PATH } = require('./service');
const { FATAL_STATUSES } = require('./stream-client');
const health = {
  pid: process.pid,
  version: DAEMON_VERSION,
  startedAt: new Date().toISOString(),
  stream: 'starting',
  connectedAt: null,
  unreachableSince: null,
  lastStreamError: null,
  lastSyncAt: null,
  lastSyncOk: null,
  lastSync: null,
  updatedAt: null,
};
const writeHealth = (patch) => {
  try {
    Object.assign(health, patch || {});
    health.updatedAt = new Date().toISOString();
    fs.mkdirSync(require('path').dirname(STATUS_PATH), { recursive: true, mode: 0o700 });
    fs.writeFileSync(STATUS_PATH + '.tmp', JSON.stringify(health, null, 2), { mode: 0o600 });
    fs.renameSync(STATUS_PATH + '.tmp', STATUS_PATH);
  } catch (_) {}
};

// 401 / 402 / 403 from the bridge mean "this token will never work again
// until a human acts" — retrying every 30 s only spams the server. Print the
// fix, record it for `obto-bridge status`, and exit. Under the service unit
// (OBTO_BRIDGE_SERVICE=1) exit 0 so launchd/systemd do NOT restart us;
// foreground exits 78 (EX_CONFIG).
const fixFor = (status) => {
  if (status === 402) {
    return 'HTTP 402 payment required: this bridge account has no active plan.\n' +
      'Linked to an OBTO login? Check your tenant plan at https://app.obto.co (account home).\n' +
      'Bridge-only account? Subscribe at https://agent-bridge.obto.co/api/bridge/billing\n' +
      'then run: obto-bridge install-service   (or obto-bridge start)';
  }
  if (status === 403) {
    return 'HTTP 403: this bridge account is suspended. Email support@obto.co.';
  }
  return 'HTTP 401: the API token was rejected (revoked by "Disable Bridge", rotated, or another\n' +
    'machine re-linked with a new code). Issue a fresh code: https://app.obto.co → account home →\n' +
    'Agent Bridge → "Add another machine", then run:\n' +
    '  obto-bridge init --link <LNK-…>   &&   obto-bridge install-service';
};
let fatalHandled = false;
const fatalAuth = (status, where, body) => {
  if (fatalHandled) return;
  fatalHandled = true;
  stopped = true;
  const fix = fixFor(status);
  log('error', 'daemon stopped: bridge refused the token', { status, where, body: body || '', fix });
  writeHealth({ stream: 'fatal', fatalStatus: status, fatalAt: new Date().toISOString(), fatalWhere: where, fix });
  try { stream && stream.stop(); } catch (_) {}
  if (externalScanTimer) { try { clearInterval(externalScanTimer); } catch (_) {} }
  stopScanWorker();
  setTimeout(() => process.exit(process.env.OBTO_BRIDGE_SERVICE ? 0 : 78), 200);
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
// beta.32 — last SSE id + recent reply ids, for reconnect catch-up (stream-cursor.js).
const cursor = createCursor();
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

  // beta.32 — the bridge replays replies newer than our Last-Event-ID after a
  // reconnect, and that can overlap live delivery. Handle each id once.
  const eventId = sseEvent.id || payload.messageId;
  if (!cursor.accept(eventId)) {
    log('event', 'skip — already seen', { threadId: payload.threadId, messageId: eventId, replayed: !!payload.replayed });
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

  // beta.33 — a human reply on this thread is consent to mirror its local
  // session history (history.js), for this thread only.
  if (!payload.role || payload.role === 'human') recordReplyConsent(threadId);

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
    let looksAbsolute = typeof resumeCwd === 'string' && resumeCwd.startsWith('/');
    let cwdMissing = false;
    // beta.33 — the recorded cwd must still exist. A session's last cwd is
    // often a scratchpad under /private/tmp that is gone later; the SDK then
    // fails with a misleading "native binary not found". Re-derive from the
    // session file's head; if that fails too, first-touch fresh.
    if (looksAbsolute && !fs.existsSync(resumeCwd)) {
      const derived = resolveResumeCwd({
        source: ea.source,
        projectDir: ea.projectDir,
        sessionId: ea.sessionId,
      });
      if (derived) {
        log('info', 'external adoption: recorded cwd is missing, using the session file head cwd', {
          threadId,
          sessionId: ea.sessionId,
          missingCwd: resumeCwd,
          cwd: derived,
        });
        resumeCwd = derived;
      } else {
        log('warn', 'external adoption skipped: recorded cwd is missing and the session file names no existing cwd — first-touching fresh', {
          threadId,
          agent,
          sessionId: ea.sessionId,
          missingCwd: resumeCwd,
        });
        looksAbsolute = false;
        cwdMissing = true;
      }
    }
    if (cwdMissing) {
      // Logged above; the driver first-touches fresh in cfg.projectDir.
    } else if (!looksAbsolute) {
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
    backfillFullHistory({ threadId, externalAdoption: ea, discovery: cfg.discovery, log });
  }

  log('event', 'reply received', {
    threadId,
    agent,
    author: payload.author,
    messageId: payload.messageId,
    hasSession: !!session,
    replayed: !!payload.replayed,
  });

  // Permission relay: while a tool permission is pending on this thread no frame
  // starts a turn; the driver asks the bridge for the recorded human decision
  // (P0-3) and never trusts the frame's body or role.
  if (await tryResolvePermission(threadId, payload, log)) {
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
      if (result && result.jsonlPath && !session.jsonlPath) {
        session.jsonlPath = result.jsonlPath;
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
    version: DAEMON_VERSION,
    baseUrl: cfg.baseUrl,
    accountId: cfg.accountId,
    agentId: cfg.agentId,
    capabilities,
    projectDir: cfg.projectDir,
    discovery: cfg.discovery,
    service: !!process.env.OBTO_BRIDGE_SERVICE,
    boundThreads: Object.keys(state.bindings || {}),
    streamCursor: cursor.lastEventId(),
  });

  const url = cfg.baseUrl.replace(/\/$/, '') +
    '/api/bridge/stream' +
    '?agentId=' + encodeURIComponent(cfg.agentId) +
    '&capabilities=' + encodeURIComponent(capabilities.join(',')) +
    '&version=' + encodeURIComponent(DAEMON_VERSION) +
    // beta.32 — opt in to the bridge's Last-Event-ID replay (browsers do not).
    '&replay=1';
  stream = startStream({
    url,
    // Re-read config on every (re)connect so a rotated token (via
    // `obto-bridge rotate-token`, which rewrites config.json) is picked up
    // automatically without restarting the daemon.
    getHeaders: () => {
      const fresh = loadConfig();
      const h = authHeaders(fresh);
      // beta.32 — the bridge replays human replies newer than this id, so a
      // reply sent while the stream was down is not lost.
      const lastId = cursor.lastEventId();
      if (lastId) h['Last-Event-ID'] = lastId;
      return h;
    },
    onEvent: (ev) => {
      handleEvent(ev).catch((err) => {
        log('error', 'handleEvent threw', { error: err && err.message });
      });
    },
    onStatus: (st) => {
      if (!st) return;
      if (st.state === 'connected') {
        writeHealth({ stream: 'connected', connectedAt: st.at, unreachableSince: null, lastStreamError: null });
      } else if (st.state === 'lost') {
        writeHealth({ stream: 'reconnecting', lastStreamError: st.error || null });
      } else if (st.state === 'failed') {
        writeHealth({ stream: 'reconnecting', lastStreamError: st.error || null, unreachableSince: st.unreachableSince || health.unreachableSince });
      }
    },
    onFatal: (err) => fatalAuth(err && err.status, 'stream', err && err.body),
    log,
  });
  writeHealth({ stream: 'connecting' });

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
// beta.28 — a full scan of ~2000 local sessions takes longer than the 30 s
// interval on a busy machine (first service sync on 2026-10-16: 110 s), so
// without this guard ticks overlap and the bridge receives interleaved
// inventories. One scan in flight at a time; a tick that finds one running
// is skipped and the next interval picks up.
let externalScanInFlight = false;
const externalScanTick = async () => {
  if (externalScanInFlight) return;
  externalScanInFlight = true;
  try {
    await externalScanTickInner();
  } finally {
    externalScanInFlight = false;
  }
};
const externalScanTickInner = async () => {
  try {
    // Phase 6.5 — fold opencode SQLite sessions into the same external sync
    // payload. Both scanners are best-effort and return [] on failure, so a
    // dead SQLite CLI or missing DB never breaks the JSONL path.
    // beta.31 — the scan runs in a worker thread (scan-host.js); it used to
    // block this thread for up to ~48 s per tick, which held every SSE reply
    // in the socket buffer until it finished.
    const scan = await scanExternal();
    const fromJsonl = scan.fromJsonl || [];
    const fromOpencode = scan.fromOpencode || [];
    let scanDegraded = false;
    if (scan.opencodeError) {
      // Phase 6.7 — a failed sub-scan means our inventory is INCOMPLETE this
      // tick; sending it would falsely mark that source's sessions vanished.
      scanDegraded = true;
      log('warn', 'opencode sqlite scan failed', { error: scan.opencodeError });
    }
    const all = fromJsonl.concat(fromOpencode);
    // beta.34 — adopted sessions (bound under ext-<source>-<prefix>) are sent
    // too, so a later cwd/title/activity change refreshes their synopsis and
    // resume cwd. Bridge-originated owned sessions stay out (sync-select.js).
    const { sessions: external, ownedSent } = selectSyncSessions(all, state);
    // Phase 6.7 — full inventory (external + owned) so the bridge can mark
    // rows whose local file vanished. Sent even when `external` is empty;
    // the bridge ignores empty inventories, so a glitched scan is harmless.
    const presentSessionIds = scanDegraded
      ? [] // incomplete inventory — skip reconciliation this tick
      : all.filter((s) => s && s.sessionId).map((s) => String(s.sessionId));
    if (external.length === 0 && presentSessionIds.length === 0) return;
    const payload = shapeForDiscovery(external, cfg.discovery);
    const r = await postExternalSync(cfg.agentId, payload, presentSessionIds, DAEMON_VERSION, cfg.discovery);
    if (!r || !r.ok) {
      log('warn', 'external sync rejected', {
        status: r && r.status,
        body: r && r.data,
        count: external.length,
      });
      writeHealth({ lastSyncAt: new Date().toISOString(), lastSyncOk: false,
        lastSync: { status: r && r.status, error: r && r.data && (r.data.error || r.data._rawBody && String(r.data._rawBody).slice(0, 120)) } });
      if (r && FATAL_STATUSES.indexOf(r.status) !== -1) {
        fatalAuth(r.status, 'externalSync', r.data && (r.data.error || ''));
      }
    } else {
      log('debug', 'external sync ok', {
        sent: external.length,
        ownedSent,
        scanMs: scan.ms,
        discovery: cfg.discovery,
        upserted: (r.data && r.data.count) || 0,
        vanished: (r.data && r.data.vanished) || 0,
        restored: (r.data && r.data.restored) || 0,
        canonical: (r.data && r.data.canonical) || undefined,
      });
      writeHealth({ lastSyncAt: new Date().toISOString(), lastSyncOk: true,
        lastSync: { sent: external.length, ownedSent, discovery: cfg.discovery,
          upserted: (r.data && r.data.count) || 0, canonical: (r.data && r.data.canonical) || null } });
    }
  } catch (e) {
    const { describeError } = require('./stream-client');
    log('warn', 'external scan failed', { error: describeError(e) });
    writeHealth({ lastSyncAt: new Date().toISOString(), lastSyncOk: false, lastSync: { error: describeError(e) } });
  }
};

// One Thread OT-7b — privacy shaping of the discovery payload.
//   'metadata' (default): drop recentMessages entirely; keep sessionId,
//                         source, projectDir/projectName, title, timestamps
//                         and the ≤200-char lastMessagePreview.
//   'full':               send the scanner output as-is (last ~10 turns).
// The bridge (BridgeExternal.autoAdoptSessions) mirrors recentMessages into
// the canonical thread ONLY when the payload says discovery:'full', so the
// strip here is belt-and-braces: a metadata machine never ships a transcript.
const shapeForDiscovery = (sessions, discovery) => {
  if (discovery === 'full') return sessions;
  return sessions.map((s) => {
    const o = Object.assign({}, s);
    delete o.recentMessages;
    if (typeof o.lastMessagePreview === 'string' && o.lastMessagePreview.length > 200) {
      o.lastMessagePreview = o.lastMessagePreview.slice(0, 200);
    }
    return o;
  });
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
  writeHealth({ stream: 'stopped', stoppedAt: new Date().toISOString(), signal });
  try { stream && stream.stop(); } catch (_) {}
  if (externalScanTimer) { try { clearInterval(externalScanTimer); } catch (_) {} }
  stopScanWorker();
  setTimeout(() => process.exit(0), 200);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start();
