'use strict';

// `obto-bridge status` — read-only.
//   1. Daemon health from ~/.obto-bridge/daemon-status.json (written by the
//      running daemon on every stream/sync state change) + the service unit.
//   2. Thread → session bindings from ~/.agent-bridge-daemon/state.json.
// Pass --json for a machine-readable dump of (1).

const fs = require('fs');
const path = require('path');
const os = require('os');
const svc = require('../src/service');

const STATE_PATH = path.join(os.homedir(), '.agent-bridge-daemon', 'state.json');
const wantJson = process.argv.indexOf('--json') !== -1;

const fmtAge = (iso) => {
  if (!iso) return '?';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return 'just now';
  if (ms < 60000) return Math.floor(ms / 1000) + 's ago';
  if (ms < 3600000) return Math.floor(ms / 60000) + 'm ago';
  if (ms < 86400000) return Math.floor(ms / 3600000) + 'h ago';
  return Math.floor(ms / 86400000) + 'd ago';
};

// ─── 1. daemon + service ──────────────────────────────────────────────────
const health = svc.readDaemonStatus();
const service = svc.state();
const alive = !!(health && svc.pidAlive(health.pid));
const fresh = !!(health && health.updatedAt && (Date.now() - new Date(health.updatedAt).getTime()) < 10 * 60000);

let verdict;
if (!health) verdict = 'never started';
else if (!alive) verdict = health.stream === 'fatal' ? 'stopped (auth)' : 'not running';
else if (health.stream === 'connected') verdict = 'connected';
else if (health.stream === 'fatal') verdict = 'stopped (auth)';
else verdict = 'reconnecting';

let cfgSummary = null;
try {
  const c = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.obto-bridge', 'config.json'), 'utf8'));
  cfgSummary = {
    accountId: c.accountId || null,
    agentId: c.agentId || null,
    discovery: c.discovery || 'metadata',
    tenant: c.tenant && c.tenant.obtoDomain ? (c.tenant.obtoDomain + ' as ' + (c.tenant.obtoUserName || '?')) : null,
  };
} catch (_) {}

if (wantJson) {
  console.log(JSON.stringify({ verdict, alive, fresh, daemon: health, service, config: cfgSummary }, null, 2));
  process.exit(0);
}

console.log('Daemon:   ' + verdict +
  (health && health.pid ? '  (pid ' + health.pid + (alive ? '' : ', gone') + ')' : '') +
  (health && health.version ? '  v' + health.version : ''));
if (cfgSummary) {
  console.log('Account:  ' + (cfgSummary.accountId || '?') +
    (cfgSummary.tenant ? '  linked to ' + cfgSummary.tenant : '  (not linked to an OBTO login)'));
  console.log('Machine:  ' + (cfgSummary.agentId || '?') + '  discovery=' + cfgSummary.discovery);
}
if (health) {
  if (health.stream === 'connected' && health.connectedAt) {
    console.log('Stream:   connected since ' + health.connectedAt + ' (' + fmtAge(health.connectedAt) + ')');
  } else if (health.stream === 'fatal') {
    console.log('Stream:   REFUSED HTTP ' + (health.fatalStatus || '?') + ' at ' + (health.fatalAt || '?'));
    if (health.fix) String(health.fix).split('\n').forEach((l) => console.log('          ' + l));
  } else {
    console.log('Stream:   ' + (health.stream || '?') +
      (health.unreachableSince ? ' — cannot reach the bridge since ' + health.unreachableSince + ' (' + fmtAge(health.unreachableSince) + ')' : '') +
      (health.lastStreamError ? ' — ' + health.lastStreamError : ''));
  }
  if (health.lastSyncAt) {
    const s = health.lastSync || {};
    console.log('Sync:     ' + (health.lastSyncOk ? 'ok ' : 'FAILED ') + fmtAge(health.lastSyncAt) +
      (health.lastSyncOk
        ? ' — sent ' + (s.sent != null ? s.sent : '?') + ' sessions' +
          (s.canonical ? ', canonical ' + JSON.stringify(s.canonical) : '')
        : ' — ' + (s.error || ('HTTP ' + (s.status || '?')))));
  } else {
    console.log('Sync:     none yet (first scan runs 10 s after start)');
  }
  console.log('Updated:  ' + (health.updatedAt || '?') + (fresh ? '' : '  (stale)'));
}
console.log('Service:  ' + (service.kind || 'n/a') +
  (service.installed ? ' installed' : ' not installed') +
  (service.loaded ? ', loaded' : '') +
  (service.state ? ', ' + service.state : '') +
  (service.pid ? ', pid ' + service.pid : '') +
  (service.lastExit && service.lastExit !== '0' && service.lastExit !== '(never exited)' ? ', last exit ' + service.lastExit : ''));
if (!service.installed) console.log('          → obto-bridge install-service');
console.log('Log:      ' + svc.LOG_PATH);
console.log('');

// ─── 2. bindings ──────────────────────────────────────────────────────────
let state;
try {
  state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
} catch (_) {
  console.log('No bindings yet at ' + STATE_PATH);
  console.log('(The daemon writes this after it drives its first thread session.)');
  process.exit(0);
}

const bindings = state && state.bindings ? state.bindings : {};
const threads = Object.keys(bindings).sort();

if (threads.length === 0) {
  console.log('No thread bindings yet.');
  process.exit(0);
}

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
