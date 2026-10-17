'use strict';

// Thin SSE consumer for /api/bridge/stream. Uses built-in fetch + the response
// body's ReadableStream to parse newline-delimited SSE events. Handles
// reconnection with capped exponential backoff. No external deps.
//
// beta.28 (One Thread OT-7b) — outage forensics from ~/.obto-bridge/daemon.log
// (2026-06-18 → 2026-08-21 run, beta.26): the daemon reconnected 700+ times
// over two months (server closed streams: "terminated"), always recovering.
// From 2026-08-20T23:28Z every fetch failed at the network layer ("fetch
// failed", no HTTP status — undici hides the cause) for ~1 h, then the
// process got SIGTERM at 00:27Z and nothing restarted it: no service unit.
// So: (1) surface err.cause.code, (2) say out loud how long we have been
// unreachable, (3) fail FAST and LOUD on 401/402/403 instead of retrying
// forever with a dead token, (4) `obto-bridge install-service` supervises.

// beta.31 — the bridge writes ': hb' every 25 s. A socket that delivers
// nothing for this long is half-open (sleep/wake, NAT drop, the 10-17
// ETIMEDOUT case): abort and reconnect instead of waiting for the OS.
const IDLE_TIMEOUT_MS = 75000;
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 60000;
const FATAL_STATUSES = [401, 402, 403];

const parseSseFrame = (frame) => {
  // SSE frame is a sequence of "field: value" lines terminated by a blank line.
  // We care about: `event:`, `data:`, `id:`. Comments (`:`) are ignored.
  const out = { event: 'message', id: null, data: '' };
  const lines = frame.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.charAt(0) === ':') continue;
    const idx = line.indexOf(':');
    let field, value;
    if (idx === -1) {
      field = line.trim();
      value = '';
    } else {
      field = line.slice(0, idx).trim();
      value = line.slice(idx + 1);
      if (value.charAt(0) === ' ') value = value.slice(1);
    }
    if (field === 'event') out.event = value;
    else if (field === 'id') out.id = value;
    else if (field === 'data') {
      out.data = out.data ? out.data + '\n' + value : value;
    }
  }
  return out;
};

// undici wraps network errors as TypeError('fetch failed') with the real
// reason on `.cause` (ENOTFOUND, ECONNREFUSED, ETIMEDOUT, CERT_…). Flatten it.
const describeError = (err) => {
  if (!err) return 'unknown';
  let s = err.message || String(err);
  const c = err.cause;
  if (c) {
    const code = c.code || c.errno || c.name;
    const msg = c.message && c.message !== s ? c.message : '';
    if (code || msg) s += ' (' + [code, msg].filter(Boolean).join(': ') + ')';
  }
  return s;
};

// Connect once, yield SSE events to the onEvent callback. Returns an
// AbortController so the caller can cancel.
const connectOnce = async ({ url, headers, onEvent, onError, log }) => {
  const ac = new AbortController();
  const res = await fetch(url, {
    method: 'GET',
    headers: Object.assign({ Accept: 'text/event-stream' }, headers || {}),
    signal: ac.signal,
    cache: 'no-store',
  });

  if (!res.ok) {
    let bodyText = '';
    try { bodyText = (await res.text()).slice(0, 300); } catch (_) {}
    const err = new Error('SSE connect failed: HTTP ' + res.status);
    err.status = res.status;
    err.body = bodyText;
    throw err;
  }
  if (!res.body) {
    throw new Error('SSE connect: no response body');
  }

  if (log) log('info', 'sse stream connected', { status: res.status });
  ac.lastByteAt = Date.now();

  // Read the body as a stream of UTF-8 chunks; split on blank lines (frame
  // delimiter per SSE spec). Pump until end-of-stream or abort.
  (async () => {
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        ac.lastByteAt = Date.now();
        buf += decoder.decode(value, { stream: true });

        // Split on \n\n (or \r\n\r\n) — SSE frame delimiter.
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1 || (i = buf.indexOf('\r\n\r\n')) !== -1) {
          const sep = buf.indexOf('\r\n\r\n') !== -1 && buf.indexOf('\r\n\r\n') === i ? 4 : 2;
          const frame = buf.slice(0, i);
          buf = buf.slice(i + sep);
          if (frame.trim().length === 0) continue;
          try {
            onEvent(parseSseFrame(frame));
          } catch (e) {
            if (log) log('error', 'sse frame handler threw', { error: e && e.message });
          }
        }
      }
      if (onError) onError(new Error('stream ended'));
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      if (onError) onError(err);
    }
  })();

  return ac;
};

// Persistent connection with capped exponential backoff (1 s → 60 s, ±20 %
// jitter) on disconnect.
//   getHeaders  (sync) called fresh on every (re)connect so rotated tokens are
//               picked up automatically.
//   onStatus    optional ({state:'connected'|'lost'|'failed'|'fatal', …}) —
//               the daemon mirrors it into ~/.obto-bridge/daemon-status.json.
//   onFatal     optional (err) — called ONCE on 401/402/403; the loop stops.
//               Without it the loop keeps retrying like before.
const startStream = ({ url, getHeaders, headers, onEvent, onStatus, onFatal, log }) => {
  let stopped = false;
  let backoff = BACKOFF_MIN_MS;
  let currentAc = null;
  let unreachableSince = null;
  let lastUnreachableMinLogged = -1;

  // Back-compat: callers can pass a static `headers` object OR a `getHeaders`
  // callback. The callback wins; otherwise we wrap the static object.
  const resolveHeaders = typeof getHeaders === 'function'
    ? getHeaders
    : () => headers;

  const status = (payload) => {
    if (typeof onStatus !== 'function') return;
    try { onStatus(payload); } catch (_) {}
  };

  const noteUnreachable = (errText) => {
    const now = Date.now();
    if (!unreachableSince) unreachableSince = now;
    const minutes = Math.floor((now - unreachableSince) / 60000);
    // One visible line per minute of outage, not one per attempt.
    if (minutes >= 1 && minutes !== lastUnreachableMinLogged) {
      lastUnreachableMinLogged = minutes;
      if (log) log('warn', 'cannot reach the bridge for ' + minutes + ' min', {
        since: new Date(unreachableSince).toISOString(),
        lastError: errText,
        url,
      });
    }
  };

  const loop = async () => {
    while (!stopped) {
      try {
        currentAc = await connectOnce({
          url,
          headers: resolveHeaders(),
          onEvent,
          onError: (err) => {
            if (log) log('warn', 'sse stream lost', { error: describeError(err) });
            status({ state: 'lost', error: describeError(err), at: new Date().toISOString() });
            try { currentAc && currentAc.abort(); } catch (_) {}
          },
          log,
        });
        backoff = BACKOFF_MIN_MS;
        if (unreachableSince && log) {
          log('info', 'bridge reachable again', {
            afterMs: Date.now() - unreachableSince,
            since: new Date(unreachableSince).toISOString(),
          });
        }
        unreachableSince = null;
        lastUnreachableMinLogged = -1;
        status({ state: 'connected', at: new Date().toISOString() });
        // Wait until the connection ends. We don't have a clean signal from
        // connectOnce for "stream closed" so we busy-poll the AbortController.
        while (!stopped && currentAc && !currentAc.signal.aborted) {
          await new Promise((r) => setTimeout(r, 500));
          if (currentAc && !currentAc.signal.aborted &&
              Date.now() - (currentAc.lastByteAt || 0) > IDLE_TIMEOUT_MS) {
            const idleMs = Date.now() - currentAc.lastByteAt;
            if (log) log('warn', 'sse stream idle — reconnecting', { idleMs });
            status({ state: 'lost', error: 'idle ' + idleMs + ' ms', at: new Date().toISOString() });
            try { currentAc.abort(); } catch (_) {}
          }
        }
      } catch (err) {
        const errText = describeError(err);
        if (err && FATAL_STATUSES.indexOf(err.status) !== -1 && typeof onFatal === 'function') {
          if (log) log('error', 'sse connect refused — not retrying', { status: err.status, body: err.body || '' });
          status({ state: 'fatal', httpStatus: err.status, error: errText, at: new Date().toISOString() });
          stopped = true;
          try { onFatal(err); } catch (_) {}
          break;
        }
        if (log) log('error', 'sse connect failed', { error: errText, status: err && err.status, backoffMs: backoff });
        status({ state: 'failed', error: errText, httpStatus: err && err.status, backoffMs: backoff,
          unreachableSince: unreachableSince ? new Date(unreachableSince).toISOString() : new Date().toISOString(),
          at: new Date().toISOString() });
        noteUnreachable(errText);
      }
      if (stopped) break;
      const jitter = 1 + (Math.random() * 0.4 - 0.2);
      await new Promise((r) => setTimeout(r, Math.round(backoff * jitter)));
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    }
  };

  loop();

  return {
    stop: () => {
      stopped = true;
      try { currentAc && currentAc.abort(); } catch (_) {}
    },
  };
};

module.exports = { startStream, parseSseFrame, describeError, FATAL_STATUSES, IDLE_TIMEOUT_MS };
