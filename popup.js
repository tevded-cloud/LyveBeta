const toggle = document.querySelector('#toggle');
const settings = document.querySelector('#settings');
const status = document.querySelector('#status');
let activeTabId = null;

async function run(func, args = []) {
  const [result] = await chrome.scripting.executeScript({ target: { tabId: activeTabId }, func, args });
  return result?.result;
}

function setState(available, on = false) {
  toggle.disabled = !available;
  settings.disabled = !available;
  toggle.classList.toggle('on', on);
  toggle.querySelector('span').textContent = on ? 'Hide Lyve' : 'Show Lyve';
  status.textContent = available ? (on ? 'Lyve is visible on this video.' : 'Lyve is hidden on this video.') : 'Open a YouTube video to use Lyve.';
}

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id;
  if (!activeTabId || !/^https:\/\/www\.youtube\.com\/watch/.test(tab.url || '')) return setState(false);
  try {
    const state = await run(() => {
      const panel = document.querySelector('#chat-panel');
      return { available: Boolean(panel), on: Boolean(panel && getComputedStyle(panel).display !== 'none') };
    });
    setState(Boolean(state?.available), Boolean(state?.on));
  } catch { setState(false); }
})();

toggle.addEventListener('click', async () => {
  const on = await run(() => {
    const button = document.querySelector('#toggle-live-chat-btn');
    if (!button) return false;
    button.click();
    return button.dataset.on === '1';
  });
  setState(true, Boolean(on));
});

settings.addEventListener('click', async () => {
  await run(() => {
    const panel = document.querySelector('#chat-panel');
    if (panel && getComputedStyle(panel).display === 'none') document.querySelector('#toggle-live-chat-btn')?.click();
    const playerSettings = document.querySelector('#lyve-player-settings-btn');
    const gear = document.querySelector('#chat-gear-btn');
    if (typeof gear?._openFrom === 'function') gear._openFrom(playerSettings || gear, { toggle: false, center: true });
    else gear?.click();
  });
  window.close();
});
