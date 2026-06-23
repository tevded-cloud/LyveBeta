// Local-only message storage seam for Lyve.
//
// This module keeps the current local optimistic behavior while the MV3
// background worker handles Firebase Auth and Firestore.

const localMessagesByVideo = new Map();
const subscribersByVideo = new Map();
const pollTimersByVideo = new Map();
let authInitPromise = null;

const POLL_INTERVAL_MS = 5000;

function sendBackgroundMessage(type, payload = {}) {
  if (!globalThis.chrome?.runtime?.sendMessage) return Promise.resolve(null);
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage({
        source: 'lyve-message-store',
        type,
        payload,
      }, response => {
        const error = chrome.runtime.lastError;
        if (error) {
          console.debug('Lyve background bridge unavailable:', error.message);
          resolve(null);
          return;
        }
        resolve(response || null);
      });
    } catch (error) {
      console.debug('Lyve background bridge failed:', error);
      resolve(null);
    }
  });
}

function ensureBackgroundAuth() {
  if (!authInitPromise) {
    authInitPromise = sendBackgroundMessage('LYVE_AUTH_INIT').then(response => {
      if (response && response.ok === false) {
        console.debug('Lyve Firebase auth init failed:', response.error || response);
      }
      return response;
    });
  }
  return authInitPromise;
}

function mirrorToBackground(type, payload = {}) {
  const authReady = type === 'LYVE_AUTH_INIT'
    ? Promise.resolve()
    : ensureBackgroundAuth().catch(() => null);

  return authReady
    .then(() => sendBackgroundMessage(type, payload))
    .then(response => {
      if (response && response.ok === false) {
        console.debug('Lyve background bridge rejected action:', response);
      }
      return response;
    })
    .catch(error => {
      console.debug('Lyve background bridge action failed:', error);
      return null;
    });
}

ensureBackgroundAuth();

function normalizeVideoId(videoId) {
  return String(videoId || 'unknown-video');
}

function getMessageBucket(videoId) {
  const key = normalizeVideoId(videoId);
  if (!localMessagesByVideo.has(key)) localMessagesByVideo.set(key, []);
  return localMessagesByVideo.get(key);
}

function getMessageSnapshot(videoId) {
  return getMessageBucket(videoId).slice();
}

function getMessageIdentity(message) {
  return String(message?.id || message?.clientMessageId || message?.firestoreId || '');
}

function messagesLookEquivalent(first, second) {
  const firstId = getMessageIdentity(first);
  const secondId = getMessageIdentity(second);
  if (firstId && secondId && firstId === secondId) return true;
  return String(first?.userId || '') === String(second?.userId || '')
    && String(first?.text || '') === String(second?.text || '')
    && Number(first?.time ?? first?.videoTime ?? 0) === Number(second?.time ?? second?.videoTime ?? 0)
    && String(first?.created_at || first?.createdAt || '') === String(second?.created_at || second?.createdAt || '');
}

function upsertMessageInBucket(videoId, message) {
  if (!message) return false;
  if (message.videoTime !== undefined && message.time === undefined) message.time = Number(message.videoTime) || 0;
  const bucket = getMessageBucket(videoId);
  const existingIndex = bucket.findIndex(existing => messagesLookEquivalent(existing, message));
  if (existingIndex >= 0) {
    bucket[existingIndex] = { ...bucket[existingIndex], ...message };
    sortMessagesInPlace(bucket);
    return false;
  }
  bucket.push(message);
  sortMessagesInPlace(bucket);
  return true;
}

// Returns how many messages were newly added (not updates), so polling can log merges.
function mergeMessagesIntoBucket(videoId, nextMessages) {
  let added = 0;
  for (const message of nextMessages || []) {
    if (upsertMessageInBucket(videoId, message)) added += 1;
  }
  emitMessageSnapshot(videoId);
  return added;
}

function emitMessageSnapshot(videoId) {
  const key = normalizeVideoId(videoId);
  const subscribers = subscribersByVideo.get(key);
  if (!subscribers?.size) return;
  const snapshot = getMessageSnapshot(key);
  for (const callback of subscribers) {
    try { callback(snapshot); } catch (error) { console.error('Lyve message subscriber failed:', error); }
  }
}

function sortMessagesInPlace(messages) {
  messages.sort((first, second) => {
    const firstTime = Number(first?.time ?? first?.videoTime ?? 0);
    const secondTime = Number(second?.time ?? second?.videoTime ?? 0);
    if (firstTime !== secondTime) return firstTime - secondTime;
    return Number(first?._seq || 0) - Number(second?._seq || 0);
  });
}

async function loadMessagesForVideo(videoId) {
  const key = normalizeVideoId(videoId);
  try {
    const response = await mirrorToBackground('LYVE_LOAD_MESSAGES', { videoId: key });
    if (response?.ok && Array.isArray(response.messages)) {
      mergeMessagesIntoBucket(key, response.messages);
      return getMessageSnapshot(key);
    }
  } catch (error) {
    console.debug('Lyve Firestore load failed; using local messages:', error);
  }
  return getMessageSnapshot(key);
}

// Pull the latest server messages for a video and merge them into the local
// source of truth. Dedup is handled by mergeMessagesIntoBucket, so optimistic
// local messages survive and server copies of them update in place.
async function pollMessagesForVideo(videoId) {
  const key = normalizeVideoId(videoId);
  const response = await mirrorToBackground('LYVE_LOAD_MESSAGES', { videoId: key });
  if (!response?.ok || !Array.isArray(response.messages)) return;
  mergeMessagesIntoBucket(key, response.messages);
}

function startPollingForVideo(videoId) {
  const key = normalizeVideoId(videoId);
  if (pollTimersByVideo.has(key)) return;
  // Immediate refresh, then poll every 5s while the video stays active.
  pollMessagesForVideo(key).catch(error => console.debug('Lyve polling failed:', error));
  const timer = setInterval(() => {
    pollMessagesForVideo(key).catch(error => console.debug('Lyve polling failed:', error));
  }, POLL_INTERVAL_MS);
  pollTimersByVideo.set(key, timer);
}

function stopPollingForVideo(videoId) {
  const key = normalizeVideoId(videoId);
  const timer = pollTimersByVideo.get(key);
  if (timer === undefined) return;
  clearInterval(timer);
  pollTimersByVideo.delete(key);
}

async function saveMessageForVideo(videoId, message) {
  if (!message) return null;
  const key = normalizeVideoId(videoId);
  upsertMessageInBucket(key, message);
  emitMessageSnapshot(key);
  mirrorToBackground('LYVE_SAVE_MESSAGE', { videoId: key, message });
  return message;
}

async function clearMessagesForVideo(videoId) {
  localMessagesByVideo.set(normalizeVideoId(videoId), []);
  emitMessageSnapshot(videoId);
  mirrorToBackground('LYVE_CLEAR_MESSAGES', { videoId: normalizeVideoId(videoId) });
}

function subscribeToMessagesForVideo(videoId, callback) {
  const key = normalizeVideoId(videoId);
  if (!subscribersByVideo.has(key)) subscribersByVideo.set(key, new Set());
  const subscribers = subscribersByVideo.get(key);
  const wasEmpty = subscribers.size === 0;
  subscribers.add(callback);

  mirrorToBackground('LYVE_SUBSCRIBE_VIDEO_MESSAGES', { videoId: key });
  // Start the 5s poll when the first subscriber for this video arrives.
  if (wasEmpty) startPollingForVideo(key);

  try { callback(getMessageSnapshot(key)); } catch (error) { console.error('Lyve message subscriber failed:', error); }

  return () => {
    subscribers.delete(callback);
    if (!subscribers.size) {
      subscribersByVideo.delete(key);
      stopPollingForVideo(key);
    }
  };
}

export {
  loadMessagesForVideo,
  saveMessageForVideo,
  clearMessagesForVideo,
  subscribeToMessagesForVideo,
};
