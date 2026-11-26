'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createBrowserDriver } = require('../src/browser-driver');
const { siteOf, hasGrant, fieldRefusal, clickRefusal, redactUrl, siteFromInput } = require('../src/browser-guards');

// ---- guards -------------------------------------------------------------

test('siteOf keys grants by registrable domain', () => {
  assert.strictEqual(siteOf('https://www.linkedin.com/in/x?y=1'), 'linkedin.com');
  assert.strictEqual(siteOf('https://news.bbc.co.uk/a'), 'bbc.co.uk');
  assert.strictEqual(siteOf('https://alice.github.io/'), 'alice.github.io');
  assert.strictEqual(siteOf('https://my-app.lovable.app/'), 'my-app.lovable.app');
  assert.strictEqual(siteOf('http://localhost:3000/x'), 'localhost');
  assert.strictEqual(siteOf('file:///etc/passwd'), null);
  assert.strictEqual(siteOf('chrome://settings'), null);
  assert.strictEqual(siteOf('javascript:alert(1)'), null);
  assert.strictEqual(siteFromInput('www.linkedin.com'), 'linkedin.com');
});

test('read grant does not allow act; act allows read', () => {
  const g = { 'a.com': 'read', 'b.com': 'act' };
  assert.ok(hasGrant(g, 'a.com', 'read'));
  assert.ok(!hasGrant(g, 'a.com', 'act'));
  assert.ok(hasGrant(g, 'b.com', 'read'));
  assert.ok(hasGrant(g, 'b.com', 'act'));
  assert.ok(!hasGrant(g, 'c.com', 'read'));
});

test('sensitive fields are refused', () => {
  assert.strictEqual(fieldRefusal({ type: 'password' }), 'password_field');
  assert.strictEqual(fieldRefusal({ autocomplete: 'cc-number' }), 'sensitive_field');
  assert.strictEqual(fieldRefusal({ autocomplete: 'one-time-code' }), 'sensitive_field');
  assert.strictEqual(fieldRefusal({ label: 'Card number' }), 'sensitive_field');
  assert.strictEqual(fieldRefusal({ name: 'cvv' }), 'sensitive_field');
  assert.strictEqual(fieldRefusal({ placeholder: 'Enter OTP' }), 'sensitive_field');
  assert.strictEqual(fieldRefusal({ ariaLabel: 'IBAN' }), 'sensitive_field');
  assert.strictEqual(fieldRefusal({ type: 'text', label: 'Search' }), null);
  assert.strictEqual(fieldRefusal({ type: 'email', name: 'email' }), null);
});

test('commit clicks are refused', () => {
  assert.strictEqual(clickRefusal('Buy now'), 'commit_action');
  assert.strictEqual(clickRefusal('Place your order'), 'commit_action');
  assert.strictEqual(clickRefusal('Checkout'), 'commit_action');
  assert.strictEqual(clickRefusal('Delete account'), 'commit_action');
  assert.strictEqual(clickRefusal('Next page'), null);
  assert.strictEqual(clickRefusal('Connect'), null);
});

test('redactUrl drops query and hash', () => {
  assert.strictEqual(redactUrl('https://a.com/p?token=x#y'), 'https://a.com/p');
});

// ---- fake Chrome ----------------------------------------------------------

// A page is { url, title, elements: { ref: info }, redirect: { fromUrl: toUrl } }.
const fakeBrowser = (site) => {
  const calls = [];
  const handlers = {};
  const pages = [];
  const makePage = () => {
    const ph = {};
    const page = {
      _url: 'about:blank',
      on: (ev, fn) => { ph[ev] = fn; },
      url: () => page._url,
      title: async () => (site.pages[page._url] || {}).title || '',
      goto: async (u) => {
        calls.push(['goto', u]);
        page._url = (site.redirect && site.redirect[u]) || u;
        if (site.hangOn === u) await new Promise(() => {});
      },
      goBack: async () => { calls.push(['back']); },
      waitForLoadState: async () => {},
      evaluate: async (fn) => {
        const p = site.pages[page._url] || {};
        const els = p.elements || {};
        return {
          text: p.text || '',
          refs: Object.keys(els).map((r) => ({ ref: Number(r), role: els[r].role || 'button', name: els[r].text || els[r].label || '' })),
        };
      },
      mouse: { wheel: async () => { calls.push(['wheel']); } },
      screenshot: async () => Buffer.from('jpeg'),
      close: async () => { if (ph.close) ph.close(); },
      locator: (sel) => {
        const m = /data-obto-ref="(\d+)"/.exec(sel);
        return makeLocator(page, m ? m[1] : null);
      },
      getByLabel: (t) => byName(page, t),
      getByPlaceholder: (t) => byName(page, t),
      getByRole: (_r, o) => byName(page, o && o.name),
      getByText: (t) => byName(page, t),
    };
    return page;
  };
  const byName = (page, t) => {
    const els = (site.pages[page._url] || {}).elements || {};
    const hit = Object.keys(els).find((r) => (els[r].text || els[r].label || '').toLowerCase() === String(t || '').toLowerCase());
    return makeLocator(page, hit || null);
  };
  const makeLocator = (page, ref) => {
    const el = ref ? ((site.pages[page._url] || {}).elements || {})[ref] : null;
    const loc = {
      first: () => loc,
      count: async () => (el ? 1 : 0),
      evaluate: async () => Object.assign({ text: el.text || '' }, el),
      click: async () => { calls.push(['click', ref]); if (el.navigatesTo) page._url = el.navigatesTo; },
      fill: async (text) => { calls.push(['fill', ref, text]); },
    };
    return loc;
  };
  const ctx = {
    on: (ev, fn) => { handlers[ev] = fn; },
    pages: () => pages,
    newPage: async () => { const p = makePage(); pages.push(p); if (handlers.page) handlers.page(p); return p; },
    exposeBinding: async (name, fn) => { ctx._stop = fn; },
    addInitScript: async () => {},
    close: async () => { calls.push(['closeContext']); if (handlers.close) handlers.close(); },
  };
  pages.push(makePage());
  return { ctx, calls, launcher: async () => ctx };
};

const SITE = {
  pages: {
    'https://example.com/': {
      title: 'Example', text: 'Hello',
      elements: {
        1: { tag: 'input', type: 'text', label: 'Search' },
        2: { tag: 'input', type: 'password', label: 'Password' },
        3: { tag: 'button', text: 'Buy now' },
        4: { tag: 'a', role: 'link', text: 'Elsewhere', navigatesTo: 'https://evil.test/' },
        5: { tag: 'input', type: 'text', label: 'Card number', autocomplete: 'cc-number' },
      },
    },
  },
  redirect: { 'https://example.com/go': 'https://other.org/landing' },
};

const setup = (grants) => {
  const fb = fakeBrowser(SITE);
  const auditPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'obto-audit-')), 'audit.jsonl');
  const driver = createBrowserDriver({ launcher: fb.launcher, auditPath });
  const cfg = { browserGrants: grants || { 'example.com': 'act' } };
  let n = 0;
  const run = (action, args, extra) => driver.run(Object.assign({
    cmdId: 'bc_test' + (++n), action, args: args || {}, expiresAt: new Date(Date.now() + 20000).toISOString(),
  }, extra || {}), cfg);
  return { fb, driver, run, auditPath };
};

test('open needs a grant for the site', async () => {
  const { run, fb } = setup({});
  const r = await run('open', { url: 'https://example.com/' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'site_not_granted');
  assert.strictEqual(r.site, 'example.com');
  assert.strictEqual(fb.calls.length, 0, 'Chrome is not even launched');
});

test('open and read on a granted site returns text and refs, marked untrusted', async () => {
  const { run } = setup({ 'example.com': 'read' });
  const o = await run('open', { url: 'https://example.com/' });
  assert.strictEqual(o.ok, true);
  assert.strictEqual(o.result.title, 'Example');
  const r = await run('read');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.result.untrusted, true);
  assert.strictEqual(r.result.text, 'Hello');
  assert.ok(r.result.refs.length >= 3);
});

test('file and chrome URLs are refused', async () => {
  const { run } = setup({ 'example.com': 'act' });
  assert.strictEqual((await run('open', { url: 'file:///etc/hosts' })).error, 'url_not_allowed');
  assert.strictEqual((await run('open', { url: 'chrome://settings' })).error, 'url_not_allowed');
});

test('a read grant does not allow click or type', async () => {
  const { run, fb } = setup({ 'example.com': 'read' });
  await run('open', { url: 'https://example.com/' });
  const c = await run('type', { target: '1', text: 'hi' });
  assert.strictEqual(c.error, 'site_not_granted');
  assert.ok(!fb.calls.some((x) => x[0] === 'fill'));
});

test('typing into a password field is refused and nothing is filled', async () => {
  const { run, fb } = setup();
  await run('open', { url: 'https://example.com/' });
  const r = await run('type', { target: '2', text: 'hunter2' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'password_field');
  const r2 = await run('type', { target: 'Card number', text: '4111' });
  assert.strictEqual(r2.error, 'sensitive_field');
  assert.ok(!fb.calls.some((x) => x[0] === 'fill'));
});

test('typing into a normal field works and the text never reaches the audit log', async () => {
  const { run, fb, auditPath } = setup();
  await run('open', { url: 'https://example.com/' });
  const r = await run('type', { target: 'Search', text: 'secret-search-words' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(fb.calls.find((x) => x[0] === 'fill'), ['fill', '1', 'secret-search-words']);
  const log = fs.readFileSync(auditPath, 'utf8');
  assert.ok(log.indexOf('secret-search-words') === -1);
  const rows = log.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepStrictEqual(rows.map((x) => x.action), ['open', 'type']);
  assert.strictEqual(rows[1].site, 'example.com');
});

test('a buy button is never clicked', async () => {
  const { run, fb } = setup();
  await run('open', { url: 'https://example.com/' });
  const r = await run('click', { target: '3' });
  assert.strictEqual(r.error, 'commit_action');
  assert.ok(!fb.calls.some((x) => x[0] === 'click'));
});

test('a click that lands on a site without a grant is undone', async () => {
  const { run, fb } = setup();
  await run('open', { url: 'https://example.com/' });
  const r = await run('click', { target: 'Elsewhere' });
  assert.strictEqual(r.error, 'site_not_granted');
  assert.strictEqual(r.site, 'evil.test');
  assert.deepStrictEqual(fb.calls[fb.calls.length - 1], ['goto', 'about:blank']);
});

test('a redirect to a site without a grant is undone', async () => {
  const { run } = setup();
  const r = await run('open', { url: 'https://example.com/go' });
  assert.strictEqual(r.error, 'site_not_granted');
  assert.strictEqual(r.site, 'other.org');
});

test('Stop closes the window and refuses the rest of the run; a new run works', async () => {
  const { run, fb } = setup();
  await run('open', { url: 'https://example.com/' }, { runId: 'run-a' });
  await fb.ctx._stop(); // the overlay Stop button
  assert.ok(fb.calls.some((x) => x[0] === 'closeContext'));
  const r = await run('read', {}, { runId: 'run-a' });
  assert.strictEqual(r.error, 'stopped_by_user');
  const r2 = await run('open', { url: 'https://example.com/' }, { runId: 'run-b' });
  assert.strictEqual(r2.ok, true);
});

test('Stop during a pending action answers stopped_by_user', async () => {
  const fb = fakeBrowser(Object.assign({}, SITE, { hangOn: 'https://example.com/slow' }));
  const driver = createBrowserDriver({ launcher: fb.launcher, auditPath: null });
  const cfg = { browserGrants: { 'example.com': 'act' } };
  // The fake goto never resolves; simulate Chrome rejecting it when the window closes.
  const pending = driver.run({ cmdId: 'bc_x1', runId: 'run-s', action: 'open', args: { url: 'https://example.com/' } }, cfg)
    .then(() => driver.run({ cmdId: 'bc_x2', runId: 'run-s', action: 'read', args: {} }, cfg));
  await pending;
  await driver.stop('overlay');
  const r = await driver.run({ cmdId: 'bc_x3', runId: 'run-s', action: 'tabs', args: {} }, cfg);
  assert.strictEqual(r.error, 'stopped_by_user');
});

test('commands run one at a time', async () => {
  const { run } = setup();
  const [a, b] = await Promise.all([run('open', { url: 'https://example.com/' }), run('read')]);
  assert.strictEqual(a.ok, true);
  assert.strictEqual(b.ok, true, 'read waits for open');
});

// ---- B1-5 grants from a DevZone card --------------------------------------

test('a run grant lets that run open the site, and only that run', async () => {
  const fb = fakeBrowser(SITE);
  const driver = createBrowserDriver({ launcher: fb.launcher, auditPath: null });
  const cfg = { browserGrants: {} };
  const go = (runId, action, args) => driver.run({ cmdId: 'bc_g' + Math.random(), runId, action, args, expiresAt: new Date(Date.now() + 20000).toISOString() }, cfg);
  assert.strictEqual((await go('r1', 'open', { url: 'https://example.com/' })).error, 'site_not_granted');
  const g = await go('r1', 'grant', { site: 'www.example.com', level: 'read', scope: 'run' });
  assert.deepStrictEqual(g.result, { site: 'example.com', level: 'read', scope: 'run' });
  assert.strictEqual((await go('r1', 'open', { url: 'https://example.com/' })).ok, true);
  assert.strictEqual((await go('r1', 'type', { target: 'Search', text: 'x' })).error, 'site_not_granted', 'read grant, no typing');
  assert.strictEqual((await go('r2', 'read', {})).error, 'site_not_granted', 'another run has no grant');
});

test('an always grant is saved through saveGrant', async () => {
  const saved = [];
  const fb = fakeBrowser(SITE);
  const driver = createBrowserDriver({ launcher: fb.launcher, auditPath: null, saveGrant: (s, l) => saved.push([s, l]) });
  const r = await driver.run({ cmdId: 'bc_g1', runId: 'r1', action: 'grant', args: { site: 'https://example.com/x', level: 'act', scope: 'always' } }, {});
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(saved, [['example.com', 'act']]);
});

test('remote grants turned off on the machine are refused', async () => {
  const fb = fakeBrowser(SITE);
  const driver = createBrowserDriver({ launcher: fb.launcher, auditPath: null, saveGrant: () => { throw new Error('must not save'); } });
  const r = await driver.run({ cmdId: 'bc_g2', runId: 'r1', action: 'grant', args: { site: 'example.com', level: 'act', scope: 'always' } }, { browserRemoteGrants: false });
  assert.strictEqual(r.error, 'remote_grants_off');
});

test('a stopped run cannot be granted a site', async () => {
  const fb = fakeBrowser(SITE);
  const driver = createBrowserDriver({ launcher: fb.launcher, auditPath: null });
  const cfg = { browserGrants: { 'example.com': 'read' } };
  await driver.run({ cmdId: 'bc_s1', runId: 'r9', action: 'open', args: { url: 'https://example.com/' } }, cfg);
  await fb.ctx._stop();
  const r = await driver.run({ cmdId: 'bc_s2', runId: 'r9', action: 'grant', args: { site: 'other.org', level: 'read', scope: 'run' } }, cfg);
  assert.strictEqual(r.error, 'stopped_by_user');
});
