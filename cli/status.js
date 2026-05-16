'use strict';

// `obto-bridge status` — read local state.json and print thread→session bindings.
// Read-only; useful for "did the daemon ever drive this thread?"

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
  if (ms < 60_000) return Math.floor(ms / 1000) + 's ago';
  if (ms < 3_600_000) return Math.floor(ms / 60_000) + 'm ago';
  if (ms < 86_400_000) return Math.floor(ms / 3_600_000) + 'h ago';
  return Math.floor(ms / 86_400_000) + 'd ago';
};

console.log('Thread                               Session ID                            Last drive');
console.log('-'.repeat(95));
threads.forEach((t) => {
  const b = bindings[t];
  const sid = (b.sessionId || '').slice(0, 36);
  console.log(t.padEnd(36) + ' ' + sid.padEnd(38) + ' ' + fmtAge(b.lastDriveAt));
});
console.log('');
console.log('JSONLs at: ' + (bindings[threads[0]] && bindings[threads[0]].projectDir
  ? '~/.claude/projects/' + bindings[threads[0]].projectDir.replace(/\//g, '-') + '/'
  : 'unknown'));
