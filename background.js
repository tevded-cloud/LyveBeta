// MV3 background bridge for Lyve.
//
// Firebase Auth and Firestore live here instead of the YouTube content script.

// Chrome's service worker loads only background.js, so it pulls in the config
// via importScripts. Firefox loads firebaseConfig.js through background.scripts
// instead and has no importScripts, so guard the call.
if (typeof importScripts === 'function') {
  try {
    importScripts('firebaseConfig.js');
  } catch (error) {
    console.error('Lyve Firebase config could not be loaded:', error);
  }
}

const backgroundMessagesByVideo = new Map();
const FIREBASE_AUTH_STORAGE_KEYS = [
  'lyveFirebaseIdToken',
  'lyveFirebaseRefreshToken',
  'lyveFirebaseUid',
  'lyveFirebaseTokenExpiresAt',
];
const FIREBASE_TOKEN_EXPIRY_SKEW_MS = 60 * 1000;

function normalizeVideoId(videoId) {
  return String(videoId || 'unknown-video');
}

function getFirebaseConfig() {
  return globalThis.lyveFirebaseConfig || globalThis.firebaseConfig || {};
}

function getStorageLocal(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, values => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(values || {});
    });
  });
}

function setStorageLocal(values) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(values, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

function normalizeStoredFirebaseAuth(values = {}) {
  const uid = String(values.lyveFirebaseUid || '');
  const idToken = String(values.lyveFirebaseIdToken || '');
  const refreshToken = String(values.lyveFirebaseRefreshToken || '');
  const expiresAt = Number(values.lyveFirebaseTokenExpiresAt || 0);

  return {
    uid,
    idToken,
    refreshToken,
    expiresAt,
    hasToken: Boolean(idToken),
    isValid: Boolean(uid && idToken && expiresAt > Date.now() + FIREBASE_TOKEN_EXPIRY_SKEW_MS),
  };
}

async function getStoredFirebaseAuth() {
  const values = await getStorageLocal(FIREBASE_AUTH_STORAGE_KEYS);
  return normalizeStoredFirebaseAuth(values);
}

function getFirebaseApiKey() {
  const config = getFirebaseConfig();
  const apiKey = String(config.apiKey || '').trim();
  if (!apiKey) {
    throw new Error('Missing Firebase apiKey. Paste your Firebase Web App config into firebaseConfig.js.');
  }
  return apiKey;
}

async function signInWithFirebaseAnonymously() {
  const apiKey = getFirebaseApiKey();
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ returnSecureToken: true }),
    },
  );

  let data = {};
  try {
    data = await response.json();
  } catch (error) {
    data = {};
  }

  if (!response.ok) {
    const detail = data?.error?.message || data?.error || `HTTP ${response.status}`;
    throw new Error(`Firebase anonymous auth failed: ${detail}`);
  }

  const uid = String(data.localId || '');
  const idToken = String(data.idToken || '');
  const refreshToken = String(data.refreshToken || '');
  const expiresInSeconds = Number(data.expiresIn || 3600);
  const expiresAt = Date.now() + Math.max(0, expiresInSeconds) * 1000;

  if (!uid || !idToken || !refreshToken) {
    throw new Error('Firebase anonymous auth response was missing token data.');
  }

  await setStorageLocal({
    lyveFirebaseIdToken: idToken,
    lyveFirebaseRefreshToken: refreshToken,
    lyveFirebaseUid: uid,
    lyveFirebaseTokenExpiresAt: expiresAt,
  });

  return {
    uid,
    idToken,
    refreshToken,
    expiresAt,
    hasToken: true,
    isValid: true,
  };
}

async function ensureFirebaseAuth() {
  const storedAuth = await getStoredFirebaseAuth();
  if (storedAuth.isValid) return storedAuth;
  return signInWithFirebaseAnonymously();
}

// --- Real accounts (email/password) ---
//
// Anonymous auth above is kept only for reading chat. Posting requires a real
// account, whose tokens are stored separately under the lyveAccount* keys.

const ACCOUNT_AUTH_STORAGE_KEYS = [
  'lyveAccountIdToken',
  'lyveAccountRefreshToken',
  'lyveAccountUid',
  'lyveAccountTokenExpiresAt',
  'lyveAccountEmail',
  'lyveAccountDisplayName',
];

function normalizeStoredAccountAuth(values = {}) {
  const uid = String(values.lyveAccountUid || '');
  const idToken = String(values.lyveAccountIdToken || '');
  const refreshToken = String(values.lyveAccountRefreshToken || '');
  const expiresAt = Number(values.lyveAccountTokenExpiresAt || 0);
  const email = String(values.lyveAccountEmail || '');
  const displayName = String(values.lyveAccountDisplayName || '');

  return {
    uid,
    idToken,
    refreshToken,
    expiresAt,
    email,
    displayName,
    signedIn: Boolean(uid && refreshToken),
    isValid: Boolean(uid && idToken && expiresAt > Date.now() + FIREBASE_TOKEN_EXPIRY_SKEW_MS),
  };
}

async function getStoredAccountAuth() {
  const values = await getStorageLocal(ACCOUNT_AUTH_STORAGE_KEYS);
  return normalizeStoredAccountAuth(values);
}

async function storeAccountAuth(auth) {
  await setStorageLocal({
    lyveAccountIdToken: auth.idToken,
    lyveAccountRefreshToken: auth.refreshToken,
    lyveAccountUid: auth.uid,
    lyveAccountTokenExpiresAt: auth.expiresAt,
    lyveAccountEmail: auth.email || '',
    lyveAccountDisplayName: auth.displayName || '',
  });
}

function clearStoredAccountAuth() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(ACCOUNT_AUTH_STORAGE_KEYS, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

// Shared POST to the Identity Toolkit accounts:* endpoints.
async function callIdentityToolkit(method, body) {
  const apiKey = getFirebaseApiKey();
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:${method}?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  const data = await readResponseJson(response);
  if (!response.ok) {
    throw new Error(data?.error?.message || data?.error || `HTTP ${response.status}`);
  }
  return data;
}

async function refreshAccountToken(refreshToken) {
  const apiKey = getFirebaseApiKey();
  const response = await fetch(
    `https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
    },
  );
  const data = await readResponseJson(response);
  if (!response.ok) {
    throw new Error(`Token refresh failed: ${data?.error?.message || data?.error || `HTTP ${response.status}`}`);
  }
  return {
    idToken: String(data.id_token || ''),
    refreshToken: String(data.refresh_token || refreshToken),
    uid: String(data.user_id || ''),
    expiresAt: Date.now() + Math.max(0, Number(data.expires_in || 3600)) * 1000,
  };
}

// Returns valid account auth, refreshing the token if needed. Throws
// NOT_SIGNED_IN when no account is stored (used to gate writes).
async function ensureAccountAuth() {
  const stored = await getStoredAccountAuth();
  if (!stored.signedIn) {
    const error = new Error('You must sign in to send messages.');
    error.code = 'NOT_SIGNED_IN';
    throw error;
  }
  if (stored.isValid) return stored;

  const refreshed = await refreshAccountToken(stored.refreshToken);
  const merged = {
    uid: refreshed.uid || stored.uid,
    idToken: refreshed.idToken,
    refreshToken: refreshed.refreshToken,
    expiresAt: refreshed.expiresAt,
    email: stored.email,
    displayName: stored.displayName,
  };
  await storeAccountAuth(merged);
  return { ...merged, signedIn: true, isValid: true };
}

// Reads can use the signed-in account when present, else fall back to anonymous.
async function ensureReadAuth() {
  const account = await getStoredAccountAuth();
  if (account.signedIn) {
    try {
      return await ensureAccountAuth();
    } catch (error) {
      console.debug('Lyve account auth unavailable for read; using anonymous:', error?.message || error);
    }
  }
  return ensureFirebaseAuth();
}

async function signUpWithEmailPassword(email, password, username) {
  const cleanEmail = String(email || '').trim();
  const cleanUsername = String(username || '').trim();
  if (!cleanEmail) throw new Error('Email is required.');
  if (String(password || '').length < 6) throw new Error('Password must be at least 6 characters.');
  if (!cleanUsername) throw new Error('Username is required.');

  const signUp = await callIdentityToolkit('signUp', {
    email: cleanEmail,
    password: String(password),
    returnSecureToken: true,
  });

  let idToken = String(signUp.idToken || '');
  let refreshToken = String(signUp.refreshToken || '');
  const uid = String(signUp.localId || '');
  let expiresAt = Date.now() + Math.max(0, Number(signUp.expiresIn || 3600)) * 1000;
  if (!uid || !idToken) throw new Error('Sign-up response was missing token data.');

  // Store the chosen username as the account displayName.
  const updated = await callIdentityToolkit('update', {
    idToken,
    displayName: cleanUsername,
    returnSecureToken: true,
  });
  if (updated.idToken) {
    idToken = String(updated.idToken);
    refreshToken = String(updated.refreshToken || refreshToken);
    expiresAt = Date.now() + Math.max(0, Number(updated.expiresIn || 3600)) * 1000;
  }

  const auth = { uid, idToken, refreshToken, expiresAt, email: cleanEmail, displayName: cleanUsername };
  await storeAccountAuth(auth);
  return { ...auth, signedIn: true, isValid: true };
}

async function signInWithEmailPassword(email, password) {
  const cleanEmail = String(email || '').trim();
  if (!cleanEmail) throw new Error('Email is required.');
  if (!password) throw new Error('Password is required.');

  const signIn = await callIdentityToolkit('signInWithPassword', {
    email: cleanEmail,
    password: String(password),
    returnSecureToken: true,
  });

  const auth = {
    uid: String(signIn.localId || ''),
    idToken: String(signIn.idToken || ''),
    refreshToken: String(signIn.refreshToken || ''),
    expiresAt: Date.now() + Math.max(0, Number(signIn.expiresIn || 3600)) * 1000,
    email: String(signIn.email || cleanEmail),
    displayName: String(signIn.displayName || ''),
  };
  if (!auth.uid || !auth.idToken || !auth.refreshToken) {
    throw new Error('Sign-in response was missing token data.');
  }
  await storeAccountAuth(auth);
  return { ...auth, signedIn: true, isValid: true };
}

async function getAccountState() {
  const stored = await getStoredAccountAuth();
  if (!stored.signedIn) return { signedIn: false };
  return {
    signedIn: true,
    uid: stored.uid,
    email: stored.email,
    displayName: stored.displayName,
  };
}

async function sendPasswordResetEmail(email) {
  const cleanEmail = String(email || '').trim();
  if (!cleanEmail) throw new Error('Email is required.');
  await callIdentityToolkit('sendOobCode', {
    requestType: 'PASSWORD_RESET',
    email: cleanEmail,
  });
  return { email: cleanEmail };
}

// Admin is granted by a Firestore admins/{uid} doc that only the project owner
// can create (rules forbid client writes). The client can read its own doc to
// learn whether it is an admin, but can never promote itself.
async function checkAdminRole() {
  const stored = await getStoredAccountAuth();
  if (!stored.signedIn) return { isAdmin: false, signedIn: false };

  const auth = await ensureAccountAuth();
  const projectId = encodeURIComponent(getFirebaseProjectId());
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/admins/${encodeURIComponent(auth.uid)}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${auth.idToken}` },
  });

  if (response.status === 404) return { isAdmin: false, signedIn: true, uid: auth.uid };
  const data = await readResponseJson(response);
  if (!response.ok) {
    throw new Error(`Role check failed: ${firestoreErrorMessage(data, response)}`);
  }
  return { isAdmin: true, signedIn: true, uid: auth.uid };
}

function getFirebaseProjectId() {
  const config = getFirebaseConfig();
  const projectId = String(config.projectId || '').trim();
  if (!projectId) {
    throw new Error('Missing Firebase projectId. Paste your Firebase Web App config into firebaseConfig.js.');
  }
  return projectId;
}

function getFirestoreMessagesUrl(videoId) {
  const projectId = encodeURIComponent(getFirebaseProjectId());
  const safeVideoId = encodeURIComponent(requireVideoId(videoId));
  return `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/videos/${safeVideoId}/messages`;
}

function requireVideoId(videoId) {
  const value = String(videoId || '').trim();
  if (!value) throw new Error('Missing videoId');
  return value;
}

function toIsoTimestamp(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString();
}

function toFirestoreNumberValue(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error('Invalid videoTime');
  return Number.isInteger(number)
    ? { integerValue: String(number) }
    : { doubleValue: number };
}

function toFirestoreValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') return toFirestoreNumberValue(value);
  if (typeof value === 'string') return { stringValue: value };
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(item => toFirestoreValue(item)) } };
  }
  if (typeof value === 'object') {
    const fields = {};
    for (const [key, childValue] of Object.entries(value)) {
      if (childValue === undefined) continue;
      fields[key] = toFirestoreValue(childValue);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(value) };
}

function fromFirestoreValue(value) {
  if (!value || typeof value !== 'object') return undefined;
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('booleanValue' in value) return Boolean(value.booleanValue);
  if ('timestampValue' in value) return value.timestampValue;
  if ('nullValue' in value) return null;
  if ('arrayValue' in value) {
    return (value.arrayValue.values || []).map(item => fromFirestoreValue(item));
  }
  if ('mapValue' in value) {
    const output = {};
    const fields = value.mapValue.fields || {};
    for (const [key, childValue] of Object.entries(fields)) {
      output[key] = fromFirestoreValue(childValue);
    }
    return output;
  }
  return undefined;
}

function firestoreDocumentId(documentName = '') {
  return String(documentName).split('/').pop() || '';
}

function buildFirestoreMessageFields(videoId, message, firebaseUid, fallbackDisplayName = '') {
  const text = String(message?.text || '').trim();
  if (!text) throw new Error('Missing message text');

  const rawVideoTime = message?.videoTime ?? message?.time;
  const videoTime = Number(rawVideoTime);
  if (!Number.isFinite(videoTime)) throw new Error('Missing videoTime');

  const displayName = String(message?.displayName || message?.user || fallbackDisplayName || 'Anonymous').trim() || 'Anonymous';
  const createdAt = toIsoTimestamp(message?.createdAt || message?.created_at);
  const fields = {
    videoId: { stringValue: requireVideoId(videoId) },
    text: { stringValue: text },
    videoTime: toFirestoreNumberValue(videoTime),
    createdAt: { timestampValue: createdAt },
    userId: { stringValue: String(firebaseUid || '') },
    displayName: { stringValue: displayName },
    status: { stringValue: 'visible' },
  };

  if (message?.id) fields.clientMessageId = { stringValue: String(message.id) };
  if (message?.color) fields.color = { stringValue: String(message.color) };
  if (message?.badge) fields.badge = { stringValue: String(message.badge) };
  if (message?.accountCreatedAt) fields.accountCreatedAt = { timestampValue: toIsoTimestamp(message.accountCreatedAt) };
  if (message?.replyTo) fields.replyTo = toFirestoreValue(message.replyTo);

  return fields;
}

function firestoreDocumentToMessage(document) {
  const fields = document?.fields || {};
  const firestoreId = firestoreDocumentId(document?.name);
  const clientMessageId = String(fromFirestoreValue(fields.clientMessageId) || '');
  const videoTime = Number(fromFirestoreValue(fields.videoTime) ?? 0);
  const displayName = String(fromFirestoreValue(fields.displayName) || 'Unknown user');
  const createdAt = String(fromFirestoreValue(fields.createdAt) || '');
  const status = String(fromFirestoreValue(fields.status) || 'visible');
  const message = {
    id: clientMessageId || firestoreId,
    firestoreId,
    videoId: String(fromFirestoreValue(fields.videoId) || ''),
    text: String(fromFirestoreValue(fields.text) || ''),
    time: Number.isFinite(videoTime) ? videoTime : 0,
    videoTime: Number.isFinite(videoTime) ? videoTime : 0,
    created_at: createdAt,
    createdAt,
    userId: String(fromFirestoreValue(fields.userId) || ''),
    user: displayName,
    displayName,
    status,
  };

  const badge = fromFirestoreValue(fields.badge);
  const color = fromFirestoreValue(fields.color);
  const accountCreatedAt = fromFirestoreValue(fields.accountCreatedAt);
  const replyTo = fromFirestoreValue(fields.replyTo);
  if (badge) message.badge = String(badge);
  if (color) message.color = String(color);
  if (accountCreatedAt) message.accountCreatedAt = accountCreatedAt;
  if (replyTo) message.replyTo = replyTo;
  return message;
}

function upsertBackgroundMessage(videoId, message) {
  if (!message) return;
  const messages = getVideoMessages(videoId);
  const messageId = String(message.id || message.clientMessageId || message.firestoreId || '');
  const existingIndex = messageId
    ? messages.findIndex(existing =>
      messageId === String(existing?.id || existing?.clientMessageId || existing?.firestoreId || ''))
    : -1;

  if (existingIndex >= 0) messages[existingIndex] = { ...messages[existingIndex], ...message };
  else messages.push(message);
  sortMessagesInPlace(messages);
}

async function readResponseJson(response) {
  try {
    return await response.json();
  } catch (error) {
    return {};
  }
}

function firestoreErrorMessage(data, response) {
  return data?.error?.message || data?.error?.status || `HTTP ${response.status}`;
}

async function saveMessageToFirestore(videoId, message) {
  const auth = await ensureAccountAuth();
  const fields = buildFirestoreMessageFields(videoId, message, auth.uid, auth.displayName);
  const response = await fetch(getFirestoreMessagesUrl(videoId), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${auth.idToken}`,
    },
    body: JSON.stringify({ fields }),
  });
  const data = await readResponseJson(response);

  if (!response.ok) {
    throw new Error(`Firestore save failed: ${firestoreErrorMessage(data, response)}`);
  }

  const savedMessage = firestoreDocumentToMessage(data);
  upsertBackgroundMessage(videoId, savedMessage);
  return savedMessage;
}

async function loadMessagesFromFirestore(videoId) {
  const auth = await ensureReadAuth();
  const messages = [];
  let pageToken = '';

  do {
    const url = new URL(getFirestoreMessagesUrl(videoId));
    url.searchParams.set('pageSize', '300');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: { Authorization: `Bearer ${auth.idToken}` },
    });
    const data = await readResponseJson(response);

    if (!response.ok) {
      throw new Error(`Firestore load failed: ${firestoreErrorMessage(data, response)}`);
    }

    const pageMessages = (data.documents || [])
      .map(document => firestoreDocumentToMessage(document))
      .filter(message => message.status === 'visible');
    messages.push(...pageMessages);
    pageToken = String(data.nextPageToken || '');
  } while (pageToken);

  sortMessagesInPlace(messages);
  backgroundMessagesByVideo.set(requireVideoId(videoId), messages.slice());
  return messages;
}

function getVideoMessages(videoId) {
  const key = normalizeVideoId(videoId);
  if (!backgroundMessagesByVideo.has(key)) backgroundMessagesByVideo.set(key, []);
  return backgroundMessagesByVideo.get(key);
}

function sortMessagesInPlace(messages) {
  messages.sort((first, second) => {
    const firstTime = Number(first?.videoTime ?? first?.time ?? 0);
    const secondTime = Number(second?.videoTime ?? second?.time ?? 0);
    if (firstTime !== secondTime) return firstTime - secondTime;
    return Number(first?._seq || 0) - Number(second?._seq || 0);
  });
}

function getRequestAction(request) {
  return request?.type || request?.action || '';
}

async function handleLyveMessage(request) {
  const payload = request?.payload || {};
  const videoId = normalizeVideoId(payload.videoId);
  const action = getRequestAction(request);

  switch (action) {
    case 'LYVE_AUTH_INIT': {
      try {
        const auth = await ensureFirebaseAuth();
        return {
          ok: true,
          action,
          uid: auth.uid,
          hasToken: Boolean(auth.idToken),
          expiresAt: auth.expiresAt,
        };
      } catch (error) {
        return {
          ok: false,
          action,
          error: error?.message || String(error),
        };
      }
    }

    case 'LYVE_AUTH_SIGNUP': {
      try {
        const auth = await signUpWithEmailPassword(payload.email, payload.password, payload.username);
        return { ok: true, action, signedIn: true, uid: auth.uid, email: auth.email, displayName: auth.displayName };
      } catch (error) {
        return { ok: false, action, error: error?.message || String(error) };
      }
    }

    case 'LYVE_AUTH_SIGNIN': {
      try {
        const auth = await signInWithEmailPassword(payload.email, payload.password);
        return { ok: true, action, signedIn: true, uid: auth.uid, email: auth.email, displayName: auth.displayName };
      } catch (error) {
        return { ok: false, action, error: error?.message || String(error) };
      }
    }

    case 'LYVE_AUTH_SIGNOUT': {
      try {
        await clearStoredAccountAuth();
        return { ok: true, action, signedIn: false };
      } catch (error) {
        return { ok: false, action, error: error?.message || String(error) };
      }
    }

    case 'LYVE_AUTH_STATE': {
      try {
        const state = await getAccountState();
        return { ok: true, action, ...state };
      } catch (error) {
        return { ok: false, action, error: error?.message || String(error) };
      }
    }

    case 'LYVE_AUTH_RESET_PASSWORD': {
      try {
        const result = await sendPasswordResetEmail(payload.email);
        return { ok: true, action, email: result.email };
      } catch (error) {
        return { ok: false, action, error: error?.message || String(error) };
      }
    }

    case 'LYVE_GET_ROLE': {
      try {
        const role = await checkAdminRole();
        return { ok: true, action, ...role };
      } catch (error) {
        return { ok: false, action, isAdmin: false, error: error?.message || String(error) };
      }
    }

    case 'LYVE_LOAD_MESSAGES': {
      try {
        const loadedMessages = await loadMessagesFromFirestore(payload.videoId);
        return {
          ok: true,
          action,
          videoId: requireVideoId(payload.videoId),
          messages: loadedMessages,
          source: 'firestore',
        };
      } catch (error) {
        return {
          ok: false,
          action,
          videoId,
          error: error?.message || String(error),
        };
      }
    }

    case 'LYVE_SAVE_MESSAGE': {
      try {
        const message = payload.message || null;
        if (!message) return { ok: false, action, error: 'Missing message' };
        const savedMessage = await saveMessageToFirestore(payload.videoId, message);
        return {
          ok: true,
          action,
          videoId: requireVideoId(payload.videoId),
          message: savedMessage,
        };
      } catch (error) {
        return {
          ok: false,
          action,
          videoId,
          error: error?.message || String(error),
        };
      }
    }

    case 'LYVE_SUBSCRIBE_VIDEO_MESSAGES':
      return {
        ok: true,
        action,
        videoId,
        subscribed: false,
        note: 'Placeholder only. Real-time backend subscription will be added in the Firebase step.',
      };

    case 'LYVE_CLEAR_MESSAGES':
      backgroundMessagesByVideo.set(videoId, []);
      return { ok: true, action, videoId };

    default:
      return { ok: false, action, error: `Unknown Lyve action: ${action || 'missing'}` };
  }
}

function isLyveRequest(request) {
  if (request?.source === 'lyve-message-store') return true;
  const action = getRequestAction(request);
  return typeof action === 'string' && action.startsWith('LYVE_');
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!isLyveRequest(request)) return false;

  const action = getRequestAction(request);

  handleLyveMessage(request)
    .then(sendResponse)
    .catch(error => {
      sendResponse({
        ok: false,
        action,
        error: error?.message || String(error),
      });
    });
  return true; // Keep the message channel open for the async sendResponse.
});
