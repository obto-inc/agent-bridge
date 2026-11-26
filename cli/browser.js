'use strict';

// `obto-bridge browser enable|disable|status|allow|deny|grants` — DZ-B1 B1-3/B1-4.
//
// Turns browser control on or off for THIS machine. Off by default. When on,
// the daemon advertises the `browser` capability on its next connect and
// answers browser commands from the OBTO agent in a dedicated, visible Chrome
// window. Every site needs its own grant: `read` (open and read pages) or
// `act` (also click and type). The flag lives in ~/.obto-bridge/config.json;
// restart the daemon after enable/disable. Grants take effect at once.

const fs = require('fs');
const { CONFIG_PATH } = require('../src/config');
const { siteFromInput } = require('../src/browser-guards');

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

const save = () => fs.writeFileSync(CONFIG_PATH, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
const grants = () => (file.browserGrants && typeof file.browserGrants === 'object' ? file.browserGrants : {});
const printGrants = () => {
  const g = grants();
  const sites = Object.keys(g).sort();
  if (!sites.length) console.log('No site grants yet. Add one: obto-bridge browser allow <site> [read|act]');
  sites.forEach((s) => console.log('  ' + s.padEnd(32) + g[s]));
};

if (sub === 'status') {
  console.log('Browser control on this machine: ' + (file.browser === true ? 'ON' : 'off'));
  console.log('Agent browser: ' + (file.browserTarget === 'profile' ? 'profile (OBTO window)' : 'auto (your Chrome via the extension when linked)'));
  console.log('DevZone site grants: ' + (file.browserRemoteGrants === false ? 'off' : 'on'));
  printGrants();
  process.exit(0);
}

if (sub === 'grants') { printGrants(); process.exit(0); }

// DZ-B1 B1-6: the OBTO extension in your everyday Chrome.
if (sub === 'extension') { require('./browser-extension'); return; }

// Which browser the agent drives: auto (the extension when it is linked, else the
// OBTO profile window) or profile (always the OBTO profile window).
if (sub === 'use') {
  const v = (process.argv[4] || '').toLowerCase();
  if (v !== 'auto' && v !== 'profile') {
    console.log('Agent browser: ' + (file.browserTarget === 'profile' ? 'profile (OBTO window)' : 'auto (your Chrome via the extension when linked)'));
    console.log('Change: obto-bridge browser use auto | profile');
    process.exit(0);
  }
  file.browserTarget = v;
  save();
  console.log(v === 'profile' ? 'The agent uses the separate OBTO Chrome window.' : 'The agent uses your Chrome (OBTO agent tab group) when the extension is linked.');
  process.exit(0);
}

// DZ-B1 B1-5: site grants the user approves on a DevZone card. On by default.
if (sub === 'remote-grants') {
  const v = (process.argv[4] || '').toLowerCase();
  if (v !== 'on' && v !== 'off') {
    console.log('DevZone site grants on this machine: ' + (file.browserRemoteGrants === false ? 'off' : 'on'));
    console.log('Change: obto-bridge browser remote-grants on | off');
    process.exit(0);
  }
  file.browserRemoteGrants = v === 'on';
  save();
  console.log(v === 'on'
    ? 'DevZone approval cards can add site grants on this machine.'
    : 'Site grants now come only from this CLI (obto-bridge browser allow).');
  process.exit(0);
}

if (sub === 'allow' || sub === 'deny') {
  const site = siteFromInput(process.argv[4]);
  if (!site) {
    console.error('Usage: obto-bridge browser ' + sub + ' <site or URL>' + (sub === 'allow' ? ' [read|act]' : ''));
    process.exit(2);
  }
  const g = Object.assign({}, grants());
  if (sub === 'deny') {
    delete g[site];
    console.log('Removed the grant for ' + site + '.');
  } else {
    const level = (process.argv[5] || 'read').toLowerCase();
    if (level !== 'read' && level !== 'act') { console.error('Level must be read or act.'); process.exit(2); }
    g[site] = level;
    console.log(site + ': ' + level + (level === 'act'
      ? ' (open, read, click and type; never passwords, payment or one-time codes).'
      : ' (open and read pages; no clicks or typing).'));
  }
  file.browserGrants = g;
  save();
  process.exit(0);
}

if (sub !== 'enable' && sub !== 'disable') {
  console.error('Usage: obto-bridge browser enable | disable | status | allow <site> [read|act] | deny <site> | grants | remote-grants on|off | use auto|profile | extension install|status|path');
  process.exit(2);
}

const want = sub === 'enable';
if ((file.browser === true) === want) {
  console.log('Browser control is already ' + (want ? 'ON' : 'off') + ' on this machine.');
  process.exit(0);
}
file.browser = want;
save();
console.log('Browser control ' + (want ? 'enabled' : 'disabled') + ' on this machine.');
if (want) {
  console.log('The OBTO agent can now drive a separate OBTO Chrome window on this machine, only on');
  console.log('sites you grant: obto-bridge browser allow <site> [read|act]. Sign in to sites in that');
  console.log('window yourself; the agent never types passwords, payment details or one-time codes.');
}
restartHint();
