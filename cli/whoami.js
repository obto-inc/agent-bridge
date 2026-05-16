'use strict';

// `obto-bridge whoami` — hit GET /api/bridge/whoami with the configured
// Bearer token and print the result. Verifies (1) config is valid,
// (2) bridge is reachable, (3) token resolves to an active account.

const { loadConfig } = require('../src/config');

const main = async () => {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    console.error('error: ' + (err && err.message ? err.message : err));
    console.error('Run `obto-bridge init` first.');
    process.exit(1);
  }

  const url = cfg.baseUrl.replace(/\/$/, '') + '/api/bridge/whoami';
  let res;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'OBTO-ORIGIN-HOST': cfg.originHost,
        Authorization: 'Bearer ' + cfg.apiToken,
      },
      cache: 'no-store',
    });
  } catch (err) {
    console.error('error: cannot reach ' + url);
    console.error('  ' + (err && err.message ? err.message : err));
    process.exit(2);
  }

  const body = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (_) {
    parsed = { _rawBody: body };
  }

  if (!res.ok) {
    console.error('HTTP ' + res.status + ' — ' + (parsed && parsed.error ? parsed.error : 'request failed'));
    if (res.status === 401) {
      console.error('Your API token is invalid or the account is suspended. Email support@obto.co.');
    }
    process.exit(3);
  }

  const a = parsed.account || {};
  console.log('✓ Connected to ' + cfg.baseUrl);
  console.log('');
  console.log('  Account:    ' + (a.accountId || '?'));
  console.log('  Username:   @' + (a.basicAuthUser || '?'));
  console.log('  Email:      ' + (a.email || '?'));
  console.log('  Status:     ' + (a.status || '?'));
  console.log('  Token:      ' + (a.apiTokenPrefix || '?') + '…');
  console.log('  Agent name: ' + (cfg.agentId || '?'));
  console.log('  Project:    ' + (cfg.projectDir || '?'));
  console.log('');
  console.log('Server time: ' + (parsed.server && parsed.server.time ? parsed.server.time : '?'));
};

main().catch((err) => {
  console.error('whoami failed: ' + (err && err.message ? err.message : err));
  process.exit(1);
});
