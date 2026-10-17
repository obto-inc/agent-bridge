'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'agent-bridge-test-'));

const jsonl = (records) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';

const userRec = (text, extra) => Object.assign(
  { type: 'user', message: { role: 'user', content: text }, timestamp: '2026-10-17T20:00:00.000Z' },
  extra || {},
);
const assistantRec = (text, extra) => Object.assign(
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, timestamp: '2026-10-17T20:00:01.000Z' },
  extra || {},
);

const REMINDER =
  '<system-reminder>\n# userEmail\nThe user\'s email address is someone@example.com.\n</system-reminder>';

module.exports = { tmpDir, jsonl, userRec, assistantRec, REMINDER };
