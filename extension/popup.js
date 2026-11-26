'use strict';
const $ = (id) => document.getElementById(id);
const ask = (type, extra) => chrome.runtime.sendMessage(Object.assign({ type }, extra || {}));
const refresh = async () => {
  const s = await ask('status');
  const agreed = !!(s && s.agreed);
  $('consent').hidden = agreed;
  $('actions').hidden = !agreed || !s.enabled;
  $('enableRow').hidden = !agreed;
  $('enabled').checked = !!(s && s.enabled);
  if (!agreed) { $('status').textContent = 'Off. Read what the agent can do and agree before it can use this browser.'; return; }
  if (!s.enabled) { $('status').textContent = 'Off. The agent cannot use this browser.'; return; }
  if (!s.native) { $('status').textContent = 'Not linked. Run `obto-bridge browser extension install` on this computer, then reopen Chrome.'; return; }
  $('status').textContent = s.daemon
    ? 'On. The agent works only in the "OBTO agent" tab group (' + s.tabs + ' tab' + (s.tabs === 1 ? '' : 's') + '), only on sites you approve.'
    : 'The OBTO bridge is not running on this computer. Start it with `obto-bridge start`.';
};
$('review').addEventListener('click', () => { chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') }); window.close(); });
$('enabled').addEventListener('change', async (e) => { await ask('enable', { on: e.target.checked }); $('msg').textContent = e.target.checked ? 'Turned on.' : 'Turned off. Anything the agent was doing here has stopped.'; refresh(); });
$('share').addEventListener('click', async () => {
  const r = await ask('share');
  $('msg').textContent = r && r.ok ? 'Shared as ' + r.tab + '. The agent can use it on sites you approve.' : (r && r.error) || 'Could not share this tab.';
  refresh();
});
$('stop').addEventListener('click', async () => {
  await ask('stop');
  $('msg').textContent = 'Stopped. The agent cannot use this browser again in this task.';
  refresh();
});
refresh();
