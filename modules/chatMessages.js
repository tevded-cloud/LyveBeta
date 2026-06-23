import { getOrCreateUserId, getSetting } from "./settings.js";
import { SevenTV } from "./emotes.js";

// Keep the original global variables (unchanged behavior)
export let messages = [];
let _messageRevision = 0;
let _lastRenderKey = '';
let _lastVisibleCount = 0;
let _unreadCount = 0;
let _unreadStartIndex = null;

function createTimelineState() {
  const state = document.createElement('section');
  state.className = 'chat-timeline-state chat-timeline-state-empty-video';
  state.setAttribute('role', 'status');

  const icon = document.createElement('div');
  icon.className = 'chat-timeline-state-icon';
  icon.textContent = '✦';

  const copy = document.createElement('div');
  copy.className = 'chat-timeline-state-copy';

  const title = document.createElement('strong');
  const text = document.createElement('span');
  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'chat-timeline-state-action';

  title.textContent = 'No Lyve messages yet';
  text.textContent = 'Be the first to leave a timestamped message for this video.';
  action.textContent = 'Start typing';
  action.addEventListener('click', () => document.getElementById('chat-input')?.focus());

  copy.append(title, text);
  state.append(icon, copy, action);
  return state;
}

// New helper: stable, chronological insertion by (time ASC, then seq ASC)
function insertMessageSorted(msg) {
  // Product-stage moderation hook. The React/backend build can replace this
  // with server results while keeping the renderer's message-state contract.
  globalThis.lyveApplyAutoModeration?.(msg);

  // Monotonic tie-breaker stored on the function itself (no new globals)
  insertMessageSorted._seq = (insertMessageSorted._seq || 0) + 1;
  msg._seq = insertMessageSorted._seq;
  msg.id = msg.id || globalThis.crypto?.randomUUID?.() || `msg_${Date.now()}_${msg._seq}`;

  // Binary insert into messages[] by (time, _seq)
  let lo = 0, hi = messages.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const a = messages[mid];
    if (a.time === msg.time ? a._seq <= msg._seq : a.time < msg.time) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  messages.splice(lo, 0, msg);
  _messageRevision += 1;
}

// Shared single-pass renderer used by both the interval and renderNow()
function renderAtTime(currentTime, force = false) {
  const chatMessages = document.getElementById('chat-messages');
  if (!chatMessages) return;

  const showTS   = getSetting('chatShowTimestamps', true);
  const myColor  = getSetting('chatUserColor', '#3a6ff7'); // username font color
  const myName   = getSetting('chatDisplayName', 'You');   // future step
  const myUserId = getOrCreateUserId();
  const overlayActive = document.getElementById('chat-panel')?.classList.contains('lyve-minimal-overlay') || false;
  const overlayFadeSeconds = overlayActive ? Math.max(0, Number(getSetting('chatOverlayFadeSeconds', '10')) || 0) : 0;

  let visibleCount = 0;
  while (visibleCount < messages.length && messages[visibleCount].time <= currentTime) {
    visibleCount += 1;
  }
  const awayFromCurrent = chatMessages.dataset.awayFromCurrent === 'true';
  if (visibleCount < _lastVisibleCount) {
    _unreadCount = 0;
    _unreadStartIndex = null;
  } else if (awayFromCurrent && visibleCount > _lastVisibleCount) {
    if (_unreadStartIndex === null) _unreadStartIndex = _lastVisibleCount;
    _unreadCount += visibleCount - _lastVisibleCount;
  } else if (!awayFromCurrent) {
    _unreadCount = 0;
    _unreadStartIndex = null;
  }
  _lastVisibleCount = visibleCount;
  const renderKey = `${visibleCount}|${messages.length}|${_messageRevision}|${showTS}|${myColor}|${myName}|${overlayActive}|${overlayFadeSeconds}|${_unreadCount}|${_unreadStartIndex}`;
  if (!force && renderKey === _lastRenderKey) return;
  _lastRenderKey = renderKey;

  const browsingTimeline = chatMessages.dataset.awayFromCurrent === 'true';
  const previousScrollTop = chatMessages.scrollTop;
  chatMessages.innerHTML = '';

  const spacer = document.createElement('div');
  spacer.className = 'chat-timeline-spacer';
  chatMessages.appendChild(spacer);

  const boundary = document.createElement('div');
  boundary.className = 'chat-current-boundary';
  boundary.dataset.currentTime = String(currentTime);

  if (messages.length === 0) {
    chatMessages.appendChild(createTimelineState());
  }

  for (let i = 0; i < messages.length; i++) {
    if (i === visibleCount) chatMessages.appendChild(boundary);
    if (_unreadCount > 0 && i === _unreadStartIndex && i < visibleCount) {
      const separator = document.createElement('div');
      separator.className = 'chat-unread-separator';
      separator.textContent = `${_unreadCount} new message${_unreadCount === 1 ? '' : 's'}`;
      chatMessages.appendChild(separator);
    }
    const msg = messages[i];
    const overlayAge = currentTime - Number(msg.time || 0);
    const overlayExpired = overlayActive && overlayFadeSeconds > 0 && i < visibleCount && overlayAge >= overlayFadeSeconds;
    if (msg.deletedAt) {
      if (overlayActive) continue;
      let end = i + 1;
      while (end < messages.length && end !== visibleCount && messages[end].deletedAt) end += 1;
      const count = end - i;
      const summary = document.createElement('div');
      summary.className = `chat-removal-summary${i >= visibleCount ? ' chat-message-future' : ''}`;
      summary.textContent = count === 1 ? '1 message removed by moderation' : `${count} messages removed by moderation`;
      chatMessages.appendChild(summary);
      i = end - 1;
      continue;
    }
    const viewerSafety = globalThis.lyveGetViewerSafetyState?.(msg) || { muted: false, blocked: false };
    const safetyHidden = viewerSafety.blocked || viewerSafety.muted;
    const pinned = globalThis.lyveIsMessagePinned?.(msg) === true;
    const reportState = globalThis.lyveGetMessageReportState?.(msg) || { totalCount: 0, openCount: 0 };
    const row = document.createElement('div');
    row.className = `chat-message-row${i >= visibleCount ? ' chat-message-future' : ''}`;
    const deleted = false;
    if (msg.authorBanned) row.classList.add('chat-message-banned-author');
    if (pinned) row.classList.add('chat-message-pinned');
    if (reportState.openCount > 0) row.classList.add('chat-message-reported');
    if (safetyHidden) row.classList.add('chat-message-safety-hidden');
    row.dataset.messageId = msg.id || '';
    row._message = msg;
    if (overlayExpired) {
      row.classList.add('chat-message-overlay-expired');
    } else if (overlayActive && overlayFadeSeconds > 0 && i < visibleCount) {
      row.classList.add('chat-message-overlay-fading');
      row.style.setProperty('--lyve-fade-remaining', `${Math.max(.1, overlayFadeSeconds - Math.max(0, overlayAge))}s`);
    }

    if (safetyHidden) {
      const placeholder = document.createElement('div');
      placeholder.className = 'chat-safety-placeholder';
      const text = document.createElement('span');
      text.textContent = viewerSafety.blocked ? 'Message hidden from a blocked user' : 'Message hidden from a muted user';
      const undo = document.createElement('button');
      undo.type = 'button';
      undo.className = 'chat-safety-undo';
      undo.dataset.safetyType = viewerSafety.blocked ? 'blocked' : 'muted';
      undo.textContent = viewerSafety.blocked ? 'Unblock' : 'Unmute';
      placeholder.append(text, undo);
      row.appendChild(placeholder);
      chatMessages.appendChild(row);
      continue;
    }

    if (msg.replyTo && !deleted) {
      const replyContext = document.createElement('button');
      replyContext.type = 'button';
      replyContext.className = 'chat-reply-context';
      replyContext.dataset.targetMessageId = msg.replyTo.messageId || '';
      replyContext.title = 'Jump to replied-to message';
      const replyName = msg.replyTo.user || 'message';
      const replyText = String(msg.replyTo.text || '').slice(0, 80);
      replyContext.textContent = `Replying to ${replyName}${replyText ? `: ${replyText}` : ''}`;
      row.appendChild(replyContext);
    }

    const line = document.createElement('div');
    line.className = 'chat-message-line';

    if (showTS) {
      const timeSpan = document.createElement('span');
      timeSpan.className = 'chat-message-time';
      timeSpan.textContent = `[${formatTime(msg.time)}]`;
      line.appendChild(timeSpan);
    }

    const userSpan = document.createElement('button');
    userSpan.type = 'button';
    userSpan.className = 'chat-username';
    userSpan.textContent = msg.authorBanned ? 'Banned user' : (msg.user || 'Unknown');
    if (msg.user === myName) userSpan.style.color = myColor;
    userSpan.dataset.displayName = msg.user || '';
    if (msg.userId) userSpan.dataset.userId = msg.userId;
    userSpan.dataset.time = String(msg.time ?? '');
    line.appendChild(userSpan);

    if (viewerSafety.role && viewerSafety.role !== 'viewer') {
      const roleBadge = document.createElement('span');
      roleBadge.className = `chat-role-badge role-${viewerSafety.role}`;
      roleBadge.textContent = viewerSafety.role === 'creator'
        ? 'Creator'
        : viewerSafety.role === 'moderator'
          ? 'Mod'
          : 'Member';
      line.appendChild(roleBadge);
    }
    const selfBadge = msg.userId && msg.userId === myUserId
      ? String(msg.badge || getSetting('chatSelfBadge', 'none') || 'none')
      : String(msg.badge || '');
    if (selfBadge && selfBadge !== 'none') {
      const accountBadge = document.createElement('span');
      accountBadge.className = `chat-account-badge badge-${selfBadge}`;
      accountBadge.textContent = selfBadge === 'founder'
        ? 'Early'
        : selfBadge === 'supporter'
          ? 'Supporter'
          : 'Member';
      line.appendChild(accountBadge);
    }

    if (pinned) {
      const pinnedBadge = document.createElement('span');
      pinnedBadge.className = 'chat-pinned-badge';
      pinnedBadge.textContent = 'Pinned';
      line.appendChild(pinnedBadge);
    }
    if (reportState.openCount > 0) {
      const reportedBadge = document.createElement('span');
      reportedBadge.className = 'chat-reported-badge';
      reportedBadge.textContent = reportState.openCount === 1 ? 'Reported' : `${reportState.openCount} reports`;
      line.appendChild(reportedBadge);
    }

    if (msg.authorBanned) {
      const bannedBadge = document.createElement('span');
      bannedBadge.className = 'chat-banned-badge';
      bannedBadge.textContent = 'Banned';
      line.appendChild(bannedBadge);
    }
    if (viewerSafety.showAdminStates && viewerSafety.flagged) {
      const flagBadge = document.createElement('span');
      flagBadge.className = 'chat-user-state-badge flagged';
      flagBadge.textContent = 'Flagged';
      line.appendChild(flagBadge);
    }
    if (viewerSafety.showAdminStates && viewerSafety.timedOut) {
      const timeoutBadge = document.createElement('span');
      timeoutBadge.className = 'chat-user-state-badge timeout';
      timeoutBadge.textContent = 'Timeout';
      line.appendChild(timeoutBadge);
    }

    const colonSpan = document.createElement('span');
    colonSpan.className = 'chat-message-colon';
    colonSpan.textContent = ':';
    line.appendChild(colonSpan);

    const msgSpan = document.createElement('span');
    msgSpan.className = 'chat-message-text';
    if (deleted) {
      msgSpan.classList.add('chat-message-removed-text');
      msgSpan.textContent = msg.deletedBy === 'AutoMod'
        ? 'Message removed by AutoMod'
        : 'Message removed by a moderator';
    } else {
      msgSpan.appendChild(SevenTV.replaceToFragment(msg.text || ''));
    }
    line.appendChild(msgSpan);
    row.appendChild(line);

    const actions = document.createElement('div');
    actions.className = 'chat-message-actions';

    if (!deleted) {
      const replyButton = document.createElement('button');
      replyButton.type = 'button';
      replyButton.className = 'chat-message-action chat-reply-action';
      replyButton.textContent = '↩';
      replyButton.title = 'Reply';
      replyButton.setAttribute('aria-label', `Reply to ${msg.user || 'message'}`);
      actions.appendChild(replyButton);
    }
    if (actions.childElementCount) row.appendChild(actions);
    chatMessages.appendChild(row);
  }
  if (visibleCount === messages.length) chatMessages.appendChild(boundary);

  // When current chat is short, an elastic spacer keeps it pinned to the
  // bottom while future messages remain just below the viewport.
  spacer.style.height = '0px';
  const currentContentHeight = Math.max(0, boundary.offsetTop - spacer.offsetTop);
  spacer.style.height = `${Math.max(0, chatMessages.clientHeight - currentContentHeight)}px`;

  if (browsingTimeline) chatMessages.scrollTop = previousScrollTop;
  else scrollChatToCurrentTime(chatMessages);
  chatMessages.dispatchEvent(new CustomEvent('lyve:chat-rendered', { detail: { unreadCount: _unreadCount } }));
}

function clearUnreadMessages() {
  _unreadCount = 0;
  _unreadStartIndex = null;
  document.querySelector('.chat-unread-separator')?.remove();
}

function getUnreadMessageCount() {
  return _unreadCount;
}

function scrollChatToCurrentTime(container = document.getElementById('chat-messages')) {
  if (!container) return;
  const boundary = container.querySelector('.chat-current-boundary');
  if (!boundary) return;
  container.dataset.browsingAhead = 'false';
  container.dataset.awayFromCurrent = 'false';
  document.getElementById('chat-panel')?.classList.remove('lyve-browsing-history');
  container.scrollTop = Math.max(0, boundary.offsetTop - container.clientHeight);
}

// New helper: render immediately using the same logic as the interval (no new timers)
function renderNow() {
  const video = document.querySelector('video');
  if (!video) return;
  const currentTime = Math.floor(video.currentTime);
  renderAtTime(currentTime, true);
}

// Add this near your globals:
let _chatRenderInterval = null; // single source of truth for the render timer

// Replace the whole startRenderLoop() with this:
// Replace your startRenderLoop() with this single-interval version that reuses renderAtTime()
function startRenderLoop() {
  if (_chatRenderInterval !== null) {
    clearInterval(_chatRenderInterval);
    _chatRenderInterval = null;
  }

  const renderCurrentVideo = () => {
    const video = document.querySelector('video');
    if (!video) return;
    const currentTime = Math.floor(video.currentTime);
    renderAtTime(currentTime);
  };

  renderCurrentVideo();
  _chatRenderInterval = setInterval(() => {
    renderCurrentVideo();
  }, 500);
}

function stopRenderLoop() {
  if (_chatRenderInterval === null) return;
  clearInterval(_chatRenderInterval);
  _chatRenderInterval = null;
}

function isUserScrolledToBottom(container) {
  return container.scrollTop + container.clientHeight >= container.scrollHeight - 5;
}

// Format seconds to mm:ss
function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export {
  insertMessageSorted, renderAtTime, renderNow,
  startRenderLoop, stopRenderLoop, isUserScrolledToBottom,
  scrollChatToCurrentTime, clearUnreadMessages, getUnreadMessageCount
};
