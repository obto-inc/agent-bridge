#!/usr/bin/env node
'use strict';

// DZ-B1 B1-6 — Chrome Native Messaging host for the OBTO extension.
//
// Chrome starts this process when the extension calls
// chrome.runtime.connectNative("co.obto.bridge"), and only for the extension id
// listed in the host manifest (installed by `obto-bridge browser extension install`).
// It relays messages between Chrome (stdio, 4-byte length + JSON) and the
// running daemon (Unix socket ~/.obto-bridge/ext.sock, newline JSON). It holds
// no token and opens no port; when the daemon is not running it tells the
// extension and keeps retrying.

const net = require('net');
const { defaultSocketPath } = require('../src/browser-ext-link');

const socketPath = process.env.OBTO_BRIDGE_EXT_SOCK || defaultSocketPath();
const FRAME_MAX = 4 * 1024 * 1024; // Chrome's limit from the extension is 64 MiB; ours is lower.

let sock = null;
let queue = []; // lines from Chrome waiting for the daemon
let lastHello = null;

const toChrome = (obj) => {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  if (body.length > 1024 * 1024) return toChrome({ type: 'error', error: 'message_too_large' }); // Chrome's host->ext limit is 1 MiB
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([head, body]));
};

const connect = () => {
  const s = net.createConnection(socketPath);
  let buf = '';
  s.setEncoding('utf8');
  s.on('connect', () => {
    sock = s;
    if (lastHello) s.write(lastHello + '\n');
    queue.forEach((l) => s.write(l + '\n'));
    queue = [];
    toChrome({ type: 'daemon', connected: true });
  });
  s.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line) continue;
      try { toChrome(JSON.parse(line)); } catch (_) {}
    }
  });
  const retry = () => {
    if (sock === s) { sock = null; toChrome({ type: 'daemon', connected: false }); }
    setTimeout(connect, 3000);
  };
  s.on('error', () => {});
  s.on('close', retry);
};

// stdin: 4-byte little-endian length, then that many bytes of UTF-8 JSON.
let inBuf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  inBuf = Buffer.concat([inBuf, chunk]);
  while (inBuf.length >= 4) {
    const len = inBuf.readUInt32LE(0);
    if (len > FRAME_MAX) { process.exit(1); }
    if (inBuf.length < 4 + len) break;
    const raw = inBuf.slice(4, 4 + len).toString('utf8');
    inBuf = inBuf.slice(4 + len);
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { continue; }
    const line = JSON.stringify(msg);
    if (msg && msg.type === 'hello') lastHello = line; // replayed when the daemon restarts
    if (sock) sock.write(line + '\n');
    else if (queue.length < 50 && msg && msg.type !== 'hello') queue.push(line);
  }
});
process.stdin.on('end', () => process.exit(0));

connect();
