'use strict';

// `obto-bridge browser enable|disable|status` — DZ-B1 B1-3.
//
// Turns browser control on or off for THIS machine. Off by default. When on,
// the daemon advertises the `browser` capability on its next connect and
// answers browser commands from the OBTO agent (ping/echo in this release;
// the browser driver arrives in a later release). The flag lives in
// ~/.obto-bridge/config.json; restart the daemon for it to take effect.

const fs = require('fs');
const { CONFIG_PATH } = require('../src/config');

const sub = process.argv[3] || 'status';

const readFile = () => {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (_) { return null; }
};

const file = readFile();
if (!file) {
  console.error('obto-bridge: no config at ' + CONFIG_PATH + '. Run `obto-bridge init` first.');
  process.exit(1);
}

const restartHint = () => {
  console.log('Restart the daemon for this to take effect:');
  console.log('  obto-bridge uninstall-service && obto-bridge install-service   (background service)');
  console.log('  or stop and re-run `obto-bridge start`                         (foreground)');
};

if (sub === 'status') {
  console.log('Browser control on this machine: ' + (file.browser === true ? 'ON' : 'off'));
  process.exit(0);
}

if (sub !== 'enable' && sub !== 'disable') {
  console.error('Usage: obto-bridge browser enable | disable | status');
  process.exit(2);
}

const want = sub === 'enable';
if ((file.browser === true) === want) {
  console.log('Browser control is already ' + (want ? 'ON' : 'off') + ' on this machine.');
  process.exit(0);
}
file.browser = want;
fs.writeFileSync(CONFIG_PATH, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
console.log('Browser control ' + (want ? 'enabled' : 'disabled') + ' on this machine.');
if (want) {
  console.log('The OBTO agent can now send browser commands to this machine. Every site and every');
  console.log('action that changes something will still ask you first (from the browser release on).');
}
restartHint();
