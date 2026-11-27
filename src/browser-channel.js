'use strict';

// DZ-B1 B1-3 — browser command channel (daemon side).
//
// The bridge sends `event: browser.cmd` on this machine's SSE stream (AMQP key
// bridge.<accountId>.browser.<machineKey>, bound only by this machine's stream).
// Each command is answered once with POST /api/bridge/browser/result.
//
// `ping` and `echo` prove the channel. Browser actions (open, read, find,
// click, type, scroll, back, screenshot, tabs, close) go to the browser driver
// (B1-4, browser-driver.js), which enforces site grants and field guards.
//
// Guards, enforced here and not trusted to the server or the model:
//   - browser control is off unless `obto-bridge browser enable` set it;
//   - the command must name this machine;
//   - an expired command (expiresAt in the past) is refused;
//   - a command id is handled at most once (replayed or duplicated ids are dropped);
//   - only known actions run.

const SEEN_MAX = 500;
const { DRIVER_ACTIONS } = require('./browser-driver');

const ACTIONS = new Set(['ping', 'echo'].concat(DRIVER_ACTIONS));
const ARGS_MAX_CHARS = 8000;

const createBrowserChannel = ({ getConfig, postResult, log, version, getDriver }) => {
  const seen = new Map(); // cmdId -> handledAt, oldest first

  const remember = (id) => {
    seen.set(id, Date.now());
    while (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value);
  };

  // Returns the result body that was posted (or would be, for a dropped command: null).
  const handle = async (rawData) => {
    const startedAt = Date.now();
    let cmd;
    try {
      cmd = JSON.parse(rawData);
    } catch (_) {
      log('warn', 'browser.cmd unparseable');
      return null;
    }
    const cmdId = String((cmd && cmd.cmdId) || '').trim();
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(cmdId)) {
      log('warn', 'browser.cmd without a valid cmdId');
      return null;
    }
    if (seen.has(cmdId)) {
      log('event', 'browser.cmd skip — already handled', { cmdId });
      return null;
    }
    remember(cmdId);

    const cfg = getConfig();
    const reply = async (ok, fields) => {
      const body = Object.assign(
        { cmdId, agentId: cfg.agentId, ok, tookMs: Date.now() - startedAt, daemonVersion: version },
        fields,
      );
      const postAt = Date.now();
      try {
        const r = await postResult(body);
        const postMs = Date.now() - postAt;
        const bytes = JSON.stringify(body).length;
        if (!r || !r.ok) log('warn', 'browser result post failed', { cmdId, status: r && r.status, postMs, bytes });
        else log(postMs > 3000 ? 'warn' : 'event', 'browser result posted', { cmdId, postMs, bytes, actionMs: body.tookMs });
      } catch (e) {
        log('warn', 'browser result post threw', { cmdId, error: e && e.message });
      }
      return body;
    };

    if (!cfg.browser) return reply(false, { error: 'browser_disabled', message: 'Browser control is off on this machine (obto-bridge browser enable).' });
    if (String(cmd.agentId || '') !== String(cfg.agentId || '')) return reply(false, { error: 'wrong_machine' });
    const exp = Date.parse(cmd.expiresAt || '');
    if (!Number.isFinite(exp) || exp < Date.now()) return reply(false, { error: 'expired' });
    const action = String(cmd.action || '');
    if (!ACTIONS.has(action)) return reply(false, { error: 'not_implemented', message: 'Action "' + action.slice(0, 40) + '" is not available on this machine yet.' });

    if (action === 'ping') return reply(true, { result: { pong: true, at: new Date().toISOString() } });
    const args = cmd.args === undefined ? null : cmd.args;
    const text = JSON.stringify(args);
    if (text && text.length > ARGS_MAX_CHARS) return reply(false, { error: 'args_too_large' });
    if (action === 'echo') {
      // echo: return the args unchanged (size-capped), proving the round trip.
      log('event', 'browser.cmd echo', { cmdId });
      return reply(true, { result: { echo: args } });
    }
    const driver = typeof getDriver === 'function' ? getDriver() : null;
    if (!driver) return reply(false, { error: 'driver_unavailable', message: 'The browser driver is not available on this machine.' });
    log('event', 'browser.cmd', { cmdId, action });
    let out;
    try {
      out = await driver.run(Object.assign({}, cmd, { cmdId, action }), cfg);
    } catch (e) {
      out = { ok: false, error: 'driver_failed', message: e && e.message ? String(e.message).slice(0, 300) : null };
    }
    const fields = out.ok ? { result: out.result } : { error: out.error, message: out.message || null, result: out.site ? { site: out.site } : undefined };
    return reply(!!out.ok, fields);
  };

  return { handle, _seen: seen };
};

module.exports = { createBrowserChannel, ACTIONS };
