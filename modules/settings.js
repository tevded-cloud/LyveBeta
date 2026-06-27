// NEW helpers — settings persistence
import { SevenTV, DEFAULT_7TV_SOURCE } from "./emotes.js";
import { getUsernameRejection } from "./usernameFilter.js";

function getSetting(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    if (v === null || v === undefined) return fallback;
    if (v === 'true') return true;
    if (v === 'false') return false;
    return v;
  } catch {
    return fallback;
  }
}
function setSetting(key, value) {
  try { localStorage.setItem(key, String(value)); } catch {}
}

// NEW: minimal, scoped CSS for the settings popover
function injectSettingsStyles() {
  if (document.getElementById('chat-settings-styles')) return;
  const style = document.createElement('style');
  style.id = 'chat-settings-styles';
  style.textContent = `
    #chat-settings-popup {
      position: fixed; /* not clipped by the panel */
      background: #1a1a1a; color: #fff;
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 10px; padding: 10px;
      min-width: 300px; max-width: 360px;
      z-index: 2147483647; display: none;
      box-shadow: 0 10px 30px rgba(0,0,0,.45);
    }
    #chat-settings-popup .group { margin: 8px 0; }

    /* Collapsible sections */
    #chat-settings-popup details.sect {
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 8px; padding: 6px 8px; margin: 8px 0; background: #151515;
    }
    #chat-settings-popup details.sect > summary {
      list-style: none; cursor: pointer; user-select: none; font-weight: 600; padding: 4px 2px; outline: none;
    }
    #chat-settings-popup details.sect > summary::-webkit-details-marker { display: none; }
    #chat-settings-popup details.sect > summary::after { content: '▸'; float: right; opacity: .6; transform: translateY(-1px); }
    #chat-settings-popup details.sect[open] > summary::after { content: '▾'; }

    /* Inputs */
    #chat-settings-popup input[type="text"], #chat-settings-popup select {
  width: 100%; background: #121212; color: #fff;
  border: 1px solid rgba(255,255,255,0.12); border-radius: 6px; padding: 4px 8px;
  font-size: 13px; height: 28px; line-height: 20px; box-sizing: border-box;
}
    #chat-settings-popup .row { display: flex; align-items: center; gap: 8px; }
    #chat-settings-popup .radios label { margin-right: 10px; }

    /* Help tooltip (JS-controlled .show) */
    .help-wrap { position: relative; display: flex; align-items: center; gap: 8px; }
    .help-icon {
      display: inline-flex; align-items: center; justify-content: center;
      width: 18px; height: 18px; border-radius: 50%;
      border: 1px solid rgba(255,255,255,0.2);
      font-size: 12px; cursor: default; opacity: .9; background: #202020;
    }
    .help-tooltip {
      position: fixed; /* independent of panel bounds */
      background: #0f0f0f; color: #fff;
      border: 1px solid rgba(255,255,255,0.12);
      padding: 8px 10px; border-radius: 8px; width: 260px;
      opacity: 0; visibility: hidden; transition: opacity .12s ease-in-out, visibility .12s;
      z-index: 100001; pointer-events: none; font-size: 12px; line-height: 1.35;
    }
    .help-tooltip.show { opacity: 1; visibility: visible; }

    /* Save button */
    #chat-settings-popup .save {
      width: 100%; background: #e53935; color: #fff; border: none;
      border-radius: 8px; padding: 8px 10px; cursor: pointer; font-weight: 600; margin-top: 6px;
    }

    /* Refreshed tabbed settings UI */
    #chat-settings-popup.settings-v2 {
      --settings-accent:#ef3d38;
      width:min(390px,calc(100vw - 20px)); min-width:0; max-width:none;
      max-height:calc(100vh - 20px); padding:0; overflow:hidden; box-sizing:border-box;
      background:#191919; border:1px solid rgba(255,255,255,.12); border-radius:16px;
      box-shadow:0 22px 60px rgba(0,0,0,.58),0 2px 8px rgba(0,0,0,.35);
      font-family:Roboto,Arial,sans-serif; font-size:13px;
    }
    #chat-settings-popup.settings-v2 *{box-sizing:border-box}
    #chat-settings-popup.settings-v2 button,
    #chat-settings-popup.settings-v2 input,
    #chat-settings-popup.settings-v2 select{font:inherit}
    #chat-settings-popup .settings-header{
      display:flex; align-items:center; justify-content:space-between; padding:16px 16px 12px;
    }
    #chat-settings-popup .settings-title{font-size:16px;line-height:20px;font-weight:700}
    #chat-settings-popup .settings-subtitle{margin-top:2px;color:#969696;font-size:11px}
    #chat-settings-popup .settings-close{
      display:grid;place-items:center;width:30px;height:30px;padding:0;color:#aaa;
      background:transparent;border:0;border-radius:8px;cursor:pointer
    }
    #chat-settings-popup .settings-close:hover{color:#fff;background:rgba(255,255,255,.08)}
    #chat-settings-popup .settings-close svg{width:17px;height:17px}
    #chat-settings-popup .settings-tabs{
      display:grid;grid-template-columns:repeat(3,1fr);gap:3px;margin:0 14px;padding:4px;
      background:#101010;border:1px solid rgba(255,255,255,.07);border-radius:11px
    }
    #chat-settings-popup .settings-tab{
      display:flex;align-items:center;justify-content:center;gap:6px;min-width:0;height:34px;padding:0 8px;
      color:#8f8f8f;background:transparent;border:0;border-radius:8px;cursor:pointer;
      font-size:12px;font-weight:600;transition:color .14s ease,background .14s ease,box-shadow .14s ease
    }
    #chat-settings-popup .settings-tab:hover{color:#d8d8d8}
    #chat-settings-popup .settings-tab[aria-selected="true"]{
      color:#fff;background:#292929;box-shadow:0 1px 4px rgba(0,0,0,.35)
    }
    #chat-settings-popup .settings-tab svg{width:15px;height:15px;flex:0 0 auto}
    #chat-settings-popup .settings-content{
      min-height:278px;max-height:calc(100vh - 180px);overflow-y:auto;overscroll-behavior:contain;
      padding:14px;scrollbar-width:thin;scrollbar-color:#454545 transparent
    }
    #chat-settings-popup .settings-panel{display:none}
    #chat-settings-popup .settings-panel.active{display:block;animation:settings-in .13s ease-out}
    @keyframes settings-in{from{opacity:0;transform:translateY(2px)}to{opacity:1;transform:none}}
    #chat-settings-popup .settings-card{
      padding:13px;background:#141414;border:1px solid rgba(255,255,255,.075);border-radius:12px
    }
    #chat-settings-popup details.settings-card{
      padding:0;overflow:hidden
    }
    #chat-settings-popup .settings-card+.settings-card{margin-top:10px}
    #chat-settings-popup .settings-card-summary{
      display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 13px;
      cursor:pointer;list-style:none;user-select:none
    }
    #chat-settings-popup .settings-card-summary::-webkit-details-marker{display:none}
    #chat-settings-popup .settings-card-summary-copy{min-width:0}
    #chat-settings-popup .settings-card-summary .card-title{margin:0}
    #chat-settings-popup .settings-card-summary .card-copy{margin-top:2px}
    #chat-settings-popup .settings-card-chevron{
      display:grid;place-items:center;flex:0 0 22px;width:22px;height:22px;border-radius:7px;
      color:#8c8c8c;background:rgba(255,255,255,.04);transition:transform .14s ease,color .14s ease,background .14s ease
    }
    #chat-settings-popup .settings-card-summary:hover .settings-card-chevron{color:#fff;background:rgba(255,255,255,.08)}
    #chat-settings-popup details.settings-card[open] .settings-card-chevron{transform:rotate(180deg)}
    #chat-settings-popup .settings-card-body{padding:0 13px 13px}
    #chat-settings-popup details.settings-card[open] .settings-card-summary{border-bottom:1px solid rgba(255,255,255,.065);margin-bottom:12px}
    #chat-settings-popup .card-title{margin:0 0 3px;color:#f0f0f0;font-size:13px;font-weight:650}
    #chat-settings-popup .card-copy{margin:0;color:#888;font-size:11px;line-height:1.45}
    #chat-settings-popup .field{margin-top:13px}
    #chat-settings-popup .field:first-child{margin-top:0}
    #chat-settings-popup .field-label{display:block;margin-bottom:6px;color:#d4d4d4;font-size:11px;font-weight:600}
    #chat-settings-popup .field-hint{display:block;margin-top:6px;color:#727272;font-size:10px;line-height:1.4}
    #chat-settings-popup.settings-v2 input[type="text"],
    #chat-settings-popup.settings-v2 select{
      width:100%;height:40px;padding:0 11px;color:#f5f5f5;background:#0e0e0e;
      border:1px solid rgba(255,255,255,.11);border-radius:9px;outline:none;
      transition:border-color .14s ease,box-shadow .14s ease
    }
    #chat-settings-popup.settings-v2 input[type="text"]:focus,
    #chat-settings-popup.settings-v2 select:focus{
      border-color:rgba(239,61,56,.8);box-shadow:0 0 0 3px rgba(239,61,56,.13)
    }
    #chat-settings-popup.settings-v2 input:disabled{color:#666;cursor:not-allowed}
    #chat-settings-popup.settings-v2 select{cursor:pointer;color-scheme:dark}
    #chat-settings-popup .profile-preview{
      display:flex;align-items:center;gap:11px;margin-bottom:14px;padding-bottom:13px;
      border-bottom:1px solid rgba(255,255,255,.07)
    }
    #chat-settings-popup .profile-avatar{
      display:grid;place-items:center;flex:0 0 38px;width:38px;height:38px;border-radius:11px;
      color:#fff;font-size:15px;font-weight:800;box-shadow:inset 0 0 0 1px rgba(255,255,255,.15)
    }
    #chat-settings-popup .profile-copy{min-width:0}
    #chat-settings-popup .profile-name{display:block;overflow:hidden;color:#fff;font-size:13px;font-weight:700;text-overflow:ellipsis;white-space:nowrap}
    #chat-settings-popup .profile-role{display:block;margin-top:2px;color:#7f7f7f;font-size:10px}
    #chat-settings-popup .account-readonly-grid{display:grid;gap:7px}
    #chat-settings-popup .account-readonly-item{
      display:grid;grid-template-columns:82px minmax(0,1fr);gap:2px 9px;align-items:center;
      padding:8px 9px;background:#101010;border:1px solid rgba(255,255,255,.07);border-radius:9px
    }
    #chat-settings-popup .account-readonly-item span{color:#7a7a7a;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.04em}
    #chat-settings-popup .account-readonly-item strong{min-width:0;overflow:hidden;color:#e8e8e8;font-size:12px;text-overflow:ellipsis;white-space:nowrap}
    #chat-settings-popup .account-readonly-item em{grid-column:2;color:#666;font-size:10px;font-style:normal;line-height:1.3}
    #chat-settings-popup .chat-preferences-card .setting-row:first-of-type{margin-top:11px;padding-top:11px;border-top:1px solid rgba(255,255,255,.07)}
    #chat-settings-popup .color-control{
      display:flex;align-items:center;gap:9px;height:40px;padding:5px 8px;background:#0e0e0e;
      border:1px solid rgba(255,255,255,.11);border-radius:9px
    }
    #chat-settings-popup.settings-v2 input[type="color"]{
      width:30px;height:28px;padding:0;overflow:hidden;background:transparent;border:0;border-radius:7px;cursor:pointer
    }
    #chat-settings-popup input[type="color"]::-webkit-color-swatch-wrapper{padding:0}
    #chat-settings-popup input[type="color"]::-webkit-color-swatch{border:0;border-radius:6px}
    #chat-settings-popup .color-value{color:#aaa;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;text-transform:uppercase}
    #chat-settings-popup .color-palette{display:grid;grid-template-columns:repeat(6,1fr);gap:8px;margin-bottom:9px}
    #chat-settings-popup .color-swatch{width:100%}
    #chat-settings-popup .color-swatch{width:24px;height:24px;padding:0;border:2px solid transparent;border-radius:7px;cursor:pointer;box-shadow:inset 0 0 0 1px rgba(255,255,255,.18);transition:transform .1s ease}
    #chat-settings-popup .color-swatch:hover{transform:scale(1.1)}
    #chat-settings-popup .color-swatch.selected{border-color:#fff;box-shadow:0 0 0 2px rgba(239,61,56,.65)}
    #chat-settings-popup .segmented{
      display:grid;grid-template-columns:1fr 1fr;gap:5px;padding:4px;background:#0e0e0e;
      border:1px solid rgba(255,255,255,.08);border-radius:10px
    }
    #chat-settings-popup .segment-choice{cursor:pointer}
    #chat-settings-popup .segment-choice input{position:absolute;opacity:0;pointer-events:none}
    #chat-settings-popup .segment-choice span{
      display:flex;align-items:center;justify-content:center;gap:6px;height:32px;color:#8d8d8d;
      border-radius:7px;font-size:11px;font-weight:600
    }
    #chat-settings-popup .segment-choice span svg{width:14px;height:14px}
    #chat-settings-popup .segment-choice input:checked+span{
      color:#fff;background:#2a2a2a;box-shadow:0 1px 4px rgba(0,0,0,.3)
    }
    #chat-settings-popup .setting-row{display:flex;align-items:center;justify-content:space-between;gap:16px}
    #chat-settings-popup .setting-row+.setting-row{margin-top:13px;padding-top:13px;border-top:1px solid rgba(255,255,255,.07)}
    #chat-settings-popup .setting-row-copy{min-width:0}
    #chat-settings-popup .setting-row-title{display:block;color:#dedede;font-size:12px;font-weight:600}
    #chat-settings-popup .setting-row-note{display:block;margin-top:3px;color:#777;font-size:10px;line-height:1.35}
    #chat-settings-popup .switch{position:relative;flex:0 0 36px;width:36px;height:21px;cursor:pointer}
    #chat-settings-popup .switch input{position:absolute;opacity:0;pointer-events:none}
    #chat-settings-popup .switch-track{position:absolute;inset:0;background:#373737;border-radius:999px;transition:background .16s ease}
    #chat-settings-popup .switch-track::after{
      content:'';position:absolute;width:15px;height:15px;left:3px;top:3px;background:#d7d7d7;
      border-radius:50%;box-shadow:0 1px 3px rgba(0,0,0,.45);transition:transform .16s ease,background .16s ease
    }
    #chat-settings-popup .switch input:checked+.switch-track{background:var(--settings-accent)}
    #chat-settings-popup .switch input:checked+.switch-track::after{transform:translateX(15px);background:#fff}
    #chat-settings-popup .emote-heading{display:flex;align-items:center;gap:11px;margin-bottom:14px}
    #chat-settings-popup .emote-mark{
      display:grid;place-items:center;flex:0 0 38px;width:38px;height:38px;color:#fff;
      background:linear-gradient(135deg,#7c4dff,#4f7cff);border-radius:11px;font-size:12px;font-weight:900
    }
    #chat-settings-popup.settings-v2 .help-wrap{position:relative;display:flex;align-items:center;gap:7px}
    #chat-settings-popup.settings-v2 .help-icon{
      display:grid;place-items:center;flex:0 0 30px;width:30px;height:30px;padding:0;color:#999;
      background:#242424;border:1px solid rgba(255,255,255,.1);border-radius:8px;cursor:help;font-size:11px;font-weight:700
    }
    #chat-settings-popup .help-icon:hover,#chat-settings-popup .help-icon:focus{color:#fff;background:#303030;outline:none}
    #chat-settings-popup.settings-v2 .help-tooltip{
      width:270px;padding:10px 11px;color:#e9e9e9;background:#0f0f0f;border:1px solid rgba(255,255,255,.12);
      border-radius:10px;box-shadow:0 12px 30px rgba(0,0,0,.5);font-size:11px;line-height:1.5
    }
    #chat-settings-popup .help-tooltip code{color:#c9b8ff}
    #chat-settings-popup .settings-footer{
      display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 14px 14px;
      border-top:1px solid rgba(255,255,255,.07);background:#171717
    }
    #chat-settings-popup .footer-note{color:#6f6f6f;font-size:10px;line-height:1.3}
    #chat-settings-popup.settings-v2 .save{
      flex:0 0 auto;width:auto;min-width:118px;height:36px;margin:0;padding:0 15px;color:#fff;
      background:var(--settings-accent);border:0;border-radius:9px;cursor:pointer;font-size:12px;font-weight:700;
      box-shadow:0 4px 12px rgba(239,61,56,.2);transition:filter .14s ease,transform .08s ease
    }
    #chat-settings-popup.settings-v2 .save:hover{filter:brightness(1.08)}
    #chat-settings-popup.settings-v2 .save:active{transform:translateY(1px)}
  `;
  document.head.appendChild(style);
}

function createSettingsUI(panel, header) {
  injectSettingsStyles();

  const gearBtn = document.createElement('button');
  gearBtn.id = 'chat-gear-btn';
  gearBtn.title = 'Settings';
  gearBtn.setAttribute('aria-label', 'Open chat settings');
  gearBtn.style.background = 'none';
  gearBtn.style.border = 'none';
  gearBtn.style.color = '#b8b8b8';
  gearBtn.style.cursor = 'pointer';
  gearBtn.style.fontSize = '0';
  gearBtn.style.marginRight = '4px';
  gearBtn.textContent = '⚙️';

  gearBtn.style.display = 'grid';
  gearBtn.style.placeItems = 'center';
  gearBtn.style.width = '28px';
  gearBtn.style.height = '28px';
  gearBtn.style.padding = '0';
  gearBtn.style.borderRadius = '7px';
  gearBtn.innerHTML = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 00-1.88-.34 1.7 1.7 0 00-1.03 1.56V21h-4v-.08A1.7 1.7 0 009 19.37a1.7 1.7 0 00-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 004.63 15 1.7 1.7 0 003.08 14H3v-4h.08A1.7 1.7 0 004.63 9a1.7 1.7 0 00-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 009 4.63a1.7 1.7 0 001-1.55V3h4v.08a1.7 1.7 0 001.03 1.55 1.7 1.7 0 001.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0019.37 9c.25.61.85 1 1.55 1H21v4h-.08a1.7 1.7 0 00-1.52 1z"/></svg>`;
  gearBtn.addEventListener('mouseenter', () => {
    gearBtn.style.color = '#fff';
    gearBtn.style.background = 'rgba(255,255,255,.08)';
  });
  gearBtn.addEventListener('mouseleave', () => {
    gearBtn.style.color = '#b8b8b8';
    gearBtn.style.background = 'none';
  });

  // Fixed popup appended to body (can overflow panel safely)
  const popup = document.createElement('div');
  popup.id = 'chat-settings-popup';

  const escapeAttr = (value) => String(value).replace(/[&"'<>]/g, ch => ({
    '&': '&amp;', '"': '&quot;', "'": '&#39;', '<': '&lt;', '>': '&gt;'
  })[ch]);
  const rawDispName = String(getSetting('chatDisplayName', 'You') || 'You');
  const dispName = escapeAttr(rawDispName);
  const profileInitial = escapeAttr(Array.from(rawDispName.trim())[0]?.toUpperCase() || 'Y');
  const accountId = getOrCreateUserId();
  const accountShort = escapeAttr(`${accountId.slice(0, 8)}…${accountId.slice(-4)}`);
  const accountCreatedLabel = escapeAttr(new Date(getOrCreateAccountCreatedAt()).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric'
  }));
  const storedColor = String(getSetting('chatUserColor', '#3a6ff7'));
  const userColor = /^#[0-9a-f]{6}$/i.test(storedColor) ? storedColor : '#3a6ff7';
  const dock     = getSetting('chatDefaultDock', 'br');
  const showTS   = getSetting('chatShowTimestamps', true);
  const maxLen   = String(getSetting('chatMaxLen', 'unlimited') || 'unlimited');
  const profanityFilter = String(getSetting('chatProfanityFilter', 'off') || 'off');
  const protectTyping = getSetting('chatProtectTypingShortcuts', true) === true;
  const blockNumberSeeking = getSetting('chatBlockYouTubeNumberHotkeys', true) === true;
  const displayMode = String(getSetting('chatDisplayMode', 'window') || 'window');
  const overlayFade = String(getSetting('chatOverlayFadeSeconds', '10') || '10');
  const overlayHeight = String(getSetting('chatOverlayHeight', '360') || '360');
  const overlayCorner = String(getSetting('chatOverlayCorner', dock === 'tr' ? 'tr' : 'br') || 'br');
  const rawEn7   = getSetting('chatEnable7tv', true);
  const enable7  = (rawEn7 === true || rawEn7 === 'true');
  const src7     = escapeAttr(String(getSetting('chat7tvSource', typeof DEFAULT_7TV_SOURCE !== 'undefined' ? DEFAULT_7TV_SOURCE : '') || ''));

  popup.className = 'settings-v2';
  popup.innerHTML = `
    <div class="settings-header">
      <div>
        <div class="settings-title">Chat settings</div>
        <div class="settings-subtitle">Make Lyve feel like yours</div>
      </div>
      <button type="button" class="settings-close" aria-label="Close settings" title="Close">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18"/>
        </svg>
      </button>
    </div>

    <div class="settings-tabs" role="tablist" aria-label="Settings sections">
      <button type="button" class="settings-tab" id="settings-tab-profile" role="tab" data-tab="profile" aria-controls="settings-panel-profile" aria-selected="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4.5 21a7.5 7.5 0 0115 0"/></svg>
        <span>Account</span>
      </button>
      <button type="button" class="settings-tab" id="settings-tab-chat" role="tab" data-tab="chat" aria-controls="settings-panel-chat" aria-selected="false" tabindex="-1">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 15a4 4 0 01-4 4H8l-5 3V7a4 4 0 014-4h10a4 4 0 014 4z"/></svg>
        <span>Chat</span>
      </button>
      <button type="button" class="settings-tab" id="settings-tab-emotes" role="tab" data-tab="emotes" aria-controls="settings-panel-emotes" aria-selected="false" tabindex="-1">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 14s1.4 2 4 2 4-2 4-2M9 9h.01M15 9h.01"/></svg>
        <span>Emotes</span>
      </button>
    </div>

    <div class="settings-content">
      <section class="settings-panel active" id="settings-panel-profile" role="tabpanel" aria-labelledby="settings-tab-profile" data-panel="profile">
        <div class="settings-card account-auth-card">
          <div class="card-title">Account</div>
          <p class="card-copy">Sign in to post messages. Viewing chat doesn't require an account.</p>

          <div id="auth-signed-out" class="auth-view">
            <button type="button" class="save" id="auth-google" style="width:100%;background:#fff;color:#1a1a1a;margin-bottom:10px">Continue with Google</button>
            <div class="field-hint" style="text-align:center;margin:0 0 10px">or use email</div>
            <div class="field">
              <div class="segmented" role="radiogroup" aria-label="Account mode">
                <label class="segment-choice">
                  <input type="radio" name="auth-mode" value="signin" checked />
                  <span>Sign in</span>
                </label>
                <label class="segment-choice">
                  <input type="radio" name="auth-mode" value="signup" />
                  <span>Create account</span>
                </label>
              </div>
            </div>
            <div class="field" id="auth-username-field" hidden>
              <label class="field-label" for="auth-username">Username</label>
              <input id="auth-username" type="text" autocomplete="username" placeholder="Shown on your messages" />
            </div>
            <div class="field">
              <label class="field-label" for="auth-email">Email</label>
              <input id="auth-email" type="text" autocomplete="email" placeholder="you@example.com" />
            </div>
            <div class="field">
              <label class="field-label" for="auth-password">Password</label>
              <input id="auth-password" type="password" autocomplete="current-password" placeholder="At least 6 characters" />
            </div>
            <div class="field">
              <button type="button" class="save" id="auth-submit" style="width:100%">Sign in</button>
            </div>
            <div class="field" style="margin-top:8px">
              <a href="#" id="auth-forgot" class="field-hint" style="color:#9ab4ff;text-decoration:none">Forgot password?</a>
            </div>
            <div id="auth-status" class="field-hint" role="status" aria-live="polite" style="margin-top:6px"></div>
          </div>

          <div id="auth-signed-in" class="auth-view" hidden>
            <div class="profile-preview" style="margin-bottom:12px">
              <div class="profile-avatar" id="auth-account-avatar">U</div>
              <div class="profile-copy">
                <span class="profile-name" id="auth-account-name">&mdash;</span>
                <span class="profile-role" id="auth-account-email">&mdash;</span>
              </div>
            </div>
            <button type="button" class="save" id="auth-verify-channel" style="width:100%;margin-bottom:8px">Verify my YouTube channel</button>
            <div id="auth-channel-status" class="field-hint" role="status" aria-live="polite" style="margin-bottom:10px"></div>
            <button type="button" class="save" id="auth-signout" style="width:100%;background:#2a2a2a">Sign out</button>
            <div id="auth-status-in" class="field-hint" role="status" aria-live="polite" style="margin-top:6px"></div>
          </div>
        </div>

        <div class="settings-card account-identity-card">
          <div class="profile-preview">
            <div class="profile-avatar" id="settings-profile-avatar" style="background:${userColor}">${profileInitial}</div>
            <div class="profile-copy">
              <span class="profile-name" id="settings-profile-name" style="color:${userColor}">${dispName}</span>
              <span class="profile-role">Account identity preview</span>
            </div>
          </div>
          <div class="account-readonly-grid">
            <div class="account-readonly-item">
              <span id="identity-name-label">Name</span>
              <strong id="identity-name-value">${dispName}</strong>
              <em id="identity-name-hint">Your display name on messages</em>
            </div>
            <div class="account-readonly-item">
              <span id="identity-account-label">Local account</span>
              <strong id="identity-account-value">${accountShort}</strong>
              <em id="identity-account-hint">Not signed in</em>
            </div>
            <div class="account-readonly-item">
              <span>Created</span>
              <strong>${accountCreatedLabel}</strong>
              <em>Local account date</em>
            </div>
          </div>
        </div>

        <div class="settings-card">
          <div class="card-title">Appearance</div>
          <p class="card-copy">These are personal chat styling choices. They do not grant roles or moderation access.</p>
          <div class="field">
            <label class="field-label">Username color</label>
            <div class="color-palette" id="settings-color-palette" role="group" aria-label="Preset username colors">
              ${['#3a6ff7','#e53935','#43a047','#fb8c00','#8e24aa','#00acc1','#fdd835','#ec407a','#ff7043','#00bcd4','#c0ca33','#ffffff'].map(c => `<button type="button" class="color-swatch${c.toLowerCase()===userColor.toLowerCase()?' selected':''}" data-color="${c}" style="background:${c}" title="${c}" aria-label="${c}"></button>`).join('')}
            </div>
            <div class="color-control">
              <input id="set-user-color" type="color" value="${userColor}" aria-label="Custom username color" />
              <span class="color-value" id="settings-color-value">${userColor}</span>
            </div>
            <span class="field-hint">Pick a preset, or use the swatch for any custom color.</span>
          </div>
        </div>
      </section>

      <section class="settings-panel" id="settings-panel-chat" role="tabpanel" aria-labelledby="settings-tab-chat" data-panel="chat" hidden>
        <div class="settings-card">
          <div class="card-title">Window position</div>
          <p class="card-copy">Locked chat returns here. In-video overlay position is edited from the composer handle.</p>
          <div class="field">
            <div class="segmented" role="radiogroup" aria-label="Default dock position">
              <label class="segment-choice">
                <input type="radio" name="dock" value="br" ${dock==='br'?'checked':''} />
                <span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16v16H4zM12 16h5v1h-5z"/></svg>Bottom-right</span>
              </label>
              <label class="segment-choice">
                <input type="radio" name="dock" value="tr" ${dock==='tr'?'checked':''} />
                <span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16v16H4zM12 7h5v1h-5z"/></svg>Top-right</span>
              </label>
            </div>
          </div>
        </div>
        <div class="settings-card chat-preferences-card">
          <div class="card-title">Reading & input</div>
          <p class="card-copy">Timeline display and shortcut protection.</p>
          <div class="setting-row">
            <div class="setting-row-copy">
              <span class="setting-row-title">Show timestamps</span>
              <span class="setting-row-note">Display video time beside each message.</span>
            </div>
            <label class="switch" aria-label="Show timestamps">
              <input id="set-show-ts" type="checkbox" ${showTS ? 'checked' : ''} />
              <span class="switch-track"></span>
            </label>
          </div>
          <div class="setting-row">
            <div class="setting-row-copy">
              <span class="setting-row-title">Protect chat typing</span>
              <span class="setting-row-note">Keeps typing, Enter, and emote search inside Lyve.</span>
            </div>
            <label class="switch" aria-label="Protect chat typing from YouTube shortcuts">
              <input id="set-protect-typing" type="checkbox" ${protectTyping ? 'checked' : ''} />
              <span class="switch-track"></span>
            </label>
          </div>
          <div class="setting-row">
            <div class="setting-row-copy">
              <span class="setting-row-title">Block 0–9 seeking</span>
              <span class="setting-row-note">Prevents accidental YouTube timeline jumps while Lyve is visible.</span>
            </div>
            <label class="switch" aria-label="Disable YouTube number-key seeking while Lyve is visible">
              <input id="set-block-number-hotkeys" type="checkbox" ${blockNumberSeeking ? 'checked' : ''} />
              <span class="switch-track"></span>
            </label>
          </div>
          <div class="field">
            <label class="field-label" for="set-max-len">Visible chat length</label>
            <select id="set-max-len">
              <option value="unlimited" ${maxLen==='unlimited'?'selected':''}>Uncapped</option>
              <option value="10" ${maxLen==='10'?'selected':''}>10 characters</option>
              <option value="25" ${maxLen==='25'?'selected':''}>25 characters</option>
              <option value="50" ${maxLen==='50'?'selected':''}>50 characters</option>
              <option value="100" ${maxLen==='100'?'selected':''}>100 characters</option>
            </select>
            <span class="field-hint">Limits how much of long messages is shown at once.</span>
          </div>
          <div class="field">
            <label class="field-label" for="set-profanity-filter">Profanity filter</label>
            <select id="set-profanity-filter">
              <option value="off" ${profanityFilter==='off'?'selected':''}>Off</option>
              <option value="censor" ${profanityFilter==='censor'?'selected':''}>Censor words (***)</option>
              <option value="hide" ${profanityFilter==='hide'?'selected':''}>Hide message</option>
            </select>
            <span class="field-hint">Filters profanity in the messages you see — your preference only.</span>
          </div>
        </div>
        <div class="settings-card">
          <div class="card-title">In-video overlay</div>
          <p class="card-copy">Message-and-composer mode snapped inside the video.</p>
          <div class="field">
            <label class="field-label" for="set-display-mode">Overlay mode</label>
            <select id="set-display-mode">
              <option value="window" ${displayMode==='window'?'selected':''}>Off</option>
              <option value="fullscreen" ${displayMode==='fullscreen'?'selected':''}>Fullscreen only</option>
              <option value="always" ${displayMode==='always'?'selected':''}>Always</option>
            </select>
          </div>
          <div class="field">
            <label class="field-label" for="set-overlay-fade">Fade messages after</label>
            <select id="set-overlay-fade">
              <option value="0" ${overlayFade==='0'?'selected':''}>Never</option>
              <option value="5" ${overlayFade==='5'?'selected':''}>5 seconds</option>
              <option value="10" ${overlayFade==='10'?'selected':''}>10 seconds</option>
              <option value="20" ${overlayFade==='20'?'selected':''}>20 seconds</option>
              <option value="30" ${overlayFade==='30'?'selected':''}>30 seconds</option>
            </select>
          </div>
          <div class="field">
            <label class="field-label" for="set-overlay-height">Chat stack height</label>
            <select id="set-overlay-height">
              <option value="240" ${overlayHeight==='240'?'selected':''}>Short · 240 px</option>
              <option value="360" ${overlayHeight==='360'?'selected':''}>Medium · 360 px</option>
              <option value="480" ${overlayHeight==='480'?'selected':''}>Tall · 480 px</option>
              <option value="620" ${overlayHeight==='620'?'selected':''}>Extra tall · 620 px</option>
            </select>
            <span class="field-hint">Controls the invisible vertical area that messages can occupy.</span>
          </div>
          <div class="field">
            <label class="field-label" for="set-overlay-corner">Video corner</label>
            <select id="set-overlay-corner">
              <option value="br" ${overlayCorner==='br'?'selected':''}>Bottom-right</option>
              <option value="tr" ${overlayCorner==='tr'?'selected':''}>Top-right</option>
              <option value="bl" ${overlayCorner==='bl'?'selected':''}>Bottom-left</option>
              <option value="tl" ${overlayCorner==='tl'?'selected':''}>Top-left</option>
            </select>
          </div>
        </div>
      </section>

      <section class="settings-panel" id="settings-panel-emotes" role="tabpanel" aria-labelledby="settings-tab-emotes" data-panel="emotes" hidden>
        <div class="settings-card">
          <div class="emote-heading">
            <div class="emote-mark">7TV</div>
            <div>
              <div class="card-title">7TV emotes</div>
              <p class="card-copy">Use a shared emote set or channel collection.</p>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-row-copy">
              <span class="setting-row-title">Enable 7TV</span>
              <span class="setting-row-note">Render matching emote names in chat.</span>
            </div>
            <label class="switch" aria-label="Enable 7TV emotes">
              <input id="set-7tv-enable" type="checkbox" ${enable7 ? 'checked' : ''} />
              <span class="switch-track"></span>
            </label>
          </div>
          <div class="field" id="settings-7tv-source-field">
            <label class="field-label" for="set-7tv-source">Emote set or channel</label>
            <div class="help-wrap">
              <input id="set-7tv-source" type="text" value="${src7}" placeholder="set:ID or twitch:channel" />
              <button type="button" class="help-icon" aria-label="7TV source help">?</button>
              <div class="help-tooltip">Use <code>set:SET_ID</code>, <code>twitch:channel</code>, or <code>youtube:channel</code>.<br><br>Example: <code>${typeof DEFAULT_7TV_SOURCE !== 'undefined' ? DEFAULT_7TV_SOURCE : 'set:YOUR_SET_ID'}</code></div>
            </div>
            <span class="field-hint">Changes reload the available emote collection.</span>
          </div>
        </div>
      </section>
    </div>

    <div class="settings-footer">
      <span class="footer-note">Saved on this browser</span>
      <button type="button" class="save" id="chat-settings-save">Save changes</button>
    </div>
  `;

  document.body.appendChild(popup);

  function makeSettingsCardsCollapsible() {
    const cards = Array.from(popup.querySelectorAll('.settings-panel .settings-card'));
    cards.forEach((card, index) => {
      if (card.matches('details.settings-collapsible')) return;
      const panelName = card.closest('.settings-panel')?.dataset.panel || 'settings';
      const directTitle = card.querySelector(':scope > .card-title');
      const directCopy = card.querySelector(':scope > .card-copy');
      const emoteHeading = card.querySelector(':scope > .emote-heading');
      const titleText = directTitle?.textContent?.trim()
        || emoteHeading?.querySelector('.card-title')?.textContent?.trim()
        || (card.classList.contains('account-identity-card') ? 'Account identity' : `Section ${index + 1}`);
      const copyText = directCopy?.textContent?.trim()
        || emoteHeading?.querySelector('.card-copy')?.textContent?.trim()
        || (card.classList.contains('account-identity-card') ? 'Name, local account, and creation date.' : '');
      directTitle?.remove();
      directCopy?.remove();
      emoteHeading?.remove();

      const details = document.createElement('details');
      details.className = `${card.className} settings-collapsible`.trim();
      const sectionKey = `chatSettingsSection:${panelName}:${titleText.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
      details.dataset.sectionKey = sectionKey;
      // Start collapsed on a fresh open. The open/closed state then lives only in
      // the DOM for this session, so it persists until the page is refreshed.
      details.open = false;

      const summary = document.createElement('summary');
      summary.className = 'settings-card-summary';
      const summaryCopy = document.createElement('div');
      summaryCopy.className = 'settings-card-summary-copy';
      const title = document.createElement('div');
      title.className = 'card-title';
      title.textContent = titleText;
      summaryCopy.appendChild(title);
      if (copyText) {
        const copy = document.createElement('p');
        copy.className = 'card-copy';
        copy.textContent = copyText;
        summaryCopy.appendChild(copy);
      }
      const chevron = document.createElement('span');
      chevron.className = 'settings-card-chevron';
      chevron.setAttribute('aria-hidden', 'true');
      chevron.textContent = '⌄';
      summary.append(summaryCopy, chevron);

      const body = document.createElement('div');
      body.className = 'settings-card-body';
      while (card.firstChild) body.appendChild(card.firstChild);
      details.append(summary, body);
      details.addEventListener('toggle', () => {
        if (popup.style.display === 'block') positionPopup();
      });
      card.replaceWith(details);
    });
  }

  makeSettingsCardsCollapsible();

  // Keep the account/auth card expanded by default and wire its controls.
  const authDetails = popup.querySelector('details.account-auth-card');
  if (authDetails) authDetails.open = true;
  wireAccountAuthUI(popup);

  // The popup may be hosted inside YouTube's player while fullscreen. Keep
  // keystrokes in its actual form controls from reaching player shortcuts.
  popup.querySelectorAll('input,select,textarea').forEach(control => {
    for (const eventName of ['keydown', 'keypress', 'keyup']) {
      control.addEventListener(eventName, event => {
        if (getSetting('chatProtectTypingShortcuts', true) === true) event.stopPropagation();
      }, true);
    }
  });

  const tabs = Array.from(popup.querySelectorAll('.settings-tab'));
  const panels = Array.from(popup.querySelectorAll('.settings-panel'));

  function activateTab(name, focus = false) {
    if (!tabs.some(tab => tab.dataset.tab === name)) name = 'profile';
    tabs.forEach(tab => {
      const selected = tab.dataset.tab === name;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (selected && focus) tab.focus();
    });
    panels.forEach(panelEl => {
      const selected = panelEl.dataset.panel === name;
      panelEl.classList.toggle('active', selected);
      panelEl.hidden = !selected;
    });
    setSetting('chatSettingsTab', name);
    if (popup.style.display === 'block') positionPopup();
  }

  const rememberedTab = String(getSetting('chatSettingsTab', 'profile') || 'profile');
  activateTab(rememberedTab);

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => activateTab(tab.dataset.tab));
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      let next = index;
      if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      activateTab(tabs[next].dataset.tab, true);
    });
  });

  const colorInput = popup.querySelector('#set-user-color');
  const previewName = popup.querySelector('#settings-profile-name');
  const previewAvatar = popup.querySelector('#settings-profile-avatar');
  const colorValue = popup.querySelector('#settings-color-value');

  function updateProfilePreview() {
    const name = rawDispName || 'You';
    const color = colorInput.value || '#3a6ff7';
    previewName.textContent = name;
    previewName.style.color = color;
    previewAvatar.textContent = Array.from(name)[0]?.toUpperCase() || 'Y';
    previewAvatar.style.background = color;
    colorValue.textContent = color;
  }
  const colorSwatches = Array.from(popup.querySelectorAll('.color-swatch'));
  function syncColorSwatches() {
    const current = (colorInput.value || '').toLowerCase();
    colorSwatches.forEach(s => s.classList.toggle('selected', s.dataset.color.toLowerCase() === current));
  }
  colorSwatches.forEach(swatch => {
    swatch.addEventListener('click', () => {
      colorInput.value = swatch.dataset.color;
      updateProfilePreview();
      syncColorSwatches();
    });
  });
  colorInput.addEventListener('input', () => { updateProfilePreview(); syncColorSwatches(); });

  const enable7Input = popup.querySelector('#set-7tv-enable');
  const source7Input = popup.querySelector('#set-7tv-source');
  const source7Field = popup.querySelector('#settings-7tv-source-field');
  function update7tvState() {
    const enabled = enable7Input.checked;
    source7Input.disabled = !enabled;
    source7Field.style.opacity = enabled ? '1' : '.52';
  }
  enable7Input.addEventListener('change', update7tvState);
  update7tvState();

  popup.querySelector('.settings-close').addEventListener('click', () => {
    popup.style.display = 'none';
  });

  let popupAnchor = gearBtn;
  let popupCentered = false;
  let popupCustomPosition = false;

  function positionPopup(anchor = popupAnchor) {
    if (popupCustomPosition) return;
    const PADDING = 10;
    const r = anchor?.getBoundingClientRect?.() || gearBtn.getBoundingClientRect();
    const host = popup.parentElement || document.body;
    const inBody = host === document.body;
    const hostRect = inBody
      ? { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
      : host.getBoundingClientRect();

    let left = popupCentered
      ? hostRect.left + (hostRect.right - hostRect.left - popup.offsetWidth) / 2
      : r.right - popup.offsetWidth;
    let top = popupCentered
      ? hostRect.top + (hostRect.bottom - hostRect.top - popup.offsetHeight) / 2
      : r.bottom + 6;

    left = Math.max(hostRect.left + PADDING, Math.min(left, hostRect.right - popup.offsetWidth - PADDING));
    top  = Math.max(hostRect.top + PADDING, Math.min(top, hostRect.bottom - popup.offsetHeight - PADDING));

    popup.style.position = inBody ? 'fixed' : 'absolute';
    popup.style.left = `${left - hostRect.left}px`;
    popup.style.top  = `${top - hostRect.top}px`;
  }

  function openSettingsFrom(anchor = gearBtn, { toggle = true, center = false } = {}) {
    popupAnchor = anchor?.isConnected ? anchor : gearBtn;
    popupCentered = center;
    popupCustomPosition = false;
    if (toggle && popup.style.display === 'block') {
      popup.style.display = 'none';
      return;
    }
    const host = document.fullscreenElement || document.body;
    if (popup.parentElement !== host) host.appendChild(popup);
    popup.style.display = 'block';
    positionPopup(popupAnchor);
  }
  gearBtn._openFrom = openSettingsFrom;

  const settingsHeader = popup.querySelector('.settings-header');
  settingsHeader.style.cursor = 'move';
  settingsHeader.addEventListener('pointerdown', event => {
    if (event.target.closest('button,input,select,a')) return;
    const startRect = popup.getBoundingClientRect();
    const host = popup.parentElement || document.body;
    const inBody = host === document.body;
    const hostRect = inBody
      ? { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
      : host.getBoundingClientRect();
    const startX = event.clientX; const startY = event.clientY;
    popupCustomPosition = true;
    const move = moveEvent => {
      const left = Math.max(hostRect.left + 8, Math.min(startRect.left + moveEvent.clientX - startX, hostRect.right - popup.offsetWidth - 8));
      const top = Math.max(hostRect.top + 8, Math.min(startRect.top + moveEvent.clientY - startY, hostRect.bottom - popup.offsetHeight - 8));
      popup.style.left = `${left - hostRect.left}px`;
      popup.style.top = `${top - hostRect.top}px`;
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop, { once: true });
  });

  // Open/close on gear click
  gearBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openSettingsFrom(gearBtn);
  });

  // Save handler
  popup.querySelector('#chat-settings-save').addEventListener('click', async () => {
    const prevOverlayHeight = String(getSetting('chatOverlayHeight', '360') || '360');
    const prevOverlayCorner = String(getSetting('chatOverlayCorner', 'br') || 'br');

    const color   = popup.querySelector('#set-user-color').value || '#3a6ff7';
    const dockSel = popup.querySelector('input[name="dock"]:checked')?.value || 'br';
    const ts      = popup.querySelector('#set-show-ts').checked;
    const ml      = popup.querySelector('#set-max-len').value || 'unlimited';
    const profanity = popup.querySelector('#set-profanity-filter')?.value || 'off';
    const protectTypingValue = popup.querySelector('#set-protect-typing').checked;
    const blockNumberSeekingValue = popup.querySelector('#set-block-number-hotkeys').checked;
    const displayModeValue = popup.querySelector('#set-display-mode').value || 'window';
    const overlayFadeValue = popup.querySelector('#set-overlay-fade').value || '10';
    const overlayHeightValue = popup.querySelector('#set-overlay-height').value || '360';
    const overlayCornerValue = popup.querySelector('#set-overlay-corner').value || 'br';
    const en7     = popup.querySelector('#set-7tv-enable').checked;
    const src     = (popup.querySelector('#set-7tv-source').value || '').trim();

    setSetting('chatUserColor', color);
    setSetting('chatDefaultDock', dockSel);
    setSetting('chatShowTimestamps', ts);
    setSetting('chatMaxLen', ml);
    setSetting('chatProfanityFilter', profanity);
    setSetting('chatProtectTypingShortcuts', protectTypingValue);
    setSetting('chatBlockYouTubeNumberHotkeys', blockNumberSeekingValue);
    setSetting('chatDisplayMode', displayModeValue);
    setSetting('chatOverlayFadeSeconds', overlayFadeValue);
    setSetting('chatOverlayHeight', overlayHeightValue);
    setSetting('chatOverlayCorner', overlayCornerValue);
    setSetting('chatEnable7tv', en7);
    setSetting('chat7tvSource', src);

    if (overlayHeightValue !== prevOverlayHeight) {
      localStorage.removeItem('chatOverlayCustomWidth');
      localStorage.removeItem('chatOverlayCustomHeight');
    }
    if (overlayCornerValue !== prevOverlayCorner) {
      for (const key of ['chatOverlayCustomPosition','chatOverlayRelativeX','chatOverlayRelativeY']) localStorage.removeItem(key);
    }

    if (displayModeValue !== 'window') {
      panel.classList.remove('lyve-hidden');
      panel.style.display = 'flex';
      setSetting('chatVisible', true);
    }

    if (typeof window.isLocked !== 'undefined' && window.isLocked) window.setDockPosition?.(panel, dockSel);
    if (typeof SevenTV !== 'undefined' && SevenTV.loadFromSettings) await SevenTV.loadFromSettings();
    if (typeof window.renderNow === 'function') window.renderNow();
    window.dispatchEvent(new CustomEvent('lyve:display-mode-changed'));
    popup.style.display = 'none';
  });

  // Close / reposition hooks
  window.addEventListener('resize', () => {
    if (popup.style.display === 'block') positionPopup(popupAnchor);
  });
  document.addEventListener('click', (e) => {
    if (popup.style.display === 'block' && !popup.contains(e.target) && e.target !== gearBtn) {
      popup.style.display = 'none';
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && popup.style.display === 'block') {
      popup.style.display = 'none';
      gearBtn.focus();
    }
  }, true);

  // Smart tooltip placement
  function attachTooltipLogic(container) {
    container.querySelectorAll('.help-wrap').forEach(wrap => {
      const icon = wrap.querySelector('.help-icon');
      const tip  = wrap.querySelector('.help-tooltip');
      if (!icon || !tip) return;

      const showTip = () => {
        const M = 10;
        const ir = icon.getBoundingClientRect();
        tip.style.left = '0px'; tip.style.top = '0px';
        tip.classList.add('show');
        const tw = tip.offsetWidth, th = tip.offsetHeight;
        const vw = window.innerWidth, vh = window.innerHeight;

        let left = ir.right + 8;
        let top  = ir.top - 4;

        if (left + tw + M > vw) left = ir.left - tw - 8;
        if (left < M) left = Math.max(M, ir.left + (ir.width/2) - tw/2);
        if (top + th + M > vh) top = ir.bottom - th - 8;
        if (top < M) top = M;

        tip.style.left = `${left}px`;
        tip.style.top  = `${top}px`;
      };

      icon.addEventListener('mouseenter', showTip);
      icon.addEventListener('focus', showTip);
      icon.addEventListener('mouseleave', () => tip.classList.remove('show'));
      icon.addEventListener('blur', () => tip.classList.remove('show'));
    });
  }
  attachTooltipLogic(popup);

  document.addEventListener('scroll', () => {
    popup.querySelectorAll('.help-tooltip.show').forEach(t => t.classList.remove('show'));
  }, true);

  return gearBtn;
}

// --- Admin gating (account-based) ---
//
// Admin is no longer a shared client token. It is granted by a Firestore
// admins/{uid} document that only the project owner can create. `isAdmin()`
// stays synchronous for render code by reading a cached flag, while
// `refreshAdminRole()` reconciles that flag against the backend.
function isAdmin() {
  return getSetting('chatAdminEnabled', false) === true;
}

function sendBackgroundRequest(type, payload = {}) {
  if (!globalThis.chrome?.runtime?.sendMessage) return Promise.resolve(null);
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage({ source: 'lyve-message-store', type, payload }, response => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(response || null);
      });
    } catch {
      resolve(null);
    }
  });
}

// Ask the background whether the signed-in account is an admin, and reconcile
// the cached flag. A stale local flag (e.g. left over from the old token) is
// cleared here whenever the backend says the account is not an admin.
async function refreshAdminRole() {
  const wasAdmin = isAdmin();
  const response = await sendBackgroundRequest('LYVE_GET_ROLE');
  const isAdminNow = Boolean(response?.ok && response.isAdmin);
  if (isAdminNow) setSetting('chatAdminEnabled', true);
  else { try { localStorage.removeItem('chatAdminEnabled'); } catch {} }
  if (isAdminNow !== wasAdmin) {
    window.dispatchEvent(new CustomEvent('lyve:admin-enabled'));
  }
  return isAdminNow;
}

// Reconcile admin state on load (and whenever auth changes).
refreshAdminRole();
window.addEventListener('lyve:auth-changed', refreshAdminRole);

// Cached account state so render/compose code can read sign-in status
// synchronously. Refreshed on load and whenever auth changes.
let cachedAccountState = { signedIn: false };
function getAccountStateCached() {
  return cachedAccountState;
}
async function refreshAccountStateCache() {
  const state = await sendBackgroundRequest('LYVE_AUTH_STATE');
  cachedAccountState = (state?.ok && state.signedIn)
    ? { signedIn: true, uid: state.uid, email: state.email, displayName: state.displayName }
    : { signedIn: false };
  return cachedAccountState;
}
refreshAccountStateCache();
window.addEventListener('lyve:auth-changed', refreshAccountStateCache);

// Map raw Firebase Auth error codes to readable messages.
function friendlyAuthError(code) {
  const map = {
    EMAIL_EXISTS: 'That email already has an account. Try signing in.',
    EMAIL_NOT_FOUND: 'No account found for that email.',
    INVALID_PASSWORD: 'Incorrect password.',
    INVALID_LOGIN_CREDENTIALS: 'Email or password is incorrect.',
    INVALID_EMAIL: 'That email address looks invalid.',
    MISSING_PASSWORD: 'Please enter a password.',
    WEAK_PASSWORD: 'Password must be at least 6 characters.',
    OPERATION_NOT_ALLOWED: 'Email/password sign-in is not enabled in Firebase.',
    TOO_MANY_ATTEMPTS_TRY_LATER: 'Too many attempts. Please wait and try again.',
    USER_DISABLED: 'This account has been disabled.',
  };
  if (!code) return 'Something went wrong. Please try again.';
  const key = String(code).split(' : ')[0].trim();
  return map[key] || String(code);
}

// Wire the Account-tab sign in / create account / forgot-password / sign out UI.
function wireAccountAuthUI(popup) {
  const signedOutView = popup.querySelector('#auth-signed-out');
  const signedInView = popup.querySelector('#auth-signed-in');
  if (!signedOutView || !signedInView) return;

  const modeInputs = Array.from(popup.querySelectorAll('input[name="auth-mode"]'));
  const usernameField = popup.querySelector('#auth-username-field');
  const usernameInput = popup.querySelector('#auth-username');
  const emailInput = popup.querySelector('#auth-email');
  const passwordInput = popup.querySelector('#auth-password');
  const submitBtn = popup.querySelector('#auth-submit');
  const forgotLink = popup.querySelector('#auth-forgot');
  const statusOut = popup.querySelector('#auth-status');
  const signoutBtn = popup.querySelector('#auth-signout');
  const statusIn = popup.querySelector('#auth-status-in');
  const accountName = popup.querySelector('#auth-account-name');
  const accountEmail = popup.querySelector('#auth-account-email');
  const accountAvatar = popup.querySelector('#auth-account-avatar');

  // The lower identity card mirrors the real account when signed in.
  const identityNameValue = popup.querySelector('#identity-name-value');
  const identityAccountLabel = popup.querySelector('#identity-account-label');
  const identityAccountValue = popup.querySelector('#identity-account-value');
  const identityAccountHint = popup.querySelector('#identity-account-hint');
  const identityProfileName = popup.querySelector('#settings-profile-name');
  const identityProfileAvatar = popup.querySelector('#settings-profile-avatar');
  const originalIdentity = {
    name: identityNameValue?.textContent || '',
    profileName: identityProfileName?.textContent || '',
    avatar: identityProfileAvatar?.textContent || '',
    accountLabel: identityAccountLabel?.textContent || 'Local account',
    accountValue: identityAccountValue?.textContent || '',
  };

  const currentMode = () => popup.querySelector('input[name="auth-mode"]:checked')?.value || 'signin';

  function setStatus(message, kind = 'info') {
    statusOut.textContent = message || '';
    statusOut.style.color = kind === 'error' ? '#ff6b6b' : kind === 'success' ? '#6bd28a' : '#727272';
  }

  function setBusy(busy) {
    submitBtn.disabled = busy;
    modeInputs.forEach(input => { input.disabled = busy; });
  }

  function applyMode() {
    const signup = currentMode() === 'signup';
    usernameField.hidden = !signup;
    submitBtn.textContent = signup ? 'Create account' : 'Sign in';
    passwordInput.autocomplete = signup ? 'new-password' : 'current-password';
    setStatus('');
  }

  function showSignedIn(state) {
    const name = state.displayName || state.email || 'Account';
    const initial = (Array.from(String(name))[0] || 'U').toUpperCase();
    accountName.textContent = name;
    accountEmail.textContent = state.email || '';
    accountAvatar.textContent = initial;
    signedOutView.hidden = true;
    signedInView.hidden = false;

    if (identityNameValue) identityNameValue.textContent = name;
    if (identityProfileName) identityProfileName.textContent = name;
    if (identityProfileAvatar) identityProfileAvatar.textContent = initial;
    if (identityAccountLabel) identityAccountLabel.textContent = 'Email';
    if (identityAccountValue) identityAccountValue.textContent = state.email || '';
    if (identityAccountHint) identityAccountHint.textContent = 'Signed in';
  }

  function showSignedOut() {
    signedInView.hidden = true;
    signedOutView.hidden = false;

    if (identityNameValue) identityNameValue.textContent = originalIdentity.name;
    if (identityProfileName) identityProfileName.textContent = originalIdentity.profileName;
    if (identityProfileAvatar) identityProfileAvatar.textContent = originalIdentity.avatar;
    if (identityAccountLabel) identityAccountLabel.textContent = originalIdentity.accountLabel;
    if (identityAccountValue) identityAccountValue.textContent = originalIdentity.accountValue;
    if (identityAccountHint) identityAccountHint.textContent = 'Not signed in';
  }

  async function refresh() {
    const state = await sendBackgroundRequest('LYVE_AUTH_STATE');
    if (state?.ok && state.signedIn) showSignedIn(state);
    else showSignedOut();
  }

  async function submit() {
    const mode = currentMode();
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    const username = usernameInput.value.trim();
    if (!email || !password || (mode === 'signup' && !username)) {
      setStatus('Please fill in all fields.', 'error');
      return;
    }
    if (mode === 'signup') {
      const usernameIssue = getUsernameRejection(username);
      if (usernameIssue) { setStatus(usernameIssue, 'error'); return; }
    }
    setBusy(true);
    setStatus(mode === 'signup' ? 'Creating account…' : 'Signing in…');
    const type = mode === 'signup' ? 'LYVE_AUTH_SIGNUP' : 'LYVE_AUTH_SIGNIN';
    const payload = mode === 'signup' ? { email, password, username } : { email, password };
    const res = await sendBackgroundRequest(type, payload);
    setBusy(false);
    if (res?.ok && res.signedIn) {
      const name = res.displayName || username || '';
      // On sign-up adopt the chosen username; on sign-in only adopt the account
      // name when the user hasn't already picked a custom local one.
      const keepLocalName = mode === 'signin'
        && !['', 'You'].includes(String(getSetting('chatDisplayName', 'You') || '').trim());
      if (name && !keepLocalName) setSetting('chatDisplayName', name);
      passwordInput.value = '';
      window.dispatchEvent(new CustomEvent('lyve:auth-changed'));
      showSignedIn(res);
    } else {
      setStatus(friendlyAuthError(res?.error), 'error');
    }
  }

  modeInputs.forEach(input => input.addEventListener('change', applyMode));
  submitBtn.addEventListener('click', submit);
  [usernameInput, emailInput, passwordInput].forEach(input => {
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); submit(); }
    });
  });

  forgotLink.addEventListener('click', async event => {
    event.preventDefault();
    const email = emailInput.value.trim();
    if (!email) { setStatus('Enter your email first, then click Forgot password.', 'error'); return; }
    setStatus('Sending reset email…');
    const res = await sendBackgroundRequest('LYVE_AUTH_RESET_PASSWORD', { email });
    if (res?.ok) setStatus('Password reset email sent. Check your inbox.', 'success');
    else setStatus(friendlyAuthError(res?.error), 'error');
  });

  const googleBtn = popup.querySelector('#auth-google');
  googleBtn?.addEventListener('click', async () => {
    googleBtn.disabled = true;
    setStatus('Opening Google sign-in…');
    const res = await sendBackgroundRequest('LYVE_AUTH_GOOGLE');
    googleBtn.disabled = false;
    if (res?.ok && res.signedIn) {
      const keepLocalName = !['', 'You'].includes(String(getSetting('chatDisplayName', 'You') || '').trim());
      if (res.displayName && !keepLocalName) setSetting('chatDisplayName', res.displayName);
      window.dispatchEvent(new CustomEvent('lyve:auth-changed'));
      showSignedIn(res);
    } else {
      setStatus(friendlyAuthError(res?.error), 'error');
    }
  });

  signoutBtn.addEventListener('click', async () => {
    signoutBtn.disabled = true;
    const res = await sendBackgroundRequest('LYVE_AUTH_SIGNOUT');
    signoutBtn.disabled = false;
    if (res?.ok) {
      window.dispatchEvent(new CustomEvent('lyve:auth-changed'));
      showSignedOut();
    } else {
      statusIn.textContent = 'Sign out failed. Try again.';
      statusIn.style.color = '#ff6b6b';
    }
  });

  const verifyChannelBtn = popup.querySelector('#auth-verify-channel');
  const channelStatus = popup.querySelector('#auth-channel-status');
  verifyChannelBtn?.addEventListener('click', async () => {
    verifyChannelBtn.disabled = true;
    channelStatus.textContent = 'Opening Google sign-in…';
    channelStatus.style.color = '#727272';
    const res = await sendBackgroundRequest('LYVE_VERIFY_CHANNEL');
    verifyChannelBtn.disabled = false;
    if (res?.ok) {
      channelStatus.textContent = 'Verified channel: ' + (res.channelTitle || res.channelId);
      channelStatus.style.color = '#6bd28a';
    } else {
      channelStatus.textContent = res?.error || 'Verification failed.';
      channelStatus.style.color = '#ff6b6b';
    }
  });

  applyMode();
  refresh();
}

// ---- Identity & Clock scaffolding (Step 5) ----
function getOrCreateUserId() {
  try {
    const KEY = 'chatUserId';
    let id = localStorage.getItem(KEY);
    if (!id) {
      // UUIDv4 (simple)
      id = ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
        (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
      );
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    // Fallback (very unlikely path)
    return 'uid_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
}

function getOrCreateAccountCreatedAt() {
  try {
    const KEY = 'chatAccountCreatedAt';
    let createdAt = localStorage.getItem(KEY);
    if (!createdAt) {
      createdAt = new Date().toISOString();
      localStorage.setItem(KEY, createdAt);
    }
    return createdAt;
  } catch {
    return new Date().toISOString();
  }
}

const Clock = {
  now: () => Date.now(),
  nowISO: () => new Date(Date.now()).toISOString(),
};

export { getSetting, setSetting, injectSettingsStyles, createSettingsUI,
         isAdmin, refreshAdminRole, getAccountStateCached, refreshAccountStateCache,
         getOrCreateUserId, getOrCreateAccountCreatedAt, Clock };
