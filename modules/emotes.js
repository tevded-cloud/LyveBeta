// modules/emotes.js  — ES module version of your current emotes.js (no logic changes)

import { searchEmoji } from "./emojiData.js";

// --- 1) Emoji/7tv picker styles ------------------------------------------
export function injectEmojiStyles() {
  if (document.getElementById('emoji-picker-styles')) return;
  const style = document.createElement('style');
  style.id = 'emoji-picker-styles';
  style.textContent = `
    .emote-picker{
      position:fixed; z-index:2147483647;
      width:360px; background:#151515; color:#fff;
      border:1px solid rgba(255,255,255,0.12);
      border-radius:10px; box-shadow:0 12px 30px rgba(0,0,0,.5);
      padding:8px;
    }
    .ep-header{font-weight:600; padding:4px 8px; margin-bottom:6px;}
    .ep-search{
      width:calc(100% - 16px);height:34px;margin:0 8px 6px;padding:0 10px;
      background:#0d0d0d;color:#fff;border:1px solid rgba(255,255,255,.13);
      border-radius:8px;outline:none;font:12px Roboto,Arial,sans-serif;
    }
    .ep-search:focus{border-color:rgba(239,61,56,.75);box-shadow:0 0 0 3px rgba(239,61,56,.12)}
    .ep-recent{display:flex;gap:6px;padding:2px 8px 6px;overflow-x:auto;overscroll-behavior:contain}
    .ep-recent:empty{display:none}
    .ep-recent .ep-item{flex:0 0 34px;width:34px;height:34px;font-size:18px}
    .ep-grid{
      display:grid; grid-template-columns:repeat(8, 1fr);
      grid-auto-rows:40px; gap:8px; padding:8px;
      height:300px; max-height:300px; /* fixed height so it scrolls */
      overflow-y:auto; overscroll-behavior:contain;
      background:#101010; border-radius:8px;
    }
    .ep-item{
      background:#1f1f1f; border:1px solid rgba(255,255,255,0.1);
      border-radius:8px; display:flex; align-items:center; justify-content:center;
      font-size:20px; cursor:pointer; user-select:none;
    }
    .ep-item img{ width:100%; height:100%; object-fit:contain; border-radius:6px; }
    .ep-categories{
      display:flex; gap:12px; padding:8px; margin-top:8px;
      background:#151515; border-radius:10px;
    }
    .ep-tab{
      flex:1; background:#222; border:1px solid rgba(255,255,255,0.12);
      border-radius:10px; padding:8px; color:#bbb; cursor:pointer;
    }
    .ep-tab.active{ background:#2a2a2a; color:#fff; }
    .ep-count{opacity:.7; margin-left:6px;}
  `;
  document.head.appendChild(style);
}

// --- 2) Default 7tv source id --------------------------------------------
export const DEFAULT_7TV_SOURCE = 'set:01FSPQXZAG00038GDBZ91HTAPQ'; // used by Settings help

// Prevent ordinary conversation words from becoming surprise emotes. This
// applies at load time, so blocked names stay out of rendering, autocomplete,
// and the picker while distinctive emote names continue to work normally.
const BLOCKED_COMMON_EMOTE_NAMES = new Set([
  'a','about','after','again','all','also','am','an','and','any','are','around','as','at','back','bad',
  'be','because','been','before','big','but','by','can','come','could','day','did','do','does','doing',
  'down','even','first','for','from','get','give','go','going','good','got','had','has','have','he',
  'hello','her','here','hey','him','his','how','i','if','in','into','is','it','its','just','know','last',
  'like','little','look','love','make','man','me','more','much','my','need','never','new','no','not','now',
  'of','off','oh','ok','okay','on','one','only','or','our','out','people','please','really','right','said',
  'same','say','see','she','so','some','still','take','tell','than','that','the','their','them','then',
  'there','these','they','thing','think','this','time','to','too','up','us','very','want','was','way','we',
  'well','were','what','when','where','which','who','why','will','with','work','would','yeah','yes','you','your'
]);

function isBlockedCommonEmoteName(name) {
  return BLOCKED_COMMON_EMOTE_NAMES.has(String(name || '').trim().toLowerCase());
}

// --- 3) Cursor insertion helper (shared) ----------------------------------
export function insertAtCursor(input, text) {
  const start = input.selectionStart ?? input.value.length;
  const end   = input.selectionEnd   ?? input.value.length;
  const before = input.value.slice(0, start);
  const after  = input.value.slice(end);
  input.value = before + text + after;
  const caret = start + text.length;
  input.setSelectionRange(caret, caret);
  input.focus();
}

// --- Recently used emotes ------------------------------------------------
const RECENT_EMOTES_KEY = 'lyveRecentEmotes';
const RECENT_EMOTES_MAX = 16;

export function getRecentEmotes() {
  try {
    const arr = JSON.parse(localStorage.getItem(RECENT_EMOTES_KEY) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// Record an emote use (most-recent-first, de-duplicated, capped).
export function recordEmoteUse(emote) {
  if (!emote || !emote.name) return;
  try {
    const list = getRecentEmotes().filter(existing => existing.name !== emote.name);
    list.unshift({ type: emote.type, name: emote.name, char: emote.char, url: emote.url });
    localStorage.setItem(RECENT_EMOTES_KEY, JSON.stringify(list.slice(0, RECENT_EMOTES_MAX)));
  } catch {}
}

// Insert a token with smart spaces: add a leading space if needed, always a trailing space
export function insertTokenWithSpaces(input, token) {
  const v = input.value;
  const start = input.selectionStart ?? v.length;
  const needsLeading =
    start > 0 && !/\s/.test(v[start - 1]); // no space before caret

  const text = (needsLeading ? ' ' : '') + token + ' ';
  insertAtCursor(input, text);
}

// --- 4) Emoji/7tv picker --------------------------------------------------
export function createEmojiPicker(panel, input, emojiBtn) {
  injectEmojiStyles();

  const BASIC = [
    "😀","😅","😂","🤣","🙂","😉","😎","😍","🥳","😡",
    "😭","💀","👍","👎","🙏","🙌","✨","🔥","💯","🎉",
    "⭐","🧠","🚀","🍿","💤","😴","😇","😏","😮","🤔",
    "😐","😬","🤷","👏","🫡","🫶","🤝","🫠"
  ];
  const getSevenTVEmotes = () =>
    (typeof SevenTV !== 'undefined' && typeof SevenTV.listEmotes === 'function')
      ? SevenTV.listEmotes() : [];

  const picker = document.createElement('div');
  picker.className = 'emote-picker';
  picker.innerHTML = `
    <div class="ep-header">Emotes</div>
    <input class="ep-search" type="search" placeholder="Search 7TV emotes" aria-label="Search 7TV emotes" autocomplete="off" />
    <div class="ep-recent" aria-label="Recently used emotes"></div>
    <div class="ep-grid" tabindex="0" aria-label="Emote grid"></div>
    <div class="ep-categories">
      <button class="ep-tab ep-basic active" type="button">Basic</button>
      <button class="ep-tab ep-7tv" type="button">7tv <span class="ep-count"></span></button>
    </div>
  `;
  document.body.appendChild(picker);
  picker.style.display = 'none';

  const gridEl   = picker.querySelector('.ep-grid');
  const searchEl = picker.querySelector('.ep-search');
  const tabBasic = picker.querySelector('.ep-basic');
  const tab7tv   = picker.querySelector('.ep-7tv');
  const recentEl = picker.querySelector('.ep-recent');

  function renderRecent() {
    recentEl.innerHTML = '';
    getRecentEmotes().slice(0, 8).forEach(recent => {
      const item = document.createElement('div');
      item.className = 'ep-item';
      if (recent.type === '7tv' && recent.url) {
        const img = document.createElement('img');
        img.src = recent.url; img.alt = recent.name; img.title = recent.name;
        item.appendChild(img);
        item.addEventListener('click', () => {
          insertTokenWithSpaces(input, recent.name);
          recordEmoteUse(recent);
          renderRecent();
        });
      } else {
        const ch = recent.char || recent.name;
        item.textContent = ch;
        item.title = ch;
        item.addEventListener('click', () => {
          insertAtCursor(input, ch);
          recordEmoteUse(recent);
          renderRecent();
        });
      }
      recentEl.appendChild(item);
    });
  }

  function update7tvCount() {
    const c = picker.querySelector('.ep-count');
    const n = getSevenTVEmotes().length;
    c.textContent = n ? `(${n})` : '(0)';
  }

  function render(mode) {
    gridEl.innerHTML = '';
    if (mode === 'basic') {
      BASIC.forEach(ch => {
        const item = document.createElement('div');
        item.className = 'ep-item';
        item.textContent = ch;
        item.title = ch;
        item.addEventListener('click', () => {
          insertAtCursor(input, ch);
          recordEmoteUse({ type: 'basic', name: ch, char: ch });
          renderRecent();
        });
        gridEl.appendChild(item);
      });
      return;
    }

    const query = searchEl.value.trim().toLowerCase();
    const ems = getSevenTVEmotes().filter(emote => !query || String(emote.name || '').toLowerCase().includes(query));
    if (!ems.length) {
      const empty = document.createElement('div');
      empty.style.opacity = '.7';
      empty.style.fontSize = '12px';
      empty.style.gridColumn = '1 / -1';
      empty.style.padding = '6px';
      empty.textContent = query ? 'No emotes match that search.' : 'No 7tv emotes loaded. Check Settings → 7tv.';
      gridEl.appendChild(empty);
      return;
    }

    ems.forEach(e => {
      const url = e.url || (Array.isArray(e.urls) ? e.urls[0] : null);
      if (!url) return;
      const item = document.createElement('div');
      item.className = 'ep-item';
      const img = document.createElement('img');
      img.src = url;
      img.alt = e.name;
      img.title = e.name;
      item.appendChild(img);
      item.addEventListener('click', () => {
        insertTokenWithSpaces(input, e.name);
        recordEmoteUse({ type: '7tv', name: e.name, url });
        renderRecent();
      });
      gridEl.appendChild(item);
    });
  }

  function positionPicker() {
    const P = 8;
    const r = input.getBoundingClientRect();
    picker.style.display = 'block';
    const pw = picker.offsetWidth, ph = picker.offsetHeight;

    let left = r.left;
    let top  = r.top - ph - 6;
    if (top < P) top = r.bottom + 6;
    if (left + pw + P > innerWidth)  left = innerWidth  - pw - P;
    if (left < P) left = P;
    if (top  + ph + P > innerHeight) top  = Math.max(P, innerHeight - ph - P);

    picker.style.left = `${left}px`;
    picker.style.top  = `${top}px`;
  }

  // initial render — restore the last-used tab.
  let mode = localStorage.getItem('lyveEmoteTab') === '7tv' ? '7tv' : 'basic';
  if (mode === '7tv') {
    tab7tv.classList.add('active');
    tabBasic.classList.remove('active');
  }
  render(mode);
  update7tvCount();
  renderRecent();

  searchEl.addEventListener('input', () => {
    if (searchEl.value.trim()) {
      mode = '7tv';
      tab7tv.classList.add('active');
      tabBasic.classList.remove('active');
    }
    render(mode);
  });
  for (const eventName of ['keydown', 'keypress', 'keyup']) {
    searchEl.addEventListener(eventName, event => event.stopPropagation());
  }

  // tabs
  tabBasic.addEventListener('click', () => {
    mode = 'basic';
    tabBasic.classList.add('active');
    tab7tv.classList.remove('active');
    try { localStorage.setItem('lyveEmoteTab', 'basic'); } catch {}
    render(mode);
  });
  tab7tv.addEventListener('click', () => {
    mode = '7tv';
    tab7tv.classList.add('active');
    tabBasic.classList.remove('active');
    try { localStorage.setItem('lyveEmoteTab', '7tv'); } catch {}
    update7tvCount();
    render(mode);
  });

  // stop wheel bubbling
  picker.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
  gridEl.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });

  // toggle open/close
  emojiBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (picker.style.display === 'block') {
      picker.style.display = 'none';
    } else {
      picker.style.display = 'block';
      requestAnimationFrame(positionPicker);
      update7tvCount();
      if (mode === '7tv') render('7tv');
      renderRecent();
      // Focus the search immediately so the user can type to filter right away.
      searchEl.focus();
      requestAnimationFrame(() => { searchEl.focus(); searchEl.select(); });
    }
  });

  input.addEventListener('lyve:composer-sent', () => {
    picker.style.display = 'none';
    searchEl.value = '';
  });

  // close when clicking outside / Esc / resize
  document.addEventListener('click', (e) => {
    if (picker.style.display === 'block' && !picker.contains(e.target) && e.target !== emojiBtn) {
      picker.style.display = 'none';
    }
  });
  window.addEventListener('resize', () => {
    if (picker.style.display === 'block') positionPicker();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && picker.style.display === 'block') picker.style.display = 'none';
  }, true);
}

// --- 5) Autocomplete (TAB cycling) — colon menu opens UP -----------------
export function injectAutocompleteStyles() {
  if (document.getElementById('emote-ac-css')) return;
  const st = document.createElement('style');
  st.id = 'emote-ac-css';
  st.textContent = `
  .emote-ac{
    position:fixed; z-index:2147483647; display:none;
    background:#151515; color:#fff;
    border:1px solid rgba(255,255,255,.12); border-radius:8px;
    box-shadow:0 10px 24px rgba(0,0,0,.4); padding:6px;
  }
  .emote-ac-list{ display:flex; gap:6px; }

  /* Both plain-word and colon suggestions use the same horizontal carousel. */
  .emote-ac{
    max-width:calc(100vw - 16px);
  }
  .emote-ac .emote-ac-list{
    flex-flow:row nowrap;
    overflow:hidden;
  }
  .emote-ac .emote-ac-item{
    flex:0 0 72px;
    width:72px; height:58px;
    flex-direction:column;
    gap:3px;
    padding:4px 5px;
  }
  .emote-ac .emote-ac-item img{
    width:32px; height:32px;
  }
  .emote-ac .emote-label{
    display:block;
    width:100%;
    color:#ddd; font-size:11px; line-height:13px; text-align:center;
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
  }

  .emote-ac-item{
    display:flex; align-items:center; justify-content:center;
    background:#1e1e1e; border:1px solid rgba(255,255,255,.08);
    border-radius:8px; padding:4px; cursor:pointer;
    width:40px; height:40px; user-select:none;
  }
  .emote-ac-item img{ width:100%; height:100%; object-fit:contain; border-radius:6px }
  .emote-ac-item .emote-ac-glyph{ font-size:24px; line-height:1 }
  .emote-ac-item.active{ outline:2px solid #e53935 }

`;
  document.head.appendChild(st);
}

export function attachEmoteAutocomplete(panel, input) {
  injectAutocompleteStyles();

  const ac = document.createElement('div');
  ac.id = 'emote-ac';
  ac.className = 'emote-ac';
  ac.innerHTML = `<div class="emote-ac-list"></div>`;
  document.body.appendChild(ac);
  const listEl = ac.querySelector('.emote-ac-list');
  input.addEventListener('lyve:composer-sent', () => hide());

  let candidates = [];
  let active = 0;
  let tokenInfo = null; // { start, end, mode: 'colon'|'word' }
  // The completed suffix is only a preview. Keep the user's original fragment
  // so Tab can cycle without narrowing the search to the previewed name.
  let tokenPreview = null; // { start, previewEnd, restoreText, mode }
  const pageSize = 5;

  function restoreTokenPreview() {
    if (!tokenPreview) return;
    const { start, previewEnd, restoreText } = tokenPreview;
    input.setRangeText(restoreText, start, previewEnd, 'end');
    input.setSelectionRange(start + restoreText.length, start + restoreText.length);
    tokenPreview = null;
  }

  function hide({ restorePreview = false } = {}) {
    if (restorePreview) restoreTokenPreview();
    ac.style.display = 'none';
    candidates = [];
    active = 0;
    tokenInfo = null;
    tokenPreview = null;
  }

  function previewActiveToken() {
    if (!tokenPreview || !candidates[active]) return;
    const c = candidates[active];
    const { start, restoreText, mode } = tokenPreview;
    const previewText = mode === 'colon' ? `:${c.name}` : c.name;

    input.setRangeText(previewText, start, tokenPreview.previewEnd, 'end');
    tokenPreview.previewEnd = start + previewText.length;

    // Selecting only the suggested suffix makes the full name visible while
    // keeping the characters the user actually typed as the stable filter.
    const suffixStart = start + restoreText.length;
    input.setSelectionRange(suffixStart, tokenPreview.previewEnd);
  }

  function beginTokenPreview(q) {
    if (!q || !candidates.length) return;
    tokenPreview = {
      start: q.start,
      previewEnd: q.end,
      restoreText: q.mode === 'colon' ? `:${q.text}` : q.text,
      mode: q.mode
    };
    previewActiveToken();
  }

  function choose(idx) {
    if (!tokenInfo || !candidates[idx]) return;
    const c = candidates[idx];
    const start = tokenPreview?.start ?? tokenInfo.start;
    const end = tokenPreview?.previewEnd ?? tokenInfo.end;
    input.setSelectionRange(start, end);       // replace current token
    insertTokenWithSpaces(input, c.char || c.name); // emoji inserts its glyph
    recordEmoteUse(c.char
      ? { type: 'basic', name: c.name, char: c.char }
      : { type: '7tv', name: c.name, url: c.url });
    tokenPreview = null;
    hide();
  }

  function cycle(dir) {
    if (!candidates.length) return;
    const n = candidates.length;
    active = (active + (dir % n) + n) % n;
    render(); // re-render page or keep active row in view
    previewActiveToken();
  }

  function render() {
    listEl.innerHTML = '';
    // Five-at-a-time horizontal pager for both input styles.
    const start = Math.floor(active / pageSize) * pageSize;
    const page = candidates.slice(start, start + pageSize);
    page.forEach((c, i) => {
      const gIdx = start + i;
      const el = document.createElement('div');
      el.className = 'emote-ac-item' + (gIdx === active ? ' active' : '');
      if (c.url) {
        const img = document.createElement('img');
        img.src = c.url; img.alt = c.name; img.title = c.name;
        el.appendChild(img);
      } else if (c.char) {
        const glyph = document.createElement('span');
        glyph.className = 'emote-ac-glyph';
        glyph.textContent = c.char;
        el.appendChild(glyph);
      }
      const label = document.createElement('span');
      label.className = 'emote-label';
      label.textContent = c.name;
      el.appendChild(label);
      el.addEventListener('click', () => choose(gIdx));
      listEl.appendChild(el);
    });
  }

  function open(list, tInfo) {
    candidates = list;
    active = 0;
    tokenInfo = tInfo;
    if (!candidates.length) return hide();

    // set orientation first so height measures correctly
    if (tokenInfo?.mode === 'colon') ac.classList.add('up');
    else ac.classList.remove('up');

    render();

    const r = input.getBoundingClientRect();
    const vw = innerWidth, vh = innerHeight, pad = 8;

    ac.style.display = 'block';
    const w = ac.offsetWidth, h = ac.offsetHeight;

    let left = Math.max(pad, Math.min(r.left + 8, vw - w - pad));
    let top;
    if (tokenInfo?.mode === 'colon') {
      // stack upwards (fall back below if not enough room)
      top = r.top - h - 6;
      if (top < pad) top = Math.max(pad, r.bottom + 6);
    } else {
      // default below the input
      top = r.bottom + 6;
      if (top + h + pad > vh) top = Math.max(pad, r.top - h - 6);
    }
    ac.style.left = `${left}px`;
    ac.style.top  = `${top}px`;
  }

  function queryFromInput() {
    const v = input.value;
    const pos = input.selectionStart ?? v.length;

    // colon mode: ":KE" — we replace from the colon to caret
    const lastColon = v.lastIndexOf(':', pos - 1);
    if (lastColon !== -1) {
      const end = pos;
      const start = lastColon + 1; // after ':'
      const text = v.slice(start, end);
      if (/^[A-Za-z0-9_]{0,30}$/.test(text)) {
        return { mode: 'colon', text, start: lastColon, end };
      }
    }

    // word mode: "KE"
    const m = v.slice(0, pos).match(/([A-Za-z0-9_]{1,30})$/);
    if (m) {
      const end = pos;
      const start = end - m[1].length;
      return { mode: 'word', text: m[1], start, end };
    }
    return null;
  }

  function listCandidates(prefix) {
    const ems = (typeof SevenTV !== 'undefined' && typeof SevenTV.listEmotes === 'function')
      ? SevenTV.listEmotes() : [];
    const raw = prefix;            // original casing as typed
    const p = prefix.toLowerCase();
    return ems
      .filter(e => e.name && e.name.toLowerCase().startsWith(p))
      .sort((a, b) => {
        const aName = a.name, bName = b.name;
        const aLow = aName.toLowerCase(), bLow = bName.toLowerCase();
        // 1) Prefer emotes whose casing matches what was typed ("SAD" -> SADKEK
        //    before sadge), so Tab doesn't surface a lowercase variant first.
        const aCase = aName.startsWith(raw), bCase = bName.startsWith(raw);
        if (aCase !== bCase) return aCase ? -1 : 1;
        // 2) Exact (case-insensitive) name match.
        if ((aLow === p) !== (bLow === p)) return aLow === p ? -1 : 1;
        // 3) Shorter/base name before extensions such as SadgeCry.
        if (aName.length !== bName.length) return aName.length - bName.length;
        // 4) Alphabetical, numeric-aware.
        return aLow.localeCompare(bLow, undefined, { numeric: true });
      })
      .map(e => ({ name: e.name, url: e.url || (Array.isArray(e.urls) ? e.urls[0] : null) }));
  }

  // Colon mode also matches emojis by name/keyword (emojis listed first); plain
  // word mode stays 7TV-only so bare words never become emojis.
  function candidatesFor(q) {
    const seven = listCandidates(q.text);
    if (q.mode !== 'colon') return seven;
    return [...searchEmoji(q.text), ...seven];
  }

  // Keep popup live while editing
  function updateFromCaret() {
    const q = queryFromInput();
    if (!q) { hide(); return; }
    if (!q.text || q.text.length === 0) { hide(); return; }
    const list = candidatesFor(q);
    if (list.length) open(list, q);
    else hide();
  }

  // Live update if it’s already open
  // Keep it in sync AND (re)open when typing into a token
// Typing behavior:
// - In colon mode (":k"), open/update live.
// - In word mode, only refresh if popup is already open (never auto-open on typing).
input.addEventListener('input', () => {
  // A typed character replaces the selected preview suffix. That edit becomes
  // the new real prefix and starts a fresh search session.
  if (tokenPreview) tokenPreview = null;
  const q = queryFromInput();
  if (!q) { hide(); return; }

  if (q.mode === 'colon') {
    // Require at least 1 char after ":" to show results
    if (q.text && q.text.length > 0) {
      const list = candidatesFor(q);
      if (list.length) open(list, q); else hide();
    } else {
      hide(); // bare ":" -> keep closed
    }
    return;
  }

  // word mode: only update if already open (e.g., user opened via Tab)
  if (ac.style.display === 'block') {
    const list = candidatesFor(q);
    if (list.length) open(list, q); else hide();
  } else {
    // keep closed while typing plain words
    if (!q.text || q.text.length === 0) hide();
  }
});

  // Key handling: Tab previews/cycles; Space commits in either input mode.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !e.shiftKey) {
  if (tokenPreview && ac.style.display === 'block') {
    e.preventDefault();
    cycle(+1);
    return;
  }
  const q = queryFromInput();
  if (!q) return; // let Tab behave normally outside tokens

  // Only allow opening if we have a prefix; don't open on bare ':'
  const hasPrefix = (q.mode !== 'colon') || (q.text && q.text.length > 0);
  if (!hasPrefix && ac.style.display !== 'block') return;

  e.preventDefault();
  if (ac.style.display !== 'block') {
    open(listCandidates(q.text), q);
    if (ac.style.display === 'block') beginTokenPreview(q);
  } else if (!tokenPreview) {
    // Typing over a preview creates a new prefix. The next Tab previews the
    // first match for that new prefix instead of skipping ahead.
    open(listCandidates(q.text), q);
    if (ac.style.display === 'block') beginTokenPreview(q);
  } else {
    cycle(+1); // cycle forward
  }
  return;
}
    if (e.key === 'Tab' && e.shiftKey && ac.style.display === 'block') {
      e.preventDefault();
      if (!tokenPreview) {
        const q = queryFromInput();
        if (q) beginTokenPreview(q);
      }
      cycle(-1);
      return;
    }
    if (e.key === ' ' && ac.style.display === 'block') {
      e.preventDefault();
      choose(active);
      return;
    }
    if (e.key === 'Enter' && tokenPreview && ac.style.display === 'block') {
      // Do not let an unaccepted preview get sent as though it were committed.
      e.preventDefault();
      e.stopImmediatePropagation();
      hide({ restorePreview: true });
      return;
    }
    if (e.key === 'Escape' && ac.style.display === 'block') {
      e.preventDefault();
      hide({ restorePreview: true });
      return;
    }
    if (e.key === 'Backspace' && ac.style.display === 'block') {
      // after DOM updates, recompute; close if token vanished
      setTimeout(updateFromCaret, 0);
      return;
    }
    if (e.key === ':') {
  // Wait until at least one char follows the colon before opening
  setTimeout(() => {
    const q = queryFromInput();
    if (q && q.mode === 'colon' && q.text && q.text.length > 0) {
      const list = candidatesFor(q);
      if (list.length) open(list, q);
      else hide();
    } else {
      hide(); // close on bare ':' or when leaving colon-mode
    }
  }, 0);
}
  }, true);

  // Close on outside click
  document.addEventListener('click', (ev) => {
    if (ac.style.display === 'block' && !ac.contains(ev.target)) {
      hide({ restorePreview: true });
    }
  }, true);
}

// --- SevenTV namespace: load + list + replace ------------------------------
export const SevenTV = (() => {
  let _emotes = []; // [{name, url}]

  function listEmotes() {
    return _emotes;
  }

  function _bestUrlFromFiles(files, base) {
    // pick a decent size; fall back sanely
    if (!Array.isArray(files) || !base) return null;
    // prefer 2x if available, else biggest
    const f2 = files.find(f => f.scale === "2x") || files.at(-1);
    return f2 ? `${base}/${f2.name}` : null;
  }

  async function _loadSetById(setId) {
    const r = await fetch(`https://7tv.io/v3/emote-sets/${setId}`);
    if (!r.ok) throw new Error("7tv set fetch failed");
    const js = await r.json();
    const base = js?.emotes?.map?.(e => {
      const host = e?.data?.host;
      const urlBase = host?.url?.startsWith("http") ? host.url : (host?.url ? `https:${host.url}` : null);
      const url = _bestUrlFromFiles(host?.files, urlBase);
      return url && !isBlockedCommonEmoteName(e.name) ? { name: e.name, url } : null;
    }).filter(Boolean) || [];
    _emotes = base;
  }

  async function _loadByPlatform(kind, channel) {
    const r = await fetch(`https://7tv.io/v3/users/${kind}/${encodeURIComponent(channel)}`);
    if (!r.ok) throw new Error("7tv user fetch failed");
    const js = await r.json();
    const setId = js?.emote_set?.id || js?.emote_set?.emotes ? js.emote_set.id : null;
    if (!setId) { _emotes = []; return; }
    await _loadSetById(setId);
  }

  async function loadFromSettings() {
    try {
      const enabledRaw = localStorage.getItem('chatEnable7tv');
      const enabled = (enabledRaw === null) ? true : (enabledRaw === 'true' || enabledRaw === true);
      if (!enabled) { _emotes = []; return; }

      let src = localStorage.getItem('chat7tvSource');
      if (!src) {
        // DEFAULT_7TV_SOURCE exported above in this module
        src = typeof DEFAULT_7TV_SOURCE !== 'undefined' ? DEFAULT_7TV_SOURCE : '';
      }
      if (!src) { _emotes = []; return; }

      if (src.startsWith('set:')) {
        await _loadSetById(src.slice(4));
      } else if (src.startsWith('twitch:')) {
        await _loadByPlatform('twitch', src.slice(7));
      } else if (src.startsWith('youtube:')) {
        await _loadByPlatform('youtube', src.slice(8));
      } else {
        _emotes = []; // unknown source format
      }
    } catch {
      _emotes = [];
    }
  }

  // Replace tokens in text with <img> nodes. Keeps plain text for unknown tokens.
function replaceToFragment(text) {
  const frag = document.createDocumentFragment();
  if (!text) return frag;

  const parts = text.split(/(\s+)/);
  const map = new Map(_emotes.filter(e => !isBlockedCommonEmoteName(e.name)).map(e => [e.name, e.url]));

  for (const p of parts) {
    if (p.trim().length && map.has(p)) {
      const img = document.createElement('img');
      img.src = map.get(p);
      img.alt = p;
      img.title = p;
      img.className = 'lyve-emote';
      frag.appendChild(img);
    } else {
      frag.appendChild(document.createTextNode(p));
    }
  }
  return frag;
}

  // Kick an initial async load (non-blocking)
  loadFromSettings().catch(() => {});

  return { listEmotes, replaceToFragment, loadFromSettings };
})();
