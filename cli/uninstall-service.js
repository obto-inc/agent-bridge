'use strict';

// `obto-bridge uninstall-service` — stop the background daemon and remove
// the launchd plist / systemd unit. Config and logs stay.

const svc = require('../src/service');

const kind = svc.platformKind();
if (!kind) {
  console.error('error: no service manager supported on ' + process.platform + '.');
  process.exit(1);
}
const r = svc.uninstall();
console.log((r.removed ? '✓ service removed: ' : '· nothing installed at: ') + r.path);
console.log('  Config at ~/.obto-bridge/config.json and the log were left in place.');
