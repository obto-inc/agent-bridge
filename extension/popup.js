'use strict';
const $ = (id) => document.getElementById(id);
const ask = (type) => chrome.runtime.sendMessage({ type });
const refresh = async () => {
  const s = await ask('status');
  if (!s || !s.native) {
    $('status').textContent = 'Not linked. Run `obto-bridge browser extension install` on this computer, then reopen Chrome.';
    return;
  }
  $('status').textContent = s.daemon
    ? 'Linked to the OBTO bridge. The agent works only in the "OBTO agent" tab group (' + s.tabs + ' tab' + (s.tabs === 1 ? '' : 's') + '), only on sites you allow.'
    : 'The OBTO bridge is not running on this computer. Start it with `obto-bridge start`.';
};
$('share').addEventListener('click', async () => {
  const r = await ask('share');
  $('msg').textContent = r && r.ok ? 'Shared as ' + r.tab + '. The agent can use it on sites you allow.' : (r && r.error) || 'Could not share this tab.';
  refresh();
});
$('stop').addEventListener('click', async () => {
  await ask('stop');
  $('msg').textContent = 'Stopped. The agent cannot use this browser again in this run.';
  refresh();
});
refresh();
