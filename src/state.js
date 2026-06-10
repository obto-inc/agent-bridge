'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_DIR = path.join(os.homedir(), '.agent-bridge-daemon');
const STATE_PATH = path.join(STATE_DIR, 'state.json');

const ensureDir = () => {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  } catch (_) {}
};

// Schema (v1.1 — per-agent sessions):
// {
//   "bindings": {
//     "<threadId>": {
//       "createdAt": "iso-ts",
//       "agentId": "<machine id>",
//       "sessions": {
//         "claude": { "sessionId", "projectDir", "jsonlPath", "lastJsonlMtimeMs", "lastDriveAt" },
//         "codex":  { "sessionId", "projectDir", "lastDriveAt" }
//       }
//     }, ...
//   }
// }
// A thread keeps one session PER agent, so switching claude<->codex and back
// resumes each engine's own context. v1 flat bindings are migrated on load.

// Migrate a v1 flat binding ({ sessionId, projectDir, ... }) into the v1.1
// per-agent shape. The flat session is filed under 'claude' — the v1 default
// agent. A v1 codex daemon's threads simply first-touch codex fresh after the
// upgrade, which is acceptable (a switch is a fresh first-touch anyway).
const migrateBinding = (b) => {
  if (!b || typeof b !== 'object') {
    return { createdAt: null, agentId: null, sessions: {} };
  }
  if (b.sessions && typeof b.sessions === 'object') return b; // already v1.1
  const out = {
    createdAt: b.createdAt || null,
    agentId: b.agentId || null,
    sessions: {},
  };
  if (b.sessionId) {
    out.sessions.claude = {
      sessionId: b.sessionId,
      projectDir: b.projectDir,
      jsonlPath: b.jsonlPath,
      lastJsonlMtimeMs: b.lastJsonlMtimeMs || null,
      lastDriveAt: b.lastDriveAt || null,
    };
  }
  return out;
};

const loadState = () => {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (_) {
    raw = {};
  }
  if (!raw.bindings || typeof raw.bindings !== 'object') {
    raw.bindings = {};
  }
  // Migrate any v1 flat bindings to the per-agent shape.
  for (const tid of Object.keys(raw.bindings)) {
    raw.bindings[tid] = migrateBinding(raw.bindings[tid]);
  }
  return raw;
};

const saveState = (state) => {
  ensureDir();
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
};

// The full per-thread binding ({ createdAt, agentId, sessions }), or null.
const getBinding = (state, threadId) =>
  state.bindings && state.bindings[threadId] ? state.bindings[threadId] : null;

// One agent's session record on a thread, or null. The driver consumes this
// flat shape directly — same contract as the v1 binding.
const getAgentSession = (state, threadId, agent) => {
  const b = getBinding(state, threadId);
  if (!b || !b.sessions) return null;
  return b.sessions[agent] || null;
};

// Store/replace one agent's session on a thread. Creates the binding if absent.
const setAgentSession = (state, threadId, agent, session, meta) => {
  let b = state.bindings[threadId];
  if (!b || !b.sessions) {
    b = {
      createdAt: new Date().toISOString(),
      agentId: (meta && meta.agentId) || null,
      sessions: {},
    };
    state.bindings[threadId] = b;
  }
  if (meta && meta.agentId) b.agentId = meta.agentId;
  b.sessions[agent] = session;
  saveState(state);
  return b;
};

module.exports = {
  STATE_DIR,
  STATE_PATH,
  loadState,
  saveState,
  getBinding,
  getAgentSession,
  setAgentSession,
};
