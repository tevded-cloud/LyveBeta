// modules/usernameFilter.js
//
// Blocks offensive usernames at signup while allowing innocent words that merely
// contain a substring (assassin, class, cockpit). Twitch/Kick-level strictness:
// strong profanity and slurs are blocked; mild words (ass, hell, damn) are not,
// so "assassin" is fine but "assfuckloser9000" is not.
//
// CAVEAT: this runs client-side and is bypassable by a custom client. True
// enforcement needs a server / Cloud Function (see project task #21).

// Leetspeak / obfuscation map (mirrors the chat moderation lexicon).
const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '!': 'i' };

// Normalize: fold leetspeak, then strip everything but letters so separators and
// numbers can't be used to dodge the match ("a$$_f4ck.99" -> "assfack"... etc.).
function normalizeUsername(value) {
  return String(value || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[013457@$!]/g, character => LEET[character] || character)
    .replace(/[^a-z]/g, '');
}

// Strong profanity + slurs, matched as substrings after normalization. Mild
// words (ass, hell, damn, crap) are intentionally excluded to avoid false
// positives like "assassin", "class", "bass".
const BLOCKLIST = [
  'fuck', 'fuk', 'cunt', 'shit', 'bitch', 'slut', 'whore', 'pussy', 'dick', 'cock',
  'bastard', 'dildo', 'jizz', 'twat', 'wank', 'prick', 'asshole', 'dickhead',
  'blowjob', 'handjob', 'cumshot', 'shithead', 'douchebag',
  'faggot', 'fag', 'nigger', 'nigga', 'retard', 'tranny', 'kike', 'spic', 'chink',
  'gook', 'beaner', 'coon', 'wetback', 'dyke', 'jiggaboo', 'towelhead', 'raghead',
];

// Innocent words that contain a blocked substring — removed before matching so
// they aren't flagged. Grow this over time as false positives surface.
const ALLOWLIST = [
  'cockpit', 'cocktail', 'peacock', 'hancock', 'hitchcock', 'alcock', 'babcock',
  'shuttlecock', 'woodcock', 'gamecock', 'cockney', 'cockle', 'cockroach',
  'stopcock', 'cockatoo', 'cockatiel', 'dickens', 'dickinson', 'dickie', 'dickson',
  'dicky', 'shitake', 'scunthorpe', 'penistone', 'fukuoka', 'fukushima', 'fage',
  'fagin',
];

// Returns a rejection message if the username is not allowed, else null.
export function getUsernameRejection(name) {
  const normalized = normalizeUsername(name);
  if (!normalized) return null;
  let scrubbed = normalized;
  for (const safe of ALLOWLIST) scrubbed = scrubbed.split(safe).join('');
  if (BLOCKLIST.some(term => scrubbed.includes(term))) {
    return "That username isn't allowed — please choose another.";
  }
  return null;
}

// --- Per-viewer message profanity filtering (opt-in) --------------------------

function isWordProfane(word) {
  let normalized = normalizeUsername(word);
  if (!normalized) return false;
  for (const safe of ALLOWLIST) normalized = normalized.split(safe).join('');
  return BLOCKLIST.some(term => normalized.includes(term));
}

export function messageHasProfanity(text) {
  return String(text || '').split(/\s+/).some(isWordProfane);
}

// Replace the letters of any profane word with asterisks, preserving spacing
// and punctuation ("what the fuck!" -> "what the ****!").
export function censorMessageText(text) {
  return String(text || '').replace(/\S+/g, word =>
    isWordProfane(word) ? word.replace(/[A-Za-z0-9@$!]/g, '*') : word);
}
