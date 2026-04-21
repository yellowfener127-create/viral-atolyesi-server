const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const crush = require('./crush-pipeline');

const app = express();
app.use(cors());
app.use(express.json({ limit: '256kb' }));

const PORT = process.env.LOCAL_DOWNLOADER_PORT || 8787;
const DEFAULT_DIR = path.join(process.env.USERPROFILE || process.cwd(), 'Videos', 'Viral Atölyesi İndirilenler');
const DOWNLOAD_DIR = process.env.VA_DOWNLOAD_DIR || DEFAULT_DIR;
const PUBLIC_DIR = path.join(__dirname, 'public');
/** Önizleme kare çıkarımı: sabit 1000×1000 letterbox (analiz / hizalama). */
const GEMINI_ANALYSIS_PX = 1000;
const YTDLP_NET_ARGS = [
  '--retries', '8',
  '--fragment-retries', '8',
  '--file-access-retries', '3',
  '--retry-sleep', 'fragment:2',
  '--socket-timeout', '20',
  '--force-ipv4',
  '--concurrent-fragments', '1'
];

/** yt-dlp: YouTube için — cookies.txt veya tarayıcıdan çerez (ortam değişkeni) */
function ytdlpCookieCliArgs() {
  const file = String(process.env.YTDLP_COOKIES_FILE || process.env.YOUTUBE_COOKIES_FILE || '').trim();
  if (file && fs.existsSync(file)) return ['--cookies', file];
  const browser = String(process.env.YTDLP_COOKIES_FROM_BROWSER || '').trim();
  if (browser) return ['--cookies-from-browser', browser];
  return [];
}

function isYoutubeAgeSignInError(msg) {
  const m = String(msg || '').toLowerCase();
  return /sign in to confirm your age|confirm your age|age-restricted|inappropriate for some users|login required/i.test(m);
}
function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function stripJsonFences(s) {
  const t = String(s || '').trim();
  const m = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return (m && m[1]) ? m[1].trim() : t;
}

function escapeRegExp(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeJsonLikeString(s) {
  return String(s || '')
    .replace(/\r/g, '')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '')
    .replace(/\\t/g, ' ')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
    .trim();
}

function extractBalancedJsonObject(text) {
  const src = String(text || '');
  const start = src.indexOf('{');
  if (start < 0) return '';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1).trim();
    }
  }
  return src.slice(start).trim();
}

function extractJsonLikeStringField(src, key) {
  const re = new RegExp(`["']${escapeRegExp(key)}["']\\s*:\\s*["']`, 'i');
  const m = re.exec(String(src || ''));
  if (!m) return '';
  let i = m.index + m[0].length;
  let out = '';
  let escaped = false;
  while (i < src.length) {
    const ch = src[i];
    if (escaped) {
      out += ch;
      escaped = false;
      i += 1;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      escaped = true;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") break;
    out += ch;
    i += 1;
  }
  return decodeJsonLikeString(out);
}

function extractJsonLikeNumberField(src, key) {
  const m = String(src || '').match(new RegExp(`["']${escapeRegExp(key)}["']\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`, 'i'));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function parseLooseBoxFragment(fragment) {
  const x = extractJsonLikeNumberField(fragment, 'x');
  const y = extractJsonLikeNumberField(fragment, 'y');
  const w = extractJsonLikeNumberField(fragment, 'w');
  const h = extractJsonLikeNumberField(fragment, 'h');
  if (![x, y, w, h].every(Number.isFinite)) return null;
  const text = extractJsonLikeStringField(fragment, 'text');
  const kind = extractJsonLikeStringField(fragment, 'kind');
  return {
    x, y, w, h,
    ...(text ? { text } : {}),
    ...(kind ? { kind } : {})
  };
}

function extractJsonLikeBoxField(src, key) {
  const idx = String(src || '').toLowerCase().indexOf(`"${String(key || '').toLowerCase()}"`);
  if (idx < 0) return null;
  const tail = String(src || '').slice(idx, idx + 260);
  const frag = tail.match(/\{[\s\S]*?\}/);
  return frag ? parseLooseBoxFragment(frag[0]) : null;
}

function extractJsonLikeBoxArrayField(src, key, maxItems = 6) {
  const idx = String(src || '').toLowerCase().indexOf(`"${String(key || '').toLowerCase()}"`);
  if (idx < 0) return [];
  const tail = String(src || '').slice(idx, idx + 1200);
  const arrStart = tail.indexOf('[');
  if (arrStart < 0) return [];
  const arrChunk = tail.slice(arrStart, tail.includes(']') ? tail.indexOf(']') + 1 : undefined);
  const fragments = arrChunk.match(/\{[^{}]{0,240}\}/g) || [];
  const out = [];
  for (const frag of fragments) {
    const box = parseLooseBoxFragment(frag);
    if (!box) continue;
    out.push(box);
    if (out.length >= maxItems) break;
  }
  return out;
}

function extractJsonLikeStringArrayField(src, key, maxItems = 8) {
  const idx = String(src || '').toLowerCase().indexOf(`"${String(key || '').toLowerCase()}"`);
  if (idx < 0) return [];
  const tail = String(src || '').slice(idx, idx + 800);
  const arrStart = tail.indexOf('[');
  if (arrStart < 0) return [];
  const arrChunk = tail.slice(arrStart, tail.includes(']') ? tail.indexOf(']') + 1 : undefined);
  const out = [];
  const re = /"((?:\\.|[^"\\])*)"/g;
  let m;
  while ((m = re.exec(arrChunk)) && out.length < maxItems) {
    const item = decodeJsonLikeString(m[1]);
    if (!item) continue;
    out.push(item);
  }
  return out;
}

function extractHashtagsFromText(text, maxItems = 8) {
  const tags = String(text || '').match(/#[a-z0-9_]+/gi) || [];
  const out = [];
  const seen = new Set();
  for (const t of tags) {
    const clean = String(t || '').toLowerCase();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= maxItems) break;
  }
  return out;
}

function stripHashtagsFromText(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/(^|\s)#[a-z0-9_]+/gi, ' ').replace(/[|]+/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function splitCaptionPayload(text) {
  const raw = stripEmoji(String(text || '').trim());
  return {
    caption: stripHashtagsFromText(raw),
    hashtags: extractHashtagsFromText(raw)
  };
}

function toSingleSentenceCaption(text) {
  let s = stripHashtagsFromText(String(text || '').trim())
    .replace(/\r/g, '')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '';
  s = s.replace(/[!?]+/g, '.');
  const first = s.split(/[.]+/).map((p) => p.trim()).filter(Boolean)[0] || s;
  const out = first.replace(/[!?]+/g, '').trim();
  return out ? `${out}.` : '';
}

function pickOne(arr) {
  if (!arr || !arr.length) return '';
  return arr[Math.floor(Math.random() * arr.length)];
}

function getDirectorCachePath() {
  return path.join(DOWNLOAD_DIR, '.va_director_cache_v1.json');
}

function loadDirectorCache() {
  try {
    const p = getDirectorCachePath();
    if (!fs.existsSync(p)) return { hooks: [], captions: [] };
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return {
      hooks: Array.isArray(j.hooks) ? j.hooks : [],
      captions: Array.isArray(j.captions) ? j.captions : []
    };
  } catch {
    return { hooks: [], captions: [] };
  }
}

function saveDirectorCache(cache) {
  try {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
    fs.writeFileSync(getDirectorCachePath(), JSON.stringify(cache || {}, null, 2), 'utf8');
  } catch {}
}

function normTextKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function isRecentlyUsed(list, text, windowSize = 160) {
  const key = normTextKey(text);
  if (!key) return false;
  const recent = (list || []).slice(-windowSize);
  return recent.includes(key);
}

function rememberUsed(cache, kind, text, maxKeep = 400) {
  const key = normTextKey(text);
  if (!key) return;
  if (!cache[kind]) cache[kind] = [];
  cache[kind].push(key);
  if (cache[kind].length > maxKeep) cache[kind] = cache[kind].slice(-maxKeep);
}

function makeVideoSpecificHashtagFromHook(hookText) {
  const stop = new Set([
    'the','a','an','and','or','to','of','in','on','for','with','this','that','these','those',
    'is','are','was','were','be','been','being','so','too','very','just','really','crazy','best',
    'wait','watch','ending','end','moment','moments','ranking','ranked','top','baby','dads','dad'
  ]);
  const words = String(hookText || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s#]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter(w => !stop.has(w) && !/^#/.test(w));
  const w = words[0] || '';
  const cleaned = w.replace(/[^a-z0-9]/g, '');
  if (!cleaned) return '#viral';
  return ('#' + cleaned).slice(0, 24);
}

function brandNicheHashtag(brand) {
  const b = String(brand || 'terapi').toLowerCase();
  if (b === 'kaos') return '#chaos';
  if (b === 'umut') return '#motivation';
  return '#therapy';
}

function ensureStartsWithHash(tag) {
  const s = String(tag || '').trim().toLowerCase().replace(/[^a-z0-9_#]/g, '');
  if (!s) return '';
  return s.startsWith('#') ? s : `#${s}`;
}

function ensureHashtagPack(brand, hookText, hashtags) {
  const generic3 = ['#viral', '#kesfet', '#trending'];
  const brandTag = brandNicheHashtag(brand);
  const incoming = Array.isArray(hashtags) ? hashtags.map(ensureStartsWithHash).filter(Boolean) : [];

  const rankedSignal = /(^|\s)(ranked|ranking|top\s*\d|#\s*1|#1|1\.)/i.test(String(hookText || '')) ||
    incoming.some((t) => /^#ranked$/i.test(t));

  let specific = '';
  if (rankedSignal) {
    specific = '#ranked';
  } else {
    specific = incoming.find((t) =>
      t &&
      !generic3.includes(t) &&
      t !== brandTag &&
      t !== '#fyp'
    ) || makeVideoSpecificHashtagFromHook(hookText);
  }
  specific = ensureStartsWithHash(specific) || '#video';
  if (generic3.includes(specific) || specific === brandTag) specific = '#video';

  const out = [...generic3, brandTag, specific];
  const uniq = [];
  const seen = new Set();
  for (const t of out) {
    const k = String(t).toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    uniq.push(k);
  }
  const filler = ['#reels', '#explore', '#shorts', '#video'];
  for (const f of filler) {
    if (uniq.length >= 5) break;
    if (!seen.has(f)) {
      seen.add(f);
      uniq.push(f);
    }
  }
  return uniq.slice(0, 5);
}

function makeUniqueHook(brand, base, cache, isListicle) {
  const b = String(brand || 'terapi').toLowerCase();
  const core = String(base || '').trim();
  // Ranked/#1 gibi listicle hook'ları istemiyoruz.
  const kaos = [
    'That crash was brutal',
    'Instant regret moment',
    'This went so wrong',
    'One slip, pure chaos'
  ];
  const terapi = [
    'Too cute to be real',
    'This is pure joy',
    'The sweetest little moment',
    'My heart can’t handle this'
  ];
  const umut = [
    'This is why hope matters',
    'Humanity still wins',
    'A win you can feel',
    'Faith restored today'
  ];
  const pool = (b === 'kaos') ? kaos : (b === 'umut' ? umut : terapi);

  const candidates = [];
  if (core) candidates.push(core);
  // small structured variations to avoid repeats
  for (const p of pool) candidates.push(p);

  // pick first that is not recently used; else fall back to random
  for (const c of candidates) {
    if (!isRecentlyUsed(cache.hooks, c)) return c;
  }
  return pickOne(candidates);
}

function stripEmoji(s) {
  return String(s || '').replace(/[\p{Extended_Pictographic}\uFE0F]/gu, '').replace(/\s+/g, ' ').trim();
}

/** Caption vb. için tüm emoji kaldır */
function stripAllEmoji(s) {
  return String(s || '')
    .replace(/[\p{Extended_Pictographic}\uFE0F]/gu, '')
    .replace(/\u200D/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Kaos / meta için: emoji ayrı tutulmaz. Terapi/Umut Reels’te emoji font ile videoda kalır. */
function normalizeHookEmoji(s) {
  return { text: stripAllEmoji(String(s || '')), emoji: '' };
}

const CRUSH_EMOJI_POOL_FILE = path.join(__dirname, 'public', 'crush-emoji-pool.txt');

function loadCrushEmojiPool() {
  const fallback = ['😮', '🔥', '❤️', '✨', '👀', '🙌', '💯', '😊', '🥹', '💪', '😅', '👏', '🫶', '💫', '🤯'];
  try {
    if (!fs.existsSync(CRUSH_EMOJI_POOL_FILE)) return fallback;
    const raw = fs.readFileSync(CRUSH_EMOJI_POOL_FILE, 'utf8');
    const seen = new Set();
    const out = [];
    const re = /\p{Extended_Pictographic}(\uFE0F)?/gu;
    for (const line of raw.split(/\n/)) {
      const ln = line.trim();
      if (!ln || ln.startsWith('#')) continue;
      let m;
      const iter = ln.matchAll(re);
      for (m of iter) {
        const tok = m[0];
        if (tok && !seen.has(tok)) {
          seen.add(tok);
          out.push(tok);
        }
      }
    }
    return out.length ? out : fallback;
  } catch {
    return fallback;
  }
}

function stripTrailingEmojiRun(s) {
  const arr = [...String(s || '').trim()];
  while (arr.length) {
    const c = arr[arr.length - 1];
    if (/\s/.test(c) || /[\p{Extended_Pictographic}]/u.test(c) || c === '\uFE0F' || c === '\u200D') {
      arr.pop();
      continue;
    }
    break;
  }
  return arr.join('').trim();
}

/** Sonda tam olarak havuzdan bir emoji olsun (Gemini kaçarsa veya kutu emoji ise düzelt). */
function ensureHookUsesPoolEmoji(text, pool) {
  if (!pool || !pool.length) return String(text || '').trim();
  let s = String(text || '').trim();
  if (!s) return s;
  const uniq = [...new Set(pool)];
  const sorted = uniq.sort((a, b) => b.length - a.length);
  for (const e of sorted) {
    if (e && s.endsWith(e)) return s;
  }
  // Gemini havuz dışı emoji eklediyse veya hiç eklemediyse: sondaki emoji/boşlukları temizle.
  s = stripTrailingEmojiRun(s);
  return `${s} ${pickOne(uniq)}`.trim();
}

function stripBannedHookWords(text) {
  // Hard-ban "ignore" everywhere (any casing, standalone).
  return String(text || '')
    .replace(/\bignore\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Yarım kalmış başlık: son kelime yardımcı fiil/bağlaç ile bitmesin */
function hookFeelsComplete(textNoEmoji) {
  const w = normTextKey(textNoEmoji).split(/\s+/).filter(Boolean);
  if (w.length < 3) return false;
  const last = w[w.length - 1];
  const badLast = new Set([
    'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'has', 'have', 'had', 'does', 'do', 'did',
    'will', 'would', 'could', 'should', 'shall', 'may', 'might', 'must', 'can',
    'and', 'or', 'but', 'nor', 'the', 'a', 'an', 'to', 'for', 'of', 'in', 'on', 'at', 'by', 'with', 'from', 'as',
    'if', 'when', 'so', 'than', 'that', 'this', 'these', 'those', 'my', 'your', 'our', 'their', 'its',
    'no', 'not', 'very', 'too', 'up', 'out', 'off', 'only', 'just', 'even', 'more', 'most', 'least',
    'here', 'there', 'where', 'how', 'why', 'what', 'which', 'who', 'whom', 'whose', 'into', 'onto', 'too'
  ]);
  if (badLast.has(last)) return false;
  return true;
}

function makeUniqueCaption(brand, base, cache) {
  const core = String(base || '').trim();
  const pool = [
    fallbackCaptionForBrand(brand),
    'You can’t make this up',
    'I’m not okay after this',
    'This is your sign today'
  ];
  const candidates = [];
  if (core) candidates.push(core);
  candidates.push(...pool);
  for (const c of candidates) {
    if (!isRecentlyUsed(cache.captions, c)) return c;
  }
  return pickOne(candidates);
}

function looksGenericHook(s) {
  const t = normTextKey(s);
  if (!t) return true;
  const banned = [
    'wait for it',
    'wait for the end',
    'watch until the end',
    'amazing end',
    'sweet end',
    'end is crazy',
    'ending is crazy',
    'crazy',
    'viral',
    'insane'
  ];
  return banned.some((b) => t.includes(b));
}

function hookMakesSense(s) {
  const t = normTextKey(normalizeHookEmoji(String(s || '')).text);
  if (!t) return false;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 3) return false;
  // Sadece "no x" veya "not x" gibi iki kelimelik negatif parça kabul etme
  if (/^(no|not|never|nope)\s+\w+$/.test(t)) return false;
  if (/^(no|not|never|nope)\s+\w+\s+\w+$/.test(t) && words.length === 3) {
    // "No one expected" vb. 3 kelime negatifler genelde anlamlı, bunları kabul et
  }
  // Tamamen tek konu + negasyon olanları çıkar
  if (/^(no|not)\s+(mother|father|dad|mom|one|body|way|cap|idea)$/.test(t)) return false;
  // Kelimelerin hiçbiri somut değilse (en az 1 isim veya eylem gerekli)
  const anyConcrete = /\b(dog|dogs|cat|cats|baby|kid|elephant|bear|car|bike|skate|ball|stairs|door|water|pool|road|park|phone|woman|man|boy|girl|mom|mother|father|dad|team|player|ring|boxer|bird|birds|chicken|animal|animals|wild|slip|slipped|fall|fell|crash|hit|hits|drop|drops|save|saves|rescue|rescues|jumps|jump|lands|flip|flips|escape|escapes|push|pushes|throw|throws|protect|protects|catch|catches|climb|climbs|climb|runs|runs|scream|screams|cry|cries|laugh|laughs|kicks|kick|punch|punches|grabs|grab|swings|swing|spill|spills)\b/.test(t);
  return anyConcrete;
}

function extractKeywordsFromTitle(title) {
  const t = String(title || '').toLowerCase();
  const raw = t.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const stop = new Set([
    'the','a','an','and','or','to','of','in','on','for','with','this','that','these','those',
    'is','are','was','were','be','been','being','so','too','very','just','really','crazy','best',
    'wait','watch','ending','end','moment','moments','ranking','ranked','top','baby','dads','dad',
    'shorts','reels','tiktok','viral','compilation','clips'
  ]);
  const keep = [];
  for (const w of raw) {
    if (stop.has(w)) continue;
    if (w.length < 3) continue;
    keep.push(w);
    if (keep.length >= 6) break;
  }
  return keep;
}

function buildHookFromTitle({ title, isListicle }) {
  const kw = extractKeywordsFromTitle(title);
  const subject = kw[0] || '';
  if (!subject) return '';
  if (isListicle) {
    return `Best ${subject} moment — #1`;
  }
  return `${subject} moment you can't look away from`;
}

function buildFallbackCaptionFromTitle(title, isListicle = false) {
  const kw = extractKeywordsFromTitle(title);
  const topic = kw.slice(0, 2).join(' ') || 'this moment';
  const line1 = isListicle
    ? `This ranked ${topic} moment falls apart fast, follow for more ranked clips like this.`
    : pickOne([
        `This ${topic} moment goes off the rails fast and lands hard.`,
        `This ${topic} clip escalates quickly and hits with perfect timing.`,
        `This ${topic} moment unravels in seconds and stays entertaining throughout.`
      ]);
  const tags = [
    '#' + (kw[0] || 'viral'),
    '#shorts',
    '#fyp',
    '#trending',
    '#wow'
  ].map((t) => String(t).replace(/[^#a-zA-Z0-9]/g, '').toLowerCase()).filter(Boolean);
  // ensure at least 5 unique hashtags
  const uniq = [];
  const seen = new Set();
  for (const t of tags) {
    if (seen.has(t)) continue;
    seen.add(t);
    uniq.push(t);
    if (uniq.length >= 5) break;
  }
  while (uniq.length < 5) uniq.push('#viral');
  return `${line1}\n${uniq.slice(0, 5).join(' ')}`.trim();
}

function captionLooksGood(caption) {
  const s = toSingleSentenceCaption(caption);
  if (s.length < 24) return false;
  const hasBadQuestion = /\?|what would you do|rate this|rate it|1-10|1–10|would you|did you catch|wait for|watch till/i.test(s);
  return !hasBadQuestion && /^[^.!?]+[.]$/.test(s);
}

function remixHookFromOldHook(oldHookText, title, isListicle) {
  const words = stripEmoji(String(oldHookText || ''))
    .replace(/[^\p{L}\p{N}\s#]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .slice(0, 7);
  if (!words.length) return '';
  const replacements = {
    ranking: 'ranked',
    ranked: 'ranking',
    funniest: 'wildest',
    funny: 'messy',
    best: 'boldest',
    worst: 'roughest',
    challenge: 'round',
    moment: 'scene',
    moments: 'fails',
    copied: 'stole',
    make: 'build',
    word: 'phrase',
    lost: 'dropped',
    lightsaber: 'blade',
    wrong: 'sideways',
    took: 'went',
    seriously: 'too far'
  };
  let changed = 0;
  const out = words.map((w) => {
    const key = String(w || '').toLowerCase();
    if (replacements[key] && changed < 2) {
      changed += 1;
      return replacements[key];
    }
    return w;
  });
  if (changed === 0 && isListicle && out.length) {
    out[0] = out[0].toLowerCase() === 'ranking' ? 'Ranked' : 'Ranking';
  }
  return splitHookTwoLines(out.join(' '), { titleHint: title || '' });
}

function splitHookTwoLines(hookText, opts) {
  const forReels = !!(opts && opts.forReels);
  let raw = String(hookText || '')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return '';
  if (forReels) {
    raw = raw.replace(/(\p{Extended_Pictographic}\uFE0F?)/gu, ' $1 ').replace(/\s+/g, ' ').trim();
  }
  const t = forReels ? raw : stripAllEmoji(raw);
  if (!t) return '';
  const maxLen = forReels ? 78 : 52;
  let words = t
    .split(' ')
    .filter(Boolean)
    .slice(0, 7);
  words = words.map((w) => (w.length > 14 ? w.slice(0, 14) : w));
  while (words.join(' ').length > maxLen && words.length > 1) {
    words.pop();
  }
  let out = words.join(' ').trim();
  if (out.length > maxLen) {
    if (forReels) {
      const g = [...out];
      while (g.length > maxLen) g.pop();
      out = g.join('').trim();
      const sp = out.lastIndexOf(' ');
      if (sp > 28) out = out.slice(0, sp).trim();
    } else {
      out = out.slice(0, maxLen);
      const sp = out.lastIndexOf(' ');
      if (sp > 24) out = out.slice(0, sp).trim();
    }
  }
  return out;
}

async function ytDlpGetTitle(url) {
  return await new Promise((resolve) => {
    try {
      const child = spawn('yt-dlp', ['--no-playlist', ...ytdlpCookieCliArgs(), '--print', '%(title)s', url], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      const t = setTimeout(() => {
        try {
          if (process.platform === 'win32' && child.pid) {
            try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
          }
          child.kill();
        } catch {}
        resolve('');
      }, 45_000);
      child.stdout.on('data', (d) => { out += d.toString(); });
      child.on('close', () => { clearTimeout(t); resolve(String(out || '').trim()); });
      child.on('error', () => { clearTimeout(t); resolve(''); });
    } catch {
      resolve('');
    }
  });
}

function guessListicleFromTitle(title) {
  const t = String(title || '').toLowerCase();
  return /(^|\s)(top|rank|ranking|ranked|#\s*1|#1|1\.)/.test(t);
}

function fallbackHookTextForBrand(brand) {
  const b = String(brand || 'terapi').toLowerCase();
  if (b === 'kaos') {
    return pickOne([
      'Ending is unbelievable',
      'Watch for the end',
      'Did not expect that',
      'That ending hits hard'
    ]);
  }
  if (b === 'umut') {
    return pickOne([
      'This moment hits different',
      'Wait for the payoff',
      'Proof people are amazing',
      'Ending feels earned'
    ]);
  }
  return pickOne([
    'Ending is so sweet',
    'Wait for the sweet end',
    'Watch till the end',
    'Too cute to be real'
  ]);
}

async function ffmpegExtractFrame(inFile, outFile, tSec, ffmpegBin = 'ffmpeg') {
  const args = [
    '-y',
    '-ss', String(Math.max(0, tSec).toFixed(3)),
    '-i', inFile,
    '-frames:v', '1',
    // Gemini: sabit 1000×1000 letterbox — tüm bbox koordinatları bu uzayda.
    '-vf',
    `scale=${GEMINI_ANALYSIS_PX}:${GEMINI_ANALYSIS_PX}:force_original_aspect_ratio=decrease,` +
      `pad=${GEMINI_ANALYSIS_PX}:${GEMINI_ANALYSIS_PX}:(ow-iw)/2:(oh-ih)/2:color=black`,
    '-c:v', 'png',
    outFile
  ];
  await run(ffmpegBin, args, { timeoutMs: 45_000 });
}

async function ffmpegExtractAudioPreview(inFile, outFile, durSec = 10, ffmpegBin = 'ffmpeg') {
  const args = [
    '-y',
    '-i', inFile,
    '-t', String(Math.max(1, Math.min(15, durSec)).toFixed(3)),
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    // WAV: küçük ve inlineData için güvenli (PCM 16-bit mono)
    '-c:a', 'pcm_s16le',
    '-f', 'wav',
    outFile
  ];
  await run(ffmpegBin, args, { timeoutMs: 45_000 });
}

function fallbackCaptionForBrand(brand) {
  const b = String(brand || 'terapi').toLowerCase();
  if (b === 'kaos') return 'Chaos in one perfect moment';
  if (b === 'umut') return 'A small moment of hope';
  return 'This made my whole day';
}

function fallbackHashtagsForBrand(brand) {
  const b = String(brand || 'terapi').toLowerCase();
  if (b === 'kaos') return ['#fail', '#funny', '#oops', '#viral', '#chaos'];
  if (b === 'umut') return ['#hope', '#motivation', '#inspiration', '#humanity', '#viral'];
  return ['#cute', '#wholesome', '#animals', '#funny', '#viral'];
}

function normBrand(brand) {
  const b = String(brand || '').toLowerCase().trim();
  if (b === 'kaos') return 'kaos';
  if (b === 'umut') return 'umut';
  return 'terapi';
}

/**
 * Gemini (Google AI Studio key): tek satır İngilizce hook. Başarısız olursa reject.
 * Ortam: GEMINI_API_KEY ve isteğe bağlı GEMINI_MODEL (örn. gemini-2.0-flash).
 */
function fetchGeminiHookEnglish(apiKey, title, brand, emojiPool, media, modelOverride) {
  const n = normBrand(brand);
  const tone =
    n === 'umut'
      ? 'hopeful, emotional, inspiring, sincere (no graphic injury topics)'
      : 'wholesome, gentle, uplifting, family-friendly';
  const style = pickOne([
    'first-person vibe (perspective shift) WITHOUT literally saying "POV"',
    'a specific, story-like hook that hints what will happen (no generic templates)',
    'a subtle perspective twist (what you notice changes the whole moment)'
  ]);
  const pool = Array.isArray(emojiPool) ? emojiPool.filter(Boolean) : [];
  const emojiRules =
    pool.length > 0
      ? `\nAdd exactly ONE emoji at the very end of the sentence (single space before it). ` +
        `Choose that emoji ONLY from this pool: ${pool.slice(0, 100).join(' ')}\n` +
        `No other emoji, and no emoji in the middle of the sentence.`
      : '';
  const prompt =
    `Write a video-specific English hook for a vertical Shorts/Reels/TikTok video.\n` +
    `It must feel like it matches THIS video (avoid generic templates like "watch till the end").\n` +
    `Style: ${style}.\n` +
    `Important: Do NOT start with "POV:" and do NOT use the word "POV" unless it is truly necessary.\n` +
    `Banned words: do NOT use the word "ignore" in any form.\n` +
    `Rules: max 55 characters total (including spaces + the final emoji). ` +
    `No quotation marks. No hashtags. English only.\n` +
    `Tone: ${tone}.\n` +
    `Video title (may be vague): ${String(title || '').slice(0, 220)}\n` +
    `Use the provided screenshot(s) + audio preview to make it specific.\n` +
    emojiRules +
    `\nReturn only the hook sentence, nothing else.`;
  const model = String(modelOverride || process.env.GEMINI_MODEL || 'gemini-1.5-flash').trim();
  const parts = [{ text: prompt }];
  try {
    const fs = require('fs');
    if (media && media.framePng && fs.existsSync(media.framePng)) {
      const b = fs.readFileSync(media.framePng);
      parts.push({ inlineData: { mimeType: 'image/png', data: b.toString('base64') } });
    }
    if (media && media.audioWav && fs.existsSync(media.audioWav)) {
      const b = fs.readFileSync(media.audioWav);
      // Keep it small: Gemini accepts short audio previews.
      parts.push({ inlineData: { mimeType: 'audio/wav', data: b.toString('base64') } });
    }
  } catch {}

  const body = JSON.stringify({
    contents: [{ parts }],
    generationConfig: { temperature: 0.85, maxOutputTokens: 96 }
  });
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'generativelanguage.googleapis.com',
        path: `/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: 28_000
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => {
          raw += c.toString();
        });
        res.on('end', () => {
          try {
            const j = JSON.parse(raw);
            const errMsg = j && (j.error && (j.error.message || j.error.status)) ? String(j.error.message || j.error.status) : '';
            if (res.statusCode && res.statusCode >= 400) {
              const e = new Error(errMsg || `Gemini HTTP ${res.statusCode}`);
              e.statusCode = res.statusCode;
              e.raw = raw;
              e.model = model;
              e.geminiError = (j && j.error) ? j.error : null;
              return reject(e);
            }
            const t =
              (j &&
                j.candidates &&
                j.candidates[0] &&
                j.candidates[0].content &&
                j.candidates[0].content.parts &&
                j.candidates[0].content.parts.map((p) => p.text || '').join('')) ||
              '';
            const line = String(t)
              .replace(/\s+/g, ' ')
              .replace(/^["']|["']$/g, '')
              .trim()
              .replace(/\bignore\b/gi, '')
              .replace(/\s+/g, ' ')
              .slice(0, 120);
            if (line.length >= 6) return resolve(line);
            {
              const e = new Error('Gemini empty hook');
              e.statusCode = res.statusCode || 200;
              e.raw = raw;
              e.model = model;
              return reject(e);
            }
          } catch (e) {
            try {
              e.raw = raw;
              e.statusCode = res.statusCode;
              e.model = model;
            } catch {}
            return reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function getBrandFolderName(brand) {
  const n = normBrand(brand);
  if (n === 'kaos') return 'Chaos Lab';
  if (n === 'umut') return 'Hope Lab';
  return 'Therapy Lab';
}

function getBrandDir(brand) {
  // Araç çıktıları: brand'e göre alt klasöre yaz
  return path.join(DOWNLOAD_DIR, getBrandFolderName(brand));
}

/** Telif Ezici: Kaos / Terapi / Umut için PNG yolu. İşlem hattı Terapi ile aynı; sadece bu dosya değişir. */
function crushWatermarkPngPath(brand) {
  const n = normBrand(brand);
  const name =
    n === 'kaos' ? 'watermark-kaos.png' : n === 'umut' ? 'watermark-umut.png' : 'watermark-terapi.png';
  return path.join(PUBLIC_DIR, name);
}

function existsOnPath(cmd) {
  try {
    const isWin = process.platform === 'win32';
    const probe = spawn(isWin ? 'where' : 'which', [cmd], { stdio: ['ignore', 'ignore', 'ignore'] });
    return new Promise((resolve) => probe.on('close', (code) => resolve(code === 0)));
  } catch {
    return Promise.resolve(false);
  }
}

function safeName(s) {
  return String(s || 'video')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180) || 'video';
}

function run(bin, args, { timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer =
      timeoutMs && timeoutMs > 0
        ? setTimeout(() => {
            try {
              if (process.platform === 'win32' && child.pid) {
                try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
              }
              child.kill();
            } catch {}
          }, timeoutMs)
        : null;

    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 120_000) stderr = stderr.slice(-120_000);
    });
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) return resolve({ stderr });
      reject(new Error(stderr || `exit ${code}`));
    });
  });
}

function pickNewestFile(dir, exts) {
  const files = fs.readdirSync(dir)
    .map((f) => path.join(dir, f))
    .filter((p) => fs.statSync(p).isFile());
  const picked = files
    .map((p) => ({ p, m: fs.statSync(p).mtimeMs, s: fs.statSync(p).size }))
    .filter((x) => x.s > 0 && (!exts || !exts.length || exts.includes(path.extname(x.p).toLowerCase())))
    .sort((a, b) => b.m - a.m)[0];
  return picked ? picked.p : null;
}

function randRange(min, max) {
  const a = Number(min), b = Number(max);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return min;
  return a + Math.random() * (b - a);
}

function clamp(n, lo, hi) {
  const x = Number(n);
  if (!Number.isFinite(x)) return lo;
  return Math.min(hi, Math.max(lo, x));
}

function clampInt(n, lo, hi) {
  const x = Math.round(Number(n));
  if (!Number.isFinite(x)) return lo;
  return Math.min(hi, Math.max(lo, x));
}

/** ffprobe → ilk video akışı genişlik/yükseklik */
async function probeVideoStreamSize(filePath, ffprobeBin = 'ffprobe') {
  const args = [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-of', 'csv=p=0',
    filePath
  ];
  const child = spawn(ffprobeBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  return await new Promise((resolve) => {
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code !== 0) return resolve(null);
      const parts = String(out || '').trim().split(',');
      const width = Number(parts[0]);
      const height = Number(parts[1]);
      if (!Number.isFinite(width) || !Number.isFinite(height) || width < 16 || height < 16) return resolve(null);
      resolve({ width: Math.round(width), height: Math.round(height) });
    });
  });
}

/** Letterbox 1000×1000 analiz karesindeki (ax,ay) → kaynak video (ix,iy) oranları; sonra çıktı crop (outW×outH). */
function mapAnalysisPointToOut(ax, ay, inW, inH, outW, outH) {
  const Wk = GEMINI_ANALYSIS_PX;
  const sA = Math.min(Wk / inW, Wk / inH);
  const fitW = inW * sA;
  const fitH = inH * sA;
  const padX = (Wk - fitW) / 2;
  const padY = (Wk - fitH) / 2;
  const ix = clamp((ax - padX) / sA, 0, inW);
  const iy = clamp((ay - padY) / sA, 0, inH);
  const sC = Math.max(outW / inW, outH / inH);
  const sw = inW * sC;
  const sh = inH * sC;
  const cox = (sw - outW) / 2;
  const coy = (sh - outH) / 2;
  return {
    ox: clampInt(ix * sC - cox, 0, outW - 1),
    oy: clampInt(iy * sC - coy, 0, outH - 1)
  };
}

function map1kVerticalSpanToOutHeight(y0a, y1a, inW, inH, outW, outH) {
  const xa = GEMINI_ANALYSIS_PX / 2;
  const p0 = mapAnalysisPointToOut(xa, clamp(y0a, 0, GEMINI_ANALYSIS_PX), inW, inH, outW, outH);
  const p1 = mapAnalysisPointToOut(xa, clamp(y1a, 0, GEMINI_ANALYSIS_PX), inW, inH, outW, outH);
  return Math.max(0, Math.round(Math.abs(p1.oy - p0.oy)));
}

function clampUsernameBlurBox1k(b) {
  const x = clampInt(b?.x, 0, GEMINI_ANALYSIS_PX - 1);
  const y = clampInt(b?.y, 0, GEMINI_ANALYSIS_PX - 1);
  let w = clampInt(b?.w, 0, GEMINI_ANALYSIS_PX);
  let h = clampInt(b?.h, 0, GEMINI_ANALYSIS_PX);
  w = Math.min(w, GEMINI_ANALYSIS_PX - x);
  h = Math.min(h, GEMINI_ANALYSIS_PX - y);
  if (w < 6 || h < 6) return null;
  return { x, y, w, h };
}

function normalizeUsernameBlurBoxes1k(raw) {
  const arr = Array.isArray(raw?.username_blur_boxes_1k)
    ? raw.username_blur_boxes_1k
    : Array.isArray(raw?.usernameBlurBoxes1k)
      ? raw.usernameBlurBoxes1k
      : [];
  const out = [];
  for (const b of arr) {
    const c = clampUsernameBlurBox1k(b);
    if (c) out.push(c);
    if (out.length >= 10) break;
  }
  return out;
}

/** 1000×1000 letterbox kutusu → ilk scale+crop sonrası outW×outH piksel dikdörtgen */
function mapUsernameBlurBox1kToOutPx(box1k, inW, inH, outW, outH) {
  const corners = [
    mapAnalysisPointToOut(box1k.x, box1k.y, inW, inH, outW, outH),
    mapAnalysisPointToOut(box1k.x + box1k.w, box1k.y, inW, inH, outW, outH),
    mapAnalysisPointToOut(box1k.x, box1k.y + box1k.h, inW, inH, outW, outH),
    mapAnalysisPointToOut(box1k.x + box1k.w, box1k.y + box1k.h, inW, inH, outW, outH)
  ];
  let minOx = Infinity;
  let minOy = Infinity;
  let maxOx = -Infinity;
  let maxOy = -Infinity;
  for (const c of corners) {
    minOx = Math.min(minOx, c.ox);
    minOy = Math.min(minOy, c.oy);
    maxOx = Math.max(maxOx, c.ox);
    maxOy = Math.max(maxOy, c.oy);
  }
  const x = clampInt(Math.floor(minOx), 0, outW - 2);
  const y = clampInt(Math.floor(minOy), 0, outH - 2);
  let w = clampInt(Math.ceil(maxOx - minOx), 4, outW);
  let h = clampInt(Math.ceil(maxOy - minOy), 4, outH);
  w = Math.min(w, outW - x);
  h = Math.min(h, outH - y);
  if (w < 8 || h < 8) return null;
  return { x, y, w, h };
}

function mapUsernameBlurBoxes1kToOutPx(boxes1k, inW, inH, outW, outH) {
  if (!inW || !inH || !boxes1k || !boxes1k.length) return [];
  const out = [];
  for (const b of boxes1k) {
    const m = mapUsernameBlurBox1kToOutPx(b, inW, inH, outW, outH);
    if (m) out.push(m);
  }
  return out.slice(0, 10);
}

async function ytDlpGetDurationSec(url) {
  // duration in seconds if available, else null
  try {
    const { stderr } = await run('yt-dlp', [
      '--no-playlist',
      '--print',
      '%(duration)s',
      url
    ], { timeoutMs: 45_000 });
    // run() returns stderr only; duration is printed to stdout, so we can't read it here.
    // Fallback: use spawn to capture stdout for this one call.
  } catch {}

  return await new Promise((resolve) => {
    try {
      const child = spawn('yt-dlp', ['--no-playlist', ...ytdlpCookieCliArgs(), '--print', '%(duration)s', url], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      const t = setTimeout(() => {
        try {
          if (process.platform === 'win32' && child.pid) {
            try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
          }
          child.kill();
        } catch {}
        resolve(null);
      }, 45_000);
      child.stdout.on('data', (d) => { out += d.toString(); });
      child.on('close', () => {
        clearTimeout(t);
        const v = Number(String(out || '').trim());
        if (!Number.isFinite(v) || v <= 0) return resolve(null);
        resolve(v);
      });
      child.on('error', () => { clearTimeout(t); resolve(null); });
    } catch {
      resolve(null);
    }
  });
}

async function probeDurationSec(filePath) {
  // Requires ffprobe available with ffmpeg install
  const args = [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath
  ];
  const child = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  return await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(err || `ffprobe exit ${code}`));
      const v = Number(String(out).trim());
      if (!Number.isFinite(v) || v <= 0) return reject(new Error('Süre okunamadı'));
      resolve(v);
    });
  });
}

async function probeVideoDurationSec(filePath) {
  // Prefer stream duration to avoid "hours-long" bad container timestamps.
  const args = [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath
  ];
  const child = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  return await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(err || `ffprobe exit ${code}`));
      const v = Number(String(out).trim());
      if (!Number.isFinite(v) || v <= 0) return reject(new Error('Video süre okunamadı'));
      resolve(v);
    });
  });
}

async function probeHasAudio(filePath) {
  const args = [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=index',
    '-of', 'csv=p=0',
    filePath
  ];
  const child = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  return await new Promise((resolve) => {
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('close', (code) => {
      if (code !== 0) return resolve(false);
      resolve(String(out || '').trim().length > 0);
    });
    child.on('error', () => resolve(false));
  });
}

async function probeHasVideo(filePath) {
  const args = [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=index',
    '-of', 'csv=p=0',
    filePath
  ];
  const child = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  return await new Promise((resolve) => {
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('close', (code) => {
      if (code !== 0) return resolve(false);
      resolve(String(out || '').trim().length > 0);
    });
    child.on('error', () => resolve(false));
  });
}

async function runYtDlpToResponse(res, url) {
  // Requires: yt-dlp installed on user's machine (in PATH)
  // This avoids server-side bot blocks by running from the user's own network/session.
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  const outTpl = path.join(DOWNLOAD_DIR, '%(title).120s [%(id)s].%(ext)s');

  // Yerel: dosyayı direkt hedef klasöre indir. Tarayıcı indirme klasörüne bağlı kalmayız.
  const args = [
    '--no-playlist',
    '--newline',
    '--no-part',
    '--no-mtime',
    ...YTDLP_NET_ARGS,
    '--downloader', 'ffmpeg',
    ...ytdlpCookieCliArgs(),
    // MP4 + AAC ses: Windows/MPC/telefonlarda "Opus desteklenmiyor" hatasını önler.
    '--merge-output-format',
    'mp4',
    '-f',
    // Öncelik: mp4 video + m4a (aac) ses; yoksa tek parça mp4; en sonda best.
    // 1080p hedefi: Shorts'ta genişlik genelde 1080 (yükseklik 1920), yatayda yükseklik 1080 (genişlik 1920).
    // Önce 1080 wide/1080 tall mp4+ m4a dene; yoksa "1080'e kadar" mp4; yoksa genel mp4.
    'bv*[ext=mp4][vcodec!=none][width=1080]+ba[ext=m4a][acodec!=none]/' +
      'bv*[ext=mp4][vcodec!=none][height=1080]+ba[ext=m4a][acodec!=none]/' +
      'bv*[ext=mp4][vcodec!=none][width<=1080][height<=1920]+ba[ext=m4a][acodec!=none]/' +
      'bv*[ext=mp4][vcodec!=none][height<=1080]+ba[ext=m4a][acodec!=none]/' +
      'bv*[ext=mp4][vcodec!=none]+ba[ext=m4a][acodec!=none]/' +
      'b[ext=mp4][acodec!=none][vcodec!=none]/best',
    '-o',
    outTpl,
    url
  ];

  const child = spawn('yt-dlp', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';

  child.stderr.on('data', (d) => {
    stderr += d.toString();
    if (stderr.length > 120_000) stderr = stderr.slice(-120_000);
  });

  child.on('error', (e) => {
    res.status(500).json({ error: 'yt-dlp çalıştırılamadı: ' + e.message });
  });

  child.on('close', (code) => {
    try {
      if (code !== 0) {
        const s = String(stderr || '');
        const hint = /did not get any data blocks|http error 416/i.test(s)
          ? '\nİpucu: Kaynak veri aralığı/CDN hatası verdi. Sistem fallback denemesi için /crush yolunda daha dayanıklı akış kullanır.'
          : '';
        return res.status(500).json({ error: (s || `yt-dlp exit ${code}`) + hint });
      }
      const newest = pickNewestFile(DOWNLOAD_DIR);
      if (!newest) return res.status(500).json({ error: 'Dosya bulunamadı (0 byte)' });
      return res.json({ ok: true, savedTo: DOWNLOAD_DIR, file: path.basename(newest) });
    } catch (e) {
      res.status(500).json({ error: (e && e.message) ? e.message : String(e) });
    }
  });
}

app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/download', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'url gerekli' });
  await runYtDlpToResponse(res, url);
});

// Telif Ezici (PC): indir -> 9:16 + zoom + renk + 1.10x + seken watermark
const __crushInProgress = new Map(); // key: `${brand}::${url}` -> startedAt ms
app.post('/crush', async (req, res) => {
  const url = req.body?.url || req.query?.url;
  const brand = normBrand(req.body?.brand || req.query?.brand || 'terapi');
  const manualBlurRectsBody = crush.parseManualBlurRectsInput(
    req.body?.manual_blur_rects ?? req.body?.manualBlurRects ?? []
  );
  const manualCropRect720 = crush.parseManualCropRectInput(
    req.body?.manual_crop_rect_720 ?? req.body?.manualCropRect720 ?? req.body?.manual_crop_rect ?? req.body?.manualCropRect ?? null
  );
  const manualReelsCropYNudgePx = crush.parseManualReelsCropYNudgePx(
    req.body?.manual_reels_crop_y_nudge_px ?? req.body?.manualReelsCropYNudgePx
  );
  const manualReelsWindowShiftYPx = crush.parseManualReelsWindowShiftYPx(
    req.body?.manual_reels_window_shift_y_px ?? req.body?.manualReelsWindowShiftYPx
  );
  const manualReelsHookXOff = crush.parseManualReelsHookOffsetPx(
    req.body?.manual_reels_hook_x_offset_px ?? req.body?.manualReelsHookXOffsetPx
  );
  const manualReelsHookYOff = crush.parseManualReelsHookOffsetPx(
    req.body?.manual_reels_hook_y_offset_px ?? req.body?.manualReelsHookYOffsetPx
  );
  const manualHookTextRaw = String(req.body?.hook_text ?? req.body?.manual_hook_text ?? '').trim();
  if (!url) return res.status(400).json({ error: 'url gerekli' });

  // Aynı video için paralel/çift tıklama koruması:
  // Aynı url+brand için bir render akışı devam ederken ikinci istek gelirse hemen reddet.
  const crushKey = `${brand}::${String(url).trim()}`;
  const now = Date.now();
  const prev = __crushInProgress.get(crushKey);
  if (prev && (now - prev) < 10 * 60 * 1000) {
    return res.status(409).json({ error: 'Bu video zaten işleniyor, lütfen mevcut işlem bitene kadar bekle.' });
  }
  __crushInProgress.set(crushKey, now);
  let __crushLockReleased = false;
  const releaseCrushLock = () => {
    if (__crushLockReleased) return;
    __crushLockReleased = true;
    try { __crushInProgress.delete(crushKey); } catch {}
  };
  res.on('close', releaseCrushLock);
  res.on('finish', releaseCrushLock);

  const brandDir = getBrandDir(brand);
  fs.mkdirSync(brandDir, { recursive: true });

  const hasYtDlp = await existsOnPath('yt-dlp');
  if (!hasYtDlp) return res.status(500).json({ error: 'yt-dlp bulunamadı. Önce bilgisayara yt-dlp kur.' });

  const hasFfmpeg = await existsOnPath('ffmpeg');
  const hasFfprobe = await existsOnPath('ffprobe');
  if (!hasFfmpeg || !hasFfprobe) return res.status(500).json({ error: 'ffmpeg/ffprobe bulunamadı. Önce bilgisayara ffmpeg kur.' });

  const wmFile = crushWatermarkPngPath(brand);
  if (!fs.existsSync(wmFile)) return res.status(500).json({ error: 'Watermark dosyası yok (public/watermark-*.png).' });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'va-local-crush-'));
  const inTpl = path.join(tmpDir, 'in.%(ext)s');
  const outName = `crushed_${brand}_9x16_${Date.now()}.mp4`;
  const outFile = path.join(brandDir, outName);

  try {
    const metaDur = await ytDlpGetDurationSec(url);
    const metaTitle = await ytDlpGetTitle(url).catch(() => '');
    const titleIsListicle = guessListicleFromTitle(metaTitle);
    if (metaDur && metaDur > 60) {
      return res.status(400).json({ error: `Bu araç sadece 60 saniye altı videolarda çalışır. Video süresi: ${Math.round(metaDur)}s` });
    }
    // İndirme kodu baştan: ana sayfadaki indir mantığı (finite MP4 A+V).
    // Download-sections gibi kesme işlerini burada yapmıyoruz; kesmeyi ffmpeg processing tarafında outDur ile garanti ediyoruz.
    const dlTimeoutMs = Math.round(clamp(((metaDur || 20) * 8000) + 60_000, 90_000, 3 * 60 * 1000));

    const buildCrushDlArgs = (youtubeExtractorSuffix) => {
      const extractorPart = youtubeExtractorSuffix
        ? ['--extractor-args', `youtube:player_client=${youtubeExtractorSuffix}`]
        : [];
      return [
        '--no-playlist',
        '--newline',
        '--no-part',
        '--no-mtime',
        ...YTDLP_NET_ARGS,
        '--downloader', 'ffmpeg',
        '--match-filter', '!is_live',
        '--merge-output-format', 'mp4',
        ...extractorPart,
        '-f',
        'best[ext=mp4][acodec!=none][vcodec!=none]/best[acodec!=none][vcodec!=none]/best',
        '-o',
        inTpl,
        ...ytdlpCookieCliArgs(),
        url
      ];
    };

    const dlArgs = buildCrushDlArgs(null);
    try {
      await run('yt-dlp', dlArgs, { timeoutMs: dlTimeoutMs });
    } catch (e0) {
      const msg0 = String((e0 && e0.message) || e0 || '');

      if (isYoutubeAgeSignInError(msg0)) {
        return res.status(400).json({
          error: 'Bu video yaş kısıtlı veya oturum istiyor; Telif Ezici bu videoları işlemez. Sitede yaş kısıtlı Shorts listelenmez.'
        });
      }
      if (/did not get any data blocks|unable to download video data|http error 403|http error 416|http error 429|po token/i.test(msg0)) {
        const dlArgsFallback = [
          '--no-playlist',
          '--newline',
          '--no-part',
          '--no-mtime',
          ...YTDLP_NET_ARGS,
          '--downloader', 'ffmpeg',
          '--match-filter', '!is_live',
          '--merge-output-format', 'mp4',
          '-f',
          'b[ext=mp4][acodec!=none][vcodec!=none]/best[ext=mp4]/best',
          '-o',
          inTpl,
          ...ytdlpCookieCliArgs(),
          url
        ];
        console.log('[yt-dlp retry] İlk deneme başarısız, progressive mp4 + ffmpeg downloader ile yeniden deneniyor...');
        await run('yt-dlp', dlArgsFallback, { timeoutMs: dlTimeoutMs });
      } else {
        throw e0;
      }
    }

    const inFile = pickNewestFile(tmpDir);
    if (!inFile) return res.status(500).json({ error: 'İndirilen dosya bulunamadı' });
    const hasVideo = await probeHasVideo(inFile);
    if (!hasVideo) {
      return res.status(500).json({
        error: 'İndirilen dosyada video akışı yok (sadece ses geldi). Bu videoda uygun mp4 A+V formatı bulunamadı.'
      });
    }

    const probedDur = await probeVideoDurationSec(inFile).catch(() => probeDurationSec(inFile).catch(() => null));
    // Süreyi meta'dan almayı tercih et: bazı dosyalarda container timestamp'leri bozuk olup saatler gösterebiliyor.
    const inDur = clamp(metaDur || probedDur || 20, 1, 60);
    if (inDur > 60) {
      return res.status(400).json({ error: `Bu araç sadece 60 saniye altı videolarda çalışır. Video süresi: ${Math.round(inDur)}s` });
    }
    const outW = 1080;
    const outH = 1920;
    const hasAudio = await probeHasAudio(inFile);
    const musicFile = crush.pickRandomMusicFile(PUBLIC_DIR, brand);
    const cache = loadDirectorCache();
    const titleHook = buildHookFromTitle({ title: metaTitle, isListicle: titleIsListicle });
    const emojiPool = loadCrushEmojiPool();
    const reelsEmojiBrand = normBrand(brand) === 'terapi' || normBrand(brand) === 'umut';
    const isLabBrand = normBrand(brand) === 'terapi' || normBrand(brand) === 'umut' || normBrand(brand) === 'kaos';
    let gemHook = '';
    const gemKeyFromReq = String(req.body?.gemini_api_key ?? req.body?.geminiApiKey ?? '').trim();
    const gemKeyEnv = String(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
    const gemKey = gemKeyFromReq || gemKeyEnv;
    const gemKeySource = gemKeyFromReq ? 'request' : (gemKeyEnv ? 'env' : 'missing');
    const gemKeyFp = gemKey
      ? crypto.createHash('sha256').update(gemKey).digest('hex').slice(0, 10)
      : null;
    const gemModelFromReq = String(req.body?.gemini_model ?? req.body?.geminiModel ?? '').trim();
    const gemModel = gemModelFromReq || String(process.env.GEMINI_MODEL || 'gemini-1.5-flash').trim();
    const mustUseGeminiHook = !manualHookTextRaw && isLabBrand;
    let geminiErr = null;
    if (!manualHookTextRaw && gemKey && metaTitle && isLabBrand) {
      try {
        const frameFile = path.join(tmpDir, 'gem_frame.png');
        const audioFile = path.join(tmpDir, 'gem_audio.wav');
        const tSec = Math.min(2.0, Math.max(0.35, inDur * 0.25));
        await ffmpegExtractFrame(inFile, frameFile, tSec, 'ffmpeg').catch(() => {});
        await ffmpegExtractAudioPreview(inFile, audioFile, 6, 'ffmpeg').catch(() => {});
        gemHook = await fetchGeminiHookEnglish(gemKey, metaTitle, brand, emojiPool, {
          framePng: frameFile,
          audioWav: audioFile
        }, gemModel);
      } catch (e) {
        geminiErr = {
          message: (e && e.message) ? String(e.message) : String(e),
          statusCode: (e && (e.statusCode || e.code)) ? (e.statusCode || e.code) : null,
          model: (e && e.model) ? String(e.model) : gemModel,
          keySource: gemKeySource,
          keyFp: gemKeyFp,
          apiError: (e && e.geminiError) ? e.geminiError : null
        };
        console.warn('[gemini hook]', geminiErr);
      }
    }
    // If Gemini is required but didn't produce a hook, fail fast (do not render video).
    if (mustUseGeminiHook && (!gemKey || !metaTitle || !gemHook || gemHook.length < 6)) {
      return res.status(502).json({
        ok: false,
        error: !gemKey
          ? 'Gemini API key yok (GEMINI_API_KEY). Hook üretilemedi.'
          : (!metaTitle ? 'Video title alınamadı; Gemini hook üretimi yapılamadı.' : 'Gemini hook üretimi başarısız oldu. Video render edilmedi.'),
        gemini: geminiErr || {
          message: 'Gemini hook empty',
          statusCode: null,
          model: gemModel,
          keySource: gemKeySource,
          keyFp: gemKeyFp
        }
      });
    }
    const seed =
      manualHookTextRaw
        ? manualHookTextRaw
        : gemHook && gemHook.length > 8
          ? gemHook
          : titleHook || fallbackHookTextForBrand(brand);
    // Hook için listicle/ranked sinyalini tamamen yok say (Best one is #1 vb. istemiyoruz)
    const hookCore = manualHookTextRaw
      ? manualHookTextRaw.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)
      : splitHookTwoLines(makeUniqueHook(brand, seed, cache, false), {
          titleHint: metaTitle || '',
          forReels: reelsEmojiBrand
        });
    let hookText =
      manualHookTextRaw
        ? hookCore
        : reelsEmojiBrand
          ? ensureHookUsesPoolEmoji(hookCore, emojiPool)
          : hookCore;
    hookText = stripBannedHookWords(hookText);
    // If stripping "ignore" makes it too short, fall back to a safe brand hook.
    if (!hookText || hookText.length < 6) {
        const fb = fallbackHookTextForBrand(brand);
      hookText = reelsEmojiBrand ? ensureHookUsesPoolEmoji(fb, emojiPool) : fb;
      hookText = stripBannedHookWords(hookText) || fb;
    }
    const hook = { text: hookText, bannerY: 0, y: 95, boxOpacity: 1, color: null };
    const fallbackCaptionBits = splitCaptionPayload(buildFallbackCaptionFromTitle(metaTitle || fallbackCaptionForBrand(brand), titleIsListicle));
    const finalCaption = toSingleSentenceCaption(fallbackCaptionBits.caption || fallbackCaptionForBrand(brand));
    const finalHashtags = ensureHashtagPack(brand, hookText, fallbackCaptionBits.hashtags);
    rememberUsed(cache, 'hooks', hookText);
    rememberUsed(cache, 'captions', finalCaption);
    saveDirectorCache(cache);

    const coverBox = null;

    const runFfmpeg = async (plan) => {
      await run('ffmpeg', [...plan.ffmpegArgsTail, outFile], { timeoutMs: 8 * 60 * 1000 });
    };

    const renderPlanWithFallback = async (currentPlan) => {
      try {
        await runFfmpeg(currentPlan);
        return currentPlan;
      } catch (e1) {
        const msg = String((e1 && e1.message) || e1);
        if (/rubberband|No such filter|not found|Invalid argument/i.test(msg)) {
          const retryPlan = await crush.buildCrushRenderPlan({
            inFile,
            wmFile,
            musicFile,
            brand,
            outW,
            outH,
            sourceDurSec: inDur,
            hook,
            coverBox,
            manual_blur_rects: manualBlurRectsBody,
          manual_crop_rect_720: manualCropRect720,
            manual_reels_crop_y_nudge_px: manualReelsCropYNudgePx,
            manual_reels_window_shift_y_px: manualReelsWindowShiftYPx,
            manual_reels_hook_x_offset_px: manualReelsHookXOff,
            manual_reels_hook_y_offset_px: manualReelsHookYOff,
            manualBlurRefW: crush.MANUAL_BLUR_REF_W,
            manualBlurRefH: crush.MANUAL_BLUR_REF_H,
            hasAudio,
            ffmpegPath: 'ffmpeg',
            ffprobePath: 'ffprobe',
            useRubberband: false
          });
          await runFfmpeg(retryPlan);
          return retryPlan;
        }
        throw e1;
      }
    };

    let plan = await crush.buildCrushRenderPlan({
      inFile,
      wmFile,
      musicFile,
      brand,
      outW,
      outH,
      sourceDurSec: inDur,
      hook,
      coverBox,
      manual_blur_rects: manualBlurRectsBody,
      manual_crop_rect_720: manualCropRect720,
      manual_reels_crop_y_nudge_px: manualReelsCropYNudgePx,
      manual_reels_window_shift_y_px: manualReelsWindowShiftYPx,
      manual_reels_hook_x_offset_px: manualReelsHookXOff,
      manual_reels_hook_y_offset_px: manualReelsHookYOff,
      manualBlurRefW: crush.MANUAL_BLUR_REF_W,
      manualBlurRefH: crush.MANUAL_BLUR_REF_H,
      hasAudio,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      useRubberband: true
    });
    plan = await renderPlanWithFallback(plan);

    const verify = await crush.selfCheckCrushOutput('ffmpeg', 'ffprobe', outFile);

    return res.json({
      ok: true,
      savedTo: brandDir,
      file: path.basename(outFile),
      settings: { ...plan.debug },
      verify,
      manualBlurRects: manualBlurRectsBody,
      manualReelsCropYNudgePx,
      manualReelsWindowShiftYPx,
      director: {
        ok: true,
        caption: finalCaption || '',
        hashtags: finalHashtags && finalHashtags.length ? finalHashtags : [],
        hookText: hook && hook.text ? hook.text : ''
      },
      musicDir: crush.getCrushMusicDir(PUBLIC_DIR, brand),
      musicHint:
        crush.listMusicFiles(crush.getCrushMusicDir(PUBLIC_DIR, brand)).length < 1
          ? 'BGM yok: public/audio/crush/<konsept>/ içine lisanslı .mp3/.m4a ekleyin (README).'
          : null
    });
  } catch (e) {
    return res.status(500).json({ error: (e && e.message) ? e.message : String(e) });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    releaseCrushLock();
  }
});

if (require.main === module) {
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`Local Downloader running on http://127.0.0.1:${PORT}`);
    console.log('Download dir:', DOWNLOAD_DIR);
    console.log('Install yt-dlp then open your frontend and click Download.');
  });
}

module.exports = {
  GEMINI_ANALYSIS_PX,
  probeVideoStreamSize,
  ffmpegExtractFrame,
  ffmpegExtractAudioPreview
};

