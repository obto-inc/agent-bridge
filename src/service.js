'use strict';

// One Thread OT-7b — background service helpers shared by
// `obto-bridge install-service`, `uninstall-service` and `status`.
//
// macOS: a launchd LaunchAgent at ~/Library/LaunchAgents/com.obto.agent-bridge.plist
// Linux: a systemd --user unit at ~/.config/systemd/user/obto-bridge.service
//
// Both run `node <bin/obto-bridge.js> start` with OBTO_BRIDGE_SERVICE=1 and
// restart it only on a NON-zero exit (launchd KeepAlive SuccessfulExit=false,
// systemd Restart=on-failure). The daemon exits 0 on 401/402/403 so a dead
// token does not turn into a restart storm — the fix is printed in the log
// and `obto-bridge status` shows it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const LABEL = 'com.obto.agent-bridge';
const UNIT = 'obto-bridge';
const CONFIG_DIR = path.join(os.homedir(), '.obto-bridge');
const LOG_PATH = path.join(CONFIG_DIR, 'daemon.log');
const STATUS_PATH = path.join(CONFIG_DIR, 'daemon-status.json');
const PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', LABEL + '.plist');
const UNIT_PATH = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
  'systemd', 'user', UNIT + '.service',
);

const BIN_PATH = path.resolve(__dirname, '..', 'bin', 'obto-bridge.js');

// Running out of the npx cache: the files vanish on the next cache prune, so
// a service pointing at them would die silently. Refuse and say how to fix.
const isEphemeralInstall = () => /[\\/]_npx[\\/]/.test(BIN_PATH);

const xmlEscape = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

// PATH the daemon needs: the node binary's dir (nvm installs are not on the
// launchd default PATH) + wherever claude/codex/opencode live for this user.
const servicePath = () => {
  const parts = [path.dirname(process.execPath)];
  const cur = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const p of cur) if (parts.indexOf(p) === -1) parts.push(p);
  for (const p of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']) {
    if (parts.indexOf(p) === -1) parts.push(p);
  }
  return parts.join(path.delimiter);
};

const run = (cmd, args, opts) => {
  const r = spawnSync(cmd, args, Object.assign({ encoding: 'utf8' }, opts || {}));
  return {
    status: r.status,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
    error: r.error,
  };
};

const uid = () => {
  if (typeof process.getuid === 'function') return process.getuid();
  const r = run('id', ['-u']);
  return r.status === 0 ? parseInt(r.stdout, 10) : null;
};

// Rotate a fat log once so the service does not append to 20 MB forever.
const rotateLogIfLarge = (maxBytes) => {
  try {
    const st = fs.statSync(LOG_PATH);
    if (st.size > (maxBytes || 10 * 1024 * 1024)) {
      fs.renameSync(LOG_PATH, LOG_PATH + '.1');
      return true;
    }
  } catch (_) {}
  return false;
};

const launchdPlist = ({ workingDir }) => {
  // USER / LOGNAME: launchd starts agents without them, and Claude Code looks up
  // its macOS Keychain login by user name. Without them every bridge turn
  // answers "Not logged in · Please run /login" (witnessed 2026-10-17).
  const userName = (() => { try { return os.userInfo().username; } catch (_) { return process.env.USER || ''; } })();
  const env = {
    PATH: servicePath(),
    HOME: os.homedir(),
    OBTO_BRIDGE_SERVICE: '1',
  };
  if (userName) { env.USER = userName; env.LOGNAME = userName; }
  const envXml = Object.keys(env).map((k) =>
    '    <key>' + xmlEscape(k) + '</key>\n    <string>' + xmlEscape(env[k]) + '</string>').join('\n');
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0">\n<dict>\n' +
    '  <key>Label</key>\n  <string>' + LABEL + '</string>\n' +
    '  <key>ProgramArguments</key>\n  <array>\n' +
    '    <string>' + xmlEscape(process.execPath) + '</string>\n' +
    '    <string>' + xmlEscape(BIN_PATH) + '</string>\n' +
    '    <string>start</string>\n' +
    '  </array>\n' +
    '  <key>WorkingDirectory</key>\n  <string>' + xmlEscape(workingDir) + '</string>\n' +
    '  <key>EnvironmentVariables</key>\n  <dict>\n' + envXml + '\n  </dict>\n' +
    '  <key>RunAtLoad</key>\n  <true/>\n' +
    '  <key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>\n  </dict>\n' +
    '  <key>ThrottleInterval</key>\n  <integer>30</integer>\n' +
    // beta.31 — Standard, not Background: Background throttles CPU and disk
    // IO for the daemon AND the coding agent it spawns. On 2026-10-17 it made
    // a cold session scan take 184 s and warm ones up to 40 s, and every turn
    // the human is waiting on ran at background priority.
    '  <key>ProcessType</key>\n  <string>Standard</string>\n' +
    '  <key>StandardOutPath</key>\n  <string>' + xmlEscape(LOG_PATH) + '</string>\n' +
    '  <key>StandardErrorPath</key>\n  <string>' + xmlEscape(LOG_PATH) + '</string>\n' +
    '</dict>\n</plist>\n';
};

const systemdUnit = ({ workingDir }) => {
  const q = (s) => '"' + String(s).replace(/(["\\])/g, '\\$1') + '"';
  return '[Unit]\n' +
    'Description=OBTO Agent Bridge daemon\n' +
    'After=network-online.target\n' +
    'Wants=network-online.target\n\n' +
    '[Service]\n' +
    'Type=simple\n' +
    'ExecStart=' + q(process.execPath) + ' ' + q(BIN_PATH) + ' start\n' +
    'WorkingDirectory=' + workingDir + '\n' +
    'Environment=PATH=' + servicePath() + '\n' +
    'Environment=OBTO_BRIDGE_SERVICE=1\n' +
    (process.env.USER ? 'Environment=USER=' + process.env.USER + '\n' + 'Environment=LOGNAME=' + process.env.USER + '\n' : '') +
    'Restart=on-failure\n' +
    'RestartSec=30\n' +
    'StandardOutput=append:' + LOG_PATH + '\n' +
    'StandardError=append:' + LOG_PATH + '\n\n' +
    '[Install]\n' +
    'WantedBy=default.target\n';
};

// ─── macOS ────────────────────────────────────────────────────────────────
const launchdInstall = ({ workingDir }) => {
  fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
  fs.writeFileSync(PLIST_PATH, launchdPlist({ workingDir }), { mode: 0o644 });
  const domain = 'gui/' + uid();
  // Replace whatever is loaded (older plist, foreground-killed run, …).
  run('launchctl', ['bootout', domain + '/' + LABEL]);
  let r = run('launchctl', ['bootstrap', domain, PLIST_PATH]);
  if (r.status !== 0) {
    // Older launchctl grammar.
    run('launchctl', ['unload', '-w', PLIST_PATH]);
    r = run('launchctl', ['load', '-w', PLIST_PATH]);
  }
  if (r.status !== 0) {
    throw new Error('launchctl failed: ' + (r.stderr || r.stdout || ('exit ' + r.status)));
  }
  // KeepAlive{SuccessfulExit:false} does not start a job that is already
  // loaded-but-idle; kickstart makes "install" mean "running now".
  run('launchctl', ['kickstart', '-k', domain + '/' + LABEL]);
  return { path: PLIST_PATH, label: LABEL, domain };
};

const launchdUninstall = () => {
  const domain = 'gui/' + uid();
  run('launchctl', ['bootout', domain + '/' + LABEL]);
  run('launchctl', ['unload', '-w', PLIST_PATH]);
  let removed = false;
  try { fs.unlinkSync(PLIST_PATH); removed = true; } catch (_) {}
  return { path: PLIST_PATH, removed };
};

// {installed, loaded, pid, lastExitStatus, state}
const launchdState = () => {
  const out = { kind: 'launchd', path: PLIST_PATH, installed: fs.existsSync(PLIST_PATH), loaded: false, pid: null, lastExit: null, state: null };
  const r = run('launchctl', ['print', 'gui/' + uid() + '/' + LABEL]);
  if (r.status === 0) {
    out.loaded = true;
    const pid = r.stdout.match(/\bpid = (\d+)/);
    const st = r.stdout.match(/\bstate = ([a-z ]+)/);
    const ex = r.stdout.match(/last exit code = ([^\n]+)/);
    if (pid) out.pid = parseInt(pid[1], 10);
    if (st) out.state = st[1].trim();
    if (ex) out.lastExit = ex[1].trim();
  }
  return out;
};

// ─── Linux ────────────────────────────────────────────────────────────────
const systemdInstall = ({ workingDir }) => {
  fs.mkdirSync(path.dirname(UNIT_PATH), { recursive: true });
  fs.writeFileSync(UNIT_PATH, systemdUnit({ workingDir }), { mode: 0o644 });
  let r = run('systemctl', ['--user', 'daemon-reload']);
  if (r.status !== 0) throw new Error('systemctl --user daemon-reload failed: ' + (r.stderr || r.stdout));
  r = run('systemctl', ['--user', 'enable', '--now', UNIT + '.service']);
  if (r.status !== 0) throw new Error('systemctl --user enable --now failed: ' + (r.stderr || r.stdout));
  run('systemctl', ['--user', 'restart', UNIT + '.service']);
  return { path: UNIT_PATH, unit: UNIT + '.service' };
};

const systemdUninstall = () => {
  run('systemctl', ['--user', 'disable', '--now', UNIT + '.service']);
  let removed = false;
  try { fs.unlinkSync(UNIT_PATH); removed = true; } catch (_) {}
  run('systemctl', ['--user', 'daemon-reload']);
  return { path: UNIT_PATH, removed };
};

const systemdState = () => {
  const out = { kind: 'systemd', path: UNIT_PATH, installed: fs.existsSync(UNIT_PATH), loaded: false, pid: null, lastExit: null, state: null };
  const r = run('systemctl', ['--user', 'show', UNIT + '.service', '-p', 'ActiveState,SubState,MainPID,ExecMainStatus,Result']);
  if (r.status === 0 && r.stdout) {
    out.loaded = true;
    const kv = {};
    r.stdout.split('\n').forEach((l) => { const i = l.indexOf('='); if (i > 0) kv[l.slice(0, i)] = l.slice(i + 1); });
    out.state = (kv.ActiveState || '') + (kv.SubState ? ' (' + kv.SubState + ')' : '');
    if (kv.MainPID && kv.MainPID !== '0') out.pid = parseInt(kv.MainPID, 10);
    if (kv.ExecMainStatus) out.lastExit = kv.ExecMainStatus + (kv.Result ? ' ' + kv.Result : '');
  }
  return out;
};

// ─── Dispatch ─────────────────────────────────────────────────────────────
const platformKind = () => {
  if (process.platform === 'darwin') return 'launchd';
  if (process.platform === 'linux') return 'systemd';
  return null;
};

const install = (opts) => (platformKind() === 'launchd' ? launchdInstall(opts) : systemdInstall(opts));
const uninstall = () => (platformKind() === 'launchd' ? launchdUninstall() : systemdUninstall());
const state = () => {
  const k = platformKind();
  if (k === 'launchd') return launchdState();
  if (k === 'systemd') return systemdState();
  return { kind: null, installed: false, loaded: false, pid: null, state: null };
};

const readDaemonStatus = () => {
  try { return JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8')); } catch (_) { return null; }
};

const pidAlive = (pid) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
};

module.exports = {
  LABEL, UNIT, BIN_PATH, LOG_PATH, STATUS_PATH, PLIST_PATH, UNIT_PATH,
  platformKind, isEphemeralInstall, rotateLogIfLarge,
  install, uninstall, state, readDaemonStatus, pidAlive, execFileSync,
};
