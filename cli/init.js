'use strict';

// `obto-bridge init` — interactive setup wizard. Prompts for credentials,
// writes ~/.obto-bridge/config.json with mode 0600, then validates the token
// against the server via GET /api/bridge/whoami so the user knows immediately
// if anything is wrong.

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const CONFIG_DIR = path.join(os.homedir(), '.obto-bridge');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

const DEFAULTS = {
  baseUrl: 'https://agent-bridge.obto.co',
  originHost: 'agent-bridge.obto.co',
  relayPermissions: true,
};

const loadExisting = () => {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch (_) { return {}; }
};

const ask = (rl, prompt, def) =>
  new Promise((resolve) => {
    const suffix = def
      ? ' [' + (typeof def === 'string' && def.length > 30 ? def.slice(0, 8) + '…' : def) + ']'
      : '';
    rl.question(prompt + suffix + ': ', (answer) => {
      const v = answer.trim();
      resolve(v || (def != null ? def : ''));
    });
  });

const validateAgainstServer = async (cfg) => {
  const url = cfg.baseUrl.replace(/\/$/, '') + '/api/bridge/whoami';
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'OBTO-ORIGIN-HOST': cfg.originHost,
      Authorization: 'Bearer ' + cfg.apiToken,
    },
    cache: 'no-store',
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch (_) { parsed = { _rawBody: text }; }
  return { status: res.status, ok: res.ok, parsed };
};

const main = async () => {
  console.log('OBTO Agent Bridge — setup');
  console.log('-------------------------');
  console.log('Need credentials? Email support@obto.co for an invite.');
  console.log('Config will be written to: ' + CONFIG_PATH);
  console.log('');

  const existing = loadExisting();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // Server base URL and OBTO-ORIGIN-HOST are constants of the platform, not
  // per-user config — every daemon talks to the same bridge app. They are no
  // longer prompted. Advanced / self-hosted users can still override them via
  // the BRIDGE_BASE_URL / BRIDGE_ORIGIN_HOST env vars or by editing config.json.
  const baseUrl    = process.env.BRIDGE_BASE_URL    || existing.baseUrl    || DEFAULTS.baseUrl;
  const originHost = process.env.BRIDGE_ORIGIN_HOST || existing.originHost || DEFAULTS.originHost;
  const accountId  = await ask(rl, 'Account ID (acc_…)',       existing.accountId  || '');
  const apiToken   = await ask(rl, 'API token (obto_…)',       existing.apiToken   || '');
  const agentId    = await ask(rl, 'Agent name (e.g. my-mac)', existing.agentId    || os.hostname().split('.')[0] || 'unnamed-agent');
  const projectDir = await ask(rl, 'Project working dir',      existing.projectDir || process.cwd());
  const agentAns   = await ask(rl, 'Coding agent — claude or codex', existing.agent || 'claude');
  const agent      = String(agentAns).trim().toLowerCase() === 'codex' ? 'codex' : 'claude';
  const relayAns   = await ask(rl, 'Relay permission requests via bridge? (y/n)', existing.relayPermissions !== false ? 'y' : 'n');
  const relayPermissions = String(relayAns).toLowerCase().startsWith('y');

  rl.close();

  if (!accountId || !apiToken) {
    console.error('\nerror: accountId and apiToken are both required.');
    process.exit(1);
  }
  if (!/^acc_[a-z0-9]+$/i.test(accountId)) {
    console.error('\nerror: accountId should look like "acc_xxxxxxxxxxxx".');
    process.exit(1);
  }
  if (!/^obto_[a-z0-9]+$/i.test(apiToken)) {
    console.error('\nerror: apiToken should look like "obto_xxxxxxxxxxxx".');
    process.exit(1);
  }

  const cfg = {
    baseUrl,
    originHost,
    accountId,
    apiToken,
    agentId,
    agent,
    projectDir: path.resolve(projectDir),
    relayPermissions,
  };

  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    fs.chmodSync(CONFIG_PATH, 0o600);
  } catch (err) {
    console.error('error: failed to write config: ' + (err && err.message ? err.message : err));
    process.exit(1);
  }

  console.log('');
  console.log('✓ Config saved to ' + CONFIG_PATH);

  // Validate against the server. Non-fatal on network failure — user might be
  // offline. Fatal on 401/403 (wrong creds) so they fix it now.
  console.log('  Verifying credentials with ' + baseUrl + ' ...');
  let result;
  try {
    result = await validateAgainstServer(cfg);
  } catch (err) {
    console.warn('  ⚠ could not reach the server: ' + (err && err.message ? err.message : err));
    console.warn('    Config is saved; run `obto-bridge whoami` once you have a network.');
    console.log('');
    console.log('Next:  obto-bridge start');
    return;
  }

  if (result.ok && result.parsed && result.parsed.account) {
    const a = result.parsed.account;
    console.log('  ✓ Authenticated as @' + a.basicAuthUser + ' (' + a.accountId + ', status: ' + a.status + ')');
    console.log('');
    console.log('Next:  obto-bridge start');
    return;
  }

  if (result.status === 401) {
    console.error('  ✗ Server rejected the API token (HTTP 401). Double-check that you pasted the full token from your invite email.');
    process.exit(2);
  }
  if (result.status === 403) {
    console.error('  ✗ Account is suspended (HTTP 403). Contact support@obto.co.');
    process.exit(2);
  }
  console.error('  ✗ Validation failed: HTTP ' + result.status);
  if (result.parsed && result.parsed.error) console.error('    ' + result.parsed.error);
  console.error('    Config is saved at ' + CONFIG_PATH + '; edit it manually or rerun `obto-bridge init`.');
  process.exit(2);
};

main().catch((err) => {
  console.error('init failed: ' + (err && err.message ? err.message : err));
  process.exit(1);
});
