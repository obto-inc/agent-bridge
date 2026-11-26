'use strict';

// `obto-bridge browser extension install|uninstall|status|path` — DZ-B1 B1-6.
//
// Links the OBTO Chrome extension in your everyday browser to this machine's
// bridge daemon through Chrome Native Messaging. `install` writes a small host
// manifest (only the OBTO extension id may start the host) into each Chromium
// browser's NativeMessagingHosts folder, plus a launcher script in
// ~/.obto-bridge. No port is opened and no token is copied.

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOST = 'co.obto.bridge';
const ROOT = path.join(__dirname, '..');
const EXT_DIR = path.join(ROOT, 'extension');
const EXT_ID = fs.readFileSync(path.join(EXT_DIR, 'EXTENSION_ID'), 'utf8').trim();
const BASE = path.join(os.homedir(), '.obto-bridge');
const LAUNCHER = path.join(BASE, 'native-host.sh');

const hostDirs = () => {
  const h = os.homedir();
  if (process.platform === 'darwin') {
    const s = path.join(h, 'Library', 'Application Support');
    return [
      ['Google Chrome', path.join(s, 'Google', 'Chrome')],
      ['Chrome for Testing', path.join(s, 'Google', 'Chrome for Testing')],
      ['Chrome Beta', path.join(s, 'Google', 'Chrome Beta')],
      ['Chromium', path.join(s, 'Chromium')],
      ['Brave', path.join(s, 'BraveSoftware', 'Brave-Browser')],
      ['Microsoft Edge', path.join(s, 'Microsoft Edge')],
    ];
  }
  if (process.platform === 'linux') {
    const c = path.join(h, '.config');
    return [
      ['Google Chrome', path.join(c, 'google-chrome')],
      ['Chromium', path.join(c, 'chromium')],
      ['Brave', path.join(c, 'BraveSoftware', 'Brave-Browser')],
      ['Microsoft Edge', path.join(c, 'microsoft-edge')],
    ];
  }
  return [];
};

const manifestFor = () => ({
  name: HOST,
  description: 'OBTO bridge: links the OBTO agent extension to the bridge daemon on this computer',
  path: LAUNCHER,
  type: 'stdio',
  allowed_origins: ['chrome-extension://' + EXT_ID + '/'],
});

const sub = process.argv[4] || 'status';

if (process.platform === 'win32') {
  console.error('The browser extension link is not available on Windows yet.');
  process.exit(1);
}

if (sub === 'path') {
  console.log(EXT_DIR);
  process.exit(0);
}

if (sub === 'install') {
  fs.mkdirSync(BASE, { recursive: true, mode: 0o700 });
  const hostJs = path.join(ROOT, 'bin', 'obto-bridge-native-host.js');
  fs.writeFileSync(LAUNCHER, '#!/bin/sh\nexec "' + process.execPath + '" "' + hostJs + '" "$@"\n', { mode: 0o755 });
  fs.chmodSync(LAUNCHER, 0o755);
  const done = [];
  for (const [name, dir] of hostDirs()) {
    if (!fs.existsSync(dir)) continue; // browser not installed
    const d = path.join(dir, 'NativeMessagingHosts');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, HOST + '.json'), JSON.stringify(manifestFor(), null, 2) + '\n');
    done.push(name);
  }
  console.log('Linked for: ' + (done.length ? done.join(', ') : 'no Chromium browser found'));
  console.log('Next, once: open chrome://extensions, turn on Developer mode, click "Load unpacked" and pick');
  console.log('  ' + EXT_DIR);
  console.log('The extension id must be ' + EXT_ID + '. The badge shows ON when it is linked to the daemon.');
  process.exit(0);
}

if (sub === 'uninstall') {
  for (const [, dir] of hostDirs()) {
    try { fs.unlinkSync(path.join(dir, 'NativeMessagingHosts', HOST + '.json')); } catch (_) {}
  }
  try { fs.unlinkSync(LAUNCHER); } catch (_) {}
  console.log('Extension link removed. Remove the extension itself from chrome://extensions.');
  process.exit(0);
}

if (sub === 'status') {
  const linked = hostDirs().filter(([, dir]) => fs.existsSync(path.join(dir, 'NativeMessagingHosts', HOST + '.json'))).map(([n]) => n);
  console.log('Extension id: ' + EXT_ID);
  console.log('Host linked for: ' + (linked.length ? linked.join(', ') : 'none (run: obto-bridge browser extension install)'));
  console.log('Extension folder: ' + EXT_DIR);
  process.exit(0);
}

console.error('Usage: obto-bridge browser extension install | uninstall | status | path');
process.exit(2);
