'use strict';

// `obto-bridge logout` — wipe ~/.obto-bridge/config.json.
// Does NOT touch ~/.agent-bridge-daemon/ (your thread→session bindings stay,
// in case you log back into the same account).

const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_PATH = path.join(os.homedir(), '.obto-bridge', 'config.json');

try {
  fs.unlinkSync(CONFIG_PATH);
  console.log('✓ Removed ' + CONFIG_PATH);
} catch (err) {
  if (err && err.code === 'ENOENT') {
    console.log('No config to remove (' + CONFIG_PATH + ' did not exist).');
  } else {
    console.error('logout failed: ' + (err && err.message ? err.message : err));
    process.exit(1);
  }
}
