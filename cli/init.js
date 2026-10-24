'use strict';

// `obto-bridge init` — setup.
//
// Paths, in precedence order:
//
//   1. --link <LNK-…>      (>=0.1.0-beta.28, One Thread OT-7b) Trade a one-time
//                          link code issued from your OBTO account home
//                          (Agent Bridge → Enable / Add another machine) for an
//                          API token bound to your OBTO identity. Non-interactive:
//                          no email, no password, no prompts. Exchange endpoint:
//                          POST https://app.obto.co/api/bridge/link/exchange.
//   2. --token + --account Paste an existing token (scripted / headless).
//   3. --register          Email → /api/bridge/register (legacy bridge-only
//                          account, not linked to an OBTO login). Also used when
//                          an existing config is found and --reuse is passed.
//   4. (default)           Device sign-in (One Thread OT-7c, RFC 8628 shape):
//                          POST /api/bridge/device/start → open the browser at
//                          https://app.obto.co/api/bridge/device?user_code=…, the
//                          user signs in to OBTO and approves the machine, the CLI
//                          polls POST /api/bridge/device/token and stores the same
//                          credential --link would. `obto-bridge login` = this path.
//
// Other flags:
//   --username <name>      (register) Use this instead of the derived username.
//   --password <pwd>       (register) Use this instead of an auto-generated one.
//   --agent-id <name>      Machine name shown in the UI (default: hostname).
//   --project-dir <path>   Directory the daemon drives agents in (default: cwd).
//   --discovery <level>    'metadata' (default) | 'full' — what the local
//                          session scanner sends to the bridge. See README.
//   --link-url <url>       Override the exchange endpoint (self-hosted).
//   --device-url <url>     Override the device sign-in base (default
//                          https://app.obto.co/api/bridge/device).
//   --no-browser           Device sign-in: print the URL, do not open a browser.
//   --reuse                Keep the credentials already in config.json (old
//                          interactive setup) instead of signing in again.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const readline = require('readline');
const { agentIdHeader } = require('../src/config');

const CONFIG_DIR = path.join(os.homedir(), '.obto-bridge');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

const DEFAULTS = {
  baseUrl: 'https://agent-bridge.obto.co',
  originHost: 'agent-bridge.obto.co',
  linkUrl: 'https://app.obto.co/api/bridge/link/exchange',
  deviceUrl: 'https://app.obto.co/api/bridge/device',
  relayPermissions: true,
  discovery: 'metadata',
};

const DISCOVERY_LEVELS = ['metadata', 'full'];

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
const cliLink = flagValue('--link');
const cliLinkUrl = flagValue('--link-url');
const cliAgentId = flagValue('--agent-id');
const cliProjectDir = flagValue('--project-dir');
const cliDiscovery = flagValue('--discovery');
const cliDeviceUrl = flagValue('--device-url');
const hasFlag = (name) => argv.indexOf(name) !== -1;

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

const parseJsonLoose = (text) => {
  try { return JSON.parse(text); } catch (_) { return { _rawBody: text }; }
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
  return { status: res.status, ok: res.ok, data: parseJsonLoose(text) };
};

// One Thread OT-7b — trade a one-time link code for a token. The code IS the
// credential (one exchange per code, ever), so no bearer header is sent.
const PKG_VERSION = (() => { try { return require('../package.json').version; } catch (_) { return null; } })();

const exchangeLinkCode = async ({ linkUrl, code, agentId }) => {
  const res = await fetch(linkUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    // beta.36 — per-machine tokens: the token is minted for this machine only.
    body: JSON.stringify({
      code,
      agentId,
      machine: { hostname: os.hostname(), platform: os.platform() + ' ' + os.arch(), clientVersion: PKG_VERSION },
    }),
    cache: 'no-store',
    redirect: 'manual',
  });
  const text = await res.text();
  return { status: res.status, ok: res.ok, data: parseJsonLoose(text) };
};

const validateAgainstServer = async (cfg) => {
  const url = cfg.baseUrl.replace(/\/$/, '') + '/api/bridge/whoami';
  const res = await fetch(url, {
    method: 'GET',
    headers: Object.assign({
      Accept: 'application/json',
      'OBTO-ORIGIN-HOST': cfg.originHost,
      Authorization: 'Bearer ' + cfg.apiToken,
    }, agentIdHeader(cfg.agentId)),
    cache: 'no-store',
  });
  const text = await res.text();
  return { status: res.status, ok: res.ok, parsed: parseJsonLoose(text) };
};

const normalizeDiscovery = (raw, fallback) => {
  const v = String(raw || '').trim().toLowerCase();
  if (DISCOVERY_LEVELS.indexOf(v) !== -1) return v;
  return fallback;
};

const writeConfig = (cfg, existing) => {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  // Keep the previous file when we are about to overwrite a token — the
  // same pattern rotate-token uses. Never printed, mode 0600.
  if (existing && existing.apiToken && existing.apiToken !== cfg.apiToken) {
    try {
      fs.copyFileSync(CONFIG_PATH, CONFIG_PATH + '.bak.' + Math.floor(Date.now() / 1000));
    } catch (_) {}
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.chmodSync(CONFIG_PATH, 0o600);
};

const LINK_FIX =
  '  Issue a fresh code: app.obto.co → account home → Agent Bridge → "Add another machine",\n' +
  '  then run:  npx @obtoai/agent-bridge@latest init --link <LNK-…>';

const DEVICE_FIX =
  '  Run `npx @obtoai/agent-bridge@latest init` again for a new sign-in code.';

// Machine settings shared by the --link and device paths. Exits on a bad
// --discovery value.
const machineContext = (existing) => {
  const agentId = cliAgentId || process.env.AGENT_ID || existing.agentId ||
    os.hostname().split('.')[0] || 'unnamed-agent';
  const projectDir = path.resolve(
    cliProjectDir || process.env.BRIDGE_PROJECT_DIR || existing.projectDir || process.cwd(),
  );
  const agent = ['claude', 'codex', 'opencode'].indexOf(String(existing.agent || '').toLowerCase()) !== -1
    ? String(existing.agent).toLowerCase()
    : 'claude';
  const relayPermissions = existing.relayPermissions !== undefined
    ? !!existing.relayPermissions
    : DEFAULTS.relayPermissions;
  if (cliDiscovery && normalizeDiscovery(cliDiscovery, null) === null) {
    console.error('error: --discovery must be one of: ' + DISCOVERY_LEVELS.join(', '));
    process.exit(1);
  }
  const discovery = normalizeDiscovery(
    cliDiscovery || process.env.BRIDGE_DISCOVERY,
    normalizeDiscovery(existing.discovery, DEFAULTS.discovery),
  );
  return {
    baseUrl:    process.env.BRIDGE_BASE_URL    || existing.baseUrl    || DEFAULTS.baseUrl,
    originHost: process.env.BRIDGE_ORIGIN_HOST || existing.originHost || DEFAULTS.originHost,
    linkUrl:    cliLinkUrl || process.env.BRIDGE_LINK_URL || existing.linkUrl || DEFAULTS.linkUrl,
    agentId,
    projectDir,
    agent,
    relayPermissions,
    discovery,
  };
};

// Store a credential returned by link/exchange or device/token (same body),
// print what it linked to, verify it against the bridge. `fix` = what to run
// when the response is unusable.
const saveLinked = async (d, ctx, existing, fix, extra) => {
  if (!/^acc_[a-z0-9]+$/i.test(d.accountId || '') || !/^obto_[a-z0-9]+$/i.test(d.apiToken || '')) {
    console.error('error: unexpected credential shape in the server response. Not saving.');
    console.error(fix);
    process.exit(3);
  }

  const cfg = Object.assign({}, existing, {
    baseUrl: ctx.baseUrl,
    originHost: ctx.originHost,
    linkUrl: ctx.linkUrl,
    accountId: d.accountId,
    apiToken: d.apiToken,
    agentId: ctx.agentId,
    agent: ctx.agent,
    projectDir: ctx.projectDir,
    relayPermissions: ctx.relayPermissions,
    discovery: ctx.discovery,
    tenant: d.tenant || null,
    linkedAt: new Date().toISOString(),
  }, extra || {});

  try {
    writeConfig(cfg, existing);
  } catch (err) {
    console.error('error: failed to write config: ' + (err && err.message ? err.message : err));
    process.exit(1);
  }

  const t = d.tenant || {};
  const how = d.created ? 'new bridge account' : (d.adopted ? 'adopted your existing bridge account'
    : (d.machineToken ? 'new token for this machine; your other machines stay signed in' : 'token rotated'));
  console.log('');
  if (t.obtoDomain) {
    console.log('✓ linked to ' + t.obtoDomain + ' as ' + (t.obtoUserName || t.obtoUserId || '?') + '  (' + how + ')');
  } else {
    console.log('✓ linked  (' + how + '; the server returned no tenant — account ' + d.accountId + ')');
  }
  console.log('  Account:   ' + d.accountId);
  console.log('  Machine:   ' + ctx.agentId);
  console.log('  Project:   ' + ctx.projectDir);
  console.log('  Discovery: ' + ctx.discovery + (ctx.discovery === 'metadata'
    ? '  (titles, paths, timestamps, ≤200-char preview; no transcript turns)'
    : '  (recent turns of every local session are sent to the bridge)'));
  console.log('  Config:    ' + CONFIG_PATH);
  if (d.rotated) {
    console.log('  Note: any other machine still using the previous token is now signed out;');
    console.log('        sign it in again with `obto-bridge init` on that machine.');
  }

  // Verify the new token against the bridge. Non-fatal on network failure.
  let result;
  try {
    result = await validateAgainstServer(cfg);
  } catch (err) {
    console.warn('  ⚠ could not reach ' + ctx.baseUrl + ' to verify: ' + (err && err.message ? err.message : err));
    console.warn('    Config is saved; run `obto-bridge whoami` once you have a network.');
  }
  if (result) {
    if (result.ok && result.parsed && result.parsed.account) {
      console.log('  ✓ token verified against ' + ctx.baseUrl);
    } else {
      console.warn('  ⚠ token verification returned HTTP ' + result.status +
        (result.parsed && result.parsed.error ? ' ' + result.parsed.error : '') +
        ' — run `obto-bridge whoami` to retry.');
    }
  }

  console.log('');
  console.log('Next:  obto-bridge install-service     # run the daemon in the background, start at login');
  console.log('  or:  obto-bridge start               # foreground');
};

// ─── Path 1: --link <code> (non-interactive) ──────────────────────────────
const linkMain = async () => {
  const existing = loadExisting();
  const ctx = machineContext(existing);

  const code = String(cliLink).trim().toUpperCase();
  if (!/^LNK(-[A-Z0-9]{4}){4}$/.test(code)) {
    console.error('error: a link code looks like LNK-XXXX-XXXX-XXXX-XXXX (got "' + cliLink + '").');
    console.error(LINK_FIX);
    process.exit(1);
  }

  console.log('OBTO Agent Bridge — link this machine');
  console.log('-------------------------------------');
  console.log('Exchanging link code ' + code.slice(0, 8) + '… at ' + ctx.linkUrl + ' (machine "' + ctx.agentId + '") ...');

  let r;
  try {
    r = await exchangeLinkCode({ linkUrl: ctx.linkUrl, code, agentId: ctx.agentId });
  } catch (e) {
    const cause = e && e.cause && (e.cause.code || e.cause.message);
    console.error('error: cannot reach ' + ctx.linkUrl + ': ' + (e && e.message ? e.message : e) +
      (cause ? ' (' + cause + ')' : ''));
    console.error('  Check your network, then retry. The code stays valid until it expires (~15 min).');
    process.exit(2);
  }

  if (r.status === 404 || (r.data && r.data.error === 'link_code_invalid')) {
    console.error('error: link code invalid, expired, or already used (HTTP ' + r.status + ' link_code_invalid).');
    console.error(LINK_FIX);
    process.exit(3);
  }
  if (r.status === 403 || (r.data && r.data.error === 'account_suspended')) {
    console.error('error: the bridge account for this identity is suspended (HTTP 403). Email support@obto.co.');
    process.exit(3);
  }
  if (!r.ok || !r.data || !r.data.ok || !r.data.apiToken || !r.data.accountId) {
    const msg = (r.data && (r.data.error || r.data._rawBody)) || ('HTTP ' + r.status);
    console.error('error: link exchange rejected: ' + String(msg).slice(0, 300));
    console.error(LINK_FIX);
    process.exit(3);
  }

  await saveLinked(r.data, ctx, existing, LINK_FIX);
};

// ─── Path 4 (default): device sign-in in the browser (One Thread OT-7c) ───
const postJson = async (url, body) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
    redirect: 'manual',
  });
  const text = await res.text();
  return { status: res.status, ok: res.ok, data: parseJsonLoose(text) };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Best effort. Never on an SSH session or a Linux box without a display: the
// user opens the printed URL on whatever device they are signed in on.
const openBrowser = (url) => {
  if (hasFlag('--no-browser') || process.env.SSH_CONNECTION || process.env.SSH_TTY) return false;
  const { spawn } = require('child_process');
  let cmd;
  let args;
  if (process.platform === 'darwin') { cmd = 'open'; args = [url]; }
  else if (process.platform === 'win32') { cmd = 'cmd'; args = ['/c', 'start', '""', url]; }
  else {
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
    cmd = 'xdg-open'; args = [url];
  }
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch (_) {
    return false;
  }
};

const deviceMain = async () => {
  const existing = loadExisting();
  const ctx = machineContext(existing);
  const deviceUrl = String(cliDeviceUrl || process.env.BRIDGE_DEVICE_URL || existing.deviceUrl || DEFAULTS.deviceUrl)
    .replace(/\/+$/, '');
  let clientVersion = null;
  try { clientVersion = require('../package.json').version; } catch (_) {}

  console.log('OBTO Agent Bridge — sign in this machine');
  console.log('----------------------------------------');
  if (existing.accountId && existing.apiToken) {
    const t = existing.tenant || {};
    console.log('This machine already has credentials' +
      (t.obtoDomain ? ' (linked to ' + t.obtoDomain + ' as ' + (t.obtoUserName || '?') + ')' : '') +
      '. Signing in again replaces them.');
    console.log('(Keep them instead: `obto-bridge init --reuse`.)');
    console.log('');
  }

  let start;
  try {
    start = await postJson(deviceUrl + '/start', {
      agentId: ctx.agentId,
      hostname: os.hostname(),
      platform: os.platform() + ' ' + os.arch(),
      clientVersion,
    });
  } catch (e) {
    const cause = e && e.cause && (e.cause.code || e.cause.message);
    console.error('error: cannot reach ' + deviceUrl + '/start: ' + (e && e.message ? e.message : e) +
      (cause ? ' (' + cause + ')' : ''));
    console.error('  Check your network, then retry. Or link with a code: ' +
      'npx @obtoai/agent-bridge@latest init --link <LNK-…>');
    process.exit(2);
  }
  const s = start.data || {};
  if (!start.ok || !s.ok || !s.device_code || !s.user_code) {
    const msg = s.error || s._rawBody || ('HTTP ' + start.status);
    console.error('error: device sign-in could not start: ' + String(msg).slice(0, 300));
    if (start.status === 404) {
      console.error('  This OBTO server has no device sign-in yet. Use a link code instead:');
      console.error(LINK_FIX);
    }
    process.exit(3);
  }

  const url = s.verification_uri_complete || s.verification_uri;
  console.log('Sign in to OBTO in your browser and approve this machine:');
  console.log('');
  console.log('    ' + url);
  console.log('');
  console.log('  Code:    ' + s.user_code + '   (the page must show this exact code)');
  console.log('  Machine: ' + ctx.agentId);
  const opened = openBrowser(url);
  console.log(opened
    ? '  Opened your browser. If it did not open, copy the link above.'
    : '  Open the link above on any device where you can sign in to OBTO.');
  console.log('');
  process.stdout.write('Waiting for approval');

  let interval = Math.max(1, parseInt(s.interval, 10) || 5) * 1000;
  const deadline = Date.now() + Math.max(60, parseInt(s.expires_in, 10) || 600) * 1000;
  let netFailures = 0;
  for (;;) {
    await sleep(interval);
    if (Date.now() > deadline) {
      process.stdout.write('\n');
      console.error('error: the sign-in code expired before it was approved.');
      console.error(DEVICE_FIX);
      process.exit(3);
    }
    let r;
    try {
      r = await postJson(deviceUrl + '/token', { device_code: s.device_code });
      netFailures = 0;
    } catch (e) {
      netFailures++;
      if (netFailures === 1 || netFailures % 6 === 0) {
        process.stdout.write('\n  (cannot reach ' + deviceUrl + ' — retrying)');
      }
      continue;
    }
    const d = r.data || {};
    if (r.ok && d.ok && d.apiToken) {
      process.stdout.write(' approved.\n');
      return saveLinked(d, ctx, existing, DEVICE_FIX, { deviceUrl });
    }
    const err = d.error || ('HTTP ' + r.status);
    if (err === 'authorization_pending') { process.stdout.write('.'); continue; }
    if (err === 'slow_down') { interval += 5000; continue; }
    process.stdout.write('\n');
    if (err === 'access_denied') {
      console.error('error: the request was denied in the browser. Nothing was saved.');
      process.exit(3);
    }
    if (err === 'expired_token' || err === 'invalid_grant') {
      console.error('error: the sign-in code expired or was already used (' + err + ').');
      console.error(DEVICE_FIX);
      process.exit(3);
    }
    if (r.status === 403 || err === 'account_suspended') {
      console.error('error: the bridge account for this login is suspended (HTTP 403). Email support@obto.co.');
      process.exit(3);
    }
    console.error('error: device sign-in failed: ' + String(err).slice(0, 300));
    console.error(DEVICE_FIX);
    process.exit(3);
  }
};

// ─── Paths 2–3: paste-in / existing (--reuse) / self-serve register ───────
const main = async () => {
  if (cliLink !== null || argv.indexOf('--link') !== -1) {
    if (!cliLink) {
      console.error('error: --link needs a code, e.g. --link LNK-XXXX-XXXX-XXXX-XXXX');
      console.error(LINK_FIX);
      process.exit(1);
    }
    return linkMain();
  }
  const pasteIn = !!(cliToken || cliAccount);
  if (!pasteIn && !hasFlag('--register') && !hasFlag('--reuse')) {
    return deviceMain();
  }

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
    console.log('  Token:   (set)');
    if (existing.tenant && existing.tenant.obtoDomain) {
      console.log('  Linked:  ' + existing.tenant.obtoDomain + ' as ' + (existing.tenant.obtoUserName || '?'));
    }
    console.log('Reusing those credentials. To sign this machine in with your OBTO login instead,');
    console.log('run `obto-bridge init` (browser sign-in) or `obto-bridge init --link <LNK-…>`.');
    console.log('');
  } else {
    console.log('Have an OBTO login? Stop here and run `obto-bridge init` (browser sign-in) instead.');
    console.log('Otherwise:');
    console.log('');
    console.log('Create a free bridge-only account (no card needed):');
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

  const agentId    = cliAgentId || await ask(rl, 'Agent name (e.g. my-mac)', existing.agentId || os.hostname().split('.')[0] || 'unnamed-agent');
  const projectDir = cliProjectDir || await ask(rl, 'Project working dir',      existing.projectDir || process.cwd());
  const agentAns   = await ask(rl, 'Coding agent fallback — claude / codex / opencode', existing.agent || 'claude');
  const agentLow   = String(agentAns).trim().toLowerCase();
  const agent      = ['claude', 'codex', 'opencode'].indexOf(agentLow) !== -1 ? agentLow : 'claude';
  const relayAns   = await ask(rl, 'Relay permission requests via bridge? (y/n)', existing.relayPermissions !== false ? 'y' : 'n');
  const relayPermissions = String(relayAns).toLowerCase().startsWith('y');
  const discoveryDef = normalizeDiscovery(existing.discovery, DEFAULTS.discovery);
  const discoveryAns = cliDiscovery || await ask(rl, 'Session discovery sent to the bridge — metadata / full', discoveryDef);
  const discovery = normalizeDiscovery(discoveryAns, discoveryDef);

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

  const cfg = Object.assign({}, existing, {
    baseUrl,
    originHost,
    accountId,
    apiToken,
    agentId,
    agent,
    projectDir: path.resolve(projectDir),
    relayPermissions,
    discovery,
  });

  try {
    writeConfig(cfg, existing);
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
    console.log('Next:  obto-bridge install-service   (or `obto-bridge start` for foreground)');
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
    console.log('Run:    obto-bridge install-service   (or `obto-bridge start` for foreground)');
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
