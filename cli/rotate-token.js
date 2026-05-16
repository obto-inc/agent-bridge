'use strict';

// `obto-bridge rotate-token` — call POST /api/bridge/rotate-token with the
// current bearer token, update ~/.obto-bridge/config.json with the new one,
// keep a backup of the previous config at config.json.bak.<unix-ts>.

const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_PATH = path.join(os.homedir(), '.obto-bridge', 'config.json');

const main = async () => {
  let raw, cfg;
  try {
    raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    cfg = JSON.parse(raw);
  } catch (err) {
    console.error('error: no config at ' + CONFIG_PATH);
    console.error('Run `obto-bridge init` first.');
    process.exit(1);
  }
  if (!cfg.apiToken || !cfg.baseUrl) {
    console.error('error: config is missing apiToken or baseUrl. Re-run `obto-bridge init`.');
    process.exit(1);
  }

  const url = cfg.baseUrl.replace(/\/$/, '') + '/api/bridge/rotate-token';
  console.log('Rotating token at ' + url + ' ...');

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'OBTO-ORIGIN-HOST': cfg.originHost || 'ob-agent-bridge.obto.co',
        Authorization: 'Bearer ' + cfg.apiToken,
      },
      body: '{}',
      cache: 'no-store',
    });
  } catch (err) {
    console.error('error: cannot reach the server: ' + (err && err.message ? err.message : err));
    process.exit(2);
  }

  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch (_) { parsed = { _rawBody: text }; }

  if (!res.ok || !parsed || !parsed.ok || !parsed.apiToken) {
    console.error('HTTP ' + res.status + ' — rotation failed');
    if (parsed && parsed.error) console.error('  ' + parsed.error);
    if (res.status === 401) {
      console.error('Your current API token is invalid. Email support@obto.co.');
    }
    process.exit(3);
  }

  // Backup, then atomic-rewrite the config with the new token.
  const newCfg = Object.assign({}, cfg, { apiToken: parsed.apiToken });
  const backup = CONFIG_PATH + '.bak.' + Math.floor(Date.now() / 1000);
  try {
    fs.writeFileSync(backup, raw, { mode: 0o600 });
    const tmp = CONFIG_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(newCfg, null, 2), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, CONFIG_PATH);
  } catch (err) {
    console.error('error: rotated successfully on the server but local config update failed:');
    console.error('  ' + (err && err.message ? err.message : err));
    console.error('  Save this new token manually before exiting:');
    console.error('  ' + parsed.apiToken);
    process.exit(4);
  }

  console.log('✓ Token rotated. Previous config backed up to:');
  console.log('  ' + backup);
  console.log('');
  console.log('If the daemon is running, restart it to pick up the new token.');
};

main().catch((err) => {
  console.error('rotate-token failed: ' + (err && err.message ? err.message : err));
  process.exit(1);
});
