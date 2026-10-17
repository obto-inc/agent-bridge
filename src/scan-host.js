'use strict';

// beta.31 — run the external-session scan in a worker thread.
//
// Measured 2026-10-17 on the Mac: scanAll() over ~2100 local sessions took
// 23-48 s of synchronous file IO + JSON parsing. It ran on the daemon's main
// thread every tick, so the SSE reader could not run while it worked: a reply
// published by the bridge sat in the socket buffer until the scan finished
// (observed 6-63 s from POST /api/reply to "reply received"; the event itself
// left the bridge within a second). The worker keeps the scanner's per-file
// memo across ticks, so warm scans take ~0.1 s, and even the cold first scan
// no longer delays reply handling.
//
// Same result shape as before: { fromJsonl, fromOpencode, opencodeError }.
// opencodeError is set when the opencode sub-scan threw (the daemon then skips
// vanished-reconciliation for that tick, as before).

const path = require('path');

const IN_WORKER = !!(require('worker_threads').workerData &&
  require('worker_threads').workerData.obtoScanWorker);

const runScanInProcess = () => {
  const { scanAll: scanJsonl } = require('./external-scanner');
  const { scanAll: scanOpencode } = require('./opencode-sqlite-scanner');
  const fromJsonl = scanJsonl();
  let fromOpencode = [];
  let opencodeError = null;
  try {
    fromOpencode = scanOpencode();
  } catch (e) {
    opencodeError = e && e.message ? e.message : String(e);
  }
  return { fromJsonl, fromOpencode, opencodeError };
};

if (IN_WORKER) {
  const { parentPort } = require('worker_threads');
  parentPort.on('message', (msg) => {
    if (!msg || msg.type !== 'scan') return;
    const startedAt = Date.now();
    try {
      const r = runScanInProcess();
      parentPort.postMessage({ id: msg.id, ok: true, result: r, ms: Date.now() - startedAt });
    } catch (e) {
      parentPort.postMessage({ id: msg.id, ok: false, error: e && e.message ? e.message : String(e) });
    }
  });
} else {
  const { Worker } = require('worker_threads');
  const SCAN_TIMEOUT_MS = 10 * 60 * 1000;
  let worker = null;
  let nextId = 1;
  const waiting = new Map(); // id -> { resolve, reject, timer }

  const failAll = (err) => {
    for (const [id, w] of waiting) {
      clearTimeout(w.timer);
      w.reject(err);
      waiting.delete(id);
    }
  };

  const getWorker = () => {
    if (worker) return worker;
    worker = new Worker(path.join(__dirname, 'scan-host.js'), {
      workerData: { obtoScanWorker: true },
    });
    worker.unref(); // never keep the daemon alive on its own
    worker.on('message', (msg) => {
      const w = msg && waiting.get(msg.id);
      if (!w) return;
      waiting.delete(msg.id);
      clearTimeout(w.timer);
      if (msg.ok) w.resolve(Object.assign({ ms: msg.ms }, msg.result));
      else w.reject(new Error(msg.error || 'scan failed'));
    });
    worker.on('error', (err) => {
      worker = null;
      failAll(err);
    });
    worker.on('exit', (code) => {
      worker = null;
      failAll(new Error('scan worker exited (code ' + code + ')'));
    });
    return worker;
  };

  // Resolves to { fromJsonl, fromOpencode, opencodeError, ms }.
  const scanExternal = () => new Promise((resolve, reject) => {
    let w;
    try {
      w = getWorker();
    } catch (e) {
      reject(e);
      return;
    }
    const id = nextId++;
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error('external scan timed out after ' + SCAN_TIMEOUT_MS + ' ms'));
      // A wedged worker would hold the memo hostage; start over next tick.
      try { w.terminate(); } catch (_) {}
    }, SCAN_TIMEOUT_MS);
    timer.unref();
    waiting.set(id, { resolve, reject, timer });
    w.postMessage({ type: 'scan', id });
  });

  const stopScanWorker = () => {
    if (worker) { try { worker.terminate(); } catch (_) {} worker = null; }
  };

  module.exports = { scanExternal, stopScanWorker, runScanInProcess };
}
