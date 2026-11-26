'use strict';

// DZ-B1 — functions that run INSIDE a web page. Each one is self-contained (no
// closures, no imports) because it is serialized into the page: by playwright
// (page.evaluate) for the OBTO profile window, and by chrome.scripting for the
// OBTO Chrome extension (B1-6). extension/lib/ holds a byte-identical copy.

// Page text plus numbered refs for links, buttons and inputs. Input values are
// never read (only the value of submit/button inputs, as a name).
function collectPage(max) {
  const sel = 'a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link],[role=checkbox],' +
    '[role=tab],[role=menuitem],[role=option],[contenteditable="true"]';
  document.querySelectorAll('[data-obto-ref]').forEach((e) => e.removeAttribute('data-obto-ref'));
  const refs = [];
  let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    if (refs.length >= max.refs) break;
    if (el.closest('[data-obto-overlay]')) continue;
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    if ((r.width === 0 && r.height === 0) || st.visibility === 'hidden' || st.display === 'none') continue;
    n += 1;
    el.setAttribute('data-obto-ref', String(n));
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    let role = el.getAttribute('role');
    if (!role) {
      if (tag === 'a') role = 'link';
      else if (tag === 'button' || type === 'submit' || type === 'button') role = 'button';
      else if (tag === 'select') role = 'select';
      else if (type === 'checkbox' || type === 'radio') role = type;
      else role = 'textbox';
    }
    const label = el.labels && el.labels[0] ? el.labels[0].innerText : '';
    const btnValue = tag === 'input' && (type === 'submit' || type === 'button') ? el.value : '';
    const name = (el.getAttribute('aria-label') || label || el.getAttribute('placeholder') || el.innerText ||
      btnValue || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const item = { ref: n, role, name };
    if (tag === 'a') item.href = el.href.split('#')[0].split('?')[0];
    if (type === 'password') item.sensitive = true;
    refs.push(item);
  }
  const text = (document.body ? document.body.innerText : '').slice(0, max.text);
  return { text, refs };
}

// What the guards need to judge one element.
function elementInfo(el) {
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute('type') || '').toLowerCase();
  const label = el.labels && el.labels[0] ? el.labels[0].innerText : '';
  const btnValue = tag === 'input' && (type === 'submit' || type === 'button') ? el.value : '';
  return {
    tag, type,
    autocomplete: el.getAttribute('autocomplete') || '',
    name: el.getAttribute('name') || '',
    id: el.id || '',
    label,
    placeholder: el.getAttribute('placeholder') || '',
    ariaLabel: el.getAttribute('aria-label') || '',
    text: ((el.innerText || '') + ' ' + btnValue + ' ' + (el.getAttribute('aria-label') || '')).trim().slice(0, 200),
  };
}

// Extension step 1 of click / type: find the target (a ref from read, or visible
// text / field label), tag it with a one-time marker, and return what the guards
// need. Nothing is clicked or typed here.
function markTarget(target, kind, marker) {
  const t = String(target || '').trim();
  if (!t) return { found: false };
  document.querySelectorAll('[data-obto-target]').forEach((e) => e.removeAttribute('data-obto-target'));
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return !((r.width === 0 && r.height === 0) || st.visibility === 'hidden' || st.display === 'none');
  };
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  let el = null;
  if (/^\d{1,4}$/.test(t)) el = document.querySelector('[data-obto-ref="' + t + '"]');
  if (!el) {
    const q = norm(t);
    const fields = 'input:not([type=hidden]):not([type=submit]):not([type=button]),textarea,[contenteditable="true"],[role=textbox]';
    const clicks = 'button,a[href],[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=checkbox],input[type=submit],input[type=button],input[type=checkbox],input[type=radio],summary,label';
    const nameOf = (e) => norm([e.getAttribute('aria-label'), e.labels && e.labels[0] ? e.labels[0].innerText : '',
      e.getAttribute('placeholder'), e.getAttribute('title'), e.innerText, e.value && /submit|button/.test(e.type || '') ? e.value : ''].join(' '));
    const pool = Array.from(document.querySelectorAll(kind === 'type' ? fields : clicks)).filter(visible);
    el = pool.find((e) => norm(e.getAttribute('aria-label')) === q || norm(e.innerText) === q) ||
      pool.find((e) => nameOf(e).indexOf(q) !== -1) || null;
  }
  if (!el) return { found: false };
  el.setAttribute('data-obto-target', marker);
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute('type') || '').toLowerCase();
  const label = el.labels && el.labels[0] ? el.labels[0].innerText : '';
  const btnValue = tag === 'input' && (type === 'submit' || type === 'button') ? el.value : '';
  return {
    found: true,
    info: {
      tag, type,
      autocomplete: el.getAttribute('autocomplete') || '',
      name: el.getAttribute('name') || '',
      id: el.id || '',
      label,
      placeholder: el.getAttribute('placeholder') || '',
      ariaLabel: el.getAttribute('aria-label') || '',
      text: ((el.innerText || '') + ' ' + btnValue + ' ' + (el.getAttribute('aria-label') || '')).trim().slice(0, 200),
    },
  };
}

// Extension step 2: act on the marked element (after the guards allowed it).
function actOnTarget(marker, kind, text) {
  const el = document.querySelector('[data-obto-target="' + marker + '"]');
  if (!el) return { ok: false, error: 'target_gone' };
  el.removeAttribute('data-obto-target');
  try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (_) {}
  if (kind === 'click') {
    el.click();
    return { ok: true };
  }
  el.focus();
  if (el.isContentEditable) {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('insertText', false, String(text));
    return { ok: true };
  }
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value');
  if (setter && setter.set) setter.set.call(el, String(text)); else el.value = String(text);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true };
}

const ObtoPage = { collectPage, elementInfo, markTarget, actOnTarget };
if (typeof module !== 'undefined' && module.exports) module.exports = ObtoPage;
else self.ObtoPage = ObtoPage;
