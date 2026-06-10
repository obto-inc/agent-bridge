'use strict';

// HTTP client for talking to the OBTO bridge from the daemon. Bearer auth
// (per-account token), sets the OBTO-ORIGIN-HOST header so requests route
// to the ob-agent-bridge app even when its DNS hasn't propagated.

const { loadConfig } = require('./config');

// No caching. loadConfig() always re-reads ~/.obto-bridge/config.json so a
// token rotation (which rewrites the file) takes effect on the next request.
// File reads are local and tiny — cost is negligible.
const getCfg = () => loadConfig();

const buildHeaders = (extra) => {
  const c = getCfg();
  return Object.assign(
    {
      'Content-Type': 'application/json',
      'OBTO-ORIGIN-HOST': c.originHost,
      Authorization: 'Bearer ' + c.apiToken,
    },
    extra || {},
  );
};

const postJson = async (path, body) => {
  const c = getCfg();
  const url = c.baseUrl.replace(/\/$/, '') + path;
  const res = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify(body),
  });
  let data;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    data = { _rawBody: text };
  }
  return { status: res.status, ok: res.ok, data };
};

const getJson = async (path) => {
  const c = getCfg();
  const url = c.baseUrl.replace(/\/$/, '') + path;
  const res = await fetch(url, {
    method: 'GET',
    headers: buildHeaders({ Accept: 'application/json' }),
    cache: 'no-store',
  });
  let data;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    data = { _rawBody: text };
  }
  return { status: res.status, ok: res.ok, data };
};

// Post a message via the agent-side /api/message route. Used both for normal
// agent posts (status/result/etc.) and for permission-relay questions.
const postMessage = (payload) => postJson('/api/message', payload);

// Read recent messages on a thread, optionally since an ISO cursor.
const getMessages = (threadId, sinceCursor) => {
  const qs =
    'threadId=' +
    encodeURIComponent(String(threadId || '')) +
    (sinceCursor ? '&since=' + encodeURIComponent(String(sinceCursor)) : '');
  return getJson('/api/messages?' + qs);
};

// Transient "agent is working / idle" signal. Fire-and-forget from the daemon
// around each Claude turn so the browser UI can show a thinking indicator.
// Not persisted server-side — pure RMQ pub/sub via BridgeBroker.
const postAgentActivity = (threadId, state) =>
  postJson('/api/bridge/agent-activity', { threadId, state });

// Phase 2b — atomic first-touch claim. Called by the daemon when it sees a
// reply event for a thread whose `agentId` is null (unrouted). The bridge's
// claimThread does a conditional Mongo update — only one daemon wins.
// Returns { ok, won, winner }: `won` is the only thing the caller acts on.
const claimThread = (threadId, agentId) =>
  postJson('/api/bridge/thread/claim', { threadId, agentId });

// Phase 6.1 — push external (non-bridge) sessions discovered by the local
// filesystem scanner so the bridge UI can render them alongside bridge-owned
// threads. Fire-and-forget; the bridge tolerates partial payloads and
// re-observes on the next 30s tick.
// Phase 6.7 — `presentSessionIds` is the FULL on-disk inventory (external +
// bridge-owned). The bridge marks rows missing from it as vanished so dead
// sessions stop being adoptable, and restores them if the file reappears.
const postExternalSync = (agentId, sessions, presentSessionIds) =>
  postJson('/api/bridge/external/sync', { agentId, sessions, presentSessionIds });

// Phase 6.6 — ship the FULL local session history for an adopted thread.
// The route replaces the adoption-time partial backfill and is idempotent
// (hist:<sessionId>:<idx> clientMsgIds), so retries are safe.
const postExternalBackfill = (threadId, sessionId, messages) =>
  postJson('/api/bridge/external/backfill', { threadId, sessionId, messages });

// Phase 5a — read the newest messages on a thread (backward page ending at
// `before`). Used to build the first-touch history block when an engine
// takes over a thread that already has conversation.
const getMessagesBefore = (threadId, beforeIso, limit) => {
  const qs =
    'threadId=' + encodeURIComponent(String(threadId || '')) +
    '&before=' + encodeURIComponent(String(beforeIso || new Date().toISOString())) +
    (limit ? '&limit=' + encodeURIComponent(String(limit)) : '');
  return getJson('/api/messages?' + qs);
};

// Phase 6.4 — download an attachment's raw bytes for use as a Claude SDK
// image content block. The serve route streams the file with its stored
// Content-Type; we read it into a Buffer and base64-encode for the SDK.
// Returns { ok, status, mimeType, base64 } or { ok: false, status }.
const getAttachmentBytes = async (attachmentId) => {
  const c = getCfg();
  const url = c.baseUrl.replace(/\/$/, '') +
    '/api/bridge/attachment/' + encodeURIComponent(String(attachmentId));
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'OBTO-ORIGIN-HOST': c.originHost,
      Authorization: 'Bearer ' + c.apiToken,
    },
    cache: 'no-store',
  });
  if (!res.ok) return { ok: false, status: res.status };
  const mimeType = res.headers.get('content-type') || 'application/octet-stream';
  const buf = Buffer.from(await res.arrayBuffer());
  return { ok: true, status: res.status, mimeType, base64: buf.toString('base64') };
};

module.exports = {
  getCfg,
  buildHeaders,
  postMessage,
  getMessages,
  getMessagesBefore,
  postAgentActivity,
  claimThread,
  postExternalSync,
  postExternalBackfill,
  getAttachmentBytes,
};
