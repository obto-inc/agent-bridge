'use strict';

// `obto-bridge install-service` — run the daemon in the background and start
// it at login. macOS → launchd LaunchAgent; Linux → systemd --user unit.
// Idempotent: re-running rewrites the unit and restarts the daemon (use it
// after `init --link` to pick up a new token).

const path = require('path');
const svc = require('../src/service');
const { loadConfig, CONFIG_PATH } = require('../src/config');

const main = () => {
  const kind = svc.platformKind();
  if (!kind) {
    console.error('error: install-service supports macOS (launchd) and Linux (systemd --user) only.');
    console.error('  On ' + process.platform + ' run `obto-bridge start` under your own supervisor (pm2, NSSM, Task Scheduler).');
    process.exit(1);
  }

  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    console.error('error: ' + (err && err.message ? err.message : err));
    console.error('  Run `obto-bridge init --link <LNK-…>` first (code from app.obto.co → account home → Agent Bridge).');
    process.exit(1);
  }

  if (svc.isEphemeralInstall()) {
    console.error('error: this copy of obto-bridge runs from the npx cache (' + svc.BIN_PATH + ').');
    console.error('  A service pointing there dies on the next cache prune. Install it for real, then retry:');
    console.error('    npm install -g @obtoai/agent-bridge && obto-bridge install-service');
    process.exit(1);
  }

  const workingDir = cfg.projectDir || process.cwd();
  const rotated = svc.rotateLogIfLarge();

  let r;
  try {
    r = svc.install({ workingDir });
  } catch (err) {
    console.error('error: ' + (err && err.message ? err.message : err));
    if (kind === 'systemd') {
      console.error('  If this is a headless box, user services need lingering:  loginctl enable-linger ' + (process.env.USER || '$USER'));
    }
    process.exit(1);
  }

  console.log('✓ service installed (' + kind + ')');
  console.log('  Unit:     ' + r.path);
  console.log('  Runs:     ' + process.execPath + ' ' + svc.BIN_PATH + ' start');
  console.log('  Cwd:      ' + workingDir);
  console.log('  Log:      ' + svc.LOG_PATH + (rotated ? '  (previous log kept as daemon.log.1)' : ''));
  console.log('  Config:   ' + CONFIG_PATH + '  (machine "' + cfg.agentId + '", discovery ' + cfg.discovery + ')');
  console.log('  Restarts: on crash only (30 s throttle). A revoked token (401/402/403) STOPS the');
  console.log('            daemon with the fix in the log — re-link, then run install-service again.');
  console.log('');
  console.log('Check:  obto-bridge status');
  console.log('Logs:   tail -f ' + svc.LOG_PATH);
  console.log('Remove: obto-bridge uninstall-service');
  if (kind === 'systemd') {
    console.log('Note:   to keep it running while logged out:  loginctl enable-linger ' + (process.env.USER || '$USER'));
  }
};

main();
