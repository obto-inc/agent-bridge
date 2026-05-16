'use strict';

// In-process MCP server exposed to daemon-spawned Claude sessions. Each tool
// wraps the daemon's authenticated HTTP client (basic auth → /api/...). Avoids
// requiring the spawned session to OAuth into OBTO's external MCP server.

const { z } = require('zod/v4');
const bridgeHttp = require('./bridge-http');

let cached = null;

const buildBridgeMcpServer = async ({ log }) => {
  if (cached) return cached;

  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const { createSdkMcpServer, tool } = sdk;

  const bridgePost = tool(
    'bridge_post',
    'Post a message to a thread on the OBTO Agent Bridge. THIS IS THE ONLY WAY for ' +
      'this session to communicate with the human who triggered the work. Plain text ' +
      'replies in the conversation are invisible to them. Use kind="result" for the ' +
      'finished answer, "status" for a progress update, "question" if you need ' +
      'clarification before continuing, "error" if something failed.',
    {
      threadId: z.string().min(1).describe(
        'Thread to post to. Use the same threadId that was given to you in the ' +
          'envelope of the message you are responding to.',
      ),
      body: z.string().min(1).describe('Message content. Plain text or markdown.'),
      kind: z.enum(['status', 'question', 'result', 'error']).optional().describe(
        'Message kind. Defaults to "result".',
      ),
      author: z.string().optional().describe(
        'Optional author override; defaults to "claude-bridge".',
      ),
    },
    async ({ threadId, body, kind, author }) => {
      try {
        const r = await bridgeHttp.postMessage({
          threadId,
          body,
          kind: kind || 'result',
          author: author || 'claude-bridge',
          role: 'agent',
        });
        if (!r.ok) {
          if (log) log('error', 'bridge_post HTTP failed', { status: r.status });
          return {
            content: [
              {
                type: 'text',
                text: 'bridge_post failed: HTTP ' + r.status + ' ' + JSON.stringify(r.data),
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: 'text',
              text: 'Posted to bridge thread "' + threadId + '" (kind=' + (kind || 'result') + '). messageId=' +
                ((r.data && r.data.message && r.data.message._id) || '?'),
            },
          ],
        };
      } catch (e) {
        if (log) log('error', 'bridge_post threw', { error: e && e.message });
        return {
          content: [
            { type: 'text', text: 'bridge_post threw: ' + (e && e.message ? e.message : String(e)) },
          ],
          isError: true,
        };
      }
    },
  );

  const bridgeThreadRead = tool(
    'bridge_thread_read',
    'Read recent messages on a bridge thread. Use to load context when resuming a ' +
      'session, or to check for human replies after asking a question.',
    {
      threadId: z.string().min(1).describe('Thread to read.'),
      sinceCursor: z.string().optional().describe(
        'ISO 8601 timestamp; only return messages newer than this. Useful for ' +
          'incremental polling so you do not re-process old messages.',
      ),
    },
    async ({ threadId, sinceCursor }) => {
      try {
        const r = await bridgeHttp.getMessages(threadId, sinceCursor);
        if (!r.ok) {
          return {
            content: [{ type: 'text', text: 'bridge_thread_read failed: HTTP ' + r.status }],
            isError: true,
          };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(r.data, null, 2) }],
        };
      } catch (e) {
        return {
          content: [
            { type: 'text', text: 'bridge_thread_read threw: ' + (e && e.message ? e.message : String(e)) },
          ],
          isError: true,
        };
      }
    },
  );

  cached = createSdkMcpServer({
    name: 'bridge',
    version: '0.1.0',
    tools: [bridgePost, bridgeThreadRead],
    alwaysLoad: true,
  });

  if (log) log('info', 'in-process bridge MCP server ready', { tools: ['bridge_post', 'bridge_thread_read'] });
  return cached;
};

module.exports = { buildBridgeMcpServer };
