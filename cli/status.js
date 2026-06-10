'use strict';

// `obto-bridge status` — read local state.json and print thread→session
// bindings. Read-only. v1.1: a thread keeps one session per agent.

const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_PATH = path.join(os.homedir(), '.agent-bridge-daemon', 'state.json');

let state;
try {
  state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
} catch (_) {
  console.log('No state file yet at ' + STATE_PATH);
  console.log('(The daemon writes this after it drives its first thread session.)');
  process.exit(0);
}

const bindings = state && state.bindings ? state.bindings : {};
const threads = Object.keys(bindings).sort();

if (threads.length === 0) {
  console.log('No thread bindings yet.');
  process.exit(0);
}

const fmtAge = (iso) => {
  if (!iso) return '?';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60000) return Math.floor(ms / 1000) + 's ago';
  if (ms < 3600000) return Math.floor(ms / 60000) + 'm ago';
  if (ms < 86400000) return Math.floor(ms / 3600000) + 'h ago';
  return Math.floor(ms / 86400000) + 'd ago';
};

console.log('Thread                               Agent   Session ID                            Last drive');
console.log('-'.repeat(100));
threads.forEach((t) => {
  const b = bindings[t] || {};
  // v1.1 per-agent sessions; tolerate a stray un-migrated v1 flat binding.
  const sessions = b.sessions && typeof b.sessions === 'object'
    ? b.sessions
    : (b.sessionId ? { claude: b } : {});
  const agents = Object.keys(sessions);
  if (agents.length === 0) {
    console.log(t.padEnd(36) + ' (no session yet)');
    return;
  }
  agents.forEach((agent, i) => {
    const s = sessions[agent] || {};
    const sid = String(s.sessionId || '').slice(0, 36);
    console.log(
      (i === 0 ? t : '').padEnd(36) + ' ' +
      agent.padEnd(7) + ' ' +
      sid.padEnd(38) + ' ' +
      fmtAge(s.lastDriveAt),
    );
  });
});
