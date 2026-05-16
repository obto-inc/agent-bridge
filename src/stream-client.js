'use strict';

// Thin SSE consumer for /api/bridge/stream. Uses built-in fetch + the response
// body's ReadableStream to parse newline-delimited SSE events. Handles
// reconnection with exponential backoff. No external deps.

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
    const err = new Error('SSE connect failed: HTTP ' + res.status);
    err.status = res.status;
    throw err;
  }
  if (!res.body) {
    throw new Error('SSE connect: no response body');
  }

  if (log) log('info', 'sse stream connected', { status: res.status });

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

// Persistent connection with exponential backoff on disconnect.
// `getHeaders` is a (sync) function — called fresh on every (re)connect so
// rotated tokens are picked up automatically.
const startStream = ({ url, getHeaders, headers, onEvent, log }) => {
  let stopped = false;
  let backoff = 1000;
  let currentAc = null;

  // Back-compat: callers can pass a static `headers` object OR a `getHeaders`
  // callback. The callback wins; otherwise we wrap the static object.
  const resolveHeaders = typeof getHeaders === 'function'
    ? getHeaders
    : () => headers;

  const loop = async () => {
    while (!stopped) {
      try {
        currentAc = await connectOnce({
          url,
          headers: resolveHeaders(),
          onEvent,
          onError: (err) => {
            if (log) log('warn', 'sse stream lost', { error: err && err.message });
            try { currentAc && currentAc.abort(); } catch (_) {}
          },
          log,
        });
        backoff = 1000;
        // Wait until the connection ends. We don't have a clean signal from
        // connectOnce for "stream closed" so we busy-poll the AbortController.
        while (!stopped && currentAc && !currentAc.signal.aborted) {
          await new Promise((r) => setTimeout(r, 500));
        }
      } catch (err) {
        if (log) log('error', 'sse connect failed', { error: err && err.message, backoffMs: backoff });
      }
      if (stopped) break;
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30000);
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

module.exports = { startStream, parseSseFrame };
