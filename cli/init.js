'use strict';

// `obto-bridge init` — interactive setup wizard.
//
// Default (>=0.1.0-beta.7): self-serve registration. Email is the only
// required input; username is derived from the email's local part, and a
// strong password is auto-generated and shown once. Posts to
// /api/bridge/register, saves the returned API token to
// ~/.obto-bridge/config.json (mode 0600).
//
// Overrides:
//   --username <name>    Use this instead of the derived username.
//   --password <pwd>     Use this instead of an auto-generated password.
//   --token <obto_…>     Skip registration entirely; paste an existing token.
//   --account <acc_…>    Pair with --token for paste-in mode.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const readline = require('readline');

const CONFIG_DIR = path.join(os.homedir(), '.obto-bridge');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

const DEFAULTS = {
  baseUrl: 'https://agent-bridge.obto.co',
  originHost: 'agent-bridge.obto.co',
  relayPermissions: true,
};

// argv after `obto-bridge init`.
const argv = process.argv.slice(3);
const flagValue = (name) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};
const cliToken = flagValue('--token');
const cliAccount = flagValue('--account');
const cliUsername = flagValue('--username');
const cliPassword = flagValue('--password');

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

// Derive a basicAuthUser-shaped username from email's local part. Mirrors
// the server-side derivation in registerSubmit so the username we sign in
// with matches what we display to the user inline.
const deriveUsername = (email) => {
  const local = String(email || '').split('@')[0].toLowerCase();
  let u = local.replace(/[^a-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  if (u.length < 3) u = 'user-' + crypto.randomBytes(3).toString('hex');
  return u;
};

// 12-char password, no ambiguous chars (0/O, 1/l/I), grouped as 4-4-4
// for readability and easy copy-paste. Backed by crypto.randomBytes.
const generatePassword = () => {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = crypto.randomBytes(12);
  let out = '';
  for (let i = 0; i < 12; i++) out += chars[bytes[i] % chars.length];
  return out.slice(0, 4) + '-' + out.slice(4, 8) + '-' + out.slice(8, 12);
};

const registerSelfServe = async ({ baseUrl, originHost, email, username, password }) => {
  const url = baseUrl.replace(/\/$/, '') + '/api/bridge/register';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'OBTO-ORIGIN-HOST': originHost,
    },
    body: new URLSearchParams({ email, username, password }).toString(),
    cache: 'no-store',
    redirect: 'manual',
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = { _rawBody: text }; }
  return { status: res.status, ok: res.ok, data };
};

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
  console.log('Config will be written to: ' + CONFIG_PATH);
  console.log('');

  const existing = loadExisting();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const baseUrl    = process.env.BRIDGE_BASE_URL    || existing.baseUrl    || DEFAULTS.baseUrl;
  const originHost = process.env.BRIDGE_ORIGIN_HOST || existing.originHost || DEFAULTS.originHost;

  let accountId = existing.accountId || '';
  let apiToken = existing.apiToken || '';

  // Pick the credential path. Precedence:
  //   1. --token + --account flags (machine paste-in, scripted).
  //   2. Existing config from a prior init.
  //   3. Self-serve registration via /api/bridge/register (default).
  const haveCliPaste = !!(cliToken && cliAccount);
  const haveExisting = !!(existing.accountId && existing.apiToken);

  let registeredUser = '';
  let registeredPassword = '';

  if (haveCliPaste) {
    apiToken = cliToken;
    accountId = cliAccount;
    console.log('Using credentials from --token / --account flags.');
    console.log('');
  } else if (haveExisting) {
    console.log('Existing config found:');
    console.log('  Account: ' + existing.accountId);
    console.log('  Token:   ' + (existing.apiToken || '').slice(0, 10) + '…');
    console.log('Reusing those credentials. To re-register from scratch, remove ' + CONFIG_PATH + ' first.');
    console.log('');
  } else {
    console.log('Create a free account (no card needed):');
    const email = await ask(rl, '  Email', '');
    if (!email || email.indexOf('@') === -1) {
      console.error('error: a valid email is required.');
      rl.close();
      process.exit(1);
    }
    const username = cliUsername || deriveUsername(email);
    const password = cliPassword || generatePassword();
    console.log('');
    console.log('  Username: ' + username + (cliUsername ? '' : '   (derived from email)'));
    if (!cliPassword) {
      console.log('  Password: ' + password + '   (auto-generated)');
      console.log('');
      console.log('  ⚠ SAVE THIS PASSWORD — you will need it to sign in to the web UI.');
      console.log('    It is shown once here and never again. Reset later from your account page.');
    }
    console.log('');
    console.log('Creating account at ' + baseUrl + ' ...');
    let r;
    try {
      r = await registerSelfServe({ baseUrl, originHost, email, username, password });
    } catch (e) {
      console.error('error: registration request failed: ' + (e && e.message ? e.message : e));
      console.error('       (network problem? you can also paste an existing token via:');
      console.error('        `obto-bridge init --token <obto_…> --account <acc_…>`)');
      rl.close();
      process.exit(1);
    }
    if (!r.ok || !r.data || !r.data.ok) {
      const msg = (r.data && (r.data.error || r.data._rawBody)) || ('HTTP ' + r.status);
      console.error('error: registration rejected: ' + msg);
      console.error('       (username taken? rerun with `obto-bridge init --username <different>`)');
      rl.close();
      process.exit(1);
    }
    accountId = r.data.accountId;
    apiToken = r.data.apiToken;
    registeredUser = r.data.basicAuthUser || username;
    registeredPassword = password;
    console.log('  ✓ Free account created.');
    console.log('    Account: ' + accountId);
    console.log('    Username: ' + registeredUser + '   (sign in with this exact string — no @)');
    console.log('    Plan:    ' + (r.data.plan || 'free'));
    console.log('');
  }

  const agentId    = await ask(rl, 'Agent name (e.g. my-mac)', existing.agentId || os.hostname().split('.')[0] || 'unnamed-agent');
  const projectDir = await ask(rl, 'Project working dir',      existing.projectDir || process.cwd());
  const agentAns   = await ask(rl, 'Coding agent fallback — claude / codex / opencode', existing.agent || 'claude');
  const agentLow   = String(agentAns).trim().toLowerCase();
  const agent      = ['claude', 'codex', 'opencode'].indexOf(agentLow) !== -1 ? agentLow : 'claude';
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
    console.log('  ✓ Authenticated as ' + a.basicAuthUser + ' (' + a.accountId + ', status: ' + a.status + ')');
    console.log('');
    // The OBTO platform's root URL bounces unauthenticated users to /login.bto;
    // /api/view is the canonical bridge entry point that serves either the
    // sign-in form (unauthenticated) or the threads UI (authenticated).
    const signInUrl = baseUrl.replace(/\/$/, '') + '/api/view';
    console.log('Sign in at ' + signInUrl + ' as ' + a.basicAuthUser + (registeredPassword ? ' (password above)' : '') + '.');
    console.log('Run:    obto-bridge start');
    return;
  }

  if (result.status === 401) {
    console.error('  ✗ Server rejected the API token (HTTP 401). Re-run `obto-bridge init` to reset.');
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
