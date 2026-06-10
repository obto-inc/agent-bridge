'use strict';

// Dual-driver dispatch (v1.1).
//
// v1 resolved ONE agent at startup and drove only that. v1.1 makes the daemon
// agent-agnostic per event: it can drive BOTH Claude (Claude Agent SDK) and
// Codex (Codex SDK), and routes each bridge event to the right driver by the
// thread's `agent` field (`payload.agent`, set server-side from the thread's
// routing record).
//
// Drivers are require()d lazily and cached — a machine that only ever runs
// Claude threads never pays to load @openai/codex-sdk, and vice versa.

const { loadConfig } = require('./config');

const KNOWN_AGENTS = ['claude', 'codex', 'opencode'];

const cache = {};

const loadDriver = (name) => {
  if (cache[name]) return cache[name];
  let mod;
  if (name === 'codex') mod = require('./codex-driver');
  else if (name === 'opencode') mod = require('./opencode-driver');
  else mod = require('./claude-driver');
  cache[name] = mod;
  return mod;
};

// Fallback agent for events that arrive without an explicit `agent` — an
// older bridge, or a thread created before v1.1. Reads config.agent (the v1
// init choice), else 'claude'.
let fallbackAgent = null;
const getFallbackAgent = () => {
  if (fallbackAgent) return fallbackAgent;
  let a = 'claude';
  try {
    a = (loadConfig().agent || 'claude').toLowerCase();
  } catch (_) {
    // config unreadable — default to claude
  }
  fallbackAgent = KNOWN_AGENTS.indexOf(a) !== -1 ? a : 'claude';
  return fallbackAgent;
};

// Resolve which agent a bridge event targets.
const agentFor = (payload) => {
  const a = payload && payload.agent ? String(payload.agent).toLowerCase() : '';
  if (KNOWN_AGENTS.indexOf(a) !== -1) return a;
  return getFallbackAgent();
};

// Drive one bridge event with the agent its thread is bound to.
const drive = (params) => {
  const name = agentFor(params && params.payload);
  return loadDriver(name).drive(params);
};

// Permission relay is Claude-only — the Codex SDK exposes no per-tool callback.
// We delegate to the claude driver's resolver regardless of the thread's agent:
// it keys on threadId against its own pending-request map, so a codex thread
// (which never has a pending claude request) simply returns false and the
// reply falls through to drive().
const tryResolvePermission = (threadId, body, log) => {
  const claude = loadDriver('claude');
  if (typeof claude.tryResolvePermission === 'function') {
    return claude.tryResolvePermission(threadId, body, log);
  }
  return false;
};

module.exports = { drive, tryResolvePermission, agentFor, KNOWN_AGENTS };
