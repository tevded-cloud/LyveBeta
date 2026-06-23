# Lyve

Lyve adds a live-style, time-synced chat to YouTube videos. Messages are anchored to the exact
moment in the video they were posted, so chat unfolds in sync with playback — and rewinding hides
future messages, just like a live-stream replay.

> Lyve is an independent third-party extension and is not affiliated with, endorsed by, or
> sponsored by YouTube or Google LLC.

---

## Features

- Time-synced chat that follows the video timeline (rewind hides future messages)
- Free accounts (email/password) — sign in to post; viewing is read-only
- Personal display name, username color, and chat badges
- 7TV emote support
- Draggable, lockable chat panel with an in-video overlay mode
- Real-time-style sync so others on the same video see new messages

---

## Browser support

| Browser | Supported | How |
|---|---|---|
| Chrome | ✅ | Chrome Web Store (or load unpacked) |
| Brave / Edge / Opera / Vivaldi | ✅ | Install the Chrome build (Chromium engine) |
| Firefox | ✅ | Load as a temporary add-on, or via AMO once published |
| Safari | ❌ | Not supported — Safari needs a separate native (Xcode) build |

---

## Installation

### Chrome, Brave, Edge, Opera, Vivaldi (Chromium)

**From the store (recommended once published):**
1. Open the Lyve listing on the Chrome Web Store: _link coming once review completes_.
2. Click **Add to Chrome / Add to Brave** and confirm.
3. Open a YouTube video — the Lyve panel appears.

**Manual / development install (load unpacked):**
1. Download or clone this repository.
2. Go to `chrome://extensions` (or `brave://extensions`, `edge://extensions`).
3. Enable **Developer mode** (top-right).
4. Click **Load unpacked** and select the project folder.
5. Open a YouTube video.

### Firefox

Firefox uses the same source via a temporary add-on (until published on AMO):
1. Go to **`about:debugging`** → **This Firefox**.
2. Click **Load Temporary Add-on…**
3. Navigate into the project folder and select **`manifest.json`**.
4. Open a YouTube video.

> Temporary add-ons are removed when Firefox restarts; reload it the same way next session.
> A permanent AMO listing will be published separately.

### Safari

Not supported. Safari requires a separate Safari Web Extension build (Xcode + Apple Developer
account + App Store), which is not part of this repository.

---

## Using Lyve

1. Open any YouTube video.
2. Click the **gear → Account** in the Lyve panel and **create an account** or **sign in**.
3. Post messages — they appear instantly and sync to others watching the same video.
4. During private beta, posting requires an approved account.

---

## Backend setup (self-hosting your own instance)

Lyve uses Firebase Authentication + Cloud Firestore via REST (no SDK bundled).

1. Create a Firebase project and a Web App; copy its config into **`firebaseConfig.js`**.
2. In Firebase Console → **Authentication → Sign-in method**, enable **Email/Password**.
3. In **Firestore Database → Rules**, publish rules that gate messages on an approved-users
   collection (`betaUsers/{uid}`) and validate message fields. See the project notes for the
   exact ruleset.
4. Approve a user by creating a document at `betaUsers/{uid}` (and `admins/{uid}` for moderation).

---

## Development

```
manifest.json        Extension manifest (cross-browser: Chromium + Firefox)
background.js         Firebase Auth + Firestore REST bridge (service worker / background script)
content.js           Injects the chat overlay into YouTube watch pages
firebaseConfig.js    Firebase Web App config
popup.html/js/css    Toolbar popup (show/hide, open settings)
styles.css           Chat panel styles
modules/             Chat panel, rendering, emotes, message store, settings
assets/              Icons
```

- After editing, reload the extension (`chrome://extensions` reload, or `about:debugging` →
  Reload) and refresh the YouTube tab.
- Background logs: Chrome → service-worker console; Firefox → **Inspect** in `about:debugging`.

---

## Privacy & third-party notices

- Privacy policy: https://github.com/tevded-cloud/tevded.github.io/blob/main/privacy.md
- Third-party attributions: see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)

---

© 2026 TevDed
