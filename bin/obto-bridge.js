#!/usr/bin/env node
'use strict';

const subcommands = {
  init:           '../cli/init',
  start:          '../cli/start',
  status:         '../cli/status',
  whoami:         '../cli/whoami',
  logout:         '../cli/logout',
  'rotate-token': '../cli/rotate-token',
};

const usage = () => {
  console.error('Usage: obto-bridge <command>');
  console.error('');
  console.error('Commands:');
  console.error('  init           Create a free account (or paste an existing token via --token/--account)');
  console.error('                 and write ~/.obto-bridge/config.json.');
  console.error('  start          Run the daemon (foreground).');
  console.error('  status         Print active thread/session bindings.');
  console.error('  whoami         Verify config and show your account info from the server.');
  console.error('  rotate-token   Rotate your API token; old token is invalidated, config is updated.');
  console.error('  logout         Wipe local credentials at ~/.obto-bridge/config.json.');
  console.error('');
  console.error('Flags:');
  console.error('  --version, -v          Print the installed package version.');
  console.error('  --help, -h             Show this help.');
  console.error('  --username <name>      (init only) Override the username derived from email.');
  console.error('  --password <pwd>       (init only) Set your password instead of auto-generating one.');
  console.error('  --token <obto_…>       (init only) Skip self-serve register, use this token.');
  console.error('  --account <acc_…>      (init only) Pair with --token for paste-in mode.');
};

const cmd = process.argv[2];

if (cmd === '--version' || cmd === '-v') {
  const pkg = require('../package.json');
  console.log(pkg.version);
  process.exit(0);
}

const target = subcommands[cmd];

if (!target) {
  if (cmd === '--help' || cmd === '-h' || cmd === undefined) {
    usage();
    process.exit(cmd === undefined ? 2 : 0);
  }
  console.error('obto-bridge: unknown command: ' + cmd);
  console.error('');
  usage();
  process.exit(2);
}

require(target);
