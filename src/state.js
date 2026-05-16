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

// Schema:
// {
//   "bindings": {
//     "<threadId>": {
//       "sessionId": "<uuid>",
//       "projectDir": "/abs/path",
//       "jsonlPath": "/.../<sid>.jsonl",
//       "createdAt": "iso-ts",
//       "lastDriveAt": "iso-ts"
//     }, ...
//   }
// }
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
  return raw;
};

const saveState = (state) => {
  ensureDir();
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
};

const getBinding = (state, threadId) =>
  state.bindings && state.bindings[threadId] ? state.bindings[threadId] : null;

const setBinding = (state, threadId, info) => {
  state.bindings[threadId] = info;
  saveState(state);
};

module.exports = {
  STATE_DIR,
  STATE_PATH,
  loadState,
  saveState,
  getBinding,
  setBinding,
};
