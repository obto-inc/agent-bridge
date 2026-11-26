'use strict';
const msg = document.getElementById('msg');
document.getElementById('agree').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'consent', agree: true });
  msg.textContent = 'Turned on. You can close this tab. The agent still needs your approval for each site, in OBTO.';
});
document.getElementById('later').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'consent', agree: false });
  msg.textContent = 'Not turned on. Open the OBTO agent menu in the toolbar when you are ready.';
});
