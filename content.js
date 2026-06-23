// YouTube SPA bootstrap for Lyve.
(async function init() {
  const base = chrome.runtime.getURL('modules/');

  const panelMod = await import(base + 'chatPanel.js');
  const msgsMod = await import(base + 'chatMessages.js');
  const emotesMod = await import(base + 'emotes.js');
  const storeMod = await import(base + 'messageStore.js');

  window.startRenderLoop = msgsMod.startRenderLoop;
  window.renderNow = msgsMod.renderNow;
  window.SevenTV = emotesMod.SevenTV;

  let activeVideoId = null;
  let lastUrl = location.href;
  let syncTimer = null;
  let unsubscribeMessages = null;
  let syncRun = 0;

  function getWatchVideoId() {
    if (location.pathname !== '/watch') return null;
    return new URL(location.href).searchParams.get('v');
  }

  function replaceMessages(nextMessages) {
    msgsMod.messages.length = 0;
    msgsMod.messages.push(...nextMessages);
    msgsMod.renderNow();
  }

  async function syncWithYouTubePage() {
    const runId = ++syncRun;
    lastUrl = location.href;
    const videoId = getWatchVideoId();

    if (!videoId) {
      if (activeVideoId) await storeMod.clearMessagesForVideo(activeVideoId);
      if (activeVideoId) panelMod.clearMessageCooldownForVideo(activeVideoId);
      unsubscribeMessages?.();
      unsubscribeMessages = null;
      activeVideoId = null;
      replaceMessages([]);
      panelMod.removeToggleButton();
      panelMod.removeChatPanel();
      msgsMod.stopRenderLoop();
      return;
    }

    if (activeVideoId && activeVideoId !== videoId) {
      await storeMod.clearMessagesForVideo(activeVideoId);
      panelMod.clearMessageCooldownForVideo(activeVideoId);
      unsubscribeMessages?.();
      unsubscribeMessages = null;
      replaceMessages([]);
      panelMod.removeToggleButton();
      panelMod.removeChatPanel();
    }
    const videoChanged = activeVideoId !== videoId;
    activeVideoId = videoId;

    if (videoChanged) {
      const loadedMessages = await storeMod.loadMessagesForVideo(videoId);
      if (runId !== syncRun || activeVideoId !== videoId) return;
      replaceMessages(loadedMessages);
      unsubscribeMessages = storeMod.subscribeToMessagesForVideo(videoId, nextMessages => {
        if (activeVideoId !== videoId) return;
        replaceMessages(nextMessages);
      });
    }

    panelMod.insertChatPanel();
    panelMod.insertToggleButton();
    msgsMod.startRenderLoop();
  }

  function scheduleSync() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncWithYouTubePage, 0);
  }

  // YouTube dispatches these during client-side navigation and layout swaps.
  window.addEventListener('yt-navigate-finish', scheduleSync);
  window.addEventListener('yt-page-data-updated', scheduleSync);
  window.addEventListener('popstate', scheduleSync);

  // Fallback for experiments that omit or rename those events.
  setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    scheduleSync();
  }, 750);

  syncWithYouTubePage();
})().catch((error) => {
  console.error('Lyve failed to initialize:', error);
});
