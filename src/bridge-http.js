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

module.exports = {
  getCfg,
  buildHeaders,
  postMessage,
  getMessages,
  postAgentActivity,
};
