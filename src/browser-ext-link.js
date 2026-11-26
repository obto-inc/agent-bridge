'use strict';

// DZ-B1 B1-6 — the daemon's side of the link to the OBTO Chrome extension.
//
//   OBTO extension (everyday Chrome) <-> Chrome Native Messaging (stdio)
//     <-> bin/obto-bridge-native-host.js <-> this Unix socket <-> daemon
//
// The socket lives in ~/.obto-bridge (mode 0600, only this user can connect);
// there is no TCP port. One extension at a time: a new connection replaces the
// old one. Messages are newline-delimited JSON:
//   daemon -> ext  {type:"cmd", id, action, args, grants, runId, timeoutMs}
//   ext -> daemon  {type:"res", id, ok, result?, error?, message?, site?}
//                  {type:"hello", version, browser}   on connect
//                  {type:"stop"}                       Stop pressed in the extension

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const defaultSocketPath = () => path.join(os.homedir(), '.obto-bridge', 'ext.sock');
const LINE_MAX = 4 * 1024 * 1024;

const createExtLink = (opts) => {
  const o = opts || {};
  const socketPath = o.socketPath || defaultSocketPath();
  const log = o.log || (() => {});
  let server = null;
  let client = null;
  let hello = null;
  let nextId = 1;
  const pending = new Map(); // id -> { resolve, timer }
  const stopHandlers = [];

  const failAll = (error) => {
    for (const [id, p] of pending) { clearTimeout(p.timer); p.resolve({ ok: false, error }); pending.delete(id); }
  };

  const onLine = (line) => {
    let m;
    try { m = JSON.parse(line); } catch (_) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.type === 'hello') {
      hello = { version: String(m.version || '').slice(0, 40), browser: String(m.browser || '').slice(0, 80), at: new Date().toISOString() };
      log('info', 'browser extension connected', hello);
      return;
    }
    if (m.type === 'stop') {
      log('info', 'browser extension Stop');
      stopHandlers.forEach((fn) => { try { fn(); } catch (_) {} });
      return;
    }
    if (m.type === 'res' && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      clearTimeout(p.timer);
      const out = { ok: !!m.ok };
      if (m.ok) out.result = m.result || {};
      else { out.error = String(m.error || 'extension_failed').slice(0, 80); out.message = m.message ? String(m.message).slice(0, 500) : null; if (m.site) out.site = String(m.site).slice(0, 200); }
      p.resolve(out);
    }
  };

  const attach = (sock) => {
    if (client) { try { client.destroy(); } catch (_) {} }
    client = sock;
    hello = null;
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > LINE_MAX) { buf = ''; sock.destroy(); return; }
      let i;
      while ((i = buf.indexOf('\n')) !== -1) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line) onLine(line); }
    });
    const gone = () => {
      if (client !== sock) return;
      client = null;
      hello = null;
      failAll('extension_disconnected');
      log('info', 'browser extension disconnected');
    };
    sock.on('close', gone);
    sock.on('error', gone);
  };

  const start = () => new Promise((resolve) => {
    if (server) return resolve(true);
    try { fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 }); } catch (_) {}
    try { fs.unlinkSync(socketPath); } catch (_) {}
    const s = net.createServer(attach);
    s.on('error', (e) => { log('warn', 'extension socket error', { error: e && e.message }); resolve(false); });
    s.listen(socketPath, () => {
      try { fs.chmodSync(socketPath, 0o600); } catch (_) {}
      server = s;
      resolve(true);
    });
  });

  const close = () => {
    failAll('extension_link_closed');
    if (client) { try { client.destroy(); } catch (_) {} client = null; }
    if (server) { try { server.close(); } catch (_) {} server = null; }
    try { fs.unlinkSync(socketPath); } catch (_) {}
  };

  // Resolves with the extension's answer, or {ok:false,error} on timeout or disconnect.
  const request = (body, timeoutMs) => new Promise((resolve) => {
    if (!client) return resolve({ ok: false, error: 'extension_not_connected' });
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, error: 'extension_timeout' }); }, Math.max(1000, timeoutMs || 30000));
    pending.set(id, { resolve, timer });
    client.write(JSON.stringify(Object.assign({ type: 'cmd', id }, body)) + '\n');
  });

  return {
    start, close, request,
    connected: () => !!(client && hello),
    info: () => hello,
    onStop: (fn) => { stopHandlers.push(fn); },
    socketPath,
  };
};

module.exports = { createExtLink, defaultSocketPath };
