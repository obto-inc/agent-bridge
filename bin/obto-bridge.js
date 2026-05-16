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
  console.error('  init           One-time setup: paste credentials, choose agent name + project dir.');
  console.error('  start          Run the daemon (foreground).');
  console.error('  status         Print active thread/session bindings.');
  console.error('  whoami         Verify config and show your account info from the server.');
  console.error('  rotate-token   Rotate your API token; old token is invalidated, config is updated.');
  console.error('  logout         Wipe local credentials at ~/.obto-bridge/config.json.');
  console.error('');
  console.error('Flags:');
  console.error('  --version, -v  Print the installed package version.');
  console.error('  --help, -h     Show this help.');
  console.error('');
  console.error('Get an invite: support@obto.co');
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
