import { isAdmin, createSettingsUI, getOrCreateUserId, getOrCreateAccountCreatedAt, Clock, getSetting, getAccountStateCached, refreshAccountStateCache } from "./settings.js";
import { createEmojiPicker, attachEmoteAutocomplete } from "./emotes.js";
import {
  messages, insertMessageSorted, renderNow, startRenderLoop, scrollChatToCurrentTime,
  clearUnreadMessages, getUnreadMessageCount
} from "./chatMessages.js";
import { saveMessageForVideo } from "./messageStore.js";

// Shared lock state for the panel (default locked; updated from storage)
let isLocked = true;
// Expose for legacy checks (settings.js uses typeof isLocked)
window.isLocked = isLocked;

// Persist chat visibility across reloads
const CHAT_VISIBLE_KEY = 'chatVisible';
const PINNED_MESSAGES_KEY = 'lyvePinnedMessages';
const MESSAGE_SLOT_SECONDS = 3;
const _usedMessageSlotsByVideo = new Map();
let _pinnedStorageCacheRaw = null;
let _pinnedStorageCache = {};

function getCurrentVideoIdentity() {
  try {
    return new URL(location.href).searchParams.get('v') || location.pathname;
  } catch {
    return location.href;
  }
}

function readPinStorage() {
  try {
    const raw = localStorage.getItem(PINNED_MESSAGES_KEY) || '{}';
    if (raw !== _pinnedStorageCacheRaw) {
      _pinnedStorageCache = JSON.parse(raw);
      _pinnedStorageCacheRaw = raw;
    }
    return _pinnedStorageCache && typeof _pinnedStorageCache === 'object' ? _pinnedStorageCache : {};
  } catch {
    return {};
  }
}

function writePinStorage(all) {
  try {
    const raw = JSON.stringify(all);
    localStorage.setItem(PINNED_MESSAGES_KEY, raw);
    _pinnedStorageCache = all;
    _pinnedStorageCacheRaw = raw;
  } catch {}
}

function normalizePinRecord(record) {
  const startTime = Math.max(0, Number(record.startTime ?? record.pinnedAtVideoTime ?? record.time ?? 0));
  const rawMode = String(record.durationMode || '60');
  const durationMode = ['30', '60', '120', '300', 'until-next'].includes(rawMode) ? rawMode : '60';
  const fixedDuration = durationMode === 'until-next' ? 0 : Number(durationMode);
  const storedEnd = Number(record.endTime);
  return {
    ...record,
    pinId: record.pinId || crypto.randomUUID?.() || `pin_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    id: record.id || record.messageId || '',
    userId: record.userId || '',
    user: record.user || 'Unknown user',
    text: String(record.text || ''),
    time: Number(record.time || 0),
    startTime,
    durationMode,
    endTime: durationMode === 'until-next'
      ? null
      : (Number.isFinite(storedEnd) && storedEnd > startTime ? storedEnd : startTime + fixedDuration),
    createdAt: String(record.createdAt || record.pinnedAt || new Date().toISOString()),
  };
}

function getVideoPinSchedule(videoId = getCurrentVideoIdentity()) {
  const all = readPinStorage();
  const stored = all[videoId];
  if (!stored) return [];
  const source = Array.isArray(stored) ? stored : [stored];
  const schedule = source.map(normalizePinRecord).sort((a, b) => a.startTime - b.startTime || a.createdAt.localeCompare(b.createdAt));
  const needsMigration = !Array.isArray(stored) || source.some(record => !record.pinId || record.startTime === undefined || record.durationMode === undefined);
  if (needsMigration) {
    all[videoId] = schedule;
    writePinStorage(all);
  }
  return schedule;
}

function getPinEffectiveEnd(pin, schedule = getVideoPinSchedule()) {
  const index = schedule.findIndex(item => item.pinId === pin.pinId);
  const nextStart = index >= 0 ? Number(schedule[index + 1]?.startTime) : NaN;
  const ownEnd = pin.durationMode === 'until-next' ? Infinity : Number(pin.endTime);
  return Number.isFinite(nextStart) ? Math.min(ownEnd, nextStart) : ownEnd;
}

function hydratePinnedMessage(pin) {
  if (!pin) return null;
  const live = messages.find(message => message.id && message.id === pin.id)
    || messages.find(message => pin.userId && message.userId === pin.userId
      && Number(message.time || 0) === Number(pin.time || 0)
      && String(message.text || '') === String(pin.text || ''));
  return live ? { ...live, ...pin } : pin;
}

function getPinnedMessage(videoId = getCurrentVideoIdentity(), videoTime = Number(document.querySelector('video')?.currentTime || 0)) {
  const schedule = getVideoPinSchedule(videoId);
  const active = schedule
    .filter(pin => pin.startTime <= videoTime && videoTime < getPinEffectiveEnd(pin, schedule))
    .at(-1);
  return hydratePinnedMessage(active);
}

function isMessagePinned(message) {
  if (!message) return false;
  return getVideoPinSchedule().some(pin => isMessageMatch(pin, message));
}

function savePinnedMessage(message, { startTime = Number(message?.time || 0), durationMode = '60' } = {}) {
  if (!message) return null;
  const videoId = getCurrentVideoIdentity();
  const all = readPinStorage();
  const schedule = getVideoPinSchedule(videoId);
  const existing = schedule.find(pin => isMessageMatch(pin, message));
  const normalizedStart = Math.max(0, Math.floor(Number(startTime) || 0));
  const normalizedMode = ['30', '60', '120', '300', 'until-next'].includes(String(durationMode)) ? String(durationMode) : '60';
  const now = new Date().toISOString();
  const pin = normalizePinRecord({
    ...(existing || {}),
    pinId: existing?.pinId,
    id: message.id || existing?.id || '', userId: message.userId || existing?.userId || '',
    user: message.user || existing?.user || 'Unknown user', text: String(message.text || ''),
    time: Number(message.time || 0), accountCreatedAt: message.accountCreatedAt || existing?.accountCreatedAt || null,
    startTime: normalizedStart, durationMode: normalizedMode,
    endTime: normalizedMode === 'until-next' ? null : normalizedStart + Number(normalizedMode),
    createdAt: existing?.createdAt || now, updatedAt: now,
  });
  const replacedAtSameTime = schedule.filter(item => item.pinId !== existing?.pinId && item.startTime === normalizedStart);
  const nextSchedule = schedule.filter(item => item.pinId !== existing?.pinId && item.startTime !== normalizedStart);
  nextSchedule.push(pin);
  nextSchedule.sort((a, b) => a.startTime - b.startTime || a.createdAt.localeCompare(b.createdAt));
  all[videoId] = nextSchedule;
  writePinStorage(all);
  for (const replaced of replacedAtSameTime) {
    appendModerationAudit('message_unpinned', {
      actor: 'You', source: 'manual', message: replaced,
      targetUserId: replaced.userId, targetName: replaced.user,
      reason: `Replaced at video ${formatVideoTime(normalizedStart)}`,
    });
  }
  const effectiveEnd = getPinEffectiveEnd(pin, nextSchedule);
  appendModerationAudit(existing ? 'message_pin_updated' : 'message_pinned', {
    actor: 'You', source: 'manual', message: pin,
    targetUserId: pin.userId, targetName: pin.user,
    reason: `Video ${formatVideoTime(pin.startTime)} to ${Number.isFinite(effectiveEnd) ? formatVideoTime(effectiveEnd) : 'next pin or video end'}`,
  });
  window.dispatchEvent(new CustomEvent('lyve:pinned-message-changed', { detail: pin }));
  renderNow();
  return pin;
}

function isMessageMatch(first, second) {
  if (!first || !second) return false;
  if (first.id && second.id) return first.id === second.id;
  return Boolean(first.userId && first.userId === second.userId
    && Number(first.time || 0) === Number(second.time || 0)
    && String(first.text || '') === String(second.text || ''));
}

function clearPinnedMessage({ pinId = '', message = null, reason = 'Unpinned by moderator', actor = 'You', source = 'manual' } = {}) {
  const videoId = getCurrentVideoIdentity();
  const all = readPinStorage();
  const schedule = getVideoPinSchedule(videoId);
  const active = getPinnedMessage(videoId);
  const removed = schedule.filter(pin => pinId ? pin.pinId === pinId : message ? isMessageMatch(pin, message) : active?.pinId === pin.pinId);
  if (!removed.length) return;
  all[videoId] = schedule.filter(pin => !removed.some(item => item.pinId === pin.pinId));
  writePinStorage(all);
  for (const pinned of removed) {
    appendModerationAudit('message_unpinned', {
      actor, source, message: pinned,
      targetUserId: pinned.userId, targetName: pinned.user, reason,
    });
  }
  window.dispatchEvent(new CustomEvent('lyve:pinned-message-changed', { detail: null }));
  renderNow();
}

function clearPinsForUser(data, options = {}) {
  const videoId = getCurrentVideoIdentity();
  const all = readPinStorage();
  const schedule = getVideoPinSchedule(videoId);
  const removed = schedule.filter(pin => messageBelongsToUser(pin, data));
  if (!removed.length) return;
  all[videoId] = schedule.filter(pin => !removed.includes(pin));
  writePinStorage(all);
  for (const pin of removed) {
    appendModerationAudit('message_unpinned', {
      actor: options.actor || 'You', source: options.source || 'manual', message: pin,
      targetUserId: pin.userId, targetName: pin.user, reason: options.reason || 'Pinned user was banned',
    });
  }
  window.dispatchEvent(new CustomEvent('lyve:pinned-message-changed', { detail: null }));
  renderNow();
}

globalThis.lyveIsMessagePinned = isMessagePinned;

function getUsedMessageSlots(videoId) {
  if (!_usedMessageSlotsByVideo.has(videoId)) _usedMessageSlotsByVideo.set(videoId, new Set());
  return _usedMessageSlotsByVideo.get(videoId);
}

function clearMessageCooldownForVideo(videoId = getCurrentVideoIdentity()) {
  _usedMessageSlotsByVideo.delete(videoId);
}

function getSavedChatVisible() {
  const raw = localStorage.getItem(CHAT_VISIBLE_KEY);
  return raw === null ? true : raw === 'true';
}
function setSavedChatVisible(on) {
  try { localStorage.setItem(CHAT_VISIBLE_KEY, String(!!on)); } catch {}
}

let _toggleMountObserver = null;
let _pendingToggleButton = null;
let _toggleMountFallbackTimer = null;
let _toggleRepairObserver = null;
let _toggleRepairTimer = null;
let _toggleRepairActive = false;

// YouTube has shipped several action-bar implementations. Prefer the player
// controls, then fall back through both legacy and current watch metadata
// containers instead of depending on one private selector.
function findToggleMount() {
  const playerControls = document.querySelector(
    '#movie_player .ytp-right-controls, .html5-video-player .ytp-right-controls, #movie_player .ytp-right-controls-container'
  );
  if (playerControls?.isConnected) {
    return { element: playerControls, mode: 'player' };
  }

  // Some player experiments replace or rename the right-controls wrapper but
  // keep familiar native buttons. Their shared parent is the safest mount.
  const player = document.querySelector('#movie_player, .html5-video-player');
  const nativePlayerButton = player?.querySelector(
    '.ytp-settings-button, .ytp-fullscreen-button, .ytp-subtitles-button, button[aria-label*="Settings" i], button[aria-label*="Full screen" i]'
  );
  const inferredPlayerControls = nativePlayerButton?.parentElement;
  if (inferredPlayerControls?.isConnected && player.contains(inferredPlayerControls)) {
    return { element: inferredPlayerControls, mode: 'player' };
  }

  const actionSelectors = [
    'ytd-watch-metadata #actions-inner',
    '#above-the-fold #actions-inner',
    'ytd-watch-metadata #actions',
    '#above-the-fold #actions',
    'ytd-watch-metadata #top-level-buttons-computed',
    'ytd-video-primary-info-renderer #top-level-buttons-computed',
    'ytd-video-primary-info-renderer #menu-container',
    'yt-flexible-actions-view-model'
  ];

  for (const selector of actionSelectors) {
    const element = document.querySelector(selector);
    if (element?.isConnected) return { element, mode: 'action' };
  }

  return null;
}

function stopWaitingForButtonBar() {
  if (_toggleMountObserver) _toggleMountObserver.disconnect();
  _toggleMountObserver = null;
  clearTimeout(_toggleMountFallbackTimer);
  _toggleMountFallbackTimer = null;
}

function removeMountedToggleElements() {
  document.getElementById('toggle-live-chat-btn')?.remove();
  document.getElementById('lyve-player-settings-btn')?.remove();
  document.getElementById('lyve-overlay-toggle-btn')?.remove();
  document.getElementById('lyve-ytp-tip')?.remove();
}

function toggleButtonsAreHealthy() {
  const mount = findToggleMount();
  const toggle = document.getElementById('toggle-live-chat-btn');
  if (!mount) return Boolean(toggle?.isConnected && toggle.classList.contains('lyve-toggle--floating'));
  if (!toggle || !mount.element.contains(toggle)) return false;
  if (mount.mode !== 'player') return true;
  const settings = document.getElementById('lyve-player-settings-btn');
  const overlay = document.getElementById('lyve-overlay-toggle-btn');
  return Boolean(settings && overlay && mount.element.contains(settings) && mount.element.contains(overlay));
}

function stopToggleMountRepair() {
  _toggleRepairActive = false;
  _toggleRepairObserver?.disconnect();
  _toggleRepairObserver = null;
  clearTimeout(_toggleRepairTimer);
  _toggleRepairTimer = null;
}

function startToggleMountRepair() {
  _toggleRepairActive = true;
  if (_toggleRepairObserver) return;
  const scheduleRepair = () => {
    clearTimeout(_toggleRepairTimer);
    _toggleRepairTimer = setTimeout(() => {
      if (!_toggleRepairActive || _pendingToggleButton || toggleButtonsAreHealthy()) return;
      removeMountedToggleElements();
      insertToggleButton();
    }, 80);
  };
  _toggleRepairObserver = new MutationObserver(scheduleRepair);
  _toggleRepairObserver.observe(document.documentElement, { childList: true, subtree: true });
  scheduleRepair();
}

// Observe YouTube's SPA-rendered DOM rather than polling one legacy element.
function waitForButtonBar(callback) {
  const check = () => {
    const mount = findToggleMount();
    if (!mount) return false;
    stopWaitingForButtonBar();
    callback(mount.element, mount.mode);
    return true;
  };

  if (check()) return;
  stopWaitingForButtonBar();

  let scheduled = false;
  _toggleMountObserver = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      check();
    });
  });
  _toggleMountObserver.observe(document.documentElement, { childList: true, subtree: true });

  // Never strand a hidden panel without a way to reopen it. If a YouTube
  // experiment exposes none of the known mounts, provide a temporary launcher.
  _toggleMountFallbackTimer = setTimeout(() => {
    stopWaitingForButtonBar();
    if (document.body) callback(document.body, 'floating');
  }, 4000);
}

// Insert toggle button styled like YouTube
function insertToggleButton() {
  // YouTube frequently replaces its control bar after the page is already
  // mounted. Keep a healthy set, but rebuild partial or detached sets.
  const existingToggle = document.getElementById('toggle-live-chat-btn');
  if (existingToggle && toggleButtonsAreHealthy()) {
    startToggleMountRepair();
    return existingToggle;
  }
  if (_pendingToggleButton) return _pendingToggleButton;
  if (existingToggle || document.getElementById('lyve-player-settings-btn') || document.getElementById('lyve-overlay-toggle-btn')) {
    removeMountedToggleElements();
  }

  // --- tiny CSS shim: kill YT underline/focus and size our button 36x36 like others
  if (!document.getElementById('lyve-toggle-css')) {
    const st = document.createElement('style');
    st.id = 'lyve-toggle-css';
    st.textContent = `
      #toggle-live-chat-btn::before,
      #toggle-live-chat-btn::after,
      #toggle-live-chat-btn[aria-pressed="true"]::before,
      #toggle-live-chat-btn[aria-pressed="true"]::after { content:none!important; display:none!important; }
      #toggle-live-chat-btn:focus, #toggle-live-chat-btn:focus-visible { outline:none!important; box-shadow:none!important; }
      #toggle-live-chat-btn {
        display:inline-flex!important; align-items:center!important; justify-content:center!important;
        width:48px!important; height:48px!important; padding:0!important; margin:0!important;
        background:transparent!important; border:none!important; line-height:0; vertical-align:middle;
      }
      #toggle-live-chat-btn .lyve-switch { margin:0!important; }
      #toggle-live-chat-btn .lyve-knob { top:50%!important; transform:translateY(-50%)!important; }
      #toggle-live-chat-btn .lyve-action-label { display:none; }
      #toggle-live-chat-btn.lyve-toggle--action {
        width:auto!important; min-width:96px!important; height:36px!important;
        padding:0 14px!important; margin:0 0 0 8px!important;
        border-radius:18px!important; background:#272727!important;
        color:#fff!important; font:500 14px/36px Roboto,Arial,sans-serif!important;
      }
      #toggle-live-chat-btn.lyve-toggle--action .lyve-switch { display:none!important; }
      #toggle-live-chat-btn.lyve-toggle--action .lyve-action-label { display:inline!important; }
      #toggle-live-chat-btn.lyve-toggle--floating {
        position:fixed!important; top:72px!important; right:20px!important;
        z-index:10002!important; box-shadow:0 4px 14px rgba(0,0,0,.35)!important;
      }
      #lyve-player-settings-btn,#lyve-overlay-toggle-btn{display:inline-grid!important;place-items:center!important;width:48px!important;height:48px!important;padding:0!important;color:#fff!important;background:transparent!important;border:0!important}
      #lyve-player-settings-btn svg,#lyve-overlay-toggle-btn svg{width:18px;height:18px}
      #lyve-overlay-toggle-btn[data-on="true"]{color:#ff6661!important}
    `;
    document.head.appendChild(st);
  }

  // --- builder ---
  const buildBtn = () => {
    const btn = document.createElement('button');
    btn.id = 'toggle-live-chat-btn';
    btn.type = 'button';
    btn.className = 'ytp-button';
    Object.assign(btn.style, {
      position: 'relative',   // we’ll adjust a tiny top offset after measuring
      zIndex: '2025'
    });

    // Track 30x14
    const track = document.createElement('div');
    track.className = 'lyve-switch';
    Object.assign(track.style, {
  width: '30px', height: '14px', borderRadius: '7px',
  background: 'rgba(255,255,255,.25)',
  position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'flex-start',
  pointerEvents: 'none', overflow: 'visible'   // allow knob to show outside the pill
});

    // Knob 14x14 (your icon)
    const knob = document.createElement('div');
    knob.className = 'lyve-knob';
    Object.assign(knob.style, {
  width: '18px', height: '18px', borderRadius: '6px',
  position: 'absolute', left: '-2px', transition: 'left .18s ease',
  boxShadow: '0 0 0 1px rgba(0,0,0,.35)', backgroundColor: '#0f0f0f',
  pointerEvents: 'none'  // clicks go to the button
});
    const img = document.createElement('img');
    img.alt = 'Lyve';
    img.src = chrome.runtime.getURL('assets/lyve-icon-32.png');
    Object.assign(img.style, { width: '100%', height: '100%', objectFit: 'contain', display: 'block', transform: 'none', transformOrigin: 'center' });
    knob.appendChild(img);
    track.appendChild(knob);
    btn.appendChild(track);

    const actionLabel = document.createElement('span');
    actionLabel.className = 'lyve-action-label';
    actionLabel.textContent = 'Lyve';
    btn.appendChild(actionLabel);

        // Tooltip (match YouTube look; no OS tooltip bubble)
    const playerEl = document.querySelector('#movie_player');
    function ensureLyveTip() {
      if (!playerEl) return null;
      let el = playerEl.querySelector('#lyve-ytp-tip');
      if (!el) {
        el = document.createElement('div');
        el.id = 'lyve-ytp-tip';
        Object.assign(el.style, {
  position: 'absolute',
  display: 'none',
  zIndex: '3000',
  pointerEvents: 'none',
  background: 'rgba(15,15,15,.92)',
  color: '#fff',
  fontWeight: '700',
  padding: '4px 6px',
borderRadius: '5px',
fontSize: '12px'
});
        playerEl.appendChild(el);
      }
      return el;
    }
    function showLyveTip(text) {
      const tip = ensureLyveTip(); if (!tip) return;
      tip.textContent = text;
      tip.style.display = 'block';
      // place centered above the button
      const br = btn.getBoundingClientRect();
      const pr = playerEl.getBoundingClientRect();
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      let left = br.left - pr.left + (br.width / 2) - (tw / 2);
      left = Math.max(8, Math.min(left, pr.width - tw - 8));
      let top = br.top - pr.top - th - 18;
      top = Math.max(8, top);
      tip.style.left = left + 'px';
      tip.style.top  = top  + 'px';
    }
    function hideLyveTip() {
      const tip = playerEl && playerEl.querySelector('#lyve-ytp-tip');
      if (tip) tip.style.display = 'none';
    }

    // State
    const setState = (on) => {
            btn.dataset.on = on ? '1' : '0';
      btn.setAttribute('aria-pressed', String(on));
      btn.setAttribute('aria-label', on ? 'Lyve is on' : 'Lyve is off');
      btn.removeAttribute('title'); // avoid OS tooltip
      track.style.background = on ? 'rgba(255,0,0,.6)' : 'rgba(255,255,255,.25)';
      knob.style.left = on ? '14px' : '-2px';
    };
    const panel = document.getElementById('chat-panel');
    setState(!!(panel && getComputedStyle(panel).display !== 'none'));
        // Show YouTube-like tooltip on hover/focus
    const _tipText = () => (btn.dataset.on === '1' ? 'Lyve is on' : 'Lyve is off');
    btn.addEventListener('mouseenter', () => showLyveTip(_tipText()));
    btn.addEventListener('mouseleave', hideLyveTip);
    btn.addEventListener('focus',     () => showLyveTip(_tipText()));
    btn.addEventListener('blur',      hideLyveTip);

    // Toggle handler
    btn.addEventListener('click', (e) => {
  e.preventDefault(); e.stopPropagation();
  let nowOn = false;
  let chat = document.getElementById('chat-panel');
  if (!chat) {
    insertChatPanel();
    chat = document.getElementById('chat-panel');
    nowOn = true;
  } else {
    const visible = !chat.classList.contains('lyve-hidden') && getComputedStyle(chat).display !== 'none';
    nowOn = !visible;
  }
  if (chat) {
    chat.classList.toggle('lyve-hidden', !nowOn);
    chat.style.display = nowOn ? 'flex' : 'none';
  }
  if (nowOn) startRenderLoop();
  setSavedChatVisible(nowOn);
  setState(nowOn);
  const tip = document.querySelector('#movie_player #lyve-ytp-tip');
  if (tip && tip.style.display === 'block') showLyveTip(nowOn ? 'Lyve is on' : 'Lyve is off');
}, true);

    btn.addEventListener('mousedown', (e) => e.stopPropagation(), true);

    // Expose a method we’ll call after insertion to align vertically
    btn._alignTo = (controls) => {
      const ref = controls.querySelector('.ytp-subtitles-button') ||
                  controls.querySelector('.ytp-settings-button');
      if (!ref) return;
      // measure twice (after layout settles)
      const align = () => {
        const br = btn.getBoundingClientRect();
        const rr = ref.getBoundingClientRect();
        const delta = Math.round(((rr.top + rr.bottom) - (br.top + br.bottom)) / 2);
        if (Math.abs(delta) > 0) {
          const cur = parseFloat(btn.style.top || '0') || 0;
          btn.style.top = (cur + delta) + 'px';
        }
      };
      requestAnimationFrame(() => requestAnimationFrame(align));
      // keep it correct if controls resize
      try {
        const ro = new ResizeObserver(() => requestAnimationFrame(align));
        ro.observe(controls);
      } catch {}
      window.addEventListener('resize', () => requestAnimationFrame(align), { passive: true });
    };

    btn._setPresentation = (mode) => {
      const inPlayer = mode === 'player';
      btn.className = inPlayer
        ? 'ytp-button lyve-toggle--player'
        : `lyve-toggle--action${mode === 'floating' ? ' lyve-toggle--floating' : ''}`;
      btn.style.top = '0px';
    };

    return btn;
  };

  const btn = buildBtn();
  const playerSettingsBtn = document.createElement('button');
  playerSettingsBtn.id = 'lyve-player-settings-btn';
  playerSettingsBtn.type = 'button';
  playerSettingsBtn.className = 'ytp-button';
  playerSettingsBtn.title = 'Lyve settings';
  playerSettingsBtn.setAttribute('aria-label', 'Open Lyve settings');
  playerSettingsBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 00-1.88-.34A1.7 1.7 0 0014 20.92V21h-4v-.08A1.7 1.7 0 009 19.37a1.7 1.7 0 00-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 004.63 15 1.7 1.7 0 003.08 14H3v-4h.08A1.7 1.7 0 004.63 9a1.7 1.7 0 00-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 009 4.63 1.7 1.7 0 0010 3.08V3h4v.08a1.7 1.7 0 001.03 1.55 1.7 1.7 0 001.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0019.37 9c.25.61.85 1 1.55 1H21v4h-.08A1.7 1.7 0 0019.4 15z"/></svg>';
  playerSettingsBtn.addEventListener('click', event => {
    event.preventDefault(); event.stopPropagation();
    const panel = document.getElementById('chat-panel');
    if (panel && getComputedStyle(panel).display === 'none') btn.click();
    const settingsGear = document.getElementById('chat-gear-btn');
    if (typeof settingsGear?._openFrom === 'function') settingsGear._openFrom(playerSettingsBtn, { center: true });
    else settingsGear?.click();
  }, true);
  const overlayToggleBtn = document.createElement('button');
  overlayToggleBtn.id = 'lyve-overlay-toggle-btn'; overlayToggleBtn.type = 'button'; overlayToggleBtn.className = 'ytp-button';
  overlayToggleBtn.title = 'Toggle minimal Lyve overlay'; overlayToggleBtn.setAttribute('aria-label', 'Toggle minimal Lyve overlay');
  overlayToggleBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 14h7M7 10h10M16 16h2"/></svg>';
  const syncOverlayToggle = () => { overlayToggleBtn.dataset.on = String(getSetting('chatDisplayMode', 'window') !== 'window'); };
  overlayToggleBtn.addEventListener('click', event => {
    event.preventDefault(); event.stopPropagation();
    const enabled = getSetting('chatDisplayMode', 'window') !== 'window';
    const next = enabled ? 'window' : (document.fullscreenElement ? 'fullscreen' : 'always');
    localStorage.setItem('chatDisplayMode', next);
    const select = document.querySelector('#chat-settings-popup #set-display-mode'); if (select) select.value = next;
    if (!enabled) {
      const chat = document.getElementById('chat-panel');
      if (chat) {
        chat.classList.remove('lyve-hidden');
        chat.style.display = 'flex';
        setSavedChatVisible(true);
        btn.dataset.on = '1';
        btn.setAttribute('aria-pressed', 'true');
        const track = btn.querySelector('.lyve-switch'); const knob = btn.querySelector('.lyve-knob');
        if (track) track.style.background = 'rgba(255,0,0,.6)';
        if (knob) knob.style.left = '14px';
      }
    }
    syncOverlayToggle();
    window.dispatchEvent(new CustomEvent('lyve:display-mode-changed'));
  }, true);
  window.addEventListener('lyve:display-mode-changed', syncOverlayToggle);
  syncOverlayToggle();
  _pendingToggleButton = btn;

  waitForButtonBar((mount, mode) => {
    if (document.getElementById('toggle-live-chat-btn')) {
      _pendingToggleButton = null;
      return;
    }

    btn._setPresentation(mode);
    if (mode === 'player') {
      let anchor = mount.querySelector('.ytp-autonav-toggle-button-container, .ytp-autonav-toggle-button');
      while (anchor && anchor.parentElement !== mount) anchor = anchor.parentElement;
      if (anchor) mount.insertBefore(btn, anchor);
      else mount.insertBefore(btn, mount.firstChild);
      btn.insertAdjacentElement('afterend', playerSettingsBtn);
      playerSettingsBtn.insertAdjacentElement('afterend', overlayToggleBtn);
      btn._alignTo(mount);
    } else if (mode === 'action') {
      const overflow = mount.querySelector(':scope > yt-overflow-menu-view-model, :scope > ytd-menu-renderer');
      if (overflow) mount.insertBefore(btn, overflow);
      else mount.appendChild(btn);
    } else {
      mount.appendChild(btn);
    }
    _pendingToggleButton = null;
  });

  startToggleMountRepair();

  return btn;
}

function removeToggleButton() {
  stopToggleMountRepair();
  stopWaitingForButtonBar();
  _pendingToggleButton = null;
  removeMountedToggleElements();
}

// Create chat panel UI
function insertChatPanel() {
  if (document.getElementById("chat-panel")) return;

  const savedLocked = localStorage.getItem('chatIsLocked');
  isLocked = savedLocked === null ? true : (savedLocked === 'true');
window.isLocked = isLocked;
  

  const savedLeft   = localStorage.getItem('chatLeft')  || localStorage.getItem('chatFreeLeft');
  const savedTop    = localStorage.getItem('chatTop')   || localStorage.getItem('chatFreeTop');
  const savedWidth  = localStorage.getItem('chatFreeWidth')  || localStorage.getItem('chatWidth');
  const savedHeight = localStorage.getItem('chatFreeHeight') || localStorage.getItem('chatHeight');

  const defaultDock = getSetting('chatDefaultDock', 'br');

  const panel = document.createElement("div");
  panel.id = "chat-panel";
  panel.style.backgroundColor = "#1e1e1e";
  panel.style.borderRadius = "8px";
  panel.style.display = getSavedChatVisible() ? "flex" : "none";
  panel.classList.toggle('lyve-hidden', !getSavedChatVisible());
  panel.style.flexDirection = "column";
  panel.style.overflow = "hidden";
  panel.style.zIndex = "10000";
  panel.style.boxShadow = "0 0 10px rgba(0,0,0,0.5)";
  panel.style.userSelect = "none";
  panel.style.resize = "none";

  if (isLocked) {
    panel.style.width = savedWidth || "340px";
    panel.style.height = savedHeight || "500px";
    panel.style.position = "fixed";
    setDockPosition(panel, defaultDock);
  } else {
    panel.style.width = savedWidth  || "320px";
    panel.style.height = savedHeight || "400px";
    panel.style.position = "fixed";
    if (savedLeft && savedTop) { panel.style.left = savedLeft; panel.style.top  = savedTop; }
  }

  // header
  const header = document.createElement("div");
  header.id = "chat-header";
  header.className = "chat-header";
  header.style.cursor = isLocked ? "default" : "grab";
  header.style.background = "#202020";
  header.style.color = "#fff";
  header.style.fontWeight = "bold";
  header.style.display = "flex";
  header.style.alignItems = "center";
  header.style.justifyContent = "space-between";
  header.style.padding = "8px 10px";
  header.style.userSelect = "none";

  const titleContainer = document.createElement("div");
  titleContainer.className = 'chat-title-container';
  titleContainer.style.display = "flex";
  titleContainer.style.alignItems = "center";

  const icon = document.createElement("img");
  icon.src = chrome.runtime.getURL('assets/lyve-icon-32.png');
  icon.alt = "Lyve";
  icon.style.height = "20px";
  icon.style.width = "20px";
  icon.style.borderRadius = "3px";
  icon.style.marginRight = "8px";

  const title = document.createElement("span");
  title.className = 'chat-title-text';
  title.textContent = "Lyve";
  title.style.fontSize = "14px";
  title.style.fontWeight = "bold";

  titleContainer.appendChild(icon);
  titleContainer.appendChild(title);
  header.appendChild(titleContainer);

  const closeBtn = document.createElement("button");
  closeBtn.textContent = "✕";
  Object.assign(closeBtn.style, {
    background: "none", border: "none", color: "#fff", cursor: "pointer",
    fontSize: "16px", marginLeft: "8px"
  });
  closeBtn.onclick = () => {
  closeParticipants();
  closeModerationQueue();
  closeReportDialog();
  closeBanDialog();
  closeUserHistory();
  closeInspector();
  panel.style.display = "none";
  panel.classList.add('lyve-hidden');
  setSavedChatVisible(false);
  const tbtn = document.getElementById('toggle-live-chat-btn');
  if (tbtn) {
    tbtn.dataset.on = '0';
    tbtn.setAttribute('aria-pressed', 'false');
    tbtn.removeAttribute('title');
    const track = tbtn.querySelector('.lyve-switch');
    const knob  = tbtn.querySelector('.lyve-knob');
    if (track) track.style.background = 'rgba(255,255,255,.25)';
    if (knob)  knob.style.left = '-2px';
  }
};

  const lockBtn = document.createElement("button");
  lockBtn.id = "chat-lock-toggle";
  lockBtn.textContent = isLocked ? "🔒" : "🔓";
  Object.assign(lockBtn.style, {
    background: "none", border: "none", color: "#fff", cursor: "pointer",
    fontSize: "16px", marginRight: "6px"
  });
  lockBtn.addEventListener("click", () => {
    isLocked = !isLocked;
    window.isLocked = isLocked;
    localStorage.setItem('chatIsLocked', String(isLocked));
    lockBtn.textContent = isLocked ? "🔒" : "🔓";
    header.style.cursor = isLocked ? "default" : "grab";

    if (isLocked) {
      const rect = panel.getBoundingClientRect();
      localStorage.setItem('chatFreeLeft',   panel.style.left || `${rect.left}px`);
      localStorage.setItem('chatFreeTop',    panel.style.top  || `${rect.top}px`);
      localStorage.setItem('chatFreeWidth',  panel.style.width  || `${rect.width}px`);
      localStorage.setItem('chatFreeHeight', panel.style.height || `${rect.height}px`);

      panel.style.position = "fixed";
      setDockPosition(panel, getSetting('chatDefaultDock', 'br'));
      panel.style.left = "";
      panel.style.width = `${rect.width}px`;
      panel.style.height = `${rect.height}px`;
    } else {
      panel.style.position = "fixed";
      panel.style.right = "";
      panel.style.bottom = "";
      const w = localStorage.getItem('chatFreeWidth');
      const h = localStorage.getItem('chatFreeHeight');
      if (w) panel.style.width = w;
      if (h) panel.style.height = h;
      const freeL = localStorage.getItem('chatFreeLeft') || localStorage.getItem('chatLeft');
      const freeT = localStorage.getItem('chatFreeTop')  || localStorage.getItem('chatTop');
      if (freeL && freeT) {
        panel.style.left = freeL;
        panel.style.top  = freeT;
      } else {
        const rect = panel.getBoundingClientRect();
        const left = window.innerWidth  - rect.width  - 20;
        const top  = window.innerHeight - rect.height - 15;
        panel.style.left = `${Math.max(0, left)}px`;
        panel.style.top  = `${Math.max(0, top)}px`;
      }
      if (!panel._dragBound && typeof enableDrag === 'function') enableDrag(panel);
    }
  });

  const gearBtn = createSettingsUI(panel, header);

  // admin badge
  const adminBadge = document.createElement("span");
  adminBadge.id = "chat-admin-badge";
  adminBadge.title = "Admin enabled";
  adminBadge.textContent = "🛡️";
  adminBadge.style.marginRight = "6px";
  adminBadge.style.fontSize = "16px";
  adminBadge.style.display = isAdmin() ? "inline-flex" : "none";

  const participantsBtn = document.createElement('button');
  participantsBtn.id = 'chat-participants-btn';
  participantsBtn.type = 'button';
  participantsBtn.title = 'Participants';
  participantsBtn.setAttribute('aria-label', 'Open video participants');
  participantsBtn.setAttribute('aria-expanded', 'false');
  participantsBtn.innerHTML = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>`;
  Object.assign(participantsBtn.style, {
    display: isAdmin() ? 'grid' : 'none', placeItems: 'center', width: '28px', height: '28px',
    padding: '0', marginRight: '4px', borderRadius: '7px', color: '#b8b8b8',
  });
  participantsBtn.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    showParticipantsNear(participantsBtn);
  });

  const moderationQueueBtn = document.createElement('button');
  moderationQueueBtn.id = 'chat-moderation-queue-btn';
  moderationQueueBtn.type = 'button';
  moderationQueueBtn.title = 'Moderation queue';
  moderationQueueBtn.setAttribute('aria-label', 'Open moderation queue');
  moderationQueueBtn.setAttribute('aria-expanded', 'false');
  moderationQueueBtn.innerHTML = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><path d="M5 21V4m0 0h11l-1.5 3L16 10H5"/></svg>`;
  const moderationBadge = document.createElement('span');
  moderationBadge.className = 'moderation-queue-badge';
  moderationBadge.hidden = true;
  moderationQueueBtn.appendChild(moderationBadge);
  Object.assign(moderationQueueBtn.style, {
    display: isAdmin() ? 'grid' : 'none', placeItems: 'center', position: 'relative', width: '28px', height: '28px',
    padding: '0', marginRight: '4px', borderRadius: '7px', color: '#b8b8b8',
  });
  moderationQueueBtn.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    showModerationQueueNear(moderationQueueBtn);
  });

  const buttonContainer = document.createElement("div");
  buttonContainer.style.display = "flex";
  buttonContainer.style.alignItems = "center";
  buttonContainer.style.marginLeft = "auto";
  buttonContainer.appendChild(adminBadge);
  buttonContainer.appendChild(moderationQueueBtn);
  buttonContainer.appendChild(participantsBtn);
  buttonContainer.appendChild(gearBtn);
  buttonContainer.appendChild(lockBtn);
  buttonContainer.appendChild(closeBtn);
  header.appendChild(buttonContainer);

  // header buttons shouldn't start a drag
  function preventDrag(el) {
    ['pointerdown','mousedown','touchstart'].forEach(evt =>
      el.addEventListener(evt, e => e.stopPropagation(), { passive: evt === 'touchstart' })
    );
  }
  preventDrag(moderationQueueBtn); preventDrag(participantsBtn); preventDrag(gearBtn); preventDrag(lockBtn); preventDrag(closeBtn);

  updateModerationQueueBadge();
  window.addEventListener('lyve:reports-changed', updateModerationQueueBadge);

  window.addEventListener('lyve:admin-enabled', () => {
    adminBadge.style.display = "inline-flex";
    moderationQueueBtn.style.display = 'grid';
    participantsBtn.style.display = 'grid';
    updateModerationQueueBadge();
    document.querySelectorAll('.chat-username').forEach(el => el.style.cursor = 'pointer');
  });

  // messages
  const messagesContainer = document.createElement("div");
  messagesContainer.id = "chat-messages";
  messagesContainer.style.flex = "1";
  messagesContainer.style.overflowY = "auto";
  messagesContainer.style.display = "flex";
  messagesContainer.style.flexDirection = "column";
  messagesContainer.style.gap = "6px";      // single source of spacing
  messagesContainer.style.padding = "10px";
  messagesContainer.style.userSelect = "text";

  const messagesStage = document.createElement('div');
  messagesStage.id = 'chat-message-stage';
  const returnToCurrentBtn = document.createElement('button');
  returnToCurrentBtn.id = 'chat-return-current';
  returnToCurrentBtn.type = 'button';
  returnToCurrentBtn.textContent = 'Return to current time';
  returnToCurrentBtn.hidden = true;
  returnToCurrentBtn.addEventListener('click', () => {
    clearUnreadMessages();
    scrollChatToCurrentTime(messagesContainer);
    returnToCurrentBtn.hidden = true;
  });
  const newMessagesBtn = document.createElement('button');
  newMessagesBtn.id = 'chat-new-messages';
  newMessagesBtn.type = 'button';
  newMessagesBtn.hidden = true;
  newMessagesBtn.addEventListener('click', () => {
    clearUnreadMessages();
    scrollChatToCurrentTime(messagesContainer);
    newMessagesBtn.hidden = true;
    returnToCurrentBtn.hidden = true;
  });
  messagesStage.append(messagesContainer, newMessagesBtn, returnToCurrentBtn);

  const pinnedBanner = document.createElement('section');
  pinnedBanner.id = 'chat-pinned-banner';
  pinnedBanner.hidden = true;
  pinnedBanner.setAttribute('aria-live', 'polite');
  const pinnedIcon = document.createElement('span');
  pinnedIcon.className = 'chat-pinned-icon';
  pinnedIcon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6Zm3 11v7"/></svg>';
  const pinnedCopy = document.createElement('div');
  pinnedCopy.className = 'chat-pinned-copy';
  const pinnedLabel = document.createElement('div');
  pinnedLabel.className = 'chat-pinned-label';
  pinnedLabel.textContent = 'Pinned message';
  const pinnedText = document.createElement('div');
  pinnedText.className = 'chat-pinned-text';
  pinnedCopy.append(pinnedLabel, pinnedText);
  const pinnedActions = document.createElement('div');
  pinnedActions.className = 'chat-pinned-actions';
  const watchPinnedButton = document.createElement('button');
  watchPinnedButton.type = 'button'; watchPinnedButton.textContent = 'Watch';
  watchPinnedButton.setAttribute('aria-label', 'Watch from pinned message');
  const unpinButton = document.createElement('button');
  unpinButton.type = 'button'; unpinButton.className = 'chat-pinned-unpin'; unpinButton.textContent = '×';
  unpinButton.title = 'Unpin message'; unpinButton.setAttribute('aria-label', 'Unpin message');
  pinnedActions.append(watchPinnedButton, unpinButton);
  pinnedBanner.append(pinnedIcon, pinnedCopy, pinnedActions);

  const renderPinnedBanner = () => {
    const currentVideoTime = Number(document.querySelector('video')?.currentTime || 0);
    const pinned = getPinnedMessage(getCurrentVideoIdentity(), currentVideoTime);
    if (!pinned) {
      pinnedBanner.hidden = true;
      delete pinnedBanner.dataset.pinId;
      pinnedText.replaceChildren();
      return;
    }
    const schedule = getVideoPinSchedule();
    const effectiveEnd = getPinEffectiveEnd(pinned, schedule);
    const remainingSeconds = Number.isFinite(effectiveEnd) ? Math.max(0, effectiveEnd - currentVideoTime) : Infinity;
    pinnedBanner.hidden = false;
    pinnedBanner.dataset.pinId = pinned.pinId || '';
    pinnedLabel.textContent = Number.isFinite(remainingSeconds)
      ? `Pinned message · ${formatVideoTime(Math.ceil(remainingSeconds))} left`
      : 'Pinned message · Until next pin';
    const author = document.createElement('strong'); author.textContent = pinned.user || 'Unknown user';
    const text = document.createElement('span'); text.textContent = pinned.text || '';
    pinnedText.replaceChildren(author, document.createTextNode(': '), text);
    unpinButton.hidden = !isAdmin();
  };
  watchPinnedButton.addEventListener('click', () => {
    const pinned = getPinnedMessage();
    if (pinned) watchFromMessage(pinned);
  });
  unpinButton.addEventListener('click', () => clearPinnedMessage());
  const pinnedChangedHandler = () => renderPinnedBanner();
  const pinnedNavigationHandler = () => requestAnimationFrame(renderPinnedBanner);
  const pinnedVisibilityTimer = setInterval(renderPinnedBanner, 500);
  window.addEventListener('lyve:pinned-message-changed', pinnedChangedHandler);
  window.addEventListener('lyve:display-mode-changed', pinnedChangedHandler);
  window.addEventListener('lyve:admin-enabled', pinnedChangedHandler);
  document.addEventListener('yt-navigate-finish', pinnedNavigationHandler);
  panel._pinnedCleanup = () => {
    window.removeEventListener('lyve:pinned-message-changed', pinnedChangedHandler);
    window.removeEventListener('lyve:display-mode-changed', pinnedChangedHandler);
    window.removeEventListener('lyve:admin-enabled', pinnedChangedHandler);
    document.removeEventListener('yt-navigate-finish', pinnedNavigationHandler);
    clearInterval(pinnedVisibilityTimer);
  };
  renderPinnedBanner();

  // Composer: reply context, stable input geometry, and visible send cooldown.
  const composer = document.createElement('div');
  composer.id = 'chat-composer';

  const onboardingCard = document.createElement('section');
  onboardingCard.className = 'chat-onboarding-card';
  onboardingCard.setAttribute('role', 'note');
  onboardingCard.hidden = localStorage.getItem('lyveFirstUseIntroDismissed') === 'true';
  const onboardingCopy = document.createElement('div');
  onboardingCopy.className = 'chat-onboarding-copy';
  const onboardingTitle = document.createElement('strong');
  onboardingTitle.textContent = 'Welcome to Lyve';
  const onboardingText = document.createElement('span');
  onboardingText.textContent = 'Messages are tied to the video timestamp, so chat replays with the moment you’re watching.';
  onboardingCopy.append(onboardingTitle, onboardingText);
  const onboardingActions = document.createElement('div');
  onboardingActions.className = 'chat-onboarding-actions';
  const onboardingStart = document.createElement('button');
  onboardingStart.type = 'button';
  onboardingStart.textContent = 'Start chatting';
  const onboardingDismiss = document.createElement('button');
  onboardingDismiss.type = 'button';
  onboardingDismiss.textContent = 'Got it';
  onboardingDismiss.className = 'secondary';
  const dismissOnboarding = () => {
    onboardingCard.hidden = true;
    try { localStorage.setItem('lyveFirstUseIntroDismissed', 'true'); } catch {}
  };
  onboardingStart.addEventListener('click', () => input?.focus());
  onboardingDismiss.addEventListener('click', dismissOnboarding);
  onboardingActions.append(onboardingStart, onboardingDismiss);
  onboardingCard.append(onboardingCopy, onboardingActions);

  const replyBar = document.createElement('div');
  replyBar.id = 'chat-reply-bar';
  replyBar.hidden = true;

  const replyCopy = document.createElement('div');
  replyCopy.className = 'chat-reply-copy';
  const replyLabel = document.createElement('strong');
  const replySnippet = document.createElement('span');
  replyCopy.append(replyLabel, replySnippet);

  const cancelReplyBtn = document.createElement('button');
  cancelReplyBtn.type = 'button';
  cancelReplyBtn.className = 'chat-reply-cancel';
  cancelReplyBtn.textContent = '×';
  cancelReplyBtn.setAttribute('aria-label', 'Cancel reply');
  replyBar.append(replyCopy, cancelReplyBtn);

  const inputContainer = document.createElement('div');
  inputContainer.id = 'chat-input-row';

  const inputWrap = document.createElement('div');
  inputWrap.className = 'chat-input-shell';

  const input = document.createElement('input');
  input.id = 'chat-input';
  input.type = 'text';
  input.placeholder = 'Type a message…';
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('autocorrect', 'off');
  input.setAttribute('autocapitalize', 'off');
  input.setAttribute('spellcheck', 'false');
  input.setAttribute('enterkeyhint', 'send');
  const shieldTypingFromYouTube = event => {
    if (getSetting('chatProtectTypingShortcuts', true) === true) event.stopPropagation();
  };

  const emojiBtn = document.createElement('button');
  emojiBtn.id = 'chat-emoji-btn';
  emojiBtn.innerHTML = `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8" />
      <circle cx="9" cy="10" r="1.1" fill="currentColor" />
      <circle cx="15" cy="10" r="1.1" fill="currentColor" />
      <path d="M8 14c1 1.7 2.3 2.5 4 2.5s3-.8 4-2.5" fill="none" stroke="currentColor"
        stroke-width="1.8" stroke-linecap="round" />
    </svg>`;
  emojiBtn.title = 'Emotes';
  emojiBtn.setAttribute('aria-label', 'Open emote picker');
  emojiBtn.type = 'button';
  emojiBtn.addEventListener('mousedown', (e) => e.preventDefault());

  const sendBtn = document.createElement('button');
  sendBtn.id = 'chat-send-btn';
  sendBtn.textContent = 'Send';
  sendBtn.type = 'button';
  sendBtn.addEventListener('mousedown', (e) => e.preventDefault());

  const overlayDragHandle = document.createElement('button');
  overlayDragHandle.id = 'chat-overlay-drag-handle';
  overlayDragHandle.type = 'button';
  overlayDragHandle.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/></svg>';
  overlayDragHandle.title = 'Edit overlay size and position';
  overlayDragHandle.setAttribute('aria-label', overlayDragHandle.title);
  overlayDragHandle.setAttribute('aria-pressed', 'false');
  overlayDragHandle.addEventListener('click', event => {
    event.preventDefault(); event.stopPropagation();
    panel.classList.toggle('lyve-overlay-editing');
    overlayDragHandle.setAttribute('aria-pressed', String(panel.classList.contains('lyve-overlay-editing')));
  });

  const cooldownStatus = document.createElement('div');
  cooldownStatus.id = 'chat-cooldown-status';
  cooldownStatus.setAttribute('aria-live', 'polite');
  cooldownStatus.textContent = '\u00a0';

  let pendingReply = null;

  function clearReply() {
    pendingReply = null;
    replyBar.hidden = true;
    replyLabel.textContent = '';
    replySnippet.textContent = '';
    input.placeholder = 'Type a message…';
  }

  function beginReply(message) {
    if (!message) return;
    pendingReply = {
      messageId: message.id || '',
      userId: message.userId || '',
      user: message.user || 'Unknown',
      time: Number(message.time || 0),
      text: String(message.text || '').slice(0, 120),
    };
    replyLabel.textContent = `Replying to ${pendingReply.user}`;
    replySnippet.textContent = pendingReply.text;
    replyBar.hidden = false;
    input.placeholder = `Reply to ${pendingReply.user}…`;
    input.focus();
  }

  panel._beginReply = beginReply;
  cancelReplyBtn.addEventListener('click', clearReply);

  function cooldownRemainingMs() {
    const video = document.querySelector('video');
    if (!video) return 0;
    const videoTime = Math.max(0, Number(video.currentTime) || 0);
    const slot = Math.floor(videoTime / MESSAGE_SLOT_SECONDS);
    const usedSlots = getUsedMessageSlots(getCurrentVideoIdentity());
    if (!usedSlots.has(slot)) return 0;
    return Math.max(0, (((slot + 1) * MESSAGE_SLOT_SECONDS) - videoTime) * 1000);
  }

  function updateComposerState() {
    // Posting requires a real account; signed-out viewers see a disabled
    // composer with an inline prompt.
    if (!getAccountStateCached().signedIn) {
      input.disabled = true;
      input.placeholder = 'Sign in to chat';
      sendBtn.disabled = true;
      sendBtn.textContent = 'Send';
      cooldownStatus.textContent = 'Sign in to chat \u2014 open Settings \u2192 Account';
      return;
    }
    if (input.disabled) {
      input.disabled = false;
      input.placeholder = pendingReply ? `Reply to ${pendingReply.user}\u2026` : 'Type a message\u2026';
    }
    const remaining = cooldownRemainingMs();
    const coolingDown = remaining > 0;
    sendBtn.disabled = coolingDown || input.value.trim().length === 0;
    sendBtn.textContent = coolingDown ? `${Math.ceil(remaining / 1000)}s` : 'Send';
    cooldownStatus.textContent = coolingDown
      ? `This video-time slot already has a message. Next slot in ${Math.ceil(remaining / 1000)}s`
      : '\u00a0';
  }

  function startCooldown() {
    clearInterval(panel._cooldownTimer);
    updateComposerState();
    panel._cooldownTimer = setInterval(updateComposerState, 200);
  }

  function sendMessage() {
    const account = getAccountStateCached();
    if (!account.signedIn) {
      updateComposerState();
      return;
    }
    const video = document.querySelector('video');
    const messageText = input.value.trim();
    if (!video || !messageText || cooldownRemainingMs() > 0) {
      updateComposerState();
      return;
    }

    const myName = String(account.displayName || getSetting('chatDisplayName', 'You') || 'You');
    const slot = Math.floor(Math.max(0, video.currentTime) / MESSAGE_SLOT_SECONDS);
    const outgoingMessage = {
      userId: account.uid || getOrCreateUserId(),
      accountCreatedAt: getOrCreateAccountCreatedAt(),
      user: myName,
      color: getSetting('chatUserColor', '#3a6ff7'),
      badge: account.signedIn ? (isAdmin() ? 'staff' : 'beta') : 'none',
      text: messageText,
      time: Math.floor(video.currentTime),
      created_at: Clock.nowISO(),
      replyTo: pendingReply ? { ...pendingReply } : null,
    };
    insertMessageSorted(outgoingMessage);
    saveMessageForVideo(getCurrentVideoIdentity(), outgoingMessage).catch(error => {
      console.error('Lyve failed to save local message:', error);
    });

    getUsedMessageSlots(getCurrentVideoIdentity()).add(slot);
    input.value = '';
    input.dispatchEvent(new CustomEvent('lyve:composer-sent'));
    dismissOnboarding();
    clearReply();
    startCooldown();
    input.focus();
    renderNow();
  }

  input.addEventListener('input', updateComposerState);
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    sendMessage();
  });
  sendBtn.addEventListener('click', sendMessage);
  // Register after the Enter handler: Lyve processes the key first, then keeps
  // it from bubbling into YouTube's player shortcuts.
  for (const eventName of ['keydown', 'keypress', 'keyup']) {
    input.addEventListener(eventName, shieldTypingFromYouTube);
  }

  inputWrap.append(input, emojiBtn);
  inputContainer.append(inputWrap, sendBtn, overlayDragHandle);
  composer.append(onboardingCard, replyBar, inputContainer, cooldownStatus);
  startCooldown();
  // Reflect the real sign-in state as soon as the background responds. The
  // 200ms cooldown timer keeps it current afterward (e.g. after sign in/out).
  refreshAccountStateCache().then(updateComposerState).catch(() => {});

  const overlayEditLayer = document.createElement('div');
  overlayEditLayer.id = 'chat-overlay-edit-layer';
  const overlayEditBar = document.createElement('div');
  overlayEditBar.className = 'chat-overlay-edit-bar';
  const overlayEditLabel = document.createElement('span');
  overlayEditLabel.textContent = 'Drag chat area';
  const overlayEditActions = document.createElement('div');
  const overlayResetButton = document.createElement('button');
  overlayResetButton.type = 'button'; overlayResetButton.textContent = 'Reset';
  const overlayDoneButton = document.createElement('button');
  overlayDoneButton.type = 'button'; overlayDoneButton.textContent = 'Done';
  overlayEditActions.append(overlayResetButton, overlayDoneButton);
  overlayEditBar.append(overlayEditLabel, overlayEditActions);
  const overlayResizeHandles = ['n','e','s','w','ne','nw','se','sw'].map(direction => {
    const handle = document.createElement('div');
    handle.className = `chat-overlay-resize-edge edge-${direction}`;
    handle.dataset.direction = direction;
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-label', `Resize overlay from ${direction}`);
    return handle;
  });
  overlayEditLayer.append(overlayEditBar, ...overlayResizeHandles);

  const persistOverlayPlacement = () => {
    const videoRect = document.querySelector('video')?.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    if (!videoRect) return;
    const relativeX = Math.max(0, Math.min(1, (panelRect.left - videoRect.left - 8) / Math.max(1, videoRect.width - panelRect.width - 16)));
    const relativeY = Math.max(0, Math.min(1, (panelRect.top - videoRect.top - 8) / Math.max(1, videoRect.height - panelRect.height - 16)));
    panel.dataset.overlayCustomPosition = 'true';
    panel.dataset.overlayRelativeX = String(relativeX);
    panel.dataset.overlayRelativeY = String(relativeY);
    localStorage.setItem('chatOverlayCustomPosition', 'true');
    localStorage.setItem('chatOverlayRelativeX', String(relativeX));
    localStorage.setItem('chatOverlayRelativeY', String(relativeY));
  };

  overlayEditBar.addEventListener('pointerdown', event => {
    if (event.target.closest('button')) return;
    event.preventDefault();
    const startRect = panel.getBoundingClientRect();
    const hostRect = panel.parentElement === document.body ? { left: 0, top: 0 } : panel.parentElement.getBoundingClientRect();
    const videoRect = document.querySelector('video')?.getBoundingClientRect();
    if (!videoRect) return;
    const startX = event.clientX; const startY = event.clientY;
    const move = moveEvent => {
      const minLeft = videoRect.left - hostRect.left + 8;
      const maxLeft = videoRect.right - hostRect.left - panel.offsetWidth - 8;
      const minTop = videoRect.top - hostRect.top + 8;
      const maxTop = videoRect.bottom - hostRect.top - panel.offsetHeight - 8;
      panel.style.left = `${Math.max(minLeft, Math.min(startRect.left - hostRect.left + moveEvent.clientX - startX, maxLeft))}px`;
      panel.style.top = `${Math.max(minTop, Math.min(startRect.top - hostRect.top + moveEvent.clientY - startY, maxTop))}px`;
      panel.style.right = ''; panel.style.bottom = '';
      persistOverlayPlacement();
    };
    const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop, { once: true });
  });

  overlayResizeHandles.forEach(handle => handle.addEventListener('pointerdown', event => {
    event.preventDefault(); event.stopPropagation();
    const direction = handle.dataset.direction || '';
    const startRect = panel.getBoundingClientRect();
    const hostRect = panel.parentElement === document.body ? { left: 0, top: 0 } : panel.parentElement.getBoundingClientRect();
    const videoRect = document.querySelector('video')?.getBoundingClientRect();
    if (!videoRect) return;
    const startX = event.clientX; const startY = event.clientY;
    const move = moveEvent => {
      const dx = moveEvent.clientX - startX; const dy = moveEvent.clientY - startY;
      let left = startRect.left; let right = startRect.right;
      let top = startRect.top; let bottom = startRect.bottom;
      if (direction.includes('e')) right = Math.max(startRect.left + 280, Math.min(startRect.right + dx, videoRect.right - 8));
      if (direction.includes('w')) left = Math.min(startRect.right - 280, Math.max(startRect.left + dx, videoRect.left + 8));
      if (direction.includes('s')) bottom = Math.max(startRect.top + 190, Math.min(startRect.bottom + dy, videoRect.bottom - 8));
      if (direction.includes('n')) top = Math.min(startRect.bottom - 190, Math.max(startRect.top + dy, videoRect.top + 8));
      const width = right - left; const height = bottom - top;
      panel.style.left = `${left - hostRect.left}px`;
      panel.style.top = `${top - hostRect.top}px`;
      panel.style.right = ''; panel.style.bottom = '';
      panel.style.setProperty('width', `${width}px`, 'important');
      panel.style.setProperty('height', `${height}px`, 'important');
      localStorage.setItem('chatOverlayCustomWidth', String(Math.round(width)));
      localStorage.setItem('chatOverlayCustomHeight', String(Math.round(height)));
      persistOverlayPlacement();
    };
    const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop, { once: true });
  }));

  overlayDoneButton.addEventListener('click', () => {
    panel.classList.remove('lyve-overlay-editing');
    overlayDragHandle.setAttribute('aria-pressed', 'false');
  });
  overlayResetButton.addEventListener('click', () => {
    for (const key of ['chatOverlayCustomPosition','chatOverlayRelativeX','chatOverlayRelativeY','chatOverlayCustomWidth','chatOverlayCustomHeight']) localStorage.removeItem(key);
    panel.dataset.overlayCustomPosition = 'false';
    panel.dataset.overlayRelativeX = '0'; panel.dataset.overlayRelativeY = '0';
    panel._positionOverlay?.();
  });

  panel.appendChild(header);
  panel.appendChild(pinnedBanner);
  panel.appendChild(messagesStage);
  panel.appendChild(composer);
  panel.appendChild(overlayEditLayer);
  document.body.appendChild(panel);
  panel.addEventListener('pointerdown', event => {
    event.stopPropagation();
    const captureTarget = event.target instanceof Element ? event.target : panel;
    try { captureTarget.setPointerCapture?.(event.pointerId); } catch {}
  });
  for (const eventName of ['mousedown', 'click', 'dblclick', 'contextmenu', 'touchstart']) {
    panel.addEventListener(eventName, event => event.stopPropagation());
  }
  panel.addEventListener('wheel', event => {
    event.stopPropagation();
    if (!event.target.closest('#chat-messages')) event.preventDefault();
  }, { passive: false });

  const blockYouTubeNumberSeeking = event => {
    if (getSetting('chatBlockYouTubeNumberHotkeys', true) !== true) return;
    if (getComputedStyle(panel).display === 'none') return;
    if (!/^[0-9]$/.test(event.key) || event.ctrlKey || event.altKey || event.metaKey) return;
    const target = event.target;
    const typing = target instanceof HTMLElement && (
      target.matches('input,textarea,select,[contenteditable="true"]') ||
      Boolean(target.closest('input,textarea,select,[contenteditable="true"]'))
    );
    if (typing) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  for (const eventName of ['keydown', 'keypress', 'keyup']) {
    window.addEventListener(eventName, blockYouTubeNumberSeeking, true);
  }
  panel._numberHotkeyCleanup = () => {
    for (const eventName of ['keydown', 'keypress', 'keyup']) {
      window.removeEventListener(eventName, blockYouTubeNumberSeeking, true);
    }
  };

  let standardPanelWidth = panel.style.width;
  let standardPanelHeight = panel.style.height;
  let overlayMinimalActive = false;
  const getSavedStandardSize = () => {
    const width = isLocked
      ? (localStorage.getItem('chatWidth') || localStorage.getItem('chatFreeWidth') || standardPanelWidth || '340px')
      : (localStorage.getItem('chatFreeWidth') || localStorage.getItem('chatWidth') || standardPanelWidth || '320px');
    const height = isLocked
      ? (localStorage.getItem('chatHeight') || localStorage.getItem('chatFreeHeight') || standardPanelHeight || '500px')
      : (localStorage.getItem('chatFreeHeight') || localStorage.getItem('chatHeight') || standardPanelHeight || '400px');
    return { width, height };
  };
  const rememberStandardPanelLayout = () => {
    if (overlayMinimalActive || panel.classList.contains('lyve-minimal-overlay')) return;
    const rect = panel.getBoundingClientRect();
    if (rect.width > 1) standardPanelWidth = `${Math.round(rect.width)}px`;
    if (rect.height > 1) standardPanelHeight = `${Math.round(rect.height)}px`;
    try {
      if (isLocked) {
        localStorage.setItem('chatWidth', standardPanelWidth);
        localStorage.setItem('chatHeight', standardPanelHeight);
      } else {
        localStorage.setItem('chatFreeWidth', standardPanelWidth);
        localStorage.setItem('chatFreeHeight', standardPanelHeight);
        if (rect.width > 1 && rect.height > 1) {
          localStorage.setItem('chatFreeLeft', `${Math.round(rect.left)}px`);
          localStorage.setItem('chatFreeTop', `${Math.round(rect.top)}px`);
        }
      }
    } catch {}
  };
  const restoreStandardPanelLayout = () => {
    const { width, height } = getSavedStandardSize();
    panel.style.position = 'fixed';
    panel.style.setProperty('width', width);
    panel.style.setProperty('height', height);

    if (isLocked) {
      panel.style.left = '';
      panel.style.right = '';
      panel.style.top = '';
      panel.style.bottom = '';
      setDockPosition(panel, getSetting('chatDefaultDock', 'br'));
      return;
    }

    panel.style.right = '';
    panel.style.bottom = '';
    const freeL = localStorage.getItem('chatFreeLeft') || localStorage.getItem('chatLeft');
    const freeT = localStorage.getItem('chatFreeTop') || localStorage.getItem('chatTop');
    if (freeL && freeT) {
      panel.style.left = freeL;
      panel.style.top = freeT;
      return;
    }
    const rect = panel.getBoundingClientRect();
    const left = window.innerWidth - rect.width - 20;
    const top = window.innerHeight - rect.height - 15;
    panel.style.left = `${Math.max(0, left)}px`;
    panel.style.top = `${Math.max(0, top)}px`;
  };
  const positionOverlayAtVideoCorner = () => {
    if (!overlayMinimalActive) return;
    const video = document.querySelector('video');
    if (!video) return;
    const videoRect = video.getBoundingClientRect();
    if (videoRect.width < 1 || videoRect.height < 1) return;
    const hostRect = panel.parentElement === document.body
      ? { left: 0, top: 0 }
      : panel.parentElement.getBoundingClientRect();
    const customWidth = Math.max(0, Number(getSetting('chatOverlayCustomWidth', '0')) || 0);
    const customHeight = Math.max(0, Number(getSetting('chatOverlayCustomHeight', '0')) || 0);
    const desiredHeight = customHeight || Math.max(240, Number(getSetting('chatOverlayHeight', '360')) || 360);
    const topInset = 12;
    const bottomInset = 74;
    const width = Math.max(280, Math.min(customWidth || 380, videoRect.width - 24));
    const height = Math.max(190, Math.min(desiredHeight, videoRect.height - topInset - bottomInset));
    const corner = String(getSetting('chatOverlayCorner', getSetting('chatDefaultDock', 'br')) || 'br');
    const atLeft = corner.endsWith('l');
    const atTop = corner.startsWith('t');
    let left; let top;
    if (panel.dataset.overlayCustomPosition === 'true') {
      const relativeX = Math.max(0, Math.min(1, Number(panel.dataset.overlayRelativeX || 0)));
      const relativeY = Math.max(0, Math.min(1, Number(panel.dataset.overlayRelativeY || 0)));
      left = videoRect.left + 8 + relativeX * Math.max(0, videoRect.width - width - 16) - hostRect.left;
      top = videoRect.top + 8 + relativeY * Math.max(0, videoRect.height - height - 16) - hostRect.top;
    } else {
      left = (atLeft ? videoRect.left + 12 : videoRect.right - width - 12) - hostRect.left;
      top = (atTop ? videoRect.top + topInset : videoRect.bottom - height - bottomInset) - hostRect.top;
    }
    panel.style.setProperty('width', `${width}px`, 'important');
    panel.style.setProperty('height', `${height}px`, 'important');
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.right = '';
    panel.style.bottom = '';
  };
  panel._positionOverlay = positionOverlayAtVideoCorner;

  const applyDisplayMode = () => {
    const mode = String(getSetting('chatDisplayMode', 'window') || 'window');
    const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement || null;
    const fullscreenHost = fullscreenElement?.matches?.('#movie_player')
      ? fullscreenElement
      : (fullscreenElement?.querySelector?.('#movie_player') || fullscreenElement);
    const pagePlayerHost = document.querySelector('#movie_player') || document.querySelector('video')?.parentElement || null;
    const overlayHost = fullscreenHost || pagePlayerHost;
    const minimal = mode === 'always' || (mode === 'fullscreen' && Boolean(fullscreenElement));
    const wasMinimal = overlayMinimalActive;
    if (minimal && !wasMinimal) rememberStandardPanelLayout();
    overlayMinimalActive = minimal;
    panel.classList.toggle('lyve-minimal-overlay', minimal);
    if (!minimal) {
      panel.classList.remove('lyve-overlay-editing');
      overlayDragHandle.setAttribute('aria-pressed', 'false');
    }

    if (minimal) {
      const visible = getSavedChatVisible();
      panel.classList.toggle('lyve-hidden', !visible);
      panel.style.display = visible ? 'flex' : 'none';
      panel.style.visibility = 'visible';
      panel.style.opacity = '1';
      const toggle = document.getElementById('toggle-live-chat-btn');
      if (toggle) {
        toggle.dataset.on = visible ? '1' : '0'; toggle.setAttribute('aria-pressed', String(visible));
        const track = toggle.querySelector('.lyve-switch'); const knob = toggle.querySelector('.lyve-knob');
        if (track) track.style.background = visible ? 'rgba(255,0,0,.6)' : 'rgba(255,255,255,.25)';
        if (knob) knob.style.left = visible ? '14px' : '-2px';
      }
      panel.dataset.overlayCustomPosition = String(getSetting('chatOverlayCustomPosition', false) === true);
      panel.dataset.overlayRelativeX = String(getSetting('chatOverlayRelativeX', '0') || '0');
      panel.dataset.overlayRelativeY = String(getSetting('chatOverlayRelativeY', '0') || '0');
    }

    if (minimal && overlayHost) {
      if (!overlayHost.contains(panel)) {
        try { overlayHost.appendChild(panel); } catch { document.body.appendChild(panel); }
      }
      panel.style.position = 'absolute';
    } else {
      if (panel.parentElement !== document.body) document.body.appendChild(panel);
      if (!minimal) {
        restoreStandardPanelLayout();
      }
    }
    if (minimal) requestAnimationFrame(positionOverlayAtVideoCorner);
    if (!fullscreenElement) {
      const popup = document.getElementById('chat-settings-popup');
      if (popup && popup.parentElement !== document.body) document.body.appendChild(popup);
    }
    renderNow();
  };
  const repositionOverlay = () => requestAnimationFrame(positionOverlayAtVideoCorner);
  const repositionBodyMountedOverlay = () => {
    if (panel.parentElement === document.body) positionOverlayAtVideoCorner();
  };
  let observedOverlayVideo = null;
  let lastOverlayBoundsKey = '';
  const overlayResizeObserver = typeof ResizeObserver === 'function'
    ? new ResizeObserver(repositionOverlay)
    : null;
  const syncOverlayBoundsWatch = () => {
    const video = document.querySelector('video');
    if (video !== observedOverlayVideo) {
      if (observedOverlayVideo) overlayResizeObserver?.unobserve(observedOverlayVideo);
      observedOverlayVideo = video;
      if (observedOverlayVideo) overlayResizeObserver?.observe(observedOverlayVideo);
    }
    if (!video || !overlayMinimalActive) return;
    const rect = video.getBoundingClientRect();
    const hostRect = panel.parentElement === document.body
      ? { left: 0, top: 0 }
      : panel.parentElement.getBoundingClientRect();
    const boundsKey = `${Math.round(rect.left - hostRect.left)}|${Math.round(rect.top - hostRect.top)}|${Math.round(rect.width)}|${Math.round(rect.height)}`;
    if (boundsKey === lastOverlayBoundsKey) return;
    lastOverlayBoundsKey = boundsKey;
    repositionOverlay();
  };
  const overlayBoundsTimer = setInterval(syncOverlayBoundsWatch, 250);
  document.addEventListener('fullscreenchange', applyDisplayMode);
  window.addEventListener('lyve:display-mode-changed', applyDisplayMode);
  window.addEventListener('resize', repositionOverlay, { passive: true });
  window.addEventListener('scroll', repositionBodyMountedOverlay, { passive: true });
  window.addEventListener('yt-page-data-updated', syncOverlayBoundsWatch);
  window.addEventListener('yt-navigate-finish', syncOverlayBoundsWatch);
  panel._presentationCleanup = () => {
    document.removeEventListener('fullscreenchange', applyDisplayMode);
    window.removeEventListener('lyve:display-mode-changed', applyDisplayMode);
    window.removeEventListener('resize', repositionOverlay);
    window.removeEventListener('scroll', repositionBodyMountedOverlay);
    window.removeEventListener('yt-page-data-updated', syncOverlayBoundsWatch);
    window.removeEventListener('yt-navigate-finish', syncOverlayBoundsWatch);
    clearInterval(overlayBoundsTimer);
    overlayResizeObserver?.disconnect();
  };
  applyDisplayMode();

  injectInspectorStyles();
  const chatMessagesEl = document.getElementById('chat-messages');
  let timelineWasAwayFromCurrent = false;
  let historyBatchFadeTimer = null;
  const clearHistoryBatchFade = () => {
    clearTimeout(historyBatchFadeTimer);
    historyBatchFadeTimer = null;
    panel.classList.remove('lyve-history-batch-fade');
    chatMessagesEl.querySelectorAll('.chat-message-history-returning').forEach(row => row.classList.remove('chat-message-history-returning'));
  };
  panel._historyFadeCleanup = clearHistoryBatchFade;
  function updateTimelineBrowseState() {
    // No messages — nothing to browse, so never enter the "away" state.
    if (!chatMessagesEl.querySelector('.chat-message-row')) {
      chatMessagesEl.dataset.awayFromCurrent = 'false';
      chatMessagesEl.dataset.browsingAhead = 'false';
      panel.classList.remove('lyve-browsing-history');
      returnToCurrentBtn.hidden = true;
      newMessagesBtn.hidden = true;
      timelineWasAwayFromCurrent = false;
      return;
    }
    const firstFuture = chatMessagesEl.querySelector('.chat-message-future');
    const boundary = chatMessagesEl.querySelector('.chat-current-boundary');
    const browsingAhead = !!firstFuture &&
      chatMessagesEl.scrollTop + chatMessagesEl.clientHeight > firstFuture.offsetTop + 4;
    const currentTop = boundary ? Math.max(0, boundary.offsetTop - chatMessagesEl.clientHeight) : 0;
    const awayFromCurrent = Math.abs(chatMessagesEl.scrollTop - currentTop) > 8;
    chatMessagesEl.dataset.browsingAhead = String(browsingAhead);
    chatMessagesEl.dataset.awayFromCurrent = String(awayFromCurrent);
    if (awayFromCurrent) {
      if (historyBatchFadeTimer) clearHistoryBatchFade();
    } else if (timelineWasAwayFromCurrent && panel.classList.contains('lyve-minimal-overlay')) {
      const videoTime = Number(document.querySelector('video')?.currentTime || 0);
      const fadeSeconds = Math.max(0, Number(getSetting('chatOverlayFadeSeconds', '10')) || 0);
      const staleHistoryRows = Array.from(chatMessagesEl.querySelectorAll('.chat-message-row:not(.chat-message-future)'))
        .filter(row => fadeSeconds > 0 && videoTime - Number(row._message?.time || 0) >= fadeSeconds);
      if (staleHistoryRows.length) {
        staleHistoryRows.forEach(row => row.classList.add('chat-message-history-returning'));
        panel.classList.add('lyve-history-batch-fade');
        historyBatchFadeTimer = setTimeout(() => {
          clearHistoryBatchFade();
          renderNow();
        }, 560);
      }
    }
    timelineWasAwayFromCurrent = awayFromCurrent;
    panel.classList.toggle('lyve-browsing-history', awayFromCurrent);
    if (!awayFromCurrent) {
      clearUnreadMessages();
      newMessagesBtn.hidden = true;
    }
    returnToCurrentBtn.hidden = !awayFromCurrent;
  }
  const updateUnreadIndicator = () => {
    const count = getUnreadMessageCount();
    newMessagesBtn.textContent = `${count} new message${count === 1 ? '' : 's'}`;
    newMessagesBtn.hidden = count === 0;
  };
  chatMessagesEl.addEventListener('scroll', updateTimelineBrowseState, { passive: true });
  // Don't let the user scroll up into the empty spacer above the first message.
  // The floor is the first message's top, but never past the current-time rest
  // position, so the bottom-pinned view of a short chat is preserved.
  chatMessagesEl.addEventListener('scroll', () => {
    // Empty chat — nothing to scroll, keep it pinned to the top.
    if (!chatMessagesEl.querySelector('.chat-message-row')) {
      if (chatMessagesEl.scrollTop !== 0) chatMessagesEl.scrollTop = 0;
      return;
    }
    const boundary = chatMessagesEl.querySelector('.chat-current-boundary');
    const firstRow = chatMessagesEl.querySelector('.chat-message-row:not(.chat-message-future)');
    if (!boundary || !firstRow) return;
    const currentTop = Math.max(0, boundary.offsetTop - chatMessagesEl.clientHeight);
    const minScroll = Math.min(firstRow.offsetTop, currentTop);
    if (chatMessagesEl.scrollTop < minScroll) chatMessagesEl.scrollTop = minScroll;
  }, { passive: true });
  chatMessagesEl.addEventListener('lyve:chat-rendered', () => {
    updateTimelineBrowseState();
    updateUnreadIndicator();
  });
  let timelineGateSide = null;
  let timelineGateReached = false;
  let timelineGestureTimer = null;
  chatMessagesEl.addEventListener('wheel', event => {
    const boundary = chatMessagesEl.querySelector('.chat-current-boundary');
    if (!boundary) return;
    const currentTop = Math.max(0, boundary.offsetTop - chatMessagesEl.clientHeight);
    const multiplier = event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? chatMessagesEl.clientHeight
        : 1;
    const delta = event.deltaY * multiplier;
    const scrollTop = chatMessagesEl.scrollTop;

    clearTimeout(timelineGestureTimer);
    timelineGestureTimer = setTimeout(() => {
      timelineGateSide = null;
      timelineGateReached = false;
    }, 180);

    if (timelineGateReached) {
      event.preventDefault();
      chatMessagesEl.scrollTop = currentTop;
      return;
    }

    if (!timelineGateSide) {
      if (scrollTop < currentTop - 3 && delta > 0) timelineGateSide = 'past';
      else if (scrollTop > currentTop + 3 && delta < 0) timelineGateSide = 'future';
    }

    const crossingFromPast = timelineGateSide === 'past' && delta > 0 && scrollTop + delta >= currentTop;
    const crossingFromFuture = timelineGateSide === 'future' && delta < 0 && scrollTop + delta <= currentTop;
    if (crossingFromPast || crossingFromFuture) {
      event.preventDefault();
      timelineGateReached = true;
      chatMessagesEl.scrollTop = currentTop;
      updateTimelineBrowseState();
      return;
    }

    if ((timelineGateSide === 'past' && delta < 0) || (timelineGateSide === 'future' && delta > 0)) {
      timelineGateSide = null;
    }
    // Lyve owns the wheel while hovered. Apply the delta here so the browser
    // cannot chain unused movement into the surrounding YouTube page.
    event.preventDefault();
    chatMessagesEl.scrollTop += delta;
  }, { passive: false });
  chatMessagesEl.addEventListener('click', (e) => {
    const row = e.target.closest('.chat-message-row');
    const message = row?._message;
    if (!message) return;

    const replyContext = e.target.closest('.chat-reply-context');
    if (replyContext) {
      const targetId = replyContext.dataset.targetMessageId;
      const targetRow = Array.from(chatMessagesEl.querySelectorAll('.chat-message-row'))
        .find(candidate => candidate.dataset.messageId === targetId);
      if (targetRow) {
        const centeredTop = targetRow.offsetTop - (chatMessagesEl.clientHeight - targetRow.offsetHeight) / 2;
        chatMessagesEl.scrollTop = Math.max(0, Math.min(centeredTop, chatMessagesEl.scrollHeight - chatMessagesEl.clientHeight));
        updateTimelineBrowseState();
        targetRow.classList.remove('chat-message-jump-highlight');
        void targetRow.offsetWidth;
        targetRow.classList.add('chat-message-jump-highlight');
        setTimeout(() => targetRow.classList.remove('chat-message-jump-highlight'), 1300);
      }
      return;
    }

    const safetyUndo = e.target.closest('.chat-safety-undo');
    if (safetyUndo) {
      setViewerSafetyState({ userId: message.userId, displayName: message.user }, safetyUndo.dataset.safetyType, false);
      return;
    }

    if (e.target.closest('.chat-reply-action')) {
      beginReply(message);
      return;
    }

    const cardTrigger = e.target.closest('.chat-username');
    if (!cardTrigger) return;

    showInspectorNear(cardTrigger, {
      displayName: message.user || 'Unknown',
      userId: message.userId || null,
      lastChanged: message.userId === getOrCreateUserId()
        ? localStorage.getItem('chatLastNameChangeAt') || null
        : null,
      accountCreatedAt: message.accountCreatedAt || (message.userId === getOrCreateUserId() ? getOrCreateAccountCreatedAt() : null),
      time: Number(message.time || 0),
      message,
    }, {
      onReply: () => beginReply(message),
      onMention: () => {
        const mention = `@${message.user || 'user'} `;
        const start = input.selectionStart ?? input.value.length;
        input.setRangeText(mention, start, input.selectionEnd ?? start, 'end');
        input.focus();
        updateComposerState();
      },
    });
  });

  // picker
  createEmojiPicker(panel, input, emojiBtn);
    // TAB autocomplete for 7tv emotes (and :NAME:)
  attachEmoteAutocomplete(panel, input);

  if (!isLocked && (!savedLeft || !savedTop)) {
    const rect = panel.getBoundingClientRect();
    const left = window.innerWidth  - rect.width  - 20;
    const top  = window.innerHeight - rect.height - 15;
    panel.style.left = `${Math.max(0, left)}px`;
    panel.style.top  = `${Math.max(0, top)}px`;
  }

  if (typeof attachResizeHandles === 'function') {
    attachResizeHandles(panel, header, { minWidth: 280, minHeight: 280, edgeSize: 14 });
  }
  if (typeof enableDrag === 'function') enableDrag(panel);
}

// Remove chat
function removeChatPanel() {
  const chat = document.getElementById('chat-panel'); // FIXED ID
  closePinDialog();
  if (chat?._cooldownTimer) clearInterval(chat._cooldownTimer);
  chat?._presentationCleanup?.();
  chat?._numberHotkeyCleanup?.();
  chat?._historyFadeCleanup?.();
  chat?._pinnedCleanup?.();
  clearMessageSeekReturn();
  closeParticipants();
  closeModerationQueue();
  closeReportDialog();
  closeBanDialog();
  closeUserHistory();
  closeInspector();
  if (chat) chat.remove();
}

function injectChatStyles() {
  const style = document.createElement('style');
  style.textContent = `
    #chat-messages {
      background-color: #1e1e1e !important;
      font-size: 14px !important;
      color: white !important;
    }
    #chat-messages > div {
      background: none !important;
      border: none !important;
      padding: 0 !important;
      margin: 0 !important;
      color: white !important;
      font-size: 14px !important;
    }
  `;
  document.head.appendChild(style);
}

function injectInspectorStyles() {
  if (document.getElementById('chat-inspector-styles')) return;
  const style = document.createElement('style');
  style.id = 'chat-inspector-styles';
  style.textContent = `
    .user-inspector {
      position: fixed; z-index: 2147483647;
      width:min(300px,calc(100vw - 20px)); max-height:calc(100vh - 20px);
      overflow-y:auto; box-sizing:border-box;
      background:#181818; color:#fff;
      border:1px solid rgba(255,255,255,.14);
      border-radius:12px; box-shadow:0 14px 40px rgba(0,0,0,.55);
      padding:12px; font:13px/1.4 Roboto,Arial,sans-serif; cursor:grab;
    }
    .user-inspector:active{cursor:grabbing}.user-inspector button,.user-inspector input,.user-inspector select,.user-inspector textarea,.user-inspector summary,.user-inspector label{cursor:auto}
    .user-inspector.admin-view{width:min(360px,calc(100vw - 20px))}
    .user-card-header{display:flex;align-items:center;gap:9px;margin-bottom:10px}
    .user-card-avatar{width:36px;height:36px;border-radius:50%;display:grid;place-items:center;
      background:#3a6ff7;color:#fff;font-weight:700;font-size:16px;flex:0 0 auto}
    .user-card-identity{min-width:0;flex:1}.user-card-name{font-size:15px;font-weight:700;
      overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.user-card-subtitle{color:#aaa;font-size:12px}
    .user-card-close{border:0;background:transparent;color:#aaa;font-size:20px;cursor:pointer;padding:2px 4px}
    .user-card-admin-toggle{width:30px;height:30px;display:grid;place-items:center;border:1px solid transparent;
      border-radius:7px;background:transparent;color:#999;cursor:pointer;padding:0}
    .user-card-admin-toggle:hover{background:#292929;color:#fff}.user-card-admin-toggle.active{
      background:#3a2810;border-color:#67471c;color:#ffd18a}
    .user-card-actions{display:grid;grid-template-columns:repeat(2,1fr);gap:6px}
    .user-card-button{border:1px solid rgba(255,255,255,.14);background:#272727;color:#fff;
      border-radius:8px;padding:7px 8px;cursor:pointer;font-weight:600;min-width:0}
    .user-card-button:hover{background:#343434}.user-card-button.danger{color:#ff9a9a}
    .user-card-button.report{grid-column:1/-1;color:#ffb3af}
    .user-card-preview{padding:9px 10px;background:#111;border-radius:8px;color:#ddd;
      overflow-wrap:anywhere}.user-card-preview strong{color:#aaa;font-size:11px;text-transform:uppercase;
      letter-spacing:.04em;display:block;margin-bottom:3px}
    .user-card-section{border-top:1px solid rgba(255,255,255,.1);margin-top:10px;padding-top:9px}
    details.user-card-section>summary{list-style:none;display:flex;align-items:center;min-height:28px;cursor:pointer;user-select:none}
    details.user-card-section>summary::-webkit-details-marker{display:none}details.user-card-section>summary::after{
      content:'›';margin-left:auto;color:#777;font-size:18px;transform:rotate(90deg);transition:transform .12s ease}
    details.user-card-section:not([open])>summary::after{transform:rotate(0)}.user-card-section-body{padding-top:7px}
    .user-card-section-title{font-size:11px;text-transform:uppercase;letter-spacing:.06em;
      color:#aaa;font-weight:700;margin:0}
    .user-card-kv{display:grid;grid-template-columns:92px minmax(0,1fr);gap:6px 10px;margin:5px 0}
    .user-card-kv span:nth-child(odd){color:#aaa}.user-card-value{overflow-wrap:anywhere}
    .user-card-list{display:flex;flex-direction:column;gap:6px}.user-card-list-item{background:#111;
      border-radius:7px;padding:7px 8px;color:#ddd}.user-card-list-meta{color:#888;font-size:11px;margin-top:2px}
    .user-card-message-actions{display:flex;flex-wrap:wrap;gap:5px;margin-top:7px}.user-card-message-action{height:23px;
      padding:0 7px;border:1px solid rgba(255,255,255,.1);border-radius:6px;background:#252525;color:#ddd;cursor:pointer;
      font-size:10px;font-weight:700}.user-card-message-action:hover{background:#313131;color:#fff}.user-card-message-action.danger{background:#321d1d;color:#ffaaa6}
    .user-card-empty{color:#888;font-style:italic}.user-card-flags{display:flex;flex-wrap:wrap;gap:5px}
    .user-card-flag{background:#3a2810;color:#ffd18a;border:1px solid #67471c;border-radius:999px;
      padding:2px 7px;font-size:11px;cursor:pointer}.user-card-admin-actions{display:grid;
      grid-template-columns:repeat(2,1fr);gap:6px;margin-top:8px}
    .user-card-timeout-controls{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px;margin-top:8px}
    .user-card-timeout-controls select{min-width:0;background:#111;color:#fff;border:1px solid rgba(255,255,255,.14);
      border-radius:8px;padding:7px 8px}.user-card-reversible-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
    .user-card-note{color:#888;font-size:11px;margin-top:8px}
    .user-card-button:disabled{opacity:.42;cursor:not-allowed}.user-card-statuses{display:flex;flex-wrap:wrap;gap:5px;padding:0 12px 9px}
    .user-card-status{padding:3px 7px;border-radius:999px;font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.03em}
    .user-card-status.muted{background:#282828;color:#c8c8c8}.user-card-status.blocked{background:#332124;color:#ffaaa6}
    .user-card-status.flagged{background:#3a2810;color:#ffd18a}.user-card-status.timeout{background:#2b2948;color:#c9c4ff}
    .user-card-status.banned{background:#472020;color:#ffaaaa}
    .user-card-status.role-viewer{background:#282828;color:#bbb}.user-card-status.role-member{background:#315a91;color:#e9f3ff}
    .user-card-status.role-moderator{background:#147d56;color:#eafff6}.user-card-status.role-creator{background:#d93025;color:#fff}
    .user-card-role-control{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px;margin-top:9px}
    .user-card-role-control select{min-width:0;height:34px;padding:0 8px;border:1px solid rgba(255,255,255,.13);border-radius:8px;background:#111;color:#fff}
    #chat-participants-btn:hover,#chat-participants-btn[aria-expanded="true"]{background:rgba(255,255,255,.08)!important;color:#fff!important}

    .admin-participants{
      position:fixed;z-index:100002;width:min(370px,calc(100vw - 20px));max-height:calc(100vh - 20px);
      display:flex;flex-direction:column;overflow:hidden;box-sizing:border-box;background:#181818;color:#fff;
      border:1px solid rgba(255,255,255,.14);border-radius:14px;box-shadow:0 16px 45px rgba(0,0,0,.58);
      font:13px/1.35 Roboto,Arial,sans-serif
    }
    .participants-header{display:flex;align-items:center;gap:10px;padding:13px 14px 11px;border-bottom:1px solid rgba(255,255,255,.08)}
    .participants-header-copy{min-width:0;flex:1}.participants-title{font-size:15px;font-weight:700}
    .participants-subtitle{color:#888;font-size:11px;margin-top:2px}
    .participants-close{display:grid;place-items:center;width:28px;height:28px;padding:0;border:0;border-radius:7px;
      background:transparent;color:#aaa;cursor:pointer;font-size:19px}
    .participants-close:hover{background:#292929;color:#fff}
    .participants-tools{padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.08)}
    .participants-search{width:100%;height:36px;padding:0 10px;background:#0f0f0f;color:#fff;
      border:1px solid rgba(255,255,255,.12);border-radius:8px;outline:none}
    .participants-search:focus{border-color:rgba(239,61,56,.75);box-shadow:0 0 0 3px rgba(239,61,56,.12)}
    .participants-filters{display:flex;gap:5px;margin-top:8px;overflow-x:auto;scrollbar-width:none}
    .participants-filters::-webkit-scrollbar{display:none}.participants-filter{flex:0 0 auto;height:28px;padding:0 9px;
      border:1px solid rgba(255,255,255,.1);border-radius:999px;background:#222;color:#aaa;cursor:pointer;font-size:11px;font-weight:600}
    .participants-filter:hover{color:#fff;background:#2b2b2b}.participants-filter.active{color:#fff;background:#3a2423;
      border-color:#7a3431}.participants-list{min-height:120px;overflow-y:auto;padding:7px;overscroll-behavior:contain}
    .participant-row{width:100%;display:grid;grid-template-columns:36px minmax(0,1fr) auto;align-items:center;gap:9px;
      padding:8px;border:0;border-radius:9px;background:transparent;color:#fff;text-align:left;cursor:pointer}
    .participant-row:hover,.participant-row:focus-visible{background:#242424;outline:none}.participant-avatar{display:grid;place-items:center;
      width:36px;height:36px;border-radius:10px;background:#315fcf;color:#fff;font-size:14px;font-weight:800}
    .participant-main{min-width:0}.participant-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:700}
    .participant-meta{margin-top:3px;color:#828282;font-size:10px;white-space:nowrap}.participant-side{text-align:right}
    .participant-count{color:#aaa;font-size:10px}.participant-statuses{display:flex;justify-content:flex-end;gap:4px;margin-top:4px}
    .participant-status{padding:2px 5px;border-radius:999px;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.03em}
    .participant-status.flagged{background:#3a2810;color:#ffd18a}.participant-status.timeout{background:#2b2948;color:#c9c4ff}
    .participant-status.banned{background:#472020;color:#ffaaaa}.participant-status.muted{background:#282828;color:#ccc}
    .participant-status.blocked{background:#332124;color:#ffaaa6}.participant-status.member{background:#315a91;color:#e9f3ff}
    .participant-status.moderator{background:#147d56;color:#eafff6}.participant-status.creator{background:#d93025;color:#fff}
    .participants-empty{padding:30px 18px;text-align:center;color:#888}
    .participants-empty strong{display:block;margin-bottom:4px;color:#ccc;font-size:12px}

    #chat-moderation-queue-btn:hover,#chat-moderation-queue-btn[aria-expanded="true"]{background:rgba(255,255,255,.08)!important;color:#fff!important}
    .moderation-queue-badge{position:absolute;right:-2px;top:-3px;display:grid;place-items:center;min-width:14px;height:14px;
      padding:0 3px;border:2px solid #202020;border-radius:999px;background:#ef3d38;color:#fff;font-size:8px;font-weight:800}
    .admin-moderation-queue{
      position:fixed;z-index:100002;width:min(390px,calc(100vw - 20px));max-height:calc(100vh - 20px);
      display:flex;flex-direction:column;overflow:hidden;box-sizing:border-box;background:#181818;color:#fff;
      border:1px solid rgba(255,255,255,.14);border-radius:14px;box-shadow:0 16px 45px rgba(0,0,0,.58);
      font:13px/1.35 Roboto,Arial,sans-serif
    }
    .moderation-queue-header{display:flex;align-items:center;gap:10px;padding:13px 14px 11px;border-bottom:1px solid rgba(255,255,255,.08)}
    .moderation-queue-heading{min-width:0;flex:1}.moderation-queue-title{font-size:15px;font-weight:700}
    .moderation-queue-subtitle{margin-top:2px;color:#888;font-size:11px}.moderation-queue-close{display:grid;place-items:center;
      width:28px;height:28px;padding:0;border:0;border-radius:7px;background:transparent;color:#aaa;cursor:pointer;font-size:19px}
    .moderation-queue-close:hover{background:#292929;color:#fff}.moderation-queue-tabs{display:grid;grid-template-columns:repeat(4,1fr);
      gap:4px;margin:10px 12px 4px;padding:4px;background:#101010;border:1px solid rgba(255,255,255,.07);border-radius:9px}
    .moderation-queue-tab{height:31px;border:0;border-radius:7px;background:transparent;color:#888;cursor:pointer;font-size:11px;font-weight:700}
    .moderation-queue-tab.active{background:#292929;color:#fff}.moderation-queue-list{min-height:150px;overflow-y:auto;
      padding:7px 10px 11px;overscroll-behavior:contain}.moderation-report-card{padding:10px;background:#121212;
      border:1px solid rgba(255,255,255,.08);border-radius:10px}.moderation-report-card+.moderation-report-card{margin-top:7px}
    .moderation-report-top{display:flex;align-items:center;gap:7px}.moderation-report-reason{padding:3px 7px;border-radius:999px;
      background:#3a2810;color:#ffd18a;font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.04em}
    .moderation-report-state{margin-left:auto;color:#777;font-size:10px}.moderation-report-user{margin-top:8px;color:#ddd;font-size:11px;font-weight:700}
    .moderation-report-message{margin-top:4px;padding:8px 9px;background:#0c0c0c;border-radius:7px;color:#eee;
      overflow-wrap:anywhere;line-height:1.4}.moderation-report-meta{margin-top:5px;color:#777;font-size:10px}
    .moderation-report-details{margin-top:6px;color:#aaa;font-size:10px}.moderation-report-actions{display:grid;
      grid-template-columns:1fr 1fr 1fr;gap:5px;margin-top:9px}.moderation-report-action{min-width:0;padding:6px 5px;
      border:1px solid rgba(255,255,255,.11);border-radius:7px;background:#242424;color:#ddd;cursor:pointer;font-size:10px;font-weight:700}
    .moderation-report-action:hover{background:#303030;color:#fff}.moderation-report-action.primary{background:#3a2423;color:#ffb1ae;border-color:#6f302d}
    .moderation-report-action.danger{background:#351e1d;color:#ffaaa6;border-color:#65302d}.moderation-report-card[data-status="open"]{box-shadow:inset 3px 0 #d96b46}
    .moderation-report-card.report-message-removed .moderation-report-message{color:#999;font-style:italic}
    .moderation-queue-empty{padding:34px 20px;text-align:center;color:#777}.moderation-queue-empty strong{display:block;margin-bottom:5px;color:#ccc}
    .automod-panel{padding:4px 2px}.automod-card{padding:11px;background:#121212;border:1px solid rgba(255,255,255,.08);border-radius:10px}
    .automod-card+.automod-card{margin-top:8px}.automod-row{display:flex;align-items:center;justify-content:space-between;gap:14px}
    .automod-row+.automod-row{margin-top:11px;padding-top:11px;border-top:1px solid rgba(255,255,255,.07)}
    .automod-copy{min-width:0}.automod-title{color:#ddd;font-size:11px;font-weight:700}.automod-note{margin-top:2px;color:#777;font-size:10px}
    .automod-switch{position:relative;flex:0 0 36px;width:36px;height:21px;cursor:pointer}.automod-switch input{position:absolute;opacity:0}
    .automod-switch span{position:absolute;inset:0;border-radius:999px;background:#383838}.automod-switch span::after{content:'';position:absolute;
      left:3px;top:3px;width:15px;height:15px;border-radius:50%;background:#ddd;transition:transform .15s ease}.automod-switch input:checked+span{background:#ef3d38}
    .automod-switch input:checked+span::after{transform:translateX(15px);background:#fff}.automod-label{display:block;margin-bottom:6px;color:#ccc;font-size:11px;font-weight:700}
    .automod-terms{width:100%;min-height:76px;resize:vertical;padding:8px 9px;background:#0c0c0c;color:#fff;
      border:1px solid rgba(255,255,255,.11);border-radius:8px;outline:none}.automod-terms:focus{border-color:rgba(239,61,56,.7)}
    .automod-threshold{width:62px;height:32px;padding:0 8px;background:#0c0c0c;color:#fff;border:1px solid rgba(255,255,255,.11);
      border-radius:7px}.automod-save{width:100%;height:34px;margin-top:9px;border:0;border-radius:8px;background:#ef3d38;color:#fff;
      cursor:pointer;font-size:11px;font-weight:800}.automod-summary{margin-top:7px;color:#777;font-size:10px;line-height:1.45}
    .audit-log-panel{display:flex;min-height:0;flex-direction:column}.audit-log-tools{display:grid;grid-template-columns:minmax(0,1fr) 112px;gap:6px;padding:4px 2px 9px}
    .audit-log-search,.audit-log-filter{height:33px;min-width:0;padding:0 9px;border:1px solid rgba(255,255,255,.1);border-radius:8px;background:#0d0d0d;color:#ddd;font-size:10px;outline:none}
    .audit-log-search:focus,.audit-log-filter:focus{border-color:rgba(239,61,56,.65)}.audit-log-count{padding:0 3px 7px;color:#777;font-size:10px}
    .audit-entry{position:relative;padding:10px 10px 10px 14px;border:1px solid rgba(255,255,255,.08);border-radius:10px;background:#121212}
    .audit-entry+.audit-entry{margin-top:7px}.audit-entry::before{content:'';position:absolute;left:0;top:9px;bottom:9px;width:3px;border-radius:0 3px 3px 0;background:#777}
    .audit-entry[data-source="automod"]::before{background:#a86be8}.audit-entry[data-action*="ban"]::before,.audit-entry[data-action="message_removed"]::before{background:#ef5954}
    .audit-entry[data-action*="pinned"]::before,.audit-entry[data-action="message_pin_updated"]::before{background:#d99a46}
    .audit-entry[data-action*="restore"]::before,.audit-entry[data-action*="cleared"]::before{background:#54ad7a}.audit-entry-top{display:flex;align-items:flex-start;gap:8px}
    .audit-entry-title{min-width:0;flex:1;color:#eee;font-size:11px;font-weight:800}.audit-entry-actor{padding:2px 6px;border-radius:999px;background:#292929;color:#aaa;font-size:9px;font-weight:700}
    .audit-entry[data-source="automod"] .audit-entry-actor{background:#30223d;color:#d8b4ff}.audit-entry-target{margin-top:4px;color:#ccc;font-size:10px;font-weight:700}
    .audit-entry-context{margin-top:6px;padding:7px 8px;border-radius:7px;background:#0b0b0b;color:#aaa;font-size:10px;line-height:1.35;overflow-wrap:anywhere}
    .audit-entry-reason{margin-top:5px;color:#aaa;font-size:10px}.audit-entry-meta{display:flex;align-items:center;gap:6px;margin-top:6px;color:#707070;font-size:9px}
    .audit-entry-view{margin-left:auto;padding:3px 7px;border:1px solid rgba(255,255,255,.1);border-radius:6px;background:#242424;color:#ccc;cursor:pointer;font-size:9px;font-weight:700}
    .audit-entry-view:hover{background:#303030;color:#fff}

    .report-dialog-backdrop{position:fixed;inset:0;z-index:100006;display:grid;place-items:center;padding:14px;
      background:rgba(0,0,0,.62);font:13px/1.4 Roboto,Arial,sans-serif}.report-dialog{width:min(380px,calc(100vw - 28px));
      max-height:calc(100vh - 28px);overflow-y:auto;padding:15px;background:#191919;color:#fff;
      border:1px solid rgba(255,255,255,.14);border-radius:14px;box-shadow:0 20px 55px rgba(0,0,0,.65)}
    .report-dialog-header{display:flex;align-items:flex-start;gap:10px}.report-dialog-title{font-size:16px;font-weight:700}
    .report-dialog-copy{margin-top:3px;color:#888;font-size:11px}.report-dialog-close{margin-left:auto;display:grid;place-items:center;
      width:28px;height:28px;padding:0;border:0;border-radius:7px;background:transparent;color:#aaa;cursor:pointer;font-size:19px}
    .report-dialog-close:hover{background:#292929;color:#fff}.report-message-preview{margin-top:13px;padding:9px 10px;
      background:#101010;border-radius:9px;color:#ddd;overflow-wrap:anywhere}.report-message-preview strong{display:block;
      margin-bottom:3px;color:#888;font-size:10px;text-transform:uppercase;letter-spacing:.05em}.report-reasons{display:grid;
      grid-template-columns:1fr 1fr;gap:6px;margin-top:12px}.report-reason{cursor:pointer}.report-reason input{position:absolute;opacity:0}
    .report-reason span{display:flex;align-items:center;height:36px;padding:0 9px;border:1px solid rgba(255,255,255,.1);
      border-radius:8px;background:#121212;color:#aaa;font-size:11px;font-weight:600}.report-reason input:checked+span{color:#fff;
      border-color:#7a3431;background:#3a2423}.report-details-label{display:block;margin:12px 0 6px;color:#ccc;font-size:11px;font-weight:700}
    .report-reason:last-child:nth-child(odd){grid-column:1/-1}
    .report-details{width:100%;min-height:72px;resize:vertical;padding:9px 10px;background:#101010;color:#fff;
      border:1px solid rgba(255,255,255,.11);border-radius:8px;outline:none}.report-details:focus{border-color:rgba(239,61,56,.7);
      box-shadow:0 0 0 3px rgba(239,61,56,.12)}.report-dialog-footer{display:flex;justify-content:flex-end;gap:7px;margin-top:13px}
    .report-dialog-button{height:34px;padding:0 13px;border:1px solid rgba(255,255,255,.12);border-radius:8px;
      background:#252525;color:#ddd;cursor:pointer;font-size:11px;font-weight:700}.report-dialog-button.primary{border-color:#ef3d38;background:#ef3d38;color:#fff}
    .report-dialog-button:disabled{cursor:not-allowed}

    .ban-dialog-backdrop{position:fixed;inset:0;z-index:100007;display:grid;place-items:center;padding:14px;
      background:rgba(0,0,0,.65);font:13px/1.4 Roboto,Arial,sans-serif}.ban-dialog{width:min(410px,calc(100vw - 28px));
      padding:15px;background:#191919;color:#fff;border:1px solid rgba(255,255,255,.14);border-radius:14px;
      box-shadow:0 20px 55px rgba(0,0,0,.65)}.ban-dialog-header{display:flex;align-items:flex-start;gap:10px}.ban-dialog-title{font-size:16px;font-weight:700}
    .ban-dialog-copy{margin-top:3px;color:#888;font-size:11px}.ban-dialog-close{margin-left:auto;display:grid;place-items:center;
      width:28px;height:28px;padding:0;border:0;border-radius:7px;background:transparent;color:#aaa;cursor:pointer;font-size:19px}
    .ban-field{margin-top:12px}.ban-field label,.ban-history-label{display:block;margin-bottom:6px;color:#ccc;font-size:11px;font-weight:700}
    .ban-reason{width:100%;height:38px;padding:0 9px;background:#101010;color:#fff;border:1px solid rgba(255,255,255,.12);
      border-radius:8px}.ban-history-options{display:flex;flex-direction:column;gap:5px}.ban-history-option{cursor:pointer}.ban-history-option input{position:absolute;opacity:0}
    .ban-history-option span{display:block;padding:8px 9px;border:1px solid rgba(255,255,255,.09);border-radius:8px;background:#111;color:#aaa;font-size:11px}
    .ban-history-option input:checked+span{border-color:#763330;background:#382221;color:#fff}.ban-dialog-note{margin-top:8px;color:#777;font-size:10px;line-height:1.45}
    .ban-dialog-footer{display:flex;justify-content:flex-end;gap:7px;margin-top:13px}.ban-dialog-button{height:34px;padding:0 13px;
      border:1px solid rgba(255,255,255,.12);border-radius:8px;background:#252525;color:#ddd;cursor:pointer;font-size:11px;font-weight:700}
    .ban-dialog-button.danger{border-color:#ef3d38;background:#ef3d38;color:#fff}

    .pin-dialog-backdrop{position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;padding:14px;background:rgba(0,0,0,.65);font:13px/1.4 Roboto,Arial,sans-serif}
    .pin-dialog{width:min(390px,calc(100vw - 28px));padding:15px;background:#191919;color:#fff;border:1px solid rgba(255,255,255,.14);border-radius:14px;box-shadow:0 20px 55px rgba(0,0,0,.65)}
    .pin-dialog-title{font-size:16px;font-weight:800}.pin-dialog-copy{margin-top:4px;color:#909090;font-size:11px}.pin-dialog-preview{margin-top:11px;padding:9px 10px;border-radius:9px;background:#101010;color:#ddd;overflow-wrap:anywhere}
    .pin-dialog-preview strong{display:block;margin-bottom:3px;color:#888;font-size:9px;text-transform:uppercase;letter-spacing:.05em}.pin-dialog-fields{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:11px}
    .pin-dialog-field{color:#bbb;font-size:10px;font-weight:700}.pin-dialog-field select{display:block;width:100%;height:36px;margin-top:5px;padding:0 8px;border:1px solid rgba(255,255,255,.12);border-radius:8px;background:#101010;color:#fff;outline:none}
    .pin-dialog-field select:focus{border-color:rgba(239,61,56,.7)}.pin-dialog-timeline-note{margin-top:9px;padding:8px 9px;border-radius:8px;background:#241f18;color:#d9bd94;font-size:10px;line-height:1.4}.pin-dialog-footer{display:flex;justify-content:flex-end;gap:7px;margin-top:13px}
    .pin-dialog-button{height:34px;padding:0 13px;border:1px solid rgba(255,255,255,.12);border-radius:8px;background:#252525;color:#ddd;cursor:pointer;font-size:11px;font-weight:700}.pin-dialog-button.primary{border-color:#ef3d38;background:#ef3d38;color:#fff}.pin-dialog-button.danger{margin-right:auto;color:#ffaaa6;background:#321d1d}

    .user-history-window{position:fixed;z-index:100005;left:50%;top:50%;transform:translate(-50%,-50%);
      width:min(620px,calc(100vw - 24px));height:min(70vh,680px);min-width:340px;min-height:300px;resize:both;
      display:flex;flex-direction:column;overflow:hidden;background:#181818;color:#fff;border:1px solid rgba(255,255,255,.14);
      border-radius:14px;box-shadow:0 22px 65px rgba(0,0,0,.68);font:13px/1.4 Roboto,Arial,sans-serif}
    .user-history-header{display:flex;align-items:center;gap:10px;padding:10px 12px;background:#202020;border-bottom:1px solid rgba(255,255,255,.09)}
    .user-history-brand-icon{width:22px;height:22px;border-radius:4px;object-fit:cover}
    .user-history-avatar{display:grid;place-items:center;width:34px;height:34px;border-radius:9px;background:#315fcf;font-weight:800}
    .user-history-heading{min-width:0;flex:1}.user-history-title{font-size:14px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .user-history-subtitle{margin-top:2px;color:#888;font-size:10px}.user-history-close{display:grid;place-items:center;width:28px;height:28px;
      padding:0;border:0;border-radius:7px;background:transparent;color:#aaa;cursor:pointer;font-size:19px}.user-history-tools{display:flex;gap:7px;padding:9px 11px;
      border-bottom:1px solid rgba(255,255,255,.08)}.user-history-search{min-width:0;flex:1;height:34px;padding:0 9px;background:#0e0e0e;
      color:#fff;border:1px solid rgba(255,255,255,.11);border-radius:8px;outline:none}.user-history-filter{height:34px;padding:0 9px;
      background:#242424;color:#ddd;border:1px solid rgba(255,255,255,.11);border-radius:8px}.user-history-list{flex:1;overflow-y:auto;padding:8px 10px}
    .user-history-item{display:grid;grid-template-columns:58px minmax(0,1fr) auto;gap:9px;padding:9px;border-radius:8px}.user-history-item:hover{background:#222}
    .user-history-time{color:#818181;font-size:10px}.user-history-text{overflow-wrap:anywhere}.user-history-text.removed{color:#888;font-style:italic}
    .user-history-state{align-self:start;padding:2px 6px;border-radius:999px;background:#352120;color:#ffaaa6;font-size:9px;font-weight:800;text-transform:uppercase}
    .user-history-empty{padding:35px 15px;text-align:center;color:#777}
    .user-history-identity{display:flex;align-items:center;gap:10px;padding:11px 13px 8px}.user-history-identity-copy{display:flex;min-width:0;flex-direction:column}
    .user-history-identity-copy strong{font-size:13px}.user-history-identity-copy span{margin-top:2px;color:#858585;font-size:10px}
    .user-history-scopes{display:flex;gap:5px;padding:0 11px 9px}.user-history-scope{height:28px;padding:0 10px;border:1px solid rgba(255,255,255,.09);border-radius:7px;background:#171717;color:#8d8d8d;font-size:10px;font-weight:700}
    .user-history-scope.active{background:#303030;color:#fff}.user-history-scope:disabled{cursor:not-allowed;opacity:.42}
    .user-history-admin-tools{display:flex;align-items:center;gap:6px;padding:8px 11px;border-block:1px solid rgba(255,255,255,.08);background:#161616;flex-wrap:wrap}
    .user-history-duration,.user-history-action{height:29px;padding:0 9px;border:1px solid rgba(255,255,255,.11);border-radius:7px;background:#292929;color:#ddd;font-size:10px;font-weight:700}
    .user-history-action{cursor:pointer}.user-history-action:hover{background:#353535;color:#fff}.user-history-action.danger{color:#ffaaa6;background:#321d1d}
    .user-history-item-actions{display:flex;align-items:center;justify-content:flex-end;gap:5px;flex-wrap:wrap}.user-history-item-actions .user-history-action{height:24px;padding:0 7px;font-size:9px}
  `;
  document.head.appendChild(style);
}

let _inspectorEl = null;
let _inspectorOutsideHandler = null;
let _userCardAdminView = false;
let _participantsEl = null;
let _participantsOutsideHandler = null;
let _moderationQueueEl = null;
let _moderationQueueOutsideHandler = null;
let _reportDialogEl = null;
let _banDialogEl = null;
let _pinDialogEl = null;
let _userHistoryEl = null;
let _messageSeekReturnState = null;
let _messageSeekReturnEl = null;
const MODERATION_RECORDS_KEY = 'lyveModerationRecords';
const MODERATION_REPORTS_KEY = 'lyveModerationReports';
const MODERATION_AUDIT_KEY = 'lyveModerationAuditLog';
const AUTOMOD_SETTINGS_KEY = 'lyveAutoModSettings';
const VIEWER_SAFETY_RECORDS_KEY = 'lyveViewerSafetyRecords';
const USER_ROLE_RECORDS_KEY = 'lyveUserRoleRecords';
const USER_ROLES = new Set(['viewer', 'member', 'moderator', 'creator']);

// Conservative high-confidence subset curated from the Shutterstock/LDNOOBW
// English moderation lexicon (CC BY 4.0). See THIRD_PARTY_NOTICES.md.
const SEVERE_SLUR_RULES = [
  /(?:^|[^a-z])n[\W_]*i[\W_]*g[\W_]*g(?:[\W_]*e[\W_]*r|[\W_]*a)s?(?=$|[^a-z])/i,
  /(?:^|[^a-z])f[\W_]*a[\W_]*g(?:[\W_]*g[\W_]*(?:o|e)[\W_]*t)?s?(?=$|[^a-z])/i,
  /(?:^|[^a-z])k[\W_]*i[\W_]*k[\W_]*e[s]?(?=$|[^a-z])/i,
  /(?:^|[^a-z])s[\W_]*p[\W_]*i[\W_]*c[s]?(?=$|[^a-z])/i,
  /(?:^|[^a-z])w[\W_]*e[\W_]*t[\W_]*b[\W_]*a[\W_]*c[\W_]*k[s]?(?=$|[^a-z])/i,
  /(?:^|[^a-z])b[\W_]*e[\W_]*a[\W_]*n[\W_]*e[\W_]*r[s]?(?=$|[^a-z])/i,
  /(?:^|[^a-z])c[\W_]*h[\W_]*i[\W_]*n[\W_]*k[s]?(?=$|[^a-z])/i,
  /(?:^|[^a-z])g[\W_]*o[\W_]*o[\W_]*k[s]?(?=$|[^a-z])/i,
  /(?:^|[^a-z])(?:r[\W_]*a[\W_]*g|t[\W_]*o[\W_]*w[\W_]*e[\W_]*l)[\W_]*h[\W_]*e[\W_]*a[\W_]*d[s]?(?=$|[^a-z])/i,
  /(?:^|[^a-z])t[\W_]*r[\W_]*a[\W_]*n[\W_]*n(?:[\W_]*y|[\W_]*i[\W_]*e[\W_]*s)(?=$|[^a-z])/i,
  /(?:^|[^a-z])j[\W_]*i[\W_]*g[\W_]*g?[\W_]*a[\W_]*b[\W_]*o[\W_]*o[s]?(?=$|[^a-z])/i,
];

function normalizeAutoModText(value) {
  const substitutions = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's' };
  return String(value || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[013457@$]/g, character => substitutions[character] || character);
}

function containsSevereSlur(value) {
  const normalized = normalizeAutoModText(value);
  return SEVERE_SLUR_RULES.some(rule => rule.test(normalized));
}

function getAutoModSettings() {
  const defaults = {
    enabled: false,
    severeSlurProtection: true,
    immediateBanSevereSlurs: true,
    blockedTerms: [],
    deleteLinks: false,
    deleteDuplicates: true,
    autoBanEnabled: false,
    autoBanThreshold: 3,
  };
  try {
    const stored = JSON.parse(localStorage.getItem(AUTOMOD_SETTINGS_KEY) || '{}');
    return {
      ...defaults,
      ...stored,
      blockedTerms: Array.isArray(stored.blockedTerms) ? stored.blockedTerms : [],
      autoBanThreshold: Math.max(1, Math.min(20, Number(stored.autoBanThreshold) || 3)),
    };
  } catch {
    return defaults;
  }
}

function saveAutoModSettings(settings) {
  try { localStorage.setItem(AUTOMOD_SETTINGS_KEY, JSON.stringify(settings)); } catch {}
}

function closeInspector() {
  _inspectorEl?._dragCleanup?.();
  if (_inspectorEl) _inspectorEl.remove();
  _inspectorEl = null;
  if (_inspectorOutsideHandler) {
    document.removeEventListener('mousedown', _inspectorOutsideHandler, true);
    _inspectorOutsideHandler = null;
  }
}

function closeParticipants() {
  if (_participantsEl) _participantsEl.remove();
  _participantsEl = null;
  document.getElementById('chat-participants-btn')?.setAttribute('aria-expanded', 'false');
  if (_participantsOutsideHandler) {
    document.removeEventListener('mousedown', _participantsOutsideHandler, true);
    _participantsOutsideHandler = null;
  }
}

function closeModerationQueue() {
  if (_moderationQueueEl?._auditChangedHandler) {
    window.removeEventListener('lyve:audit-changed', _moderationQueueEl._auditChangedHandler);
  }
  if (_moderationQueueEl) _moderationQueueEl.remove();
  _moderationQueueEl = null;
  document.getElementById('chat-moderation-queue-btn')?.setAttribute('aria-expanded', 'false');
  if (_moderationQueueOutsideHandler) {
    document.removeEventListener('mousedown', _moderationQueueOutsideHandler, true);
    _moderationQueueOutsideHandler = null;
  }
}

function closeReportDialog() {
  if (_reportDialogEl) _reportDialogEl.remove();
  _reportDialogEl = null;
}

function closeBanDialog() {
  if (_banDialogEl) _banDialogEl.remove();
  _banDialogEl = null;
}

function closePinDialog() {
  if (_pinDialogEl) _pinDialogEl.remove();
  _pinDialogEl = null;
}

function closeUserHistory() {
  if (_userHistoryEl) _userHistoryEl.remove();
  _userHistoryEl = null;
}

document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  if (_pinDialogEl) closePinDialog();
  else if (_banDialogEl) closeBanDialog();
  else if (_reportDialogEl) closeReportDialog();
  else if (_userHistoryEl) closeUserHistory();
  else if (_moderationQueueEl) closeModerationQueue();
  else if (_participantsEl) closeParticipants();
}, true);

function getModerationRecord(userId) {
  const empty = { flags: [], actions: [], banned: false, autoModViolations: 0 };
  if (!userId) return empty;
  try {
    const all = JSON.parse(localStorage.getItem(MODERATION_RECORDS_KEY) || '{}');
    const record = all[userId] || empty;
    return {
      flags: Array.isArray(record.flags) ? record.flags : [],
      actions: Array.isArray(record.actions) ? record.actions : [],
      banned: record.banned === true,
      autoModViolations: Math.max(0, Number(record.autoModViolations) || 0),
    };
  } catch {
    return empty;
  }
}

function saveModerationRecord(userId, record) {
  if (!userId) return;
  try {
    const all = JSON.parse(localStorage.getItem(MODERATION_RECORDS_KEY) || '{}');
    all[userId] = record;
    localStorage.setItem(MODERATION_RECORDS_KEY, JSON.stringify(all));
  } catch {}
}

function getModerationAuditLog() {
  try {
    const entries = JSON.parse(localStorage.getItem(MODERATION_AUDIT_KEY) || '[]');
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
}

function appendModerationAudit(action, details = {}) {
  const rawVideoTime = details.videoTime ?? details.message?.time;
  const entry = {
    id: crypto.randomUUID?.() || `audit_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    videoId: getCurrentVideoIdentity(),
    at: new Date().toISOString(),
    actor: details.actor || 'You',
    source: details.source || (details.actor === 'AutoMod' ? 'automod' : 'manual'),
    action,
    targetUserId: details.targetUserId || details.userId || '',
    targetName: details.targetName || details.displayName || details.user || 'Unknown user',
    messageId: details.messageId || details.message?.id || '',
    messageText: details.messageText ?? details.message?.text ?? '',
    videoTime: rawVideoTime === undefined || rawVideoTime === null ? null : Number(rawVideoTime),
    reason: details.reason || '',
    durationSeconds: Number(details.durationSeconds || 0),
    metadata: details.metadata || '',
  };
  try {
    const entries = getModerationAuditLog();
    entries.push(entry);
    localStorage.setItem(MODERATION_AUDIT_KEY, JSON.stringify(entries.slice(-500)));
    window.dispatchEvent(new CustomEvent('lyve:audit-changed', { detail: entry }));
  } catch {}
  return entry;
}

function getCurrentVideoAuditLog() {
  const videoId = getCurrentVideoIdentity();
  return getModerationAuditLog()
    .filter(entry => entry.videoId === videoId)
    .sort((a, b) => new Date(b.at || 0).getTime() - new Date(a.at || 0).getTime());
}

function getAuditActionLabel(entry) {
  const labels = {
    message_removed: 'Removed message',
    message_restored: 'Restored message',
    message_pinned: 'Pinned message',
    message_pin_updated: 'Updated pinned segment',
    message_unpinned: 'Unpinned message',
    user_banned: 'Banned user',
    user_unbanned: 'Unbanned user',
    user_timed_out: 'Timed out user',
    timeout_cleared: 'Cleared timeout',
    flag_added: 'Added account flag',
    flag_removed: 'Removed account flag',
    report_reviewed: 'Marked report reviewed',
    report_dismissed: 'Dismissed report',
    report_reopened: 'Reopened report',
    role_changed: 'Changed user role',
    automod_settings_changed: 'Changed AutoMod rules',
    moderation_history_cleared: 'Cleared moderation history',
    automod_strikes_cleared: 'Cleared AutoMod strikes',
  };
  return labels[entry.action] || String(entry.action || 'Moderation action').replaceAll('_', ' ');
}

function getViewerSafetyIdentity(data) {
  if (data?.userId) return `id:${data.userId}`;
  const name = String(data?.displayName || data?.user || '').trim().toLowerCase();
  return name ? `name:${name}` : '';
}

function getViewerSafetyRecord(data) {
  const empty = { muted: false, blocked: false, actions: [] };
  const identity = getViewerSafetyIdentity(data);
  if (!identity) return empty;
  try {
    const all = JSON.parse(localStorage.getItem(VIEWER_SAFETY_RECORDS_KEY) || '{}');
    const record = all[identity] || empty;
    return {
      muted: record.muted === true,
      blocked: record.blocked === true,
      actions: Array.isArray(record.actions) ? record.actions : [],
    };
  } catch {
    return empty;
  }
}

function setViewerSafetyState(data, type, enabled) {
  const identity = getViewerSafetyIdentity(data);
  if (!identity || !['muted', 'blocked'].includes(type)) return;
  try {
    const all = JSON.parse(localStorage.getItem(VIEWER_SAFETY_RECORDS_KEY) || '{}');
    const record = getViewerSafetyRecord(data);
    record[type] = Boolean(enabled);
    if (enabled && type === 'blocked') record.muted = false;
    if (enabled && type === 'muted') record.blocked = false;
    record.actions.push({ type: enabled ? type.slice(0, -1) : `un${type.slice(0, -1)}`, at: new Date().toISOString() });
    all[identity] = record;
    localStorage.setItem(VIEWER_SAFETY_RECORDS_KEY, JSON.stringify(all));
    window.dispatchEvent(new CustomEvent('lyve:viewer-safety-changed', { detail: { identity, record } }));
    renderNow();
  } catch {}
}

function getUserRole(data) {
  const identity = getViewerSafetyIdentity(data);
  if (!identity) return 'viewer';
  try {
    const all = JSON.parse(localStorage.getItem(USER_ROLE_RECORDS_KEY) || '{}');
    const role = String(all[identity] || 'viewer').toLowerCase();
    return USER_ROLES.has(role) ? role : 'viewer';
  } catch {
    return 'viewer';
  }
}

function setUserRole(data, role) {
  const identity = getViewerSafetyIdentity(data);
  const normalizedRole = String(role || '').toLowerCase();
  if (!identity || !USER_ROLES.has(normalizedRole)) return;
  try {
    const all = JSON.parse(localStorage.getItem(USER_ROLE_RECORDS_KEY) || '{}');
    const previousRole = String(all[identity] || 'viewer').toLowerCase();
    all[identity] = normalizedRole;
    localStorage.setItem(USER_ROLE_RECORDS_KEY, JSON.stringify(all));
    if (previousRole !== normalizedRole) {
      appendModerationAudit('role_changed', {
        actor: 'You', source: 'manual', targetUserId: data?.userId,
        targetName: data?.displayName || data?.user,
        reason: `${previousRole} to ${normalizedRole}`,
      });
    }
    window.dispatchEvent(new CustomEvent('lyve:user-role-changed', { detail: { identity, role: normalizedRole } }));
    renderNow();
  } catch {}
}

globalThis.lyveGetViewerSafetyState = message => {
  const identity = { userId: message?.userId || '', displayName: message?.user || message?.displayName || '' };
  const safety = getViewerSafetyRecord(identity);
  const moderation = getModerationRecord(identity.userId);
  return {
    ...safety,
    flagged: moderation.flags.length > 0,
    timedOut: Boolean(getActiveTimeout(moderation)),
    banned: moderation.banned,
    showAdminStates: isAdmin(),
    role: getUserRole(identity),
  };
};

function getModerationReports() {
  try {
    const reports = JSON.parse(localStorage.getItem(MODERATION_REPORTS_KEY) || '[]');
    return Array.isArray(reports) ? reports : [];
  } catch {
    return [];
  }
}

function saveModerationReports(reports) {
  try {
    localStorage.setItem(MODERATION_REPORTS_KEY, JSON.stringify(reports));
    window.dispatchEvent(new CustomEvent('lyve:reports-changed'));
    renderNow();
  } catch {}
}

function getCurrentVideoReports() {
  const videoId = getCurrentVideoIdentity();
  return getModerationReports()
    .filter(report => report.videoId === videoId)
    .sort((a, b) => new Date(b.reportedAt || 0).getTime() - new Date(a.reportedAt || 0).getTime());
}

function reportMatchesMessage(report, message) {
  if (!report || !message) return false;
  if (report.messageId && message.id) return report.messageId === message.id;
  return Boolean((report.userId ? report.userId === message.userId : report.user === message.user)
    && Number(report.time || 0) === Number(message.time || 0)
    && String(report.text || '') === String(message.text || ''));
}

function findReportedMessage(report) {
  return messages.find(message => reportMatchesMessage(report, message)) || null;
}

function getMessageReportState(message) {
  if (!message) return { totalCount: 0, openCount: 0, reports: [] };
  const reports = getCurrentVideoReports().filter(report => reportMatchesMessage(report, message));
  const openCount = reports.filter(report => report.status === 'open').length;
  return { totalCount: reports.length, openCount, reports };
}

globalThis.lyveGetMessageReportState = getMessageReportState;

function updateModerationQueueBadge() {
  const badge = document.querySelector('#chat-moderation-queue-btn .moderation-queue-badge');
  if (!badge) return;
  const count = getCurrentVideoReports().filter(report => report.status === 'open').length;
  badge.textContent = count > 99 ? '99+' : String(count);
  badge.hidden = count === 0;
}

function getTimeoutDurationSeconds(action) {
  return Number(action.durationSeconds || (action.durationMinutes || 10) * 60);
}

function getActiveTimeout(record) {
  const now = Date.now();
  return [...record.actions].reverse().find((action) => {
    if (action.type !== 'timeout' || action.clearedAt) return false;
    const expiresAt = action.expiresAt
      ? new Date(action.expiresAt).getTime()
      : new Date(action.at).getTime() + getTimeoutDurationSeconds(action) * 1000;
    return Number.isFinite(expiresAt) && expiresAt > now;
  }) || null;
}

function applyLocalAutoModeration(message) {
  if (!message) return message;
  const record = getModerationRecord(message.userId);
  const now = new Date().toISOString();
  const settings = getAutoModSettings();

  if (record.banned) {
    message.authorBanned = true;
    message.deletedAt = now;
    message.deletedBy = 'AutoMod';
    message.deleteReason = 'Message from banned user';
    appendModerationAudit('message_removed', {
      actor: 'AutoMod', source: 'automod', message,
      targetUserId: message.userId, targetName: message.user,
      reason: message.deleteReason,
    });
    return message;
  }

  if (settings.severeSlurProtection && containsSevereSlur(message.text)) {
    message.deletedAt = now;
    message.deletedBy = 'AutoMod';
    message.deleteReason = 'Severe protected-class slur';
    record.autoModViolations += 1;
    appendModerationAudit('message_removed', {
      actor: 'AutoMod', source: 'automod', message,
      targetUserId: message.userId, targetName: message.user,
      reason: message.deleteReason,
    });
    if (settings.immediateBanSevereSlurs) {
      record.banned = true;
      message.authorBanned = true;
      const severeUser = { userId: message.userId, displayName: message.user };
      setUserBanState(severeUser, true, { render: false });
      clearPinsForUser(severeUser, { actor: 'AutoMod', source: 'automod', reason: 'Pinned user was automatically banned' });
      for (const existing of messages) {
        if (messageBelongsToUser(existing, severeUser)) {
          markMessageDeleted(existing, 'Severe protected-class slur', 'AutoMod');
        }
      }
      record.actions.push({
        type: 'ban', at: now, source: 'automod-severe-slur',
        reason: 'Severe protected-class slur',
      });
      appendModerationAudit('user_banned', {
        actor: 'AutoMod', source: 'automod', message,
        targetUserId: message.userId, targetName: message.user,
        reason: 'Severe protected-class slur', metadata: 'Immediate AutoMod ban',
      });
      message.autoBanned = true;
    }
    saveModerationRecord(message.userId, record);
    return message;
  }

  if (!settings.enabled) return message;

  const text = String(message.text || '');
  const normalized = text.trim().toLowerCase();
  let reason = '';
  const blockedTerm = settings.blockedTerms
    .map(term => String(term).trim().toLowerCase())
    .filter(Boolean)
    .find(term => normalized.includes(term));
  if (blockedTerm) reason = `Blocked term: ${blockedTerm}`;
  else if (settings.deleteLinks && /(?:https?:\/\/|www\.)\S+/i.test(text)) reason = 'Links are not allowed';
  else if (settings.deleteDuplicates && normalized) {
    const duplicate = [...messages].reverse().find(existing => {
      const sameUser = message.userId
        ? existing.userId === message.userId
        : existing.user === message.user;
      return sameUser
        && String(existing.text || '').trim().toLowerCase() === normalized
        && Math.abs(Number(existing.time || 0) - Number(message.time || 0)) <= 30;
    });
    if (duplicate) reason = 'Repeated message';
  }

  if (!reason) return message;
  message.deletedAt = now;
  message.deletedBy = 'AutoMod';
  message.deleteReason = reason;
  record.autoModViolations += 1;
  appendModerationAudit('message_removed', {
    actor: 'AutoMod', source: 'automod', message,
    targetUserId: message.userId, targetName: message.user, reason,
  });

  if (settings.autoBanEnabled && record.autoModViolations >= settings.autoBanThreshold) {
    record.banned = true;
    message.authorBanned = true;
    const autoBannedUser = { userId: message.userId, displayName: message.user };
    setUserBanState(autoBannedUser, true, { render: false });
    clearPinsForUser(autoBannedUser, { actor: 'AutoMod', source: 'automod', reason: 'Pinned user was automatically banned' });
    record.actions.push({ type: 'ban', at: now, source: 'automod', reason });
    appendModerationAudit('user_banned', {
      actor: 'AutoMod', source: 'automod', message,
      targetUserId: message.userId, targetName: message.user,
      reason, metadata: `Reached ${settings.autoBanThreshold} AutoMod strikes`,
    });
    message.autoBanned = true;
  }
  saveModerationRecord(message.userId, record);
  return message;
}

globalThis.lyveApplyAutoModeration = applyLocalAutoModeration;

function formatModerationDuration(seconds) {
  if (seconds < 60) return `${seconds} seconds`;
  if (seconds < 3600) return `${seconds / 60} minutes`;
  if (seconds < 86400) return `${seconds / 3600} hours`;
  return `${seconds / 86400} day${seconds === 86400 ? '' : 's'}`;
}

function formatVideoTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safe / 60);
  const remainder = Math.floor(safe % 60);
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function clearMessageSeekReturn() {
  _messageSeekReturnEl?.remove();
  _messageSeekReturnEl = null;
  _messageSeekReturnState = null;
}

function showMessageSeekReturn() {
  const panel = document.getElementById('chat-panel');
  if (!panel || !_messageSeekReturnState) return;
  _messageSeekReturnEl?.remove();
  _messageSeekReturnEl = document.createElement('div');
  _messageSeekReturnEl.className = 'chat-message-seek-return';
  const copy = document.createElement('span');
  copy.textContent = `You were at ${formatVideoTime(_messageSeekReturnState.time)}`;
  const returnButton = document.createElement('button');
  returnButton.type = 'button';
  returnButton.textContent = 'Return';
  returnButton.addEventListener('click', () => {
    const state = _messageSeekReturnState;
    const video = document.querySelector('video');
    if (!state || !video) return clearMessageSeekReturn();
    video.currentTime = state.time;
    if (state.wasPaused) video.pause();
    else video.play().catch(() => {});
    clearMessageSeekReturn();
    video.addEventListener('seeked', () => {
      renderNow();
      scrollChatToCurrentTime(document.getElementById('chat-messages'));
    }, { once: true });
  });
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'chat-message-seek-dismiss';
  dismiss.textContent = '×';
  dismiss.setAttribute('aria-label', 'Dismiss return option');
  dismiss.addEventListener('click', clearMessageSeekReturn);
  _messageSeekReturnEl.append(copy, returnButton, dismiss);
  panel.appendChild(_messageSeekReturnEl);
}

function watchFromMessage(message, leadSeconds = 1) {
  const video = document.querySelector('video');
  if (!video || !message) return;
  if (!_messageSeekReturnState) {
    _messageSeekReturnState = { time: video.currentTime, wasPaused: video.paused };
  }
  showMessageSeekReturn();
  video.currentTime = Math.max(0, Number(message.time || 0) - Math.max(0, leadSeconds));
  let synced = false;
  const sync = () => {
    if (synced) return;
    synced = true;
    renderNow();
    scrollChatToCurrentTime(document.getElementById('chat-messages'));
  };
  video.addEventListener('seeked', sync, { once: true });
  setTimeout(sync, 120);
}

function messageBelongsToUser(message, data) {
  return data.userId
    ? message.userId === data.userId
    : message.user === data.displayName;
}

function setUserBanState(data, banned, { render = true } = {}) {
  for (const message of messages) {
    if (messageBelongsToUser(message, data)) message.authorBanned = Boolean(banned);
  }
  if (render) renderNow();
}

function markMessageDeleted(message, reason, deletedBy = 'Moderator') {
  if (!message || message.deletedAt) return;
  if (isMessagePinned(message)) {
    clearPinnedMessage({
      message,
      reason: 'Pinned message was removed',
      actor: deletedBy === 'AutoMod' ? 'AutoMod' : 'You',
      source: deletedBy === 'AutoMod' ? 'automod' : 'manual',
    });
  }
  message.deletedAt = new Date().toISOString();
  message.deletedBy = deletedBy;
  message.deleteReason = reason || 'Removed by moderator';
  appendModerationAudit('message_removed', {
    actor: deletedBy === 'AutoMod' ? 'AutoMod' : 'You',
    source: deletedBy === 'AutoMod' ? 'automod' : 'manual',
    message,
    targetUserId: message.userId,
    targetName: message.user,
    reason: message.deleteReason,
  });
}

function restoreMessage(message) {
  if (!message || !message.deletedAt) return;
  const previousReason = message.deleteReason || '';
  delete message.deletedAt;
  delete message.deletedBy;
  delete message.deleteReason;
  appendModerationAudit('message_restored', {
    actor: 'You', source: 'manual', message,
    targetUserId: message.userId, targetName: message.user,
    reason: previousReason ? `Previously removed: ${previousReason}` : '',
  });
}

function requestPinMessage(message, onComplete) {
  if (!message || message.deletedAt) return;
  const schedule = getVideoPinSchedule();
  const existing = schedule.find(pin => isMessageMatch(pin, message));
  const commentTime = Math.max(0, Math.floor(Number(message.time || 0)));
  const currentTime = Math.max(0, Math.floor(Number(document.querySelector('video')?.currentTime || 0)));
  closePinDialog();
  _pinDialogEl = document.createElement('div');
  _pinDialogEl.className = 'pin-dialog-backdrop';
  _pinDialogEl.setAttribute('role', 'dialog');
  _pinDialogEl.setAttribute('aria-modal', 'true');
  _pinDialogEl.setAttribute('aria-label', existing ? 'Edit pinned segment' : 'Pin message to video timeline');
  const dialog = document.createElement('div'); dialog.className = 'pin-dialog';
  const title = document.createElement('div'); title.className = 'pin-dialog-title'; title.textContent = existing ? 'Edit pinned segment' : 'Pin to video timeline';
  const copy = document.createElement('div'); copy.className = 'pin-dialog-copy'; copy.textContent = 'The pin appears only during this portion of the video and returns when viewers seek back to it.';
  const preview = document.createElement('div'); preview.className = 'pin-dialog-preview';
  const previewLabel = document.createElement('strong'); previewLabel.textContent = 'Message';
  preview.append(previewLabel, document.createTextNode(`${message.user || 'Unknown user'}: ${message.text || ''}`));

  const fields = document.createElement('div'); fields.className = 'pin-dialog-fields';
  const startField = document.createElement('label'); startField.className = 'pin-dialog-field'; startField.textContent = 'Start pin at';
  const startSelect = document.createElement('select'); startSelect.setAttribute('aria-label', 'Pinned segment start time');
  const startOptions = new Map([[String(commentTime), `Comment time · ${formatVideoTime(commentTime)}`], [String(currentTime), `Current video time · ${formatVideoTime(currentTime)}`]]);
  if (existing) startOptions.set(String(existing.startTime), `Existing start · ${formatVideoTime(existing.startTime)}`);
  for (const [value, label] of startOptions) {
    const option = document.createElement('option'); option.value = value; option.textContent = label;
    option.selected = Number(value) === Number(existing?.startTime ?? commentTime); startSelect.appendChild(option);
  }
  startField.appendChild(startSelect);
  const durationField = document.createElement('label'); durationField.className = 'pin-dialog-field'; durationField.textContent = 'Keep pinned for';
  const durationSelect = document.createElement('select'); durationSelect.setAttribute('aria-label', 'Pinned segment duration');
  for (const [value, label] of [['30', '30 seconds'], ['60', '1 minute'], ['120', '2 minutes'], ['300', '5 minutes'], ['until-next', 'Until the next pin']]) {
    const option = document.createElement('option'); option.value = value; option.textContent = label;
    option.selected = value === String(existing?.durationMode || '60'); durationSelect.appendChild(option);
  }
  durationField.appendChild(durationSelect); fields.append(startField, durationField);
  const timelineNote = document.createElement('div'); timelineNote.className = 'pin-dialog-timeline-note';
  const updateTimelineNote = () => {
    const start = Number(startSelect.value || commentTime);
    const mode = durationSelect.value || '60';
    const endCopy = mode === 'until-next' ? 'the next scheduled pin or video end' : formatVideoTime(start + Number(mode));
    const takeover = schedule.find(pin => pin.pinId !== existing?.pinId && pin.startTime <= start && start < getPinEffectiveEnd(pin, schedule));
    timelineNote.textContent = `Visible from ${formatVideoTime(start)} to ${endCopy}.${takeover ? ` Takes over from ${takeover.user || 'the current pin'} at that point.` : ''}`;
  };
  startSelect.addEventListener('change', updateTimelineNote); durationSelect.addEventListener('change', updateTimelineNote); updateTimelineNote();
  const footer = document.createElement('div'); footer.className = 'pin-dialog-footer';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'pin-dialog-button'; cancel.textContent = 'Cancel'; cancel.addEventListener('click', closePinDialog);
  const save = document.createElement('button'); save.type = 'button'; save.className = 'pin-dialog-button primary'; save.textContent = existing ? 'Save pin' : 'Pin message';
  save.addEventListener('click', () => {
    savePinnedMessage(message, { startTime: Number(startSelect.value), durationMode: durationSelect.value });
    closePinDialog();
    onComplete?.();
  });
  if (existing) {
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'pin-dialog-button danger'; remove.textContent = 'Remove pin';
    remove.addEventListener('click', () => { clearPinnedMessage({ pinId: existing.pinId }); closePinDialog(); onComplete?.(); });
    footer.append(remove);
  }
  footer.append(cancel, save); dialog.append(title, copy, preview, fields, timelineNote, footer); _pinDialogEl.appendChild(dialog);
  _pinDialogEl.addEventListener('mousedown', event => { if (event.target === _pinDialogEl) closePinDialog(); });
  const dialogHost = getInspectorHost();
  dialogHost.appendChild(_pinDialogEl);
  if (dialogHost !== document.body) _pinDialogEl.style.position = 'absolute';
  save.focus();
}

function showBanDialog(data, onComplete) {
  if (!data?.userId && !data?.displayName) return;
  closeBanDialog();
  _banDialogEl = document.createElement('div');
  _banDialogEl.className = 'ban-dialog-backdrop';
  _banDialogEl.setAttribute('role', 'dialog');
  _banDialogEl.setAttribute('aria-modal', 'true');
  _banDialogEl.setAttribute('aria-label', `Ban ${data.displayName || 'user'}`);

  const dialog = document.createElement('div');
  dialog.className = 'ban-dialog';
  const header = document.createElement('div');
  header.className = 'ban-dialog-header';
  const heading = document.createElement('div');
  const title = document.createElement('div'); title.className = 'ban-dialog-title'; title.textContent = `Ban ${data.displayName || 'user'}`;
  const copy = document.createElement('div'); copy.className = 'ban-dialog-copy'; copy.textContent = 'Choose why they are being banned and what should happen to their existing chat history.';
  heading.append(title, copy);
  const close = document.createElement('button'); close.type = 'button'; close.className = 'ban-dialog-close'; close.textContent = '×'; close.setAttribute('aria-label', 'Close ban dialog');
  close.addEventListener('click', closeBanDialog);
  header.append(heading, close);

  const reasonField = document.createElement('div'); reasonField.className = 'ban-field';
  const reasonLabel = document.createElement('label'); reasonLabel.textContent = 'Ban reason';
  const reason = document.createElement('select'); reason.className = 'ban-reason';
  const reasonOptions = [
    ['spam', 'Spam or flooding'],
    ['harassment', 'Harassment'],
    ['hate', 'Hate speech or severe slur'],
    ['threat', 'Threats, doxxing, or dangerous content'],
    ['evasion', 'Ban evasion'],
    ['other', 'Other'],
  ];
  for (const [value, label] of reasonOptions) {
    const option = document.createElement('option'); option.value = value; option.textContent = label; reason.appendChild(option);
  }
  reasonLabel.appendChild(reason); reasonField.appendChild(reasonLabel);

  const historyField = document.createElement('div'); historyField.className = 'ban-field';
  const historyLabel = document.createElement('div'); historyLabel.className = 'ban-history-label'; historyLabel.textContent = 'Existing message history';
  const historyOptions = document.createElement('div'); historyOptions.className = 'ban-history-options';
  const historyChoices = [
    ['keep', 'Keep history and mark the account as banned'],
    ['message', 'Remove only the message that opened this card'],
    ['all', 'Remove all messages from this user'],
  ];
  for (const [value, label] of historyChoices) {
    const option = document.createElement('label'); option.className = 'ban-history-option';
    const input = document.createElement('input'); input.type = 'radio'; input.name = 'ban-history-action'; input.value = value;
    const text = document.createElement('span'); text.textContent = label;
    option.append(input, text); historyOptions.appendChild(option);
  }
  historyField.append(historyLabel, historyOptions);
  const selectHistoryAction = value => {
    const input = historyOptions.querySelector(`input[value="${value}"]`);
    if (input) input.checked = true;
  };
  const syncHistoryDefault = () => {
    if (['spam', 'hate', 'threat'].includes(reason.value)) selectHistoryAction('all');
    else if (reason.value === 'harassment') selectHistoryAction('message');
    else selectHistoryAction('keep');
  };
  reason.addEventListener('change', syncHistoryDefault);
  syncHistoryDefault();
  const note = document.createElement('div'); note.className = 'ban-dialog-note';
  note.textContent = 'Kept history remains relevant to the conversation but appears dimmed under a generic banned-user label. Removed content remains visible only inside the admin history window.';

  const footer = document.createElement('div'); footer.className = 'ban-dialog-footer';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'ban-dialog-button'; cancel.textContent = 'Cancel'; cancel.addEventListener('click', closeBanDialog);
  const confirm = document.createElement('button'); confirm.type = 'button'; confirm.className = 'ban-dialog-button danger'; confirm.textContent = 'Ban user';
  confirm.addEventListener('click', () => {
    const historyAction = historyOptions.querySelector('input:checked')?.value || 'keep';
    const reasonLabelText = reasonOptions.find(([value]) => value === reason.value)?.[1] || reason.value;
    const now = new Date().toISOString();
    const record = getModerationRecord(data.userId);
    record.banned = true;
    record.actions.push({ type: 'ban', at: now, reason: reasonLabelText, historyAction, source: 'user-card' });
    saveModerationRecord(data.userId, record);
    setUserBanState(data, true, { render: false });
    clearPinsForUser(data, { reason: 'Pinned user was banned' });
    if (historyAction === 'message') markMessageDeleted(data.message, reasonLabelText);
    if (historyAction === 'all') {
      for (const message of messages) {
        if (messageBelongsToUser(message, data)) markMessageDeleted(message, reasonLabelText);
      }
    }
    appendModerationAudit('user_banned', {
      actor: 'You', source: 'manual', targetUserId: data.userId,
      targetName: data.displayName, message: data.message,
      reason: reasonLabelText, metadata: `History: ${historyAction}`,
    });
    closeBanDialog();
    renderNow();
    onComplete?.();
  });
  footer.append(cancel, confirm);
  dialog.append(header, reasonField, historyField, note, footer);
  _banDialogEl.appendChild(dialog);
  _banDialogEl.addEventListener('mousedown', event => { if (event.target === _banDialogEl) closeBanDialog(); });
  document.body.appendChild(_banDialogEl);
  reason.focus();
}

function showUserHistoryWindow(data) {
  closeUserHistory();
  const userMessages = messages.filter(message => messageBelongsToUser(message, data));
  _userHistoryEl = document.createElement('section');
  _userHistoryEl.className = 'user-history-window';
  _userHistoryEl.setAttribute('role', 'dialog');
  _userHistoryEl.setAttribute('aria-label', `Message history for ${data.displayName || 'user'}`);

  const header = document.createElement('div'); header.className = 'user-history-header';
  const brandIcon = document.createElement('img'); brandIcon.className = 'user-history-brand-icon'; brandIcon.src = chrome.runtime.getURL('assets/lyve-icon-32.png'); brandIcon.alt = '';
  const heading = document.createElement('div'); heading.className = 'user-history-heading';
  const title = document.createElement('div'); title.className = 'user-history-title'; title.textContent = 'Lyve';
  const subtitle = document.createElement('div'); subtitle.className = 'user-history-subtitle'; subtitle.textContent = `Chat history · ${data.displayName || 'Unknown user'}`;
  heading.append(title, subtitle);
  const close = document.createElement('button'); close.type = 'button'; close.className = 'user-history-close'; close.textContent = '×'; close.setAttribute('aria-label', 'Close full history'); close.addEventListener('click', closeUserHistory);
  header.append(brandIcon, heading, close);

  const identity = document.createElement('div'); identity.className = 'user-history-identity';
  const avatar = document.createElement('div'); avatar.className = 'user-history-avatar'; avatar.textContent = Array.from(String(data.displayName || '?'))[0]?.toUpperCase() || '?';
  const identityCopy = document.createElement('div'); identityCopy.className = 'user-history-identity-copy';
  const identityName = document.createElement('strong'); identityName.textContent = data.displayName || 'Unknown user';
  const identityMeta = document.createElement('span');
  const historyRole = getUserRole(data);
  identityMeta.textContent = `${userMessages.length} message${userMessages.length === 1 ? '' : 's'} · ${historyRole === 'viewer' ? 'Standard viewer' : historyRole.replace(/^./, character => character.toUpperCase())} · Account created ${data.accountCreatedAt ? new Date(data.accountCreatedAt).toLocaleDateString() : 'not available until accounts'}`;
  identityCopy.append(identityName, identityMeta); identity.append(avatar, identityCopy);

  const scopes = document.createElement('div'); scopes.className = 'user-history-scopes';
  for (const [label, enabled] of [['This video', true], ['This uploader', false], ['All channels', false]]) {
    const scope = document.createElement('button'); scope.type = 'button'; scope.className = `user-history-scope${enabled ? ' active' : ''}`; scope.textContent = label; scope.disabled = !enabled;
    if (!enabled) scope.title = 'Available after the shared account backend is connected';
    scopes.appendChild(scope);
  }

  const adminTools = document.createElement('div'); adminTools.className = 'user-history-admin-tools';
  const record = getModerationRecord(data.userId);
  const activeTimeout = getActiveTimeout(record);
  const duration = document.createElement('select'); duration.className = 'user-history-duration'; duration.setAttribute('aria-label', 'Timeout duration');
  for (const [seconds, label] of [[60, '1 minute'], [600, '10 minutes'], [3600, '1 hour'], [86400, '1 day'], [604800, '1 week']]) {
    const option = document.createElement('option'); option.value = String(seconds); option.textContent = label; duration.appendChild(option);
  }
  const actionButton = (label, handler, danger = false) => {
    const button = document.createElement('button'); button.type = 'button'; button.className = `user-history-action${danger ? ' danger' : ''}`; button.textContent = label; button.addEventListener('click', handler); return button;
  };
  if (activeTimeout) {
    adminTools.appendChild(actionButton('Clear timeout', () => {
      activeTimeout.clearedAt = new Date().toISOString();
      appendModerationAudit('timeout_cleared', { actor: 'You', source: 'manual', targetUserId: data.userId, targetName: data.displayName });
      saveModerationRecord(data.userId, record); showUserHistoryWindow(data);
    }));
  } else {
    adminTools.append(duration, actionButton('Timeout', () => {
      const now = new Date(); const seconds = Number(duration.value || 600);
      record.actions.push({ type: 'timeout', at: now.toISOString(), durationSeconds: seconds, expiresAt: new Date(now.getTime() + seconds * 1000).toISOString(), source: 'full-history' });
      appendModerationAudit('user_timed_out', { actor: 'You', source: 'manual', targetUserId: data.userId, targetName: data.displayName, durationSeconds: seconds });
      saveModerationRecord(data.userId, record); showUserHistoryWindow(data);
    }));
  }
  adminTools.appendChild(actionButton(record.banned ? 'Unban' : 'Ban', () => {
    if (record.banned) {
      record.banned = false; record.actions.push({ type: 'unban', at: new Date().toISOString(), source: 'full-history' });
      appendModerationAudit('user_unbanned', { actor: 'You', source: 'manual', targetUserId: data.userId, targetName: data.displayName });
      saveModerationRecord(data.userId, record); setUserBanState(data, false); showUserHistoryWindow(data);
    } else {
      showBanDialog(data, () => showUserHistoryWindow(data));
    }
  }, !record.banned));
  adminTools.appendChild(actionButton('Add flag', () => {
    record.flags = Array.isArray(record.flags) ? record.flags : [];
    if (!record.flags.includes('Manual review')) record.flags.push('Manual review');
    record.actions.push({ type: 'flag', at: new Date().toISOString(), label: 'Manual review', source: 'full-history' });
    appendModerationAudit('flag_added', { actor: 'You', source: 'manual', targetUserId: data.userId, targetName: data.displayName, reason: 'Manual review' });
    saveModerationRecord(data.userId, record); showUserHistoryWindow(data);
  }));

  const tools = document.createElement('div'); tools.className = 'user-history-tools';
  const search = document.createElement('input'); search.type = 'search'; search.className = 'user-history-search'; search.placeholder = 'Search this user’s messages';
  const filter = document.createElement('select'); filter.className = 'user-history-filter';
  for (const [value, label] of [['all', 'All messages'], ['visible', 'Visible'], ['removed', 'Removed']]) {
    const option = document.createElement('option'); option.value = value; option.textContent = label; filter.appendChild(option);
  }
  tools.append(search, filter);
  const list = document.createElement('div'); list.className = 'user-history-list';

  const renderHistory = () => {
    const query = search.value.trim().toLowerCase();
    const visible = userMessages.filter(message => {
      if (query && !String(message.text || '').toLowerCase().includes(query)) return false;
      if (filter.value === 'removed') return Boolean(message.deletedAt);
      if (filter.value === 'visible') return !message.deletedAt;
      return true;
    });
    list.replaceChildren();
    if (!visible.length) {
      const empty = document.createElement('div'); empty.className = 'user-history-empty'; empty.textContent = 'No messages match this view.'; list.appendChild(empty); return;
    }
    for (const message of visible) {
      const item = document.createElement('div'); item.className = 'user-history-item';
      const time = document.createElement('div'); time.className = 'user-history-time'; time.textContent = formatVideoTime(message.time);
      const text = document.createElement('div'); text.className = `user-history-text${message.deletedAt ? ' removed' : ''}`; text.textContent = message.text || '';
      item.append(time, text);
      const itemActions = document.createElement('div'); itemActions.className = 'user-history-item-actions';
      if (message.deletedAt) {
        const state = document.createElement('span'); state.className = 'user-history-state'; state.textContent = 'Removed'; itemActions.appendChild(state);
      }
      itemActions.appendChild(actionButton('Watch', () => watchFromMessage(message)));
      if (!message.deletedAt) {
        itemActions.appendChild(actionButton(isMessagePinned(message) ? 'Edit pin' : 'Pin', () => {
          requestPinMessage(message, renderHistory);
        }));
      }
      itemActions.appendChild(actionButton(message.deletedAt ? 'Restore' : 'Delete', () => {
        if (message.deletedAt) restoreMessage(message); else markMessageDeleted(message, 'Removed from full history');
        renderNow(); renderHistory();
      }, !message.deletedAt));
      itemActions.appendChild(actionButton('Report', () => showReportDialog(message)));
      item.appendChild(itemActions);
      list.appendChild(item);
    }
  };
  search.addEventListener('input', renderHistory); filter.addEventListener('change', renderHistory);
  _userHistoryEl.append(header, identity, scopes, adminTools, tools, list);
  document.body.appendChild(_userHistoryEl);
  renderHistory();
  search.focus();

  header.style.cursor = 'move';
  header.addEventListener('pointerdown', event => {
    if (event.target.closest('button,input,select')) return;
    const rect = _userHistoryEl.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;
    _userHistoryEl.style.transform = 'none';
    _userHistoryEl.style.left = `${rect.left}px`;
    _userHistoryEl.style.top = `${rect.top}px`;
    const move = moveEvent => {
      const maxLeft = Math.max(8, innerWidth - _userHistoryEl.offsetWidth - 8);
      const maxTop = Math.max(8, innerHeight - _userHistoryEl.offsetHeight - 8);
      _userHistoryEl.style.left = `${Math.max(8, Math.min(moveEvent.clientX - offsetX, maxLeft))}px`;
      _userHistoryEl.style.top = `${Math.max(8, Math.min(moveEvent.clientY - offsetY, maxTop))}px`;
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop, { once: true });
  });
}

function showReportDialog(message) {
  if (!message) return;
  closeInspector();
  closeReportDialog();

  _reportDialogEl = document.createElement('div');
  _reportDialogEl.className = 'report-dialog-backdrop';
  _reportDialogEl.setAttribute('role', 'dialog');
  _reportDialogEl.setAttribute('aria-modal', 'true');
  _reportDialogEl.setAttribute('aria-label', 'Report message');

  const dialog = document.createElement('div');
  dialog.className = 'report-dialog';
  const header = document.createElement('div');
  header.className = 'report-dialog-header';
  const heading = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'report-dialog-title';
  title.textContent = 'Report message';
  const copy = document.createElement('div');
  copy.className = 'report-dialog-copy';
  copy.textContent = 'Choose the issue that best describes this message.';
  heading.append(title, copy);
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'report-dialog-close';
  closeButton.textContent = '×';
  closeButton.setAttribute('aria-label', 'Close report dialog');
  closeButton.addEventListener('click', closeReportDialog);
  header.append(heading, closeButton);

  const preview = document.createElement('div');
  preview.className = 'report-message-preview';
  const previewLabel = document.createElement('strong');
  previewLabel.textContent = `${message.user || 'Unknown user'} · ${formatVideoTime(message.time)}`;
  const previewText = document.createElement('span');
  previewText.textContent = message.text || '';
  preview.append(previewLabel, previewText);

  const reasons = document.createElement('div');
  reasons.className = 'report-reasons';
  const reasonOptions = [
    ['spam', 'Spam or flooding'],
    ['harassment', 'Harassment'],
    ['hate', 'Hate or abuse'],
    ['sexual', 'Sexual content'],
    ['other', 'Other'],
  ];
  for (const [value, label] of reasonOptions) {
    const option = document.createElement('label');
    option.className = 'report-reason';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'report-reason';
    radio.value = value;
    const text = document.createElement('span');
    text.textContent = label;
    option.append(radio, text);
    reasons.appendChild(option);
  }

  const detailsLabel = document.createElement('label');
  detailsLabel.className = 'report-details-label';
  detailsLabel.textContent = 'Additional details (optional)';
  const details = document.createElement('textarea');
  details.className = 'report-details';
  details.maxLength = 500;
  details.placeholder = 'Add context for the moderation team…';
  detailsLabel.appendChild(details);

  const footer = document.createElement('div');
  footer.className = 'report-dialog-footer';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'report-dialog-button';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', closeReportDialog);
  const submit = document.createElement('button');
  submit.type = 'button';
  submit.className = 'report-dialog-button primary';
  submit.textContent = 'Submit report';
  submit.disabled = true;
  submit.style.opacity = '.5';
  reasons.addEventListener('change', () => {
    submit.disabled = false;
    submit.style.opacity = '1';
  });
  submit.addEventListener('click', () => {
    const selected = reasons.querySelector('input:checked');
    if (!selected) return;
    const reasonLabel = reasonOptions.find(([value]) => value === selected.value)?.[1] || selected.value;
    const reports = getModerationReports();
    const reportId = crypto.randomUUID?.() || `report_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    reports.push({
      id: reportId,
      videoId: getCurrentVideoIdentity(),
      messageId: message.id || '',
      userId: message.userId || '',
      user: message.user || 'Unknown user',
      text: String(message.text || ''),
      time: Number(message.time || 0),
      reason: selected.value,
      reasonLabel,
      details: details.value.trim(),
      reportedAt: new Date().toISOString(),
      status: 'open',
    });
    saveModerationReports(reports);
    submit.textContent = 'Reported';
    setTimeout(closeReportDialog, 250);
  });
  footer.append(cancel, submit);
  dialog.append(header, preview, reasons, detailsLabel, footer);
  _reportDialogEl.appendChild(dialog);
  _reportDialogEl.addEventListener('mousedown', event => {
    if (event.target === _reportDialogEl) closeReportDialog();
  });
  document.body.appendChild(_reportDialogEl);
  reasons.querySelector('input')?.focus();
}

function showModerationQueueNear(target) {
  if (!isAdmin()) return;
  if (_moderationQueueEl) {
    closeModerationQueue();
    return;
  }

  closeParticipants();
  closeInspector();
  injectInspectorStyles();
  target.setAttribute('aria-expanded', 'true');
  const anchorRect = target.getBoundingClientRect();
  let activeTab = 'open';

  _moderationQueueEl = document.createElement('div');
  _moderationQueueEl.className = 'admin-moderation-queue';
  _moderationQueueEl.setAttribute('role', 'dialog');
  _moderationQueueEl.setAttribute('aria-label', 'Moderation queue');

  const header = document.createElement('div');
  header.className = 'moderation-queue-header';
  const heading = document.createElement('div');
  heading.className = 'moderation-queue-heading';
  const title = document.createElement('div');
  title.className = 'moderation-queue-title';
  title.textContent = 'Moderation queue';
  const subtitle = document.createElement('div');
  subtitle.className = 'moderation-queue-subtitle';
  heading.append(title, subtitle);
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'moderation-queue-close';
  closeButton.textContent = '×';
  closeButton.setAttribute('aria-label', 'Close moderation queue');
  closeButton.addEventListener('click', closeModerationQueue);
  header.append(heading, closeButton);

  const tabs = document.createElement('div');
  tabs.className = 'moderation-queue-tabs';
  const openTab = document.createElement('button');
  openTab.type = 'button'; openTab.className = 'moderation-queue-tab active';
  const resolvedTab = document.createElement('button');
  resolvedTab.type = 'button'; resolvedTab.className = 'moderation-queue-tab';
  const autoModTab = document.createElement('button');
  autoModTab.type = 'button'; autoModTab.className = 'moderation-queue-tab'; autoModTab.textContent = 'AutoMod';
  const auditTab = document.createElement('button');
  auditTab.type = 'button'; auditTab.className = 'moderation-queue-tab'; auditTab.textContent = 'Log';
  tabs.append(openTab, resolvedTab, autoModTab, auditTab);
  const list = document.createElement('div');
  list.className = 'moderation-queue-list';

  function updateReport(reportId, status) {
    const all = getModerationReports();
    const report = all.find(item => item.id === reportId);
    if (!report) return;
    const previousStatus = report.status;
    report.status = status;
    report.resolvedAt = status === 'open' ? null : new Date().toISOString();
    saveModerationReports(all);
    if (previousStatus !== status) {
      appendModerationAudit(status === 'open' ? 'report_reopened' : status === 'dismissed' ? 'report_dismissed' : 'report_reviewed', {
        actor: 'You', source: 'manual', targetUserId: report.userId, targetName: report.user,
        messageId: report.messageId, messageText: report.text, videoTime: report.time,
        reason: report.reasonLabel || report.reason || 'Message report',
      });
    }
    renderQueue();
  }

  function getReportMessage(report) {
    return findReportedMessage(report) || {
      id: report.messageId,
      userId: report.userId,
      user: report.user,
      text: report.text,
      time: report.time,
    };
  }

  function updateReportMessage(report, action) {
    const message = findReportedMessage(report);
    if (!message) return;
    action(message);
    renderNow();
    renderQueue();
  }

  function openReportedUser(report, card) {
    const cardRect = card.getBoundingClientRect();
    const message = getReportMessage(report);
    closeModerationQueue();
    _userCardAdminView = true;
    showInspectorNear({ getBoundingClientRect: () => cardRect }, {
      displayName: report.user,
      userId: report.userId || null,
      lastChanged: null,
      accountCreatedAt: message.accountCreatedAt || null,
      time: Number(report.time || 0),
      message,
    }, {
      onMention: () => {
        const input = document.getElementById('chat-input');
        if (!input) return;
        const start = input.selectionStart ?? input.value.length;
        input.setRangeText(`@${report.user} `, start, input.selectionEnd ?? start, 'end');
        input.focus();
      },
    });
  }

  function openAuditUser(entry, card) {
    const cardRect = card.getBoundingClientRect();
    const message = messages.find(item =>
      (entry.messageId && item.id === entry.messageId)
      || (entry.targetUserId && item.userId === entry.targetUserId && Number(item.time || 0) === Number(entry.videoTime || 0))
    ) || messages.find(item => entry.targetUserId ? item.userId === entry.targetUserId : item.user === entry.targetName) || {
      id: entry.messageId,
      userId: entry.targetUserId,
      user: entry.targetName,
      text: entry.messageText,
      time: entry.videoTime,
    };
    closeModerationQueue();
    _userCardAdminView = true;
    showInspectorNear({ getBoundingClientRect: () => cardRect }, {
      displayName: entry.targetName || message.user || 'Unknown user',
      userId: entry.targetUserId || message.userId || null,
      lastChanged: null,
      accountCreatedAt: message.accountCreatedAt || null,
      time: Number(entry.videoTime || message.time || 0),
      message,
    });
  }

  function renderAutoModPanel() {
    const settings = getAutoModSettings();
    const panel = document.createElement('div');
    panel.className = 'automod-panel';

    const makeSwitchRow = (label, note, checked) => {
      const row = document.createElement('div');
      row.className = 'automod-row';
      const copy = document.createElement('div');
      copy.className = 'automod-copy';
      const title = document.createElement('div'); title.className = 'automod-title'; title.textContent = label;
      const description = document.createElement('div'); description.className = 'automod-note'; description.textContent = note;
      copy.append(title, description);
      const toggle = document.createElement('label');
      toggle.className = 'automod-switch';
      const input = document.createElement('input'); input.type = 'checkbox'; input.checked = checked;
      const track = document.createElement('span');
      toggle.append(input, track);
      row.append(copy, toggle);
      return { row, input };
    };

    const mainCard = document.createElement('div');
    mainCard.className = 'automod-card';
    const severeProtection = makeSwitchRow('Severe slur protection', 'Built-in high-confidence protected-class slur rules.', settings.severeSlurProtection);
    const immediateSevereBan = makeSwitchRow('Immediate severe-slur ban', 'Delete the message and ban the account on the first match.', settings.immediateBanSevereSlurs);
    const enabled = makeSwitchRow('Enable AutoMod', 'Automatically review new messages against these local rules.', settings.enabled);
    const links = makeSwitchRow('Delete links', 'Remove messages containing web links.', settings.deleteLinks);
    const duplicates = makeSwitchRow('Delete repeated messages', 'Remove the same message repeated by one user within 30 video seconds.', settings.deleteDuplicates);
    mainCard.append(severeProtection.row, immediateSevereBan.row, enabled.row, links.row, duplicates.row);

    const termsCard = document.createElement('div');
    termsCard.className = 'automod-card';
    const termsLabel = document.createElement('label');
    termsLabel.className = 'automod-label';
    termsLabel.textContent = 'Blocked words or phrases';
    const terms = document.createElement('textarea');
    terms.className = 'automod-terms';
    terms.placeholder = 'One word or phrase per line';
    terms.value = settings.blockedTerms.join('\n');
    termsLabel.appendChild(terms);
    termsCard.appendChild(termsLabel);

    const banCard = document.createElement('div');
    banCard.className = 'automod-card';
    const autoBan = makeSwitchRow('Auto-ban repeat offenders', 'Ban a user after the selected number of AutoMod removals.', settings.autoBanEnabled);
    const thresholdRow = document.createElement('div');
    thresholdRow.className = 'automod-row';
    const thresholdCopy = document.createElement('div');
    thresholdCopy.className = 'automod-copy';
    const thresholdTitle = document.createElement('div'); thresholdTitle.className = 'automod-title'; thresholdTitle.textContent = 'Violations before ban';
    const thresholdNote = document.createElement('div'); thresholdNote.className = 'automod-note'; thresholdNote.textContent = 'Between 1 and 20 automatic removals.';
    thresholdCopy.append(thresholdTitle, thresholdNote);
    const threshold = document.createElement('input');
    threshold.type = 'number'; threshold.className = 'automod-threshold'; threshold.min = '1'; threshold.max = '20'; threshold.value = String(settings.autoBanThreshold);
    thresholdRow.append(thresholdCopy, threshold);
    banCard.append(autoBan.row, thresholdRow);

    const save = document.createElement('button');
    save.type = 'button'; save.className = 'automod-save'; save.textContent = 'Save AutoMod rules';
    const summary = document.createElement('div');
    summary.className = 'automod-summary';
    summary.textContent = `Built-in severe-slur protection uses ${SEVERE_SLUR_RULES.length} high-confidence rule families and catches common spacing and character substitutions. Messages from manually banned users are also removed. This local scaffold will become server-enforced after the React/backend build.`;
    save.addEventListener('click', () => {
      const nextSettings = {
        enabled: enabled.input.checked,
        severeSlurProtection: severeProtection.input.checked,
        immediateBanSevereSlurs: immediateSevereBan.input.checked,
        blockedTerms: terms.value.split(/\r?\n|,/).map(term => term.trim()).filter(Boolean),
        deleteLinks: links.input.checked,
        deleteDuplicates: duplicates.input.checked,
        autoBanEnabled: autoBan.input.checked,
        autoBanThreshold: Math.max(1, Math.min(20, Number(threshold.value) || 3)),
      };
      saveAutoModSettings(nextSettings);
      if (JSON.stringify(settings) !== JSON.stringify(nextSettings)) {
        appendModerationAudit('automod_settings_changed', {
          actor: 'You', source: 'manual', targetName: 'Unknown user',
          metadata: nextSettings.enabled ? 'Automatic rules enabled' : 'Automatic rules disabled',
        });
      }
      save.textContent = 'Rules saved';
      setTimeout(() => { if (save.isConnected) save.textContent = 'Save AutoMod rules'; }, 700);
    });

    panel.append(mainCard, termsCard, banCard, save, summary);
    list.appendChild(panel);
  }

  function renderAuditPanel() {
    const panel = document.createElement('div');
    panel.className = 'audit-log-panel';
    const tools = document.createElement('div');
    tools.className = 'audit-log-tools';
    const search = document.createElement('input');
    search.type = 'search'; search.className = 'audit-log-search'; search.placeholder = 'Search user, action, or reason';
    search.setAttribute('aria-label', 'Search moderation log');
    const sourceFilter = document.createElement('select');
    sourceFilter.className = 'audit-log-filter'; sourceFilter.setAttribute('aria-label', 'Filter moderation log by source');
    for (const [value, label] of [['all', 'All actions'], ['manual', 'Manual'], ['automod', 'AutoMod']]) {
      const option = document.createElement('option'); option.value = value; option.textContent = label; sourceFilter.appendChild(option);
    }
    tools.append(search, sourceFilter);
    const count = document.createElement('div'); count.className = 'audit-log-count';
    const entriesHost = document.createElement('div');
    panel.append(tools, count, entriesHost);
    list.appendChild(panel);

    const renderEntries = () => {
      const query = search.value.trim().toLowerCase();
      const allEntries = getCurrentVideoAuditLog();
      const visible = allEntries.filter(entry => {
        if (sourceFilter.value !== 'all' && entry.source !== sourceFilter.value) return false;
        if (!query) return true;
        return [getAuditActionLabel(entry), entry.targetName, entry.reason, entry.messageText, entry.actor, entry.metadata]
          .some(value => String(value || '').toLowerCase().includes(query));
      });
      count.textContent = `${visible.length} of ${allEntries.length} action${allEntries.length === 1 ? '' : 's'} on this video`;
      entriesHost.replaceChildren();
      if (!visible.length) {
        const empty = document.createElement('div'); empty.className = 'moderation-queue-empty';
        const heading = document.createElement('strong'); heading.textContent = allEntries.length ? 'No matching actions' : 'No moderation actions yet';
        const copy = document.createElement('span'); copy.textContent = allEntries.length ? 'Try another search or source filter.' : 'Manual and AutoMod actions on this video will appear here.';
        empty.append(heading, copy); entriesHost.appendChild(empty); return;
      }
      for (const entry of visible.slice(0, 150)) {
        const card = document.createElement('article');
        card.className = 'audit-entry'; card.dataset.source = entry.source || 'manual'; card.dataset.action = entry.action || '';
        const top = document.createElement('div'); top.className = 'audit-entry-top';
        const action = document.createElement('div'); action.className = 'audit-entry-title'; action.textContent = getAuditActionLabel(entry);
        const actor = document.createElement('span'); actor.className = 'audit-entry-actor'; actor.textContent = entry.actor || (entry.source === 'automod' ? 'AutoMod' : 'You');
        top.append(action, actor); card.appendChild(top);
        if (entry.targetName && entry.targetName !== 'Unknown user') {
          const target = document.createElement('div'); target.className = 'audit-entry-target'; target.textContent = entry.targetName; card.appendChild(target);
        }
        if (entry.messageText) {
          const context = document.createElement('div'); context.className = 'audit-entry-context'; context.textContent = entry.messageText; card.appendChild(context);
        }
        if (entry.reason || entry.metadata) {
          const reason = document.createElement('div'); reason.className = 'audit-entry-reason';
          reason.textContent = [entry.reason, entry.durationSeconds ? formatModerationDuration(entry.durationSeconds) : '', entry.metadata].filter(Boolean).join(' · ');
          card.appendChild(reason);
        }
        const meta = document.createElement('div'); meta.className = 'audit-entry-meta';
        const when = document.createElement('span'); when.textContent = entry.at ? new Date(entry.at).toLocaleString() : 'Unknown time';
        meta.appendChild(when);
        if (Number.isFinite(entry.videoTime)) {
          const position = document.createElement('span'); position.textContent = `Video ${formatVideoTime(entry.videoTime)}`; meta.appendChild(position);
        }
        if (entry.targetUserId || (entry.targetName && entry.targetName !== 'Unknown user')) {
          const view = document.createElement('button'); view.type = 'button'; view.className = 'audit-entry-view'; view.textContent = 'View user';
          view.addEventListener('click', () => openAuditUser(entry, card)); meta.appendChild(view);
        }
        card.appendChild(meta); entriesHost.appendChild(card);
      }
    };
    search.addEventListener('input', renderEntries);
    sourceFilter.addEventListener('change', renderEntries);
    renderEntries();
  }

  function renderQueue() {
    const reports = getCurrentVideoReports();
    const openReports = reports.filter(report => report.status === 'open');
    const resolvedReports = reports.filter(report => report.status !== 'open');
    const visible = activeTab === 'open' ? openReports : resolvedReports;
    subtitle.textContent = activeTab === 'automod'
      ? 'Configure automatic message actions'
      : activeTab === 'audit'
        ? `${getCurrentVideoAuditLog().length} recorded action${getCurrentVideoAuditLog().length === 1 ? '' : 's'} on this video`
        : `${openReports.length} report${openReports.length === 1 ? '' : 's'} awaiting review`;
    openTab.textContent = `Open (${openReports.length})`;
    resolvedTab.textContent = `Resolved (${resolvedReports.length})`;
    openTab.classList.toggle('active', activeTab === 'open');
    resolvedTab.classList.toggle('active', activeTab === 'resolved');
    autoModTab.classList.toggle('active', activeTab === 'automod');
    auditTab.classList.toggle('active', activeTab === 'audit');
    list.replaceChildren();

    if (activeTab === 'automod') {
      renderAutoModPanel();
      return;
    }
    if (activeTab === 'audit') {
      renderAuditPanel();
      return;
    }

    if (!visible.length) {
      const empty = document.createElement('div');
      empty.className = 'moderation-queue-empty';
      const heading = document.createElement('strong');
      heading.textContent = activeTab === 'open' ? 'Queue is clear' : 'No resolved reports';
      const copy = document.createElement('span');
      copy.textContent = activeTab === 'open'
        ? 'New message reports will appear here.'
        : 'Reviewed and dismissed reports will be kept here.';
      empty.append(heading, copy);
      list.appendChild(empty);
      return;
    }

    for (const report of visible) {
      const reportedMessage = findReportedMessage(report);
      const card = document.createElement('article');
      card.className = 'moderation-report-card';
      card.dataset.status = report.status || 'open';
      if (reportedMessage?.deletedAt) card.classList.add('report-message-removed');
      const top = document.createElement('div');
      top.className = 'moderation-report-top';
      const reason = document.createElement('span');
      reason.className = 'moderation-report-reason';
      reason.textContent = report.reasonLabel || report.reason || 'Report';
      const state = document.createElement('span');
      state.className = 'moderation-report-state';
      state.textContent = report.status === 'open' ? 'Awaiting review' : report.status === 'dismissed' ? 'Dismissed' : 'Reviewed';
      top.append(reason, state);
      const user = document.createElement('div');
      user.className = 'moderation-report-user';
      user.textContent = report.user || 'Unknown user';
      const message = document.createElement('div');
      message.className = 'moderation-report-message';
      message.textContent = reportedMessage?.deletedAt
        ? `[Removed] ${report.text || reportedMessage.text || ''}`
        : (report.text || reportedMessage?.text || '');
      const meta = document.createElement('div');
      meta.className = 'moderation-report-meta';
      meta.textContent = `Video ${formatVideoTime(report.time)} · ${report.reportedAt ? new Date(report.reportedAt).toLocaleString() : 'Unknown report time'}`;
      card.append(top, user, message, meta);
      if (report.details) {
        const details = document.createElement('div');
        details.className = 'moderation-report-details';
        details.textContent = report.details;
        card.appendChild(details);
      }

      const actions = document.createElement('div');
      actions.className = 'moderation-report-actions';
      const userButton = document.createElement('button');
      userButton.type = 'button'; userButton.className = 'moderation-report-action primary'; userButton.textContent = 'Review user';
      userButton.addEventListener('click', () => openReportedUser(report, card));
      actions.appendChild(userButton);
      const watch = document.createElement('button');
      watch.type = 'button'; watch.className = 'moderation-report-action'; watch.textContent = 'Watch';
      watch.addEventListener('click', () => watchFromMessage(getReportMessage(report)));
      actions.appendChild(watch);
      if (reportedMessage) {
        const remove = document.createElement('button');
        remove.type = 'button'; remove.className = `moderation-report-action${reportedMessage.deletedAt ? '' : ' danger'}`;
        remove.textContent = reportedMessage.deletedAt ? 'Restore' : 'Delete';
        remove.addEventListener('click', () => updateReportMessage(report, messageRef => {
          if (messageRef.deletedAt) restoreMessage(messageRef);
          else markMessageDeleted(messageRef, `Report: ${report.reasonLabel || report.reason || 'Message report'}`);
        }));
        actions.appendChild(remove);
      }
      const ban = document.createElement('button');
      ban.type = 'button'; ban.className = 'moderation-report-action danger'; ban.textContent = 'Ban';
      ban.addEventListener('click', () => {
        const messageForBan = getReportMessage(report);
        showBanDialog({
          displayName: report.user || messageForBan.user || 'Unknown user',
          userId: report.userId || messageForBan.userId || null,
          message: messageForBan,
          time: Number(report.time || messageForBan.time || 0),
        }, renderQueue);
      });
      actions.appendChild(ban);
      if (report.status === 'open') {
        const dismiss = document.createElement('button');
        dismiss.type = 'button'; dismiss.className = 'moderation-report-action'; dismiss.textContent = 'Dismiss';
        dismiss.addEventListener('click', () => updateReport(report.id, 'dismissed'));
        const reviewed = document.createElement('button');
        reviewed.type = 'button'; reviewed.className = 'moderation-report-action'; reviewed.textContent = 'Reviewed';
        reviewed.addEventListener('click', () => updateReport(report.id, 'reviewed'));
        actions.append(dismiss, reviewed);
      } else {
        const reopen = document.createElement('button');
        reopen.type = 'button'; reopen.className = 'moderation-report-action'; reopen.textContent = 'Reopen';
        reopen.addEventListener('click', () => updateReport(report.id, 'open'));
        actions.appendChild(reopen);
      }
      card.appendChild(actions);
      list.appendChild(card);
    }
  }

  openTab.addEventListener('click', () => { activeTab = 'open'; renderQueue(); });
  resolvedTab.addEventListener('click', () => { activeTab = 'resolved'; renderQueue(); });
  autoModTab.addEventListener('click', () => { activeTab = 'automod'; renderQueue(); });
  auditTab.addEventListener('click', () => { activeTab = 'audit'; renderQueue(); });
  _moderationQueueEl.append(header, tabs, list);
  _moderationQueueEl._auditChangedHandler = () => {
    if (_moderationQueueEl && activeTab === 'audit') renderQueue();
  };
  window.addEventListener('lyve:audit-changed', _moderationQueueEl._auditChangedHandler);
  document.body.appendChild(_moderationQueueEl);
  renderQueue();

  const vw = innerWidth, vh = innerHeight, pad = 10;
  const width = _moderationQueueEl.offsetWidth, height = _moderationQueueEl.offsetHeight;
  const left = Math.min(Math.max(pad, anchorRect.right - width), vw - width - pad);
  let top = anchorRect.bottom + 6;
  if (top + height + pad > vh) top = Math.max(pad, anchorRect.top - height - 6);
  _moderationQueueEl.style.left = `${left}px`;
  _moderationQueueEl.style.top = `${top}px`;

  setTimeout(() => {
    _moderationQueueOutsideHandler = event => {
      if (!_moderationQueueEl || _moderationQueueEl.contains(event.target) || target.contains?.(event.target)) return;
      closeModerationQueue();
    };
    document.addEventListener('mousedown', _moderationQueueOutsideHandler, true);
  }, 0);
}

function collectVideoParticipants() {
  const byIdentity = new Map();
  for (const message of messages) {
    const displayName = String(message.user || 'Unknown user');
    const key = message.userId
      ? `id:${message.userId}`
      : `name:${displayName.trim().toLowerCase()}`;
    let participant = byIdentity.get(key);
    if (!participant) {
      participant = {
        key,
        userId: message.userId || '',
        displayName,
        messageCount: 0,
        lastMessage: message,
      };
      byIdentity.set(key, participant);
    }
    participant.messageCount += 1;
    if (Number(message.time || 0) >= Number(participant.lastMessage?.time || 0)) {
      participant.lastMessage = message;
      participant.displayName = displayName;
    }
  }

  return Array.from(byIdentity.values())
    .map(participant => {
      const record = getModerationRecord(participant.userId);
      return {
        ...participant,
        record,
        activeTimeout: getActiveTimeout(record),
        viewerSafety: getViewerSafetyRecord({ userId: participant.userId, displayName: participant.displayName }),
        role: getUserRole({ userId: participant.userId, displayName: participant.displayName }),
      };
    })
    .sort((a, b) =>
      Number(b.lastMessage?.time || 0) - Number(a.lastMessage?.time || 0)
      || a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' })
    );
}

function showParticipantsNear(target) {
  if (!isAdmin()) return;
  if (_participantsEl) {
    closeParticipants();
    return;
  }

  closeModerationQueue();
  closeInspector();
  injectInspectorStyles();
  target.setAttribute('aria-expanded', 'true');
  const anchorRect = target.getBoundingClientRect();
  const participants = collectVideoParticipants();
  let activeFilter = 'all';

  _participantsEl = document.createElement('div');
  _participantsEl.className = 'admin-participants';
  _participantsEl.setAttribute('role', 'dialog');
  _participantsEl.setAttribute('aria-label', 'Video participants');

  const header = document.createElement('div');
  header.className = 'participants-header';
  const headerCopy = document.createElement('div');
  headerCopy.className = 'participants-header-copy';
  const title = document.createElement('div');
  title.className = 'participants-title';
  title.textContent = 'Participants';
  const subtitle = document.createElement('div');
  subtitle.className = 'participants-subtitle';
  subtitle.textContent = `${participants.length} commenter${participants.length === 1 ? '' : 's'} in this session`;
  headerCopy.append(title, subtitle);
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'participants-close';
  closeButton.textContent = '×';
  closeButton.setAttribute('aria-label', 'Close participants');
  closeButton.addEventListener('click', closeParticipants);
  header.append(headerCopy, closeButton);

  const tools = document.createElement('div');
  tools.className = 'participants-tools';
  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'participants-search';
  search.placeholder = 'Search name or user ID';
  search.setAttribute('aria-label', 'Search participants');
  const filters = document.createElement('div');
  filters.className = 'participants-filters';
  const list = document.createElement('div');
  list.className = 'participants-list';

  const matchesFilter = (participant, filter) => {
    if (filter === 'flagged') return participant.record.flags.length > 0;
    if (filter === 'timeout') return Boolean(participant.activeTimeout);
    if (filter === 'banned') return participant.record.banned;
    if (filter === 'muted') return participant.viewerSafety.muted;
    if (filter === 'blocked') return participant.viewerSafety.blocked;
    if (['creator', 'moderator', 'member'].includes(filter)) return participant.role === filter;
    return true;
  };

  const filterDefs = [
    ['all', 'All'],
    ['flagged', 'Flagged'],
    ['timeout', 'Timed out'],
    ['banned', 'Banned'],
    ['muted', 'Muted'],
    ['blocked', 'Blocked'],
    ['creator', 'Creators'],
    ['moderator', 'Moderators'],
    ['member', 'Members'],
  ];

  function renderParticipants() {
    const query = search.value.trim().toLowerCase();
    const visible = participants.filter(participant => {
      const matchesQuery = !query
        || participant.displayName.toLowerCase().includes(query)
        || participant.userId.toLowerCase().includes(query);
      return matchesQuery && matchesFilter(participant, activeFilter);
    });

    list.replaceChildren();
    if (!visible.length) {
      const empty = document.createElement('div');
      empty.className = 'participants-empty';
      const heading = document.createElement('strong');
      heading.textContent = participants.length ? 'No matching participants' : 'No commenters yet';
      const copy = document.createElement('span');
      copy.textContent = participants.length
        ? 'Try another search or moderation filter.'
        : 'People will appear here after they send a message.';
      empty.append(heading, copy);
      list.appendChild(empty);
      return;
    }

    for (const participant of visible) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'participant-row';
      row.setAttribute('aria-label', `Open ${participant.displayName}'s admin user card`);

      const avatar = document.createElement('div');
      avatar.className = 'participant-avatar';
      avatar.textContent = Array.from(participant.displayName.trim())[0]?.toUpperCase() || '?';
      let hue = 0;
      for (const character of participant.key) hue = (hue * 31 + character.charCodeAt(0)) % 360;
      avatar.style.background = `hsl(${hue} 52% 42%)`;

      const main = document.createElement('div');
      main.className = 'participant-main';
      const name = document.createElement('div');
      name.className = 'participant-name';
      name.textContent = participant.displayName;
      const meta = document.createElement('div');
      meta.className = 'participant-meta';
      meta.textContent = `Last message at ${formatVideoTime(participant.lastMessage?.time)}`;
      main.append(name, meta);

      const side = document.createElement('div');
      side.className = 'participant-side';
      const count = document.createElement('div');
      count.className = 'participant-count';
      count.textContent = `${participant.messageCount} msg${participant.messageCount === 1 ? '' : 's'}`;
      const statuses = document.createElement('div');
      statuses.className = 'participant-statuses';
      if (participant.record.flags.length) {
        const badge = document.createElement('span'); badge.className = 'participant-status flagged'; badge.textContent = 'Flagged'; statuses.appendChild(badge);
      }
      if (participant.activeTimeout) {
        const badge = document.createElement('span'); badge.className = 'participant-status timeout'; badge.textContent = 'Timeout'; statuses.appendChild(badge);
      }
      if (participant.record.banned) {
        const badge = document.createElement('span'); badge.className = 'participant-status banned'; badge.textContent = 'Banned'; statuses.appendChild(badge);
      }
      if (participant.viewerSafety.muted) {
        const badge = document.createElement('span'); badge.className = 'participant-status muted'; badge.textContent = 'Muted'; statuses.appendChild(badge);
      }
      if (participant.viewerSafety.blocked) {
        const badge = document.createElement('span'); badge.className = 'participant-status blocked'; badge.textContent = 'Blocked'; statuses.appendChild(badge);
      }
      if (participant.role !== 'viewer') {
        const badge = document.createElement('span'); badge.className = `participant-status ${participant.role}`;
        badge.textContent = participant.role === 'moderator' ? 'Mod' : participant.role;
        statuses.appendChild(badge);
      }
      side.append(count, statuses);
      row.append(avatar, main, side);

      row.addEventListener('click', () => {
        const rowRect = row.getBoundingClientRect();
        const message = participant.lastMessage || {};
        closeParticipants();
        _userCardAdminView = true;
        showInspectorNear({ getBoundingClientRect: () => rowRect }, {
          displayName: participant.displayName,
          userId: participant.userId || null,
          lastChanged: participant.userId === getOrCreateUserId()
            ? localStorage.getItem('chatLastNameChangeAt') || null
            : null,
          accountCreatedAt: message.accountCreatedAt || (participant.userId === getOrCreateUserId() ? getOrCreateAccountCreatedAt() : null),
          time: Number(message.time || 0),
          message,
        }, {
          onMention: () => {
            const input = document.getElementById('chat-input');
            if (!input) return;
            const mention = `@${participant.displayName} `;
            const start = input.selectionStart ?? input.value.length;
            input.setRangeText(mention, start, input.selectionEnd ?? start, 'end');
            input.focus();
          },
        });
      });

      list.appendChild(row);
    }
  }

  for (const [key, label] of filterDefs) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `participants-filter${key === activeFilter ? ' active' : ''}`;
    button.textContent = label;
    button.setAttribute('aria-pressed', String(key === activeFilter));
    button.addEventListener('click', () => {
      activeFilter = key;
      filters.querySelectorAll('.participants-filter').forEach(filterButton => {
        const selected = filterButton === button;
        filterButton.classList.toggle('active', selected);
        filterButton.setAttribute('aria-pressed', String(selected));
      });
      renderParticipants();
    });
    filters.appendChild(button);
  }

  search.addEventListener('input', renderParticipants);
  tools.append(search, filters);
  _participantsEl.append(header, tools, list);
  document.body.appendChild(_participantsEl);
  renderParticipants();

  const vw = innerWidth, vh = innerHeight, pad = 10;
  const width = _participantsEl.offsetWidth, height = _participantsEl.offsetHeight;
  const left = Math.min(Math.max(pad, anchorRect.right - width), vw - width - pad);
  let top = anchorRect.bottom + 6;
  if (top + height + pad > vh) top = Math.max(pad, anchorRect.top - height - 6);
  _participantsEl.style.left = `${left}px`;
  _participantsEl.style.top = `${top}px`;
  search.focus();

  setTimeout(() => {
    _participantsOutsideHandler = event => {
      if (!_participantsEl || _participantsEl.contains(event.target) || target.contains?.(event.target)) return;
      closeParticipants();
    };
    document.addEventListener('mousedown', _participantsOutsideHandler, true);
  }, 0);
}

function makeCardButton(label, onClick, className = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `user-card-button ${className}`.trim();
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

function appendSection(card, title, { open = false } = {}) {
  const section = document.createElement('details');
  section.className = 'user-card-section';
  section.open = open;
  const summary = document.createElement('summary');
  const heading = document.createElement('div');
  heading.className = 'user-card-section-title';
  heading.textContent = title;
  summary.appendChild(heading);
  const body = document.createElement('div');
  body.className = 'user-card-section-body';
  section.append(summary, body);
  card.appendChild(section);
  return body;
}

function getInspectorHost() {
  const panel = document.getElementById('chat-panel');
  if (panel?.classList.contains('lyve-minimal-overlay') && panel.parentElement && panel.parentElement !== document.body) {
    return panel.parentElement;
  }
  const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement || null;
  return fullscreenElement || document.body;
}

function makeInspectorDraggable(surface, host) {
  const excluded = 'button,input,select,textarea,a,summary,label,[contenteditable="true"]';
  let moveHandler = null;
  let upHandler = null;
  const hostBounds = () => host === document.body
    ? { left: 0, top: 0, width: innerWidth, height: innerHeight }
    : host.getBoundingClientRect();
  const stop = () => {
    if (moveHandler) window.removeEventListener('pointermove', moveHandler);
    if (upHandler) window.removeEventListener('pointerup', upHandler);
    moveHandler = null; upHandler = null;
  };
  surface._dragCleanup = stop;
  surface.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target.closest(excluded)) return;
    const rect = surface.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;
    event.preventDefault();
    event.stopPropagation();
    surface.style.right = '';
    surface.style.bottom = '';
    moveHandler = moveEvent => {
      const currentBounds = hostBounds();
      const maxLeft = Math.max(8, currentBounds.width - surface.offsetWidth - 8);
      const maxTop = Math.max(8, currentBounds.height - surface.offsetHeight - 8);
      const left = Math.max(8, Math.min(moveEvent.clientX - currentBounds.left - offsetX, maxLeft));
      const top = Math.max(8, Math.min(moveEvent.clientY - currentBounds.top - offsetY, maxTop));
      surface.style.left = `${left}px`;
      surface.style.top = `${top}px`;
    };
    upHandler = stop;
    window.addEventListener('pointermove', moveHandler);
    window.addEventListener('pointerup', upHandler, { once: true });
  });
}

function showInspectorNear(target, data, actions = {}) {
  closeInspector();
  const anchorRect = target.getBoundingClientRect();
  const reopen = () => showInspectorNear({ getBoundingClientRect: () => anchorRect }, data, actions);
  const viewerSafety = getViewerSafetyRecord(data);
  const userRole = getUserRole(data);
  const profileModeration = getModerationRecord(data.userId);
  const profileActiveTimeout = getActiveTimeout(profileModeration);
  _inspectorEl = document.createElement('div');
  _inspectorEl.className = `user-inspector${isAdmin() && _userCardAdminView ? ' admin-view' : ''}`;

  const header = document.createElement('div');
  header.className = 'user-card-header';
  const avatar = document.createElement('div');
  avatar.className = 'user-card-avatar';
  avatar.textContent = String(data.displayName || '?').trim().charAt(0).toUpperCase() || '?';
  const identity = document.createElement('div');
  identity.className = 'user-card-identity';
  const name = document.createElement('div');
  name.className = 'user-card-name';
  name.textContent = data.displayName || 'Unknown user';
  const subtitle = document.createElement('div');
  subtitle.className = 'user-card-subtitle';
  subtitle.textContent = `Message at ${formatVideoTime(data.time)}`;
  const accountCreated = document.createElement('div');
  accountCreated.className = 'user-card-subtitle';
  accountCreated.textContent = `Account created ${data.accountCreatedAt ? new Date(data.accountCreatedAt).toLocaleDateString() : 'not available yet'}`;
  identity.append(name, subtitle, accountCreated);
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'user-card-close';
  closeButton.textContent = '×';
  closeButton.setAttribute('aria-label', 'Close user card');
  closeButton.addEventListener('click', closeInspector);
  header.append(avatar, identity);
  if (isAdmin()) {
    const adminToggle = document.createElement('button');
    adminToggle.type = 'button';
    adminToggle.className = `user-card-admin-toggle${_userCardAdminView ? ' active' : ''}`;
    adminToggle.textContent = '🛡';
    adminToggle.title = _userCardAdminView ? 'Show viewer card' : 'Show admin view';
    adminToggle.setAttribute('aria-pressed', String(_userCardAdminView));
    adminToggle.addEventListener('click', () => {
      _userCardAdminView = !_userCardAdminView;
      reopen();
    });
    header.appendChild(adminToggle);
  }
  header.appendChild(closeButton);
  _inspectorEl.appendChild(header);

  const statusStrip = document.createElement('div');
  statusStrip.className = 'user-card-statuses';
  const addStatus = (label, className) => {
    const badge = document.createElement('span');
    badge.className = `user-card-status ${className}`;
    badge.textContent = label;
    statusStrip.appendChild(badge);
  };
  addStatus(userRole === 'creator' ? 'Creator' : userRole === 'moderator' ? 'Moderator' : userRole === 'member' ? 'Member' : 'Viewer', `role-${userRole}`);
  if (viewerSafety.blocked) addStatus('Blocked', 'blocked');
  else if (viewerSafety.muted) addStatus('Muted', 'muted');
  if (isAdmin()) {
    if (profileModeration.flags.length) addStatus('Flagged', 'flagged');
    if (profileActiveTimeout) addStatus('Timed out', 'timeout');
    if (profileModeration.banned) addStatus('Banned', 'banned');
  }
  if (statusStrip.childElementCount) _inspectorEl.appendChild(statusStrip);

  const actionRow = document.createElement('div');
  actionRow.className = 'user-card-actions';
  const mentionButton = makeCardButton('Mention', () => { actions.onMention?.(); closeInspector(); });
  mentionButton.disabled = viewerSafety.blocked;
  if (viewerSafety.blocked) mentionButton.title = 'Unblock this user before mentioning them';
  actionRow.append(mentionButton, makeCardButton('Copy name', () => navigator.clipboard?.writeText(data.displayName || '')));
  const isSelf = Boolean(data.userId && data.userId === getOrCreateUserId());
  if (!isSelf) {
    actionRow.append(
      makeCardButton(viewerSafety.muted ? 'Unmute' : 'Mute', () => {
        setViewerSafetyState(data, 'muted', !viewerSafety.muted); reopen();
      }),
      makeCardButton(viewerSafety.blocked ? 'Unblock' : 'Block', () => {
        setViewerSafetyState(data, 'blocked', !viewerSafety.blocked); reopen();
      }, viewerSafety.blocked ? '' : 'danger'),
    );
  }
  if (data.message?.text) {
    actionRow.appendChild(makeCardButton('Watch from here', () => {
      watchFromMessage(data.message);
      closeInspector();
    }));
    actionRow.appendChild(makeCardButton('Report message', () => showReportDialog(data.message), isAdmin() ? '' : 'report'));
    if (isAdmin()) {
      if (!data.message.deletedAt) {
        actionRow.appendChild(makeCardButton(isMessagePinned(data.message) ? 'Edit pin' : 'Pin message', () => {
          requestPinMessage(data.message, reopen);
        }));
      }
      actionRow.appendChild(makeCardButton(data.message.deletedAt ? 'Restore message' : 'Delete message', () => {
        if (data.message.deletedAt) restoreMessage(data.message);
        else markMessageDeleted(data.message, 'Deleted from user card');
        renderNow();
        reopen();
      }, data.message.deletedAt ? '' : 'danger'));
    }
  }
  _inspectorEl.appendChild(actionRow);

  if (viewerSafety.actions.length) {
    const safetyHistory = appendSection(_inspectorEl, 'Your safety history');
    const list = document.createElement('div'); list.className = 'user-card-list';
    for (const safetyAction of viewerSafety.actions.slice(-4).reverse()) {
      const item = document.createElement('div'); item.className = 'user-card-list-item';
      const title = document.createElement('div'); title.textContent = safetyAction.type.replace(/^./, character => character.toUpperCase());
      const meta = document.createElement('div'); meta.className = 'user-card-list-meta';
      meta.textContent = safetyAction.at ? new Date(safetyAction.at).toLocaleString() : 'Unknown time';
      item.append(title, meta); list.appendChild(item);
    }
    safetyHistory.appendChild(list);
  }

  if (isAdmin() && _userCardAdminView) {
    const record = getModerationRecord(data.userId);
    const activeTimeout = getActiveTimeout(record);
    const details = appendSection(_inspectorEl, 'Admin details');
    const kv = document.createElement('div');
    kv.className = 'user-card-kv';
    const fields = [
      ['User ID', data.userId || 'Not available'],
      ['Account created', data.accountCreatedAt ? new Date(data.accountCreatedAt).toLocaleString() : 'Not available until accounts'],
      ['Name changed', data.lastChanged || 'No record'],
      ['AutoMod strikes', String(record.autoModViolations || 0)],
      ['Role', userRole === 'viewer' ? 'Standard viewer' : userRole.replace(/^./, character => character.toUpperCase())],
      ['Local safety', viewerSafety.blocked ? 'Blocked' : viewerSafety.muted ? 'Muted' : 'No local restriction'],
      ['Status', record.banned
        ? 'Banned'
        : activeTimeout
          ? `Timed out (${formatModerationDuration(getTimeoutDurationSeconds(activeTimeout))})`
          : 'No active restriction'],
    ];
    for (const [label, value] of fields) {
      const key = document.createElement('span'); key.textContent = label;
      const val = document.createElement('span'); val.className = 'user-card-value'; val.textContent = value;
      kv.append(key, val);
    }
    details.appendChild(kv);
    const roleControl = document.createElement('div');
    roleControl.className = 'user-card-role-control';
    const roleSelect = document.createElement('select');
    roleSelect.setAttribute('aria-label', 'Preview user role');
    for (const [value, label] of [['viewer', 'Standard viewer'], ['member', 'Member'], ['moderator', 'Moderator'], ['creator', 'Creator']]) {
      const option = document.createElement('option'); option.value = value; option.textContent = label; option.selected = value === userRole; roleSelect.appendChild(option);
    }
    const saveRole = makeCardButton('Apply role', () => {
      setUserRole(data, roleSelect.value);
      reopen();
    });
    roleControl.append(roleSelect, saveRole);
    details.appendChild(roleControl);
    if (data.userId) {
      details.appendChild(makeCardButton('Copy user ID', () => navigator.clipboard?.writeText(data.userId)));
    }

    const flagsSection = appendSection(_inspectorEl, 'Account flags');
    if (record.flags.length) {
      const flags = document.createElement('div');
      flags.className = 'user-card-flags';
      record.flags.forEach((flag, index) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'user-card-flag';
        chip.textContent = `${flag.label || String(flag)} ×`;
        chip.title = 'Remove flag';
        chip.addEventListener('click', () => {
          const removedLabel = flag.label || String(flag);
          record.flags.splice(index, 1);
          appendModerationAudit('flag_removed', { actor: 'You', source: 'manual', targetUserId: data.userId, targetName: data.displayName, reason: removedLabel });
          saveModerationRecord(data.userId, record);
          reopen();
        });
        flags.appendChild(chip);
      });
      flagsSection.appendChild(flags);
    } else {
      const empty = document.createElement('div'); empty.className = 'user-card-empty'; empty.textContent = 'No flags';
      flagsSection.appendChild(empty);
    }

    const recent = messages
      .filter((message) => data.userId ? message.userId === data.userId : message.user === data.displayName)
      .slice(-5)
      .reverse();
    const historySection = appendSection(_inspectorEl, 'Recent messages');
    if (recent.length) {
      const list = document.createElement('div'); list.className = 'user-card-list';
      for (const message of recent) {
        const item = document.createElement('div'); item.className = 'user-card-list-item';
        const text = document.createElement('div'); text.textContent = message.deletedAt ? `[Removed] ${message.text || ''}` : (message.text || '');
        const meta = document.createElement('div'); meta.className = 'user-card-list-meta';
        meta.textContent = `Video ${formatVideoTime(message.time)}${message.created_at ? ` · ${new Date(message.created_at).toLocaleString()}` : ''}`;
        const itemActions = document.createElement('div');
        itemActions.className = 'user-card-message-actions';
        const makeMiniAction = (label, handler, danger = false) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = `user-card-message-action${danger ? ' danger' : ''}`;
          button.textContent = label;
          button.addEventListener('click', handler);
          return button;
        };
        itemActions.appendChild(makeMiniAction('Watch', () => watchFromMessage(message)));
        itemActions.appendChild(makeMiniAction(message.deletedAt ? 'Restore' : 'Delete', () => {
          if (message.deletedAt) restoreMessage(message);
          else markMessageDeleted(message, 'Removed from user card recent history');
          renderNow();
          reopen();
        }, !message.deletedAt));
        item.append(text, meta, itemActions); list.appendChild(item);
      }
      historySection.appendChild(list);
    } else {
      const empty = document.createElement('div'); empty.className = 'user-card-empty'; empty.textContent = 'No recent messages';
      historySection.appendChild(empty);
    }
    historySection.appendChild(makeCardButton('Open full history ↗', () => {
      showUserHistoryWindow(data);
    }));

    const moderationSection = appendSection(_inspectorEl, 'Timeouts and bans');
    if (record.actions.length) {
      const list = document.createElement('div'); list.className = 'user-card-list';
      for (const action of record.actions.slice(-5).reverse()) {
        const item = document.createElement('div'); item.className = 'user-card-list-item';
        const seconds = action.type === 'timeout' ? getTimeoutDurationSeconds(action) : 0;
        const title = document.createElement('div');
        title.textContent = action.type === 'timeout'
          ? `Timeout · ${formatModerationDuration(seconds)}`
          : `Ban${action.reason ? ` · ${action.reason}` : ''}`;
        const meta = document.createElement('div'); meta.className = 'user-card-list-meta';
        const expiresAt = action.type === 'timeout'
          ? new Date(action.expiresAt || (new Date(action.at).getTime() + seconds * 1000)).getTime()
          : null;
        const state = action.clearedAt
          ? `Cleared ${new Date(action.clearedAt).toLocaleString()}`
          : action.type === 'timeout' && expiresAt <= Date.now()
            ? 'Expired'
            : action.type === 'ban' && !record.banned
              ? 'Reversed'
              : 'Active';
        meta.textContent = `${state} · ${action.at ? new Date(action.at).toLocaleString() : 'Unknown time'}`;
        item.append(title, meta); list.appendChild(item);
      }
      moderationSection.appendChild(list);
    } else {
      const empty = document.createElement('div'); empty.className = 'user-card-empty'; empty.textContent = 'No previous actions';
      moderationSection.appendChild(empty);
    }

    const adminActions = document.createElement('div');
    adminActions.className = 'user-card-admin-actions';
    adminActions.append(
      makeCardButton('Add flag', () => {
        const label = prompt('Flag label:');
        if (!label?.trim() || !data.userId) return;
        record.flags.push({ label: label.trim(), at: new Date().toISOString() });
        appendModerationAudit('flag_added', { actor: 'You', source: 'manual', targetUserId: data.userId, targetName: data.displayName, reason: label.trim() });
        saveModerationRecord(data.userId, record); reopen();
      }),
      makeCardButton(record.banned ? 'Unban' : 'Ban', () => {
        if (!data.userId) return;
        if (record.banned) {
          record.banned = false;
          const activeBan = [...record.actions].reverse().find((action) => action.type === 'ban' && !action.clearedAt);
          if (activeBan) activeBan.clearedAt = new Date().toISOString();
          appendModerationAudit('user_unbanned', { actor: 'You', source: 'manual', targetUserId: data.userId, targetName: data.displayName });
          saveModerationRecord(data.userId, record);
          setUserBanState(data, false);
          reopen();
        } else {
          showBanDialog(data, reopen);
        }
      }, 'danger'),
    );
    adminActions.appendChild(makeCardButton('Remove all messages', () => {
      for (const message of messages) {
        if (messageBelongsToUser(message, data)) markMessageDeleted(message, 'Removed from user card');
      }
      renderNow();
      reopen();
    }, 'danger'));
    if (messages.some(message => messageBelongsToUser(message, data) && message.deletedAt)) {
      adminActions.appendChild(makeCardButton('Restore removed messages', () => {
        for (const message of messages) {
          if (messageBelongsToUser(message, data)) restoreMessage(message);
        }
        renderNow();
        reopen();
      }));
    }
    moderationSection.appendChild(adminActions);

    const timeoutControls = document.createElement('div');
    timeoutControls.className = 'user-card-timeout-controls';
    const timeoutSelect = document.createElement('select');
    timeoutSelect.setAttribute('aria-label', 'Timeout duration');
    const timeoutOptions = [
      [30, '30 seconds'], [60, '1 minute'], [300, '5 minutes'], [600, '10 minutes'],
      [1800, '30 minutes'], [3600, '1 hour'], [21600, '6 hours'], [86400, '1 day'],
    ];
    for (const [seconds, label] of timeoutOptions) {
      const option = document.createElement('option');
      option.value = String(seconds); option.textContent = label;
      if (seconds === 600) option.selected = true;
      timeoutSelect.appendChild(option);
    }
    const timeoutButton = makeCardButton('Timeout', () => {
      if (!data.userId) return;
      const now = new Date();
      const durationSeconds = Number(timeoutSelect.value);
      const existingTimeout = getActiveTimeout(record);
      if (existingTimeout) existingTimeout.clearedAt = now.toISOString();
      record.actions.push({
        type: 'timeout', durationSeconds, at: now.toISOString(),
        expiresAt: new Date(now.getTime() + durationSeconds * 1000).toISOString(),
      });
      appendModerationAudit('user_timed_out', { actor: 'You', source: 'manual', targetUserId: data.userId, targetName: data.displayName, durationSeconds });
      saveModerationRecord(data.userId, record); reopen();
    });
    timeoutControls.append(timeoutSelect, timeoutButton);
    moderationSection.appendChild(timeoutControls);

    const reversibleActions = document.createElement('div');
    reversibleActions.className = 'user-card-reversible-actions';
    if (activeTimeout) {
      reversibleActions.appendChild(makeCardButton('Clear active timeout', () => {
        activeTimeout.clearedAt = new Date().toISOString();
        appendModerationAudit('timeout_cleared', { actor: 'You', source: 'manual', targetUserId: data.userId, targetName: data.displayName });
        saveModerationRecord(data.userId, record); reopen();
      }));
    }
    if (record.actions.length) {
      reversibleActions.appendChild(makeCardButton('Clear history', () => {
        record.actions = [];
        appendModerationAudit('moderation_history_cleared', { actor: 'You', source: 'manual', targetUserId: data.userId, targetName: data.displayName });
        saveModerationRecord(data.userId, record); reopen();
      }));
    }
    if (record.autoModViolations > 0) {
      reversibleActions.appendChild(makeCardButton('Clear AutoMod strikes', () => {
        record.autoModViolations = 0;
        appendModerationAudit('automod_strikes_cleared', { actor: 'You', source: 'manual', targetUserId: data.userId, targetName: data.displayName });
        saveModerationRecord(data.userId, record); reopen();
      }));
    }
    moderationSection.appendChild(reversibleActions);

    const note = document.createElement('div');
    note.className = 'user-card-note';
    note.textContent = 'Local moderation scaffold; enforcement will move to the account backend.';
    moderationSection.appendChild(note);
  }

  const inspectorHost = getInspectorHost();
  inspectorHost.appendChild(_inspectorEl);
  const hostRect = inspectorHost === document.body
    ? { left: 0, top: 0, right: innerWidth, bottom: innerHeight, width: innerWidth, height: innerHeight }
    : inspectorHost.getBoundingClientRect();
  _inspectorEl.style.position = inspectorHost === document.body ? 'fixed' : 'absolute';
  _inspectorEl.style.maxHeight = `${Math.max(180, hostRect.height - 20)}px`;
  _inspectorEl.style.maxWidth = `${Math.max(220, hostRect.width - 20)}px`;

  const pad = 10;
  const w = _inspectorEl.offsetWidth, h = _inspectorEl.offsetHeight;
  const maxLeft = Math.max(hostRect.left + pad, hostRect.right - w - pad);
  let left = Math.min(Math.max(hostRect.left + pad, anchorRect.left), maxLeft);
  let top  = anchorRect.bottom + 6;
  if (top + h + pad > hostRect.bottom) top = Math.max(hostRect.top + pad, anchorRect.top - h - 6);
  _inspectorEl.style.left = `${left - hostRect.left}px`;
  _inspectorEl.style.top  = `${top - hostRect.top}px`;
  makeInspectorDraggable(_inspectorEl, inspectorHost);

  setTimeout(() => {
    _inspectorOutsideHandler = (e) => {
      if (!_inspectorEl || _inspectorEl.contains(e.target) || _userHistoryEl?.contains(e.target) || _banDialogEl?.contains(e.target) || _pinDialogEl?.contains(e.target)) return;
      closeInspector();
    };
    document.addEventListener('mousedown', _inspectorOutsideHandler, true);
  }, 0);
}

// Compute safe top offset under YouTube's masthead (fallback ~56px + 15px gap)
function getDockTopOffsetPx() {
  const masthead = document.querySelector('ytd-masthead, #masthead-container, #masthead');
  const h = masthead && masthead.offsetHeight ? masthead.offsetHeight : 56;
  return h + 15;
}

// Set dock position based on setting ("tr" | "br")
function setDockPosition(panel, dockSel) {
  panel.style.right = "20px";
  if (dockSel === 'tr') {
    panel.style.top = `${getDockTopOffsetPx()}px`;
    panel.style.bottom = "";
  } else {
    panel.style.bottom = "15px";
    panel.style.top = "";
  }
}

window.setDockPosition = setDockPosition;

// Enable dragging via top bar only
function enableDrag(elm) {
  if (!elm || elm._dragBound) return;

  const dragBar = elm.querySelector('#chat-header');
  if (!dragBar) return;

  let dragging = false, offsetX = 0, offsetY = 0;

  const onDown = (e) => {
    if (isLocked) return;
    dragging = true;
    const r = elm.getBoundingClientRect();
    offsetX = e.clientX - r.left;
    offsetY = e.clientY - r.top;
    elm.style.position = 'fixed';
    elm.style.left = `${r.left}px`;
    elm.style.top = `${r.top}px`;
    elm.style.right = '';
    elm.style.bottom = '';
    document.body.style.userSelect = 'none';
    try { dragBar.setPointerCapture(e.pointerId); } catch {}
  };
  const onMove = (e) => {
    if (!dragging || isLocked) return;
    const x = Math.max(0, Math.min(e.clientX - offsetX, window.innerWidth  - elm.offsetWidth));
    const y = Math.max(0, Math.min(e.clientY - offsetY, window.innerHeight - elm.offsetHeight));
    elm.style.position = 'fixed';
    elm.style.left = `${x}px`;
    elm.style.top  = `${y}px`;
    localStorage.setItem('chatLeft', elm.style.left);
    localStorage.setItem('chatTop',  elm.style.top);
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.userSelect = '';
    try { dragBar.releasePointerCapture && dragBar.releasePointerCapture(); } catch {}
  };

  dragBar.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);

  elm._dragBound = true;
}

function attachResizeHandles(panel, header, opts = {}) {
  const edge = opts.edgeSize ?? 8;
  const minW = opts.minWidth ?? 260;
  const minH = opts.minHeight ?? 240;

  let resDir = null; // e, w, n, s, ne, nw, se, sw
  let startX = 0, startY = 0;
  let startLeft = 0, startTop = 0, startW = 0, startH = 0;
  let resizing = false;

  function getDir(e) {
    const rect = panel.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const onLeft   = x <= edge;
    const onRight  = x >= rect.width - edge;
    const onTop    = y <= edge;
    const onBottom = y >= rect.height - edge;

    if (onTop && onLeft)     return 'nw';
    if (onTop && onRight)    return 'ne';
    if (onBottom && onLeft)  return 'sw';
    if (onBottom && onRight) return 'se';
    if (onTop)    return 'n';
    if (onBottom) return 's';
    if (onLeft)   return 'w';
    if (onRight)  return 'e';
    return null;
  }

  function cursorFor(dir) {
    switch (dir) {
      case 'n': case 's': return 'ns-resize';
      case 'e': case 'w': return 'ew-resize';
      case 'ne': case 'sw': return 'nesw-resize';
      case 'nw': case 'se': return 'nwse-resize';
      default: return 'default';
    }
  }

  function setCursor(cursor) {
    panel.style.cursor = cursor || 'default';
    if (header) header.style.cursor = cursor || 'default';
  }

  // Cursor updates across the whole panel (header included)
  panel.addEventListener('mousemove', (e) => {
    if (resizing) return;
    if (panel.classList.contains('lyve-minimal-overlay')) { setCursor('default'); return; }
    const dir = getDir(e);
    setCursor(cursorFor(dir));
  });

  panel.addEventListener('mouseleave', () => {
    if (!resizing) setCursor('default');
  });

  // Use capture + stopPropagation so resize wins over header drag at top edge
  panel.addEventListener('mousedown', (e) => {
    if (panel.classList.contains('lyve-minimal-overlay')) return;
    const dir = getDir(e);
    if (!dir) return; // not near an edge/corner → let normal handlers run
    e.preventDefault();
    e.stopPropagation();
    startResize(dir, e);
  }, true);

  function startResize(dir, e) {
    resizing = true;
    resDir = dir;

    const rect = panel.getBoundingClientRect();
    startX = e.clientX;
    startY = e.clientY;
    startLeft = rect.left;
    startTop  = rect.top;
    startW = rect.width;
    startH = rect.height;

    // Preserve the current screen position while dropping dock anchors.
    panel.style.position = 'fixed';
    panel.style.left = `${startLeft}px`;
    panel.style.top = `${startTop}px`;
    panel.style.right = '';
    panel.style.bottom = '';

    function onMove(ev) {
      if (!resizing) return;

      let newLeft = startLeft;
      let newTop  = startTop;
      let newW = startW;
      let newH = startH;

      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;

      if (resDir.includes('e')) newW = Math.max(minW, startW + dx);
      if (resDir.includes('s')) newH = Math.max(minH, startH + dy);
      if (resDir.includes('w')) {
        newW = Math.max(minW, startW - dx);
        newLeft = startLeft + (startW - newW);
      }
      if (resDir.includes('n')) {
        newH = Math.max(minH, startH - dy);
        newTop = startTop + (startH - newH);
      }

      // Constrain to viewport
      newW = Math.min(newW, window.innerWidth);
      newH = Math.min(newH, window.innerHeight);
      newLeft = Math.max(0, Math.min(newLeft, window.innerWidth - newW));
      newTop  = Math.max(0, Math.min(newTop,  window.innerHeight - newH));

      panel.style.width = `${newW}px`;
      panel.style.height = `${newH}px`;
      panel.style.left = `${newLeft}px`;
      panel.style.top  = `${newTop}px`;

      // Persist while resizing
      localStorage.setItem('chatLeft', panel.style.left);
      localStorage.setItem('chatTop',  panel.style.top);
      localStorage.setItem('chatWidth',  panel.style.width);
      localStorage.setItem('chatHeight', panel.style.height);
      localStorage.setItem('chatFreeWidth', panel.style.width);
      localStorage.setItem('chatFreeHeight', panel.style.height);

      setCursor(cursorFor(resDir));
      document.body.style.userSelect = "none";
    }

    function onUp() {
      resizing = false;
      resDir = null;
      setCursor('default');
      document.body.style.userSelect = "";
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }
}

export {
  waitForButtonBar, insertToggleButton, removeToggleButton,
  insertChatPanel, removeChatPanel,
  injectChatStyles, injectInspectorStyles, showInspectorNear,
  getDockTopOffsetPx, setDockPosition, enableDrag, attachResizeHandles,
  clearMessageCooldownForVideo
};
