'use strict';

// DZ-B1 B1-4 — the browser driver's hard rules, as pure functions so tests can
// pin them. The daemon enforces these; the model and the server are not trusted
// to. See DEVZONE_DZB1_BROWSER_CONTROL §6 (security model).

// Suffixes under which each label belongs to a different owner. A grant for
// one of these is per subdomain (alice.github.io is not bob.github.io).
const SHARED_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'com.au', 'net.au', 'org.au', 'co.in', 'net.in', 'org.in',
  'gov.in', 'co.jp', 'co.nz', 'com.br', 'com.mx', 'co.za', 'com.sg', 'com.cn', 'com.hk', 'co.kr', 'com.tr',
  'github.io', 'gitlab.io', 'lovable.app', 'vercel.app', 'netlify.app', 'herokuapp.com', 'pages.dev',
  'workers.dev', 'web.app', 'firebaseapp.com', 'appspot.com', 'azurewebsites.net', 'cloudfront.net',
  'blogspot.com', 'wordpress.com', 'substack.com', 'medium.com', 'notion.site', 'replit.app', 'onrender.com',
  'fly.dev', 'railway.app', 'glitch.me', 'obto.co',
]);

const isIp = (h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.indexOf(':') !== -1;

// The site a grant is keyed by: the registrable domain of an http(s) URL, or the
// host itself for localhost and IP addresses. null for any other scheme.
const siteOf = (rawUrl) => {
  let u;
  try { u = new URL(String(rawUrl || '').trim()); } catch (_) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (!host) return null;
  if (host === 'localhost' || isIp(host)) return host;
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const last2 = labels.slice(-2).join('.');
  if (SHARED_SUFFIXES.has(last2)) return labels.slice(-3).join('.');
  return last2;
};

// Accepts a URL, a host or a bare site ("linkedin.com") from the CLI.
const siteFromInput = (input) => {
  const s = String(input || '').trim();
  if (!s) return null;
  return siteOf(/^[a-z]+:\/\//i.test(s) ? s : 'https://' + s);
};

// grants: { "<site>": "read" | "act" }. need: "read" | "act".
const hasGrant = (grants, site, need) => {
  if (!site || !grants || typeof grants !== 'object') return false;
  const g = grants[site];
  if (need === 'read') return g === 'read' || g === 'act';
  return g === 'act';
};

// A URL safe to put in the audit log or a result: origin + path, no query or hash.
const redactUrl = (rawUrl) => {
  try {
    const u = new URL(String(rawUrl || ''));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return u.protocol;
    return u.origin + u.pathname;
  } catch (_) { return ''; }
};

const SENSITIVE_AUTOCOMPLETE = /\b(cc-[a-z-]+|one-time-code|current-password|new-password)\b/i;
const SENSITIVE_WORDS = new RegExp([
  'password', 'passcode', 'passphrase', '\\bpass\\b', '\\bpwd\\b',
  'card.?(no|num|number)', 'credit.?card', 'debit.?card', '\\bcvv', '\\bcvc', '\\bcsc\\b', 'security.?code', 'expir',
  '\\botp\\b', 'one.?time', 'verification.?code', '\\b2fa\\b', '\\bmfa\\b', 'auth(entication)?.?code',
  '\\bssn\\b', 'social.?security', 'passport', '\\biban\\b', 'routing', 'sort.?code', 'account.?(no|num|number)',
  '\\bpin\\b', 'tax.?id', '\\baadhaar', '\\bpan.?(no|number)',
].join('|'), 'i');

// Refuses typing into password, payment, one-time-code, bank and ID fields.
// attrs: { type, autocomplete, name, id, label, placeholder, ariaLabel }.
// Returns null (allowed) or a reason code.
const fieldRefusal = (attrs) => {
  const a = attrs || {};
  if (String(a.type || '').toLowerCase() === 'password') return 'password_field';
  if (SENSITIVE_AUTOCOMPLETE.test(String(a.autocomplete || ''))) return 'sensitive_field';
  const words = [a.name, a.id, a.label, a.placeholder, a.ariaLabel].map((x) => String(x || '')).join(' ');
  if (SENSITIVE_WORDS.test(words)) return 'sensitive_field';
  return null;
};

// Clicks that complete a purchase, payment, transfer or account deletion need the
// Commit tier (user approval per action), which this release does not have.
const COMMIT_WORDS = /\b(buy( now)?|pay( now)?|purchase|place (your )?order|check ?out|complete (order|purchase)|subscribe|donate|transfer|send money|confirm (payment|order|purchase|transfer)|delete (my )?account|close (my )?account)\b/i;
const clickRefusal = (text) => (COMMIT_WORDS.test(String(text || '')) ? 'commit_action' : null);

module.exports = { siteOf, siteFromInput, hasGrant, redactUrl, fieldRefusal, clickRefusal, SHARED_SUFFIXES };
