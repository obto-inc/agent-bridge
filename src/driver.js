'use strict';

// Agent-agnostic driver selector. The daemon drives whichever coding agent the
// operator configured — Claude (via the Claude Agent SDK) or Codex (via the
// Codex SDK) — chosen by `agent` in config.json / the BRIDGE_AGENT env var.
// Everything else in the daemon (SSE, state, the bridge HTTP client) is
// agent-neutral; only the driver differs.
//
// The codex driver is require()d lazily, so a Claude-only install never loads
// @openai/codex-sdk (and vice versa).

const { loadConfig } = require('./config');

let resolved = null;

const pick = () => {
  if (resolved) return resolved;
  let agent = 'claude';
  try {
    agent = (loadConfig().agent || 'claude').toLowerCase();
  } catch (_) {
    // config unreadable — default to claude
  }
  if (agent === 'codex') {
    resolved = { name: 'codex', mod: require('./codex-driver') };
  } else {
    resolved = { name: 'claude', mod: require('./claude-driver') };
  }
  return resolved;
};

const drive = (params) => pick().mod.drive(params);

// Permission relay is Claude-only — Codex exposes no per-tool callback. For a
// Codex daemon this is always a no-op so the reply path goes straight to
// drive(); for Claude it delegates to the real relay resolver.
const tryResolvePermission = (threadId, body, log) => {
  const p = pick();
  if (typeof p.mod.tryResolvePermission === 'function') {
    return p.mod.tryResolvePermission(threadId, body, log);
  }
  return false;
};

const activeAgent = () => pick().name;

module.exports = { drive, tryResolvePermission, activeAgent };
