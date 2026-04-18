const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GoogleAuth } = require('google-auth-library');
const crush = require('./crush-pipeline');

const app = express();
app.use(cors());
app.use(express.json({ limit: '256kb' }));

const PORT = process.env.LOCAL_DOWNLOADER_PORT || 8787;
const DEFAULT_DIR = path.join(process.env.USERPROFILE || process.cwd(), 'Videos', 'Viral Atölyesi İndirilenler');
const DOWNLOAD_DIR = process.env.VA_DOWNLOAD_DIR || DEFAULT_DIR;
const PUBLIC_DIR = path.join(__dirname, 'public');
const GEMINI_PROJECT_DEFAULT = process.env.GEMINI_PROJECT || 'gen-lang-client-0508869582';
const GEMINI_LOCATION_DEFAULT = process.env.GEMINI_LOCATION || 'us-central1';
// Varsayılan: yalnızca en güçlü model (2.5 Pro). Flash vb. ucuz modelleri istemiyorsanız bu yeterli.
// İsterseniz ortama yazın: GEMINI_VERTEX_MODELS=gemini-2.5-pro,gemini-2.5-flash (yedek)
const GEMINI_MODELS = (process.env.GEMINI_VERTEX_MODELS || 'gemini-2.5-pro')
  .split(',')
  .map((s) => String(s || '').trim())
  .filter(Boolean);
const GEMINI_MODEL = GEMINI_MODELS[0];
/** Küçük doğrulama (üst bant sızıntısı vb.) — varsayılan Pro */
const GEMINI_LIGHT_MODEL = (process.env.GEMINI_VERTEX_LIGHT_MODEL || 'gemini-2.5-pro').trim();
const GEMINI_VERTEX_PRICE_USD_PER_MTOKEN = {
  'gemini-2.5-pro': { input: 1.25, output: 10.0 }
};
const YTDLP_NET_ARGS = [
  '--retries', '8',
  '--fragment-retries', '8',
  '--file-access-retries', '3',
  '--retry-sleep', 'fragment:2',
  '--socket-timeout', '20',
  '--force-ipv4',
  '--concurrent-fragments', '1'
];

/** yt-dlp: YouTube yaş/kısıt için — cookies.txt veya tarayıcıdan çerez */
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
function geminiEndpointFor(model, project, location) {
  const p = encodeURIComponent(String(project || GEMINI_PROJECT_DEFAULT).trim());
  const loc = encodeURIComponent(String(location || GEMINI_LOCATION_DEFAULT).trim());
  const m = encodeURIComponent(String(model || GEMINI_MODEL).trim());
  return `https://${decodeURIComponent(loc)}-aiplatform.googleapis.com/v1/projects/${p}/locations/${loc}/publishers/google/models/${m}:generateContent`;
}

let __vertexAuthClientPromise = null;
async function getVertexAuthClient() {
  if (!__vertexAuthClientPromise) {
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    __vertexAuthClientPromise = auth.getClient();
  }
  return await __vertexAuthClientPromise;
}

async function getVertexAccessToken() {
  const client = await getVertexAuthClient();
  const tok = await client.getAccessToken();
  const token = typeof tok === 'string' ? tok : tok && tok.token;
  if (!token) throw new Error('Vertex ADC access token alınamadı. gcloud auth application-default login tekrar çalıştır.');
  return token;
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function estimateGeminiCostUsd(model, promptTokens, candidateTokens) {
  const m = String(model || '').trim().toLowerCase();
  const price =
    GEMINI_VERTEX_PRICE_USD_PER_MTOKEN[m] ||
    (m.startsWith('gemini-2.5-pro') ? GEMINI_VERTEX_PRICE_USD_PER_MTOKEN['gemini-2.5-pro'] : null);
  const inTok = Number(promptTokens);
  const outTok = Number(candidateTokens);
  if (!price || !Number.isFinite(inTok) || !Number.isFinite(outTok)) return null;
  const usd = ((inTok / 1_000_000) * price.input) + ((outTok / 1_000_000) * price.output);
  return Number(usd.toFixed(6));
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

function looksLikeUsernameText(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  const s = raw.replace(/\s+/g, '');
  if (/@/.test(s)) return true;
  if (/tiktok\.com\/@/i.test(s)) return true;
  if (/^[a-z0-9._]{4,32}$/i.test(s) && /\d/.test(s)) return true;
  if (/^[A-Za-z][A-Za-z0-9._]{5,32}$/.test(s) && (/[A-Z]/.test(s.slice(1)) || /\d/.test(s))) return true;
  if (/^[A-Za-z]{6,32}\d{1,6}$/.test(s)) return true;
  return false;
}

function isConfirmedUsernameRegion(region) {
  if (!region || typeof region !== 'object') return false;
  const kind = String(region.kind || '').trim().toLowerCase();
  const text = String(region.text || '').trim();
  if (kind && !['username', 'handle', 'watermark_username', 'creator_handle'].includes(kind)) return false;
  return looksLikeUsernameText(text);
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

function salvageDirectorJson(text) {
  const src = extractBalancedJsonObject(stripJsonFences(text)) || stripJsonFences(text);
  const hook = extractJsonLikeStringField(src, 'hook');
  const captionRaw = extractJsonLikeStringField(src, 'caption');
  const oldHookText = extractJsonLikeStringField(src, 'old_hook_text');
  const captionParts = splitCaptionPayload(captionRaw);
  const explicitTags = extractJsonLikeStringArrayField(src, 'hashtags', 8);
  const inlineTags = extractHashtagsFromText(extractJsonLikeStringField(src, 'hashtags'), 8);
  const originalHeaderHeight = extractJsonLikeNumberField(src, 'original_header_height');
  const detectGarbage = extractJsonLikeBoxField(src, 'detect_garbage_text') || { x: 0, y: 0, w: 0, h: 0 };
  const oldHookBoxLoose = extractJsonLikeBoxField(src, 'old_hook_box');
  const coordUnitsRaw = extractJsonLikeStringField(src, 'coord_units');
  const blurRegions = extractJsonLikeBoxArrayField(src, 'blur_regions', 6);
  const hashtags = [...explicitTags, ...inlineTags, ...captionParts.hashtags].filter(Boolean);

  if (!hook && !captionRaw && originalHeaderHeight == null && !blurRegions.length && !oldHookBoxLoose) return null;
  return {
    hook,
    caption: captionParts.caption || captionRaw || '',
    old_hook_text: oldHookText || '',
    hashtags,
    coord_units: coordUnitsRaw || 'px',
    detect_garbage_text: detectGarbage,
    old_hook_box: oldHookBoxLoose || { x: 0, y: 0, w: 0, h: 0 },
    original_header_height: Number.isFinite(originalHeaderHeight) ? originalHeaderHeight : 0,
    blur_regions: blurRegions
  };
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
  const listicleHints = [
    'Best one is #1',
    'Wait for #1',
    '#1 is unreal'
  ];
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
  if (isListicle) for (const p of listicleHints) candidates.push(p);

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

/** Hook metninde emoji yok (FFmpeg drawtext çoğu yazı tipinde emoji kutusu gösterir). */
function normalizeHookEmoji(s) {
  return { text: stripAllEmoji(String(s || '')), emoji: '' };
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
  return `${subject} moment you can't ignore`;
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
  const titleWords = extractKeywordsFromTitle(title).slice(0, 2);
  let changed = 0;
  const out = words.map((w, idx) => {
    const key = String(w || '').toLowerCase();
    if (replacements[key] && changed < 2) {
      changed += 1;
      return replacements[key];
    }
    if (changed < 2 && idx === words.length - 1 && titleWords[0] && key !== titleWords[0]) {
      changed += 1;
      return titleWords[0];
    }
    return w;
  });
  if (changed === 0 && isListicle && out.length) {
    out[0] = out[0].toLowerCase() === 'ranking' ? 'Ranked' : 'Ranking';
  }
  return splitHookTwoLines(out.join(' '), { titleHint: title || '' });
}

function splitHookTwoLines(hookText, opts) {
  const t = stripAllEmoji(String(hookText || '')).replace(/\s+/g, ' ').trim();
  if (!t) return '';
  let words = t
    .replace(/\n/g, ' ')
    .split(' ')
    .filter(Boolean)
    .slice(0, 7);
  words = words.map((w) => (w.length > 14 ? w.slice(0, 14) : w));
  while (words.join(' ').length > 52 && words.length > 1) {
    words.pop();
  }
  let out = words.join(' ').trim();
  if (out.length > 52) {
    out = out.slice(0, 52);
    const sp = out.lastIndexOf(' ');
    if (sp > 24) out = out.slice(0, sp).trim();
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

async function ffmpegExtractFrame(inFile, outFile, tSec) {
  const args = [
    '-y',
    '-ss', String(Math.max(0, tSec).toFixed(3)),
    '-i', inFile,
    '-frames:v', '1',
    // Token tasarrufu için daha küçük kareler
    '-vf', 'scale=512:-1',
    // Bu FFmpeg build'inde JPEG(mjpeg) encoder strictness hatası çıkabiliyor.
    // PNG ile garanti alıyoruz.
    '-c:v', 'png',
    outFile
  ];
  await run('ffmpeg', args, { timeoutMs: 45_000 });
}

async function ffmpegExtractAudioPreview(inFile, outFile, durSec = 10) {
  const args = [
    '-y',
    '-i', inFile,
    '-t', String(Math.max(1, Math.min(15, durSec)).toFixed(3)),
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-b:a', '32k',
    outFile
  ];
  await run('ffmpeg', args, { timeoutMs: 45_000 });
}

async function ffmpegExtractTopBandPreview(inFile, outFile, cropHeight, tSec = 0.05) {
  const cropH = Math.max(80, Math.round(cropHeight || 220));
  const args = [
    '-y',
    '-ss', String(Math.max(0, tSec).toFixed(3)),
    '-i', inFile,
    '-frames:v', '1',
    '-vf', `crop=iw:${cropH}:0:0,scale=512:-1`,
    '-c:v', 'png',
    outFile
  ];
  await run('ffmpeg', args, { timeoutMs: 45_000 });
}

async function ffmpegExtractRegionPreview(inFile, outFile, region, outW, outH, tSec = 0.05, pad = 24) {
  const x0 = clamp(Math.round(Number(region?.x) || 0) - pad, 0, Math.max(0, outW - 2));
  const y0 = clamp(Math.round(Number(region?.y) || 0) - pad, 0, Math.max(0, outH - 2));
  const x1 = clamp(Math.round((Number(region?.x) || 0) + (Number(region?.w) || 0)) + pad, x0 + 8, outW);
  const y1 = clamp(Math.round((Number(region?.y) || 0) + (Number(region?.h) || 0)) + pad, y0 + 8, outH);
  const cropW = Math.max(8, x1 - x0);
  const cropH = Math.max(8, y1 - y0);
  const args = [
    '-y',
    '-ss', String(Math.max(0, tSec).toFixed(3)),
    '-i', inFile,
    '-frames:v', '1',
    '-vf', `crop=${cropW}:${cropH}:${x0}:${y0},scale=512:-1`,
    '-c:v', 'png',
    outFile
  ];
  await run('ffmpeg', args, { timeoutMs: 45_000 });
}

function fileToInlineData(filePath, mimeType) {
  const buf = fs.readFileSync(filePath);
  return { inlineData: { mimeType, data: buf.toString('base64') } };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms || 0)));
}

function isGeminiRateLimitError({ status, message, json }) {
  const msg = String(message || '');
  const jmsg = json && (json.error?.message || json.error);
  const s = String(jmsg || '');
  const merged = (msg + '\n' + s).toLowerCase();
  return (
    status === 429 ||
    /resource_exhausted/.test(merged) ||
    /rate limit/.test(merged) ||
    /quota exceeded/.test(merged) ||
    /exceeded your current quota/.test(merged)
  );
}

function isGeminiQuotaExceeded({ message, json }) {
  const msg = String(message || '');
  const jmsg = json && (json.error?.message || json.error);
  const s = String(jmsg || '');
  const merged = (msg + '\n' + s).toLowerCase();
  return /quota exceeded/.test(merged) || /exceeded your current quota/.test(merged) || /free_tier/.test(merged);
}

function isGeminiHighDemandError({ status, message, json }) {
  const msg = String(message || '');
  const jmsg = json && (json.error?.message || json.error);
  const s = String(jmsg || '');
  const merged = (msg + '\n' + s).toLowerCase();
  return (
    status === 503 ||
    /high demand/.test(merged) ||
    /spikes in demand/.test(merged) ||
    /try again later/.test(merged) ||
    /temporarily unavailable/.test(merged) ||
    /service unavailable/.test(merged) ||
    /overloaded/.test(merged)
  );
}

function isGeminiModelUnavailableError({ status, message, json }) {
  const msg = String(message || '');
  const jmsg = json && (json.error?.message || json.error);
  const s = String(jmsg || '');
  const merged = (msg + '\n' + s).toLowerCase();
  return (
    status === 404 ||
    /publisher model/.test(merged) ||
    /does not have access/.test(merged) ||
    /not found/.test(merged) ||
    /not supported for generatecontent/.test(merged)
  );
}

function isGeminiAbortError(err) {
  const msg = String(err && err.message ? err.message : err || '').toLowerCase();
  return msg.includes('this operation was aborted') || msg.includes('aborted');
}

async function geminiDirectorAnalyze({ geminiProject, geminiLocation, brand, framePaths, audioPath, title }) {
  const quotaProject = String(geminiProject || GEMINI_PROJECT_DEFAULT || '').trim();
  const vertexLocation = String(geminiLocation || GEMINI_LOCATION_DEFAULT || '').trim();
  if (!quotaProject) throw new Error('Vertex proje ID yok. GEMINI_PROJECT ayarla veya frontend’den geminiProject gönder.');

  const concept =
    brand === 'kaos'
      ? 'KAOS: Komedi, eğlence, karmaşa ve aksiyon odaklı.'
      : brand === 'umut'
        ? 'UMUT: Motivasyon, başarı ve insanlık odaklı.'
        : 'TERAPİ: Çocuk, köpek, tatlı ve komik anlar, huzur odaklı.';

  const promptIntro =
`Sistemin beyni olan "Viral Atölyesi AI Director v3.0" olarak görevlendirildin.

ELİNDEKİ KISITLI VERİ (KURAL):
- Sana 20 kare gönderiyorum. Her kareyi TEK TEK analiz et ve videodaki en küçük aksiyonu yakala (kaş kalkması, el hareketi, arkadaki detay vb.).
- Bu istek için toplam ${framePaths && framePaths.length ? framePaths.length : 'N'} adet kare + kısa bir ses önizlemesi var.
- İlk kareler videonun başından (metin yakalama için), kalan kareler videonun tamamına yayılmış (aksiyon/hikaye için).
- Ayrıca kısa bir ses önizlemesi var (tek kanallı, düşük bitrate).
- Tam videoyu izlemiyorsun. Bu yüzden sadece bu ipuçlarıyla en iyi tahmini yap.

KONSEPT (SAPMA YASAK):
${concept}

VIDEO BAŞLIĞI (yt-dlp):
${String(title || '').trim() || '(başlık alınamadı)'}

ANALİZ PROTOKOLÜ:
1) İlk karelerde METİN ara (üst/orta). Varsa bu “İmha Bölgesi”dir.
2) Tüm karelerde AKSİYON/HİKAYE ara (düşme, çarpma, koşma, sarılma, kurtarma, ring kırılması, vb.).
3) Ses önizlemesinde PİKLERİ ara (pat/çarpma, gülme, çığlık). Görsel net değilse ses ipucuna ağırlık ver.

SU İŞARETİ / LOGO AVI (ÇOK KRİTİK):
- Karelerde SADECE kullanıcı adı / hesap adı / creator handle görürsen bunu blur_regions listesine ayrı ayrı koordinat olarak ekle (maks 6 kutu).
- "@MaddessRnk5", "@pet&wildlifewonders", "tiktok.com/@user", "RankingEverything72" gibi handle/watermark isimlerini ASLA kaçırma.
- Kareler arasında sadece bir tanesinde görünse bile kaçırmadan koordinatını ver.
- Eğer username/handle YOKSA blur_regions listesini boş bırak.
- Tahmin yürütüp rastgele blur bölgesi verme; SADECE gerçekten gördüğün username/handle koordinatını döndür.
- SADECE merkeze yakın küçük bir kutu verme. TUM GORUNUR yazi alanini ver:
  soldaki ilk harften sagdaki son harfe kadar TAM GENISLIK,
  ustteki glow/outline/shadow ve alttaki baseline dahil TAM YUKSEKLIK.
- Ozellikle alt merkezde duran hesap adlarinda kutu dar olmasin; biraz guven payi birak.
- Normal altyazıları, sıralama numaralarını, skorları, videonun iç açıklama yazılarını, eski hook'u veya başka dekoratif metinleri blur_regions içine ASLA koyma.
- blur_regions icindeki her oge icin "text" alanina GORDUGUN username'i, "kind" alanina da "username" yaz.
- Eger blur_regions ogesindeki text bir username degilse o ogeyi hic ekleme.

ZORUNLU SİYAH BANT (FORCE MASK) — SIZINTI YASAK (ÇOK KRİTİK):
- Üstte tek satırlı başlık + ALTINDA ikinci satır/tagline/emoji (“…”, “last moments…”, “😭”) gibi bir
  ek metin BILE görünse, hepsini TEK “üst metin bloğu” say.
- old_hook_box: x,y,w,h kutusu mutlaka bu bloğun TAMAMINI içermeli (ana başlık + alt satır + emoji alanı).
  Sadece ilk satıra sıkı küçük kutu VERME; ikinci satır bandın altında “hayalet” kalır.
- original_header_height: Videonun ÜST KENARINDAN (y=0) en alttaki üst-metin pikseline kadar olan
  toplam piksel yüksekliği (720x1280 referans). Bu, kutunun altı ile UYUMLU olmalı; ikisi çelişirse
  daha BÜYÜK olanı esas al (daha güvenli).
- Videonun en üst kısmında herhangi bir yazı/başlık/hook görürsen original_header_height > 0 olmalı.
  Sadece gerçekten üstte hiç metin yoksa original_header_height=0 döndür.
- Listicle/ranked videolarda üst başlık + alt satır kombinasyonunu özellikle kaçırma.

JENERİK YASAKLAR (KESİN):
Hook şu kalıpları içeremez: "wait for it", "wait for the end", "watch until the end", "amazing end", "sweet end" (ve benzerleri).
EK YASAK (KESİN): Hook içinde şu kelimeler GEÇEMEZ: "crazy", "viral", "insane".

HOOK CÜMLE ZORUNLULUĞU (ÇOK KRİTİK):
- Hook 3-7 kelimelik anlamlı bir İngilizce cümle/ifade olmalı (içerik uzunsa 6-7 kelimeye izin var).
- TAM CÜMLE / TAM BAŞLIK: Son kelime yarım bırakılmış fiil veya bağlaç OLAMAZ (is, are, was, were, and, or, the, a, to, for… ile BİTİRME).
- KÖTÜ örnekler: "Last Moments Is", "Ranked Wildest Animal", "Top Moments And", "Wildest Blind Sunglasses Fails Too" (anlamsız kelime yığını, kopuk).
- İYİ örnekler: "Wildest animal moments go off the rails", "Ranked chaos hits different every time", "This water strike comes out of nowhere".
- Hook ASLA sadece "No Mother", "No Way", "No Cap", "Not Again" gibi 2 kelimelik negatif kopuk parça olamaz.
- Hook videoda ASLA gerçekleşmemiş bir olay iddia edemez (örn: fil yavrusunu korumak için geliyorsa "no mother" gibi yanlış çıkarım yasak).
- Hook mutlaka özne + eylem veya tamamlanmış bir başlık ifadesi içermeli.
- Hook pozitif/olumlu bir gözlem anlatmalı; olmayan bir şey üzerinden iddia kurma.

HOOK METNİ: Emoji veya özel sembol kullanma (yalnızca harf/rakam/boşluk); çıktı FFmpeg’de düz metin basılır.

SOMUTLUK ŞARTI (KESİN):
Hook İngilizce olacak ve mutlaka 1 SOMUT NESNE ve 1 SOMUT EYLEM kelimesi içerecek.
Örnek nesne: skateboard, dog, baby, elephant, car, stairs, door, bike, ball, pool
Örnek eylem: slips, crashes, falls, lands, saves, hits, drops, flips, rescues, protects, pushes

RANKED/LISTICLE KURALI:
Karelerde 1/2/3 gibi sıralama veya "ranked/top" vb. görüyorsan isListicle=true yap.
Bu durumda hook’ta #1 referansı kullanabilirsin ama yine SOMUT NESNEYİ yazmak zorundasın.

  MASKELME (OLD HOOK) — SERT İMHA:
Eğer hasOldHook=true ise görevin o eski yazıyı “süslemek” değil, tamamen YOK ETMEK:
- newHook.boxOpacity = 1.0 (tam opak)
  - newHook.yPx banner'ın başlangıç Y konumudur (0–100 birim; 0=ALT, 100=ÜST)
    Eski yazıyı tamamen yutacak şekilde ayarla (gerekirse 95–100 bandına yakın).

ÇIKTI KURALI (KESİN):
- SADECE JSON döndür. Başka hiçbir metin, açıklama, markdown, code fence yazma.
- Aşağıdaki şema DIŞINA çıkma. Anahtar isimleri birebir aynı olmalı.

KOORDİNAT SİSTEMİ (KESİN):
- "coord_units": "px" ise x,y,w,h piksel (render 720x1280).
- "coord_units": "norm" ise 0–100 normalize (x,y sol üst; w,h genişlik/yükseklik yüzdesi).
- Eski hook kutusu mutlaka old_hook_box ile ver (yoksa sıfır kutusu).

ZORUNLU JSON ŞEMASI (KATI):
{
  "coord_units": "px",
  "hook": "3-7 kelime tam İngilizce başlık; emoji yok; crazy/viral/insane yok",
  "caption": "TEK cümle İngilizce. Videodaki olayı anlatsın ve izleyiciye hitap etsin. Soru sorma. Emoji yok.",
  "old_hook_text": "",
  "hashtags": ["#viral", "#kesfet", "#trending", "#chaos", "#specific"],
  "old_hook_box": {"x": 0, "y": 0, "w": 0, "h": 0},
  "detect_garbage_text": {"x": 0, "y": 0, "w": 0, "h": 0},
  "original_header_height": 0,
  "blur_regions": [{"x": 0, "y": 0, "w": 0, "h": 0, "text": "RankingEverything72", "kind": "username"}]
}

`;

async function geminiVerifyTopBandLeak({ geminiProject, geminiLocation, previewPath, hookText, coverBox }) {
  if (!previewPath || !fs.existsSync(previewPath)) return null;
  const quotaProject = String(geminiProject || GEMINI_PROJECT_DEFAULT || '').trim();
  const vertexLocation = String(geminiLocation || GEMINI_LOCATION_DEFAULT || '').trim();
  if (!quotaProject) return null;

  const model = GEMINI_LIGHT_MODEL;
  const prompt = [
    'You are checking the TOP of an already-rendered 9:16 short video frame after a black band was applied.',
    `Our NEW hook (ignore this as leak): "${String(hookText || '').trim() || '(empty)'}"`,
    `Black band covers from y=${Math.round(Number(coverBox?.y) || 0)} with height=${Math.round(Number(coverBox?.h) || 0)} (pixels from top; 0=top).`,
    'FAIL if ANY original/foreign text remains visible IMMEDIATELY BELOW the black band edge (common bug: a second headline line, partial words, emojis, or faded old caption peeking into the content area).',
    'Also FAIL if old white/colored text shows through under the band.',
    'SUCCESS (leak=false) only if ONLY our new hook is readable on the band and NO old stacked title lines remain below it.',
    'Return extra_band_px: how many pixels taller the black band should be (8-120) if leak=true; else 0.',
    'Return only JSON.'
  ].join('\n');

  const schema = {
    type: 'OBJECT',
    properties: {
      leak: { type: 'BOOLEAN' },
      extra_band_px: { type: 'INTEGER' },
      reason: { type: 'STRING' }
    },
    required: ['leak', 'extra_band_px', 'reason']
  };

  const body = {
    contents: [{
      role: 'user',
      parts: [
        { text: prompt },
        fileToInlineData(previewPath, 'image/png')
      ]
    }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 256,
      responseMimeType: 'application/json',
      responseSchema: schema
    }
  };

  try {
    const accessToken = await getVertexAccessToken();
    const r = await fetch(geminiEndpointFor(model, quotaProject, vertexLocation), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify(body)
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return null;
    const text = (j.candidates?.[0]?.content?.parts || []).map((x) => x.text || '').join('').trim();
    const parsed = safeJsonParse(stripJsonFences(text)) || safeJsonParse(extractBalancedJsonObject(text));
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      leak: !!parsed.leak,
      extraBandPx: clamp(Number(parsed.extra_band_px) || 0, 0, 200),
      reason: String(parsed.reason || '').trim()
    };
  } catch {
    return null;
  }
}

async function geminiVerifyUsernameBlurLeak({ geminiProject, geminiLocation, previewPath, expectedUsername }) {
  if (!previewPath || !fs.existsSync(previewPath)) return null;
  const quotaProject = String(geminiProject || GEMINI_PROJECT_DEFAULT || '').trim();
  const vertexLocation = String(geminiLocation || GEMINI_LOCATION_DEFAULT || '').trim();
  if (!quotaProject) return null;

  const model = GEMINI_LIGHT_MODEL;
  const prompt = [
    'You are checking a BLURRED username region from a rendered short video.',
    `Expected username text: "${String(expectedUsername || '').trim() || '(unknown)'}"`,
    'First decide whether this crop actually contains a username/handle watermark at all.',
    'Task: decide whether any username/handle text is still readable in this crop.',
    'If still readable, estimate how many pixels the blur box should expand on each side.',
    'If there is NO username/handle in this crop, username_present=false, leak=false and all expand values must be 0.',
    'If the username is fully unreadable but clearly present, username_present=true, leak=false and all expand values must be 0.',
    'Return only JSON.'
  ].join('\n');

  const schema = {
    type: 'OBJECT',
    properties: {
      username_present: { type: 'BOOLEAN' },
      leak: { type: 'BOOLEAN' },
      expand_left_px: { type: 'INTEGER' },
      expand_top_px: { type: 'INTEGER' },
      expand_right_px: { type: 'INTEGER' },
      expand_bottom_px: { type: 'INTEGER' },
      reason: { type: 'STRING' }
    },
    required: ['username_present', 'leak', 'expand_left_px', 'expand_top_px', 'expand_right_px', 'expand_bottom_px', 'reason']
  };

  const body = {
    contents: [{
      role: 'user',
      parts: [
        { text: prompt },
        fileToInlineData(previewPath, 'image/png')
      ]
    }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 256,
      responseMimeType: 'application/json',
      responseSchema: schema
    }
  };

  try {
    const accessToken = await getVertexAccessToken();
    const r = await fetch(geminiEndpointFor(model, quotaProject, vertexLocation), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify(body)
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return null;
    const text = (j.candidates?.[0]?.content?.parts || []).map((x) => x.text || '').join('').trim();
    const parsed = safeJsonParse(stripJsonFences(text)) || safeJsonParse(extractBalancedJsonObject(text));
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      usernamePresent: !!parsed.username_present,
      leak: !!parsed.leak,
      left: clamp(Number(parsed.expand_left_px) || 0, 0, 80),
      top: clamp(Number(parsed.expand_top_px) || 0, 0, 80),
      right: clamp(Number(parsed.expand_right_px) || 0, 0, 80),
      bottom: clamp(Number(parsed.expand_bottom_px) || 0, 0, 80),
      reason: String(parsed.reason || '').trim()
    };
  } catch {
    return null;
  }
}

  const prompt = promptIntro + `KURALLAR:
- hook: tam cümle/başlık; emoji veya özel sembol yok (yalnızca düz metin).
- caption kesinlikle emoji içermez.
- hook içinde "crazy", "viral", "insane" kelimeleri geçemez.
- hook 3-7 kelime olabilir; videoyla doğrudan ilgili, somut olmalı (gereksiz uzatma yok).
- caption içine hashtag yazma; hashtagleri SADECE hashtags array içine koy.
- caption TEK cümle olsun.
- caption soru cümlesi OLMAMALI. Soru işareti kullanma.
- caption sadece videodaki olayı doğal İngilizce ile anlatsın ama izleyiciye hitap eden sıcak bir ton kullansın.
- ranked/listicle içerikte caption bir cümle içinde "follow for more ranked..." benzeri yumuşak bir takip çağrısı içerebilir.
- Eğer eski hook varsa old_hook_text alanına ekrandaki eski hook metnini mümkün olduğunca aynen yaz.
- Yeni hook üretirken eski hook varsa onu baz al: aynı iskeleti koru, sadece 1 veya 2 kelimeyi değiştir.
- hashtags array TAM 5 benzersiz hashtag içermeli ve her biri # ile başlamalı.
- hashtag formatı: 3 genel (#viral/#kesfet/#trending), 1 konsept (#chaos/#therapy/#motivation), 1 spesifik (ranked ise #ranked).
- detect_garbage_text: Eğer kullanıcı adı/watermark/logo/rahatsız edici metin görürsen en kritik alanı tek kutu olarak ver; yoksa {0,0,0,0}.
- blur_regions: SADECE username/handle alanlarını listele (maks 6 kutu); yoksa [] döndür.
- blur_regions içindeki her objede text=username metni ve kind="username" zorunlu olsun.
- original_header_height: Üstte orijinal başlık/yazı varsa kapladığı yüksekliği px olarak ver (örn 160). Yoksa 0.
- old_hook_box: Üstte eski hook varsa kutuyu ver; yoksa {0,0,0,0}.

NOT:
Eğer karelerde aksiyon net değilse, ses piklerine göre mantıklı bir fail/impact/surprise hook’u üret; ama yine de jenerik yasaklara uy.
Eğer Gemini hata verse bile: Bu video başlığına ve bu görsel karelere dayanarak, her ikisiyle de uyumlu bir hook oluştur.

ŞİMDİ SADECE JSON DÖNDÜR.`;

  const parts = [{ text: prompt }];
  let imageBytes = 0;
  let audioBytes = 0;
  for (const p of framePaths || []) {
    if (!p || !fs.existsSync(p)) continue;
    const ext = path.extname(p).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
    try { imageBytes += fs.statSync(p).size || 0; } catch {}
    parts.push(fileToInlineData(p, mime));
  }
  if (audioPath && fs.existsSync(audioPath)) {
    try { audioBytes += fs.statSync(audioPath).size || 0; } catch {}
    parts.push(fileToInlineData(audioPath, 'audio/mpeg'));
  }

  // Gemini 2.5 Flash "thinking tokens" kullanıyor.
  // İstenen ayar: derin düşünme + yeterli JSON çıkışı.
  // responseSchema ile alanları zorla tip/kısıt altına alıyoruz.
  const directorSchema = {
    type: 'OBJECT',
    properties: {
      coord_units: { type: 'STRING', enum: ['px', 'norm'] },
      hook: { type: 'STRING' },
      caption: { type: 'STRING' },
      old_hook_text: { type: 'STRING' },
      hashtags: { type: 'ARRAY', items: { type: 'STRING' }, minItems: 5, maxItems: 5 },
      original_header_height: { type: 'INTEGER' },
      old_hook_box: {
        type: 'OBJECT',
        properties: {
          x: { type: 'INTEGER' }, y: { type: 'INTEGER' },
          w: { type: 'INTEGER' }, h: { type: 'INTEGER' }
        },
        required: ['x', 'y', 'w', 'h']
      },
      detect_garbage_text: {
        type: 'OBJECT',
        properties: {
          x: { type: 'INTEGER' }, y: { type: 'INTEGER' },
          w: { type: 'INTEGER' }, h: { type: 'INTEGER' }
        },
        required: ['x', 'y', 'w', 'h']
      },
      blur_regions: {
        type: 'ARRAY',
        maxItems: 6,
        items: {
          type: 'OBJECT',
          properties: {
            x: { type: 'INTEGER' }, y: { type: 'INTEGER' },
            w: { type: 'INTEGER' }, h: { type: 'INTEGER' },
            text: { type: 'STRING' }, kind: { type: 'STRING' }
          },
          required: ['x', 'y', 'w', 'h', 'text', 'kind']
        }
      }
    },
    required: [
      'coord_units', 'hook', 'caption', 'hashtags',
      'original_header_height', 'old_hook_box', 'blur_regions', 'old_hook_text'
    ]
  };

  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: 0.45,
      maxOutputTokens: 4096,
      responseMimeType: 'application/json',
      responseSchema: directorSchema,
      thinkingConfig: {
        thinkingBudget: Math.min(8192, Math.max(0, Number(process.env.GEMINI_VERTEX_THINKING_BUDGET || 2048) || 2048))
      }
    }
  };

  // Rate Limit Kurtarma:
  // Paid Tier: 429 genelde anlık yoğunluk → 5 sn bekle ve tekrar dene.
  // Quota exceeded ise → 60 sn bekle ve tekrar dene.
  // Aynı model sürekli doluysa sıradaki desteklenen flash modele geç.
  const maxAttempts = 5;
  const retryWaitMs429 = 5_000;
  const retryWaitMsQuota = 60_000;
  const retryWaitMsAbort = 10_000;
  const retryWaitMsDemand = 15_000;
  const requestTimeoutMs = Math.min(600_000, Math.max(45_000, Number(process.env.GEMINI_VERTEX_TIMEOUT_MS || 180_000) || 180_000));
  const modelsToTry = Array.isArray(GEMINI_MODELS) && GEMINI_MODELS.length ? GEMINI_MODELS.slice() : [GEMINI_MODEL];
  let lastErr = null;
  let lastModelTried = GEMINI_MODEL;

  console.log('[Gemini Start]', JSON.stringify({
    model: GEMINI_MODEL,
    modelChain: modelsToTry,
    quotaProject: quotaProject || null,
    vertexLocation: vertexLocation || null,
    brand,
    frameCount: Array.isArray(framePaths) ? framePaths.length : 0,
    hasAudio: !!audioPath,
    title: String(title || '').slice(0, 120)
  }));

  for (let modelIndex = 0; modelIndex < modelsToTry.length; modelIndex++) {
    const currentModel = modelsToTry[modelIndex];
    const url = geminiEndpointFor(currentModel, quotaProject, vertexLocation);
    let tryNextModel = false;
    lastModelTried = currentModel;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const ac = new AbortController();
      const t = setTimeout(() => {
        try { ac.abort(); } catch {}
      }, requestTimeoutMs);

      let r = null;
      let j = {};
      try {
        const accessToken = await getVertexAccessToken();
        r = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`
          },
          body: JSON.stringify(body),
          signal: ac.signal
        }).finally(() => clearTimeout(t));

        console.log(`[Gemini HTTP] model=${currentModel} attempt=${attempt} status=${r.status}`);
        j = await r.json().catch(() => ({}));
        if (!r.ok) {
          const msg = (j && (j.error?.message || j.error)) ? (j.error.message || j.error) : `Gemini HTTP ${r.status}`;
          const err = new Error(msg);
          err.httpStatus = r.status;
          err.geminiJson = j;
          throw err;
        }

        const text = (j.candidates?.[0]?.content?.parts || []).map(x => x.text || '').join('').trim();
        const cleanText = stripJsonFences(text);
        const strictParsed = safeJsonParse(cleanText) || safeJsonParse(extractBalancedJsonObject(cleanText));
        const parsed = strictParsed || salvageDirectorJson(cleanText);
        if (!parsed) {
          const rawSnippet = String(text || '').slice(0, 400);
          console.log('[Gemini Parse Fail]', rawSnippet);
          return {
            __va_status: 'PARSE_FAILED',
            message: 'Gemini 200 döndü ama geçerli JSON üretmedi.',
            rawSnippet,
            __va_diag: {
              model: currentModel,
              attemptedModels: modelsToTry,
              quotaProject: quotaProject || null,
              vertexLocation: vertexLocation || null,
              imageBytes,
              audioBytes,
              tier: 'paid_or_unknown'
            }
          };
        }
        if (!strictParsed) {
          console.log('[Gemini Salvaged]', JSON.stringify({
            model: currentModel,
            hook: !!parsed.hook,
            caption: !!parsed.caption,
            hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags.length : 0,
            originalHeaderHeight: Number(parsed.original_header_height || 0),
            blurRegions: Array.isArray(parsed.blur_regions) ? parsed.blur_regions.length : 0
          }));
        }
        if (parsed && typeof parsed === 'object') {
          const usage = j.usageMetadata || j.usage_metadata || null;
          const promptTokens = Number(usage?.promptTokenCount ?? usage?.prompt_token_count ?? NaN);
          const candTokens = Number(usage?.candidatesTokenCount ?? usage?.candidates_token_count ?? NaN);
          const totalTokens = Number(usage?.totalTokenCount ?? usage?.total_token_count ?? NaN);
          const thinkingTokens = Number(usage?.thoughtsTokenCount ?? usage?.thinkingTokenCount ?? usage?.reasoningTokenCount ?? NaN);
          const finishReason = j?.candidates?.[0]?.finishReason || null;
          const tierGuess = (String(j?.error?.message || '').toLowerCase().includes('free_tier') || String(text).toLowerCase().includes('free_tier'))
            ? 'free'
            : 'paid_or_unknown';
          parsed.__va_diag = {
            model: currentModel,
            attemptedModels: modelsToTry,
            quotaProject: quotaProject || null,
            vertexLocation: vertexLocation || null,
            imageBytes,
            audioBytes,
            promptTokens: Number.isFinite(promptTokens) ? promptTokens : null,
            candidateTokens: Number.isFinite(candTokens) ? candTokens : null,
            totalTokens: Number.isFinite(totalTokens) ? totalTokens : null,
            thinkingTokens: Number.isFinite(thinkingTokens) ? thinkingTokens : null,
            estimatedCostUsd: estimateGeminiCostUsd(currentModel, promptTokens, candTokens),
            finishReason,
            truncated: finishReason === 'MAX_TOKENS',
            tier: tierGuess
          };
          console.log('[Gemini Diag]', JSON.stringify(parsed.__va_diag));
          if (parsed.__va_diag.truncated) {
            console.log('[Gemini WARN] Cevap MAX_TOKENS ile kesildi — maxOutputTokens değerini artırmanız gerekebilir.');
          }
        }
        return parsed || null;
      } catch (e) {
        lastErr = e;
        const status = Number(e?.httpStatus) || Number(r?.status) || null;
        const message = (e && e.message) ? e.message : String(e);
        const json = e?.geminiJson || j;
        const transientBusy = isGeminiHighDemandError({ status, message, json }) || (status === 429 && !isGeminiQuotaExceeded({ message, json }));

        if (attempt < maxAttempts && isGeminiAbortError(e)) {
          console.log(`[Gemini Abort] model=${currentModel} istek zaman aşımına uğradı, 10 saniye bekleniyor ve tekrar denenecek....`);
          await sleep(retryWaitMsAbort);
          continue;
        }
        if (attempt < maxAttempts && isGeminiHighDemandError({ status, message, json })) {
          console.log(`[Gemini Demand] model=${currentModel} yoğunlukta, 15 saniye bekleniyor ve tekrar denenecek....`);
          await sleep(retryWaitMsDemand);
          continue;
        }
        if (attempt < maxAttempts && isGeminiRateLimitError({ status, message, json })) {
          if (status === 429 && !isGeminiQuotaExceeded({ message, json })) {
            console.log(`[Gemini 429] model=${currentModel} yoğunluk var, 5 saniye bekleniyor ve tekrar denenecek....`);
            await sleep(retryWaitMs429);
            continue;
          }
          console.log(`[Gemini Quota] model=${currentModel} kota doldu, 60 saniye bekleniyor ve tekrar denenecek....`);
          await sleep(retryWaitMsQuota);
          continue;
        }
        if (modelIndex < modelsToTry.length - 1 && (transientBusy || isGeminiModelUnavailableError({ status, message, json }))) {
          const nextModel = modelsToTry[modelIndex + 1];
          console.log(`[Gemini Fallback] ${currentModel} başarısız oldu, sıradaki modele geçiliyor: ${nextModel}`);
          tryNextModel = true;
        }
        if (tryNextModel) break;
        break;
      } finally {
        clearTimeout(t);
      }
    }

    if (tryNextModel) continue;
    break;
  }

  // 5 deneme sonunda hala kota/rate-limit ise videoyu pas geç: Gemini yokmuş gibi devam et.
  // (Render devam eder; UI'da director.ok=false olarak görülecek.)
  if (lastErr) {
    const status = Number(lastErr?.httpStatus) || null;
    const message = (lastErr && lastErr.message) ? lastErr.message : String(lastErr);
    if (isGeminiRateLimitError({ status, message, json: lastErr?.geminiJson }) || isGeminiHighDemandError({ status, message, json: lastErr?.geminiJson })) {
      return {
        __va_status: 'RATE_LIMIT_EXHAUSTED',
        message,
        __va_diag: { model: lastModelTried, attemptedModels: modelsToTry, quotaProject: quotaProject || null, vertexLocation: vertexLocation || null, imageBytes, audioBytes, tier: 'paid_or_unknown' }
      };
    }
    console.log('[Gemini Error]', message);
    throw lastErr;
  }
  return null;
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

/** coord_units: "px" (720x1280) veya "norm" (0–100 yüzde) */
function regionPixelsFromRaw(r, outW, outH, coordUnits) {
  if (!r || typeof r !== 'object') return null;
  let x = Number(r.x);
  let y = Number(r.y);
  let w = Number(r.w);
  let h = Number(r.h);
  if (![x, y, w, h].every(Number.isFinite)) return null;
  const u = String(coordUnits || 'px').toLowerCase();
  let useNorm = (u === 'norm' || u === 'normalized' || u === 'percent' || u === '0-100');
  // Gemini bazen coord_units ile gerçek sayı ölçeğini karıştırabiliyor.
  // - norm denip 0..100 dışı değer gelirse px kabul et
  // - px denip tüm değerler 0..100 içindeyse norm olasılığına izin ver
  if (useNorm && (x > 100 || y > 100 || w > 100 || h > 100)) useNorm = false;
  if (!useNorm && x <= 100 && y <= 100 && w <= 100 && h <= 100) useNorm = true;
  if (useNorm) {
    x = Math.round((x / 100) * outW);
    y = Math.round((y / 100) * outH);
    w = Math.round((w / 100) * outW);
    h = Math.round((h / 100) * outH);
  }
  return { x, y, w, h };
}

function clampRegionForVideo(r, outW, outH, coordUnits) {
  const n = regionPixelsFromRaw(r, outW, outH, coordUnits);
  if (!n) return null;
  const x = Math.max(0, Math.min(outW - 2, Math.round(n.x)));
  const y = Math.max(0, Math.min(outH - 2, Math.round(n.y)));
  const w = Math.max(0, Math.min(outW - x, Math.round(n.w)));
  const h = Math.max(0, Math.min(outH - y, Math.round(n.h)));
  return (w >= 8 && h >= 8) ? { x, y, w, h } : null;
}

function expandTextRegionForBlur(r, outW, outH) {
  if (!r) return null;
  const cx = r.x + (r.w / 2);
  const cy = r.y + (r.h / 2);
  const isLowerThird = cy > (outH * 0.72);
  const isTextLike = r.h <= Math.round(outH * 0.06);
  const minW = Math.round(outW * (isLowerThird ? 0.20 : 0.08));
  const minH = Math.round(outH * (isLowerThird ? 0.028 : 0.018));
  const paddedW = Math.max(minW, Math.round(r.w * (isLowerThird && isTextLike ? 1.95 : 1.35)));
  const paddedH = Math.max(minH, Math.round(r.h * (isLowerThird && isTextLike ? 1.85 : 1.45)));
  let x = Math.round(cx - (paddedW / 2));
  let y = Math.round(cy - (paddedH / 2));
  let w = Math.round(paddedW);
  let h = Math.round(paddedH);
  x = Math.max(0, Math.min(outW - 2, x));
  y = Math.max(0, Math.min(outH - 2, y));
  w = Math.max(8, Math.min(outW - x, w));
  h = Math.max(8, Math.min(outH - y, h));
  return { x, y, w, h };
}

function sanitizeBlurRegionForText(r, outW, outH) {
  if (!r) return null;
  const area = r.w * r.h;
  const frameArea = outW * outH;
  const midY = r.y + (r.h / 2);
  const isLowerThird = midY > outH * 0.72;
  const maxW = Math.round(outW * (isLowerThird ? 0.78 : 0.62));
  const maxH = Math.round(outH * (isLowerThird ? 0.09 : 0.18));
  const tooWide = r.w > maxW;
  const tooTall = r.h > maxH;
  const tooLargeArea = area > (frameArea * 0.14);
  const isMiddleBand = midY > outH * 0.24 && midY < outH * 0.82;
  // Orta bölgede aşırı büyük kutular çoğunlukla yanlış tespittir.
  if ((tooWide && tooTall) || tooLargeArea || (isMiddleBand && area > frameArea * 0.08)) return null;
  return r;
}

function normalizeDirectorResult(raw, outW, outH, brand, titleHint) {
  if (!raw || typeof raw !== 'object') return null;
  const coordUnits = raw.coord_units || raw.coordUnits || 'px';
  const titleForHook = String(titleHint || '').trim();
  // New strict schema support:
  if (typeof raw.hook === 'string' || typeof raw.caption === 'string' || raw.original_header_height != null || Array.isArray(raw.blur_regions) || raw.old_hook_box != null || raw.oldHookBox != null) {
    let hookRaw = String(raw.hook || '').trim();
    if (!hookRaw) hookRaw = fallbackHookTextForBrand(brand);
    const hook = splitHookTwoLines(hookRaw, { titleHint: titleForHook });
    const captionParts = splitCaptionPayload(raw.caption || '');
    const rawTags = Array.isArray(raw.hashtags) ? raw.hashtags : (Array.isArray(raw.Hashtags) ? raw.Hashtags : []);
    const hashtags = [];
    const seenTags = new Set();
    for (const t of [...rawTags, ...captionParts.hashtags]) {
      const clean = String(t || '').trim().toLowerCase();
      if (!clean || seenTags.has(clean)) continue;
      seenTags.add(clean);
      hashtags.push(clean.startsWith('#') ? clean : `#${clean.replace(/^#+/, '')}`);
      if (hashtags.length >= 5) break;
    }
    const caption = toSingleSentenceCaption(captionParts.caption || '');
    const headerH = Number(raw.original_header_height);
    const originalHeaderHeight = Number.isFinite(headerH) && headerH > 0 ? headerH : 0;
    const clampRegion = (r) => {
      const base = clampRegionForVideo(r, outW, outH, coordUnits);
      const expanded = expandTextRegionForBlur(base, outW, outH);
      return sanitizeBlurRegionForText(expanded, outW, outH);
    };
    const blurRegions = [];
    const list = Array.isArray(raw.blur_regions) ? raw.blur_regions : [];
    for (const r of list.slice(0, 6)) {
      if (!isConfirmedUsernameRegion(r)) continue;
      const rr = clampRegion(r);
      if (rr) blurRegions.push(rr);
    }
    // Sadece Gemini'nin blur_regions listesi uygulanır (otomatik ekstra kutu ekleme yok).

    const oldHookBoxPx = clampRegionForVideo(raw.old_hook_box || raw.oldHookBox, outW, outH, coordUnits);
    const hasOldBox = !!(oldHookBoxPx && oldHookBoxPx.w >= 8 && oldHookBoxPx.h >= 8);
    const hasHeader = originalHeaderHeight > 0;
    const isListicle =
      raw.isListicle != null ? !!raw.isListicle
      : raw.is_listicle != null ? !!raw.is_listicle
      : raw.listicle != null ? !!raw.listicle
      : false;

    const out = {
      hasOriginalHook: hasHeader || hasOldBox,
      oldHook: hasHeader ? { yPct: 0, hPct: (originalHeaderHeight / outH) * 100 } : null,
      oldHookBox: oldHookBoxPx,
      newHook: { text: hook, yPx: 95, boxOpacity: 1 },
      isListicle,
      rankHookHint: null,
      hookColor: null,
      caption,
      oldHookText: stripEmoji(String(raw.old_hook_text || raw.oldHookText || '').trim()),
      hashtags,
      blurRegions,
      originalHeaderHeight
    };
    if (!out.caption) out.caption = fallbackCaptionForBrand(brand);
    return out;
  }
  const hasOriginal =
    raw.has_original_hook != null ? !!raw.has_original_hook
    : raw.has_old_hook != null ? !!raw.has_old_hook
    : raw.hasOriginalHook != null ? !!raw.hasOriginalHook
    : raw.hasOldHook != null ? !!raw.hasOldHook
    : false;

  const old = raw.old_hook || raw.oldHook || raw.original_hook || raw.originalHook || null;
  const oldYPct = old && Number.isFinite(Number(old.yPct)) ? Number(old.yPct) : (old && Number.isFinite(Number(old.y_pct)) ? Number(old.y_pct) : null);
  const oldHPct = old && Number.isFinite(Number(old.hPct)) ? Number(old.hPct) : (old && Number.isFinite(Number(old.h_pct)) ? Number(old.h_pct) : null);

  const newHook = raw.newHook || raw.new_hook || (raw.newHook && typeof raw.newHook === 'object' ? raw.newHook : null) || (raw.new_hook && typeof raw.new_hook === 'object' ? raw.new_hook : null) || (raw.newHookPlacement && typeof raw.newHookPlacement === 'object' ? raw.newHookPlacement : null) || (raw.new_hook_placement && typeof raw.new_hook_placement === 'object' ? raw.new_hook_placement : null) || null;

  const yPxRaw = newHook ? (newHook.yPx ?? newHook.y_px ?? newHook.y ?? null) : null;
  let yPx = Number.isFinite(Number(yPxRaw)) ? Number(yPxRaw) : null;
  if (yPx != null) {
    // 0=ALT, 100=ÜST koordinat sistemi (tam serbest)
    yPx = Math.max(0, Math.min(100, yPx));
  }
  const boxOpacityRaw = newHook ? (newHook.boxOpacity ?? newHook.box_opacity ?? null) : null;
  let boxOpacity = Number.isFinite(Number(boxOpacityRaw)) ? Number(boxOpacityRaw) : null;
  if (boxOpacity != null) boxOpacity = Math.max(0, Math.min(1, boxOpacity));

  const text = newHook ? (newHook.text ?? newHook.hook ?? newHook.title ?? '') : '';

  const captionRaw = typeof raw.caption === 'string' ? raw.caption : (typeof raw.Caption === 'string' ? raw.Caption : '');
  const captionParts = splitCaptionPayload(captionRaw);
  const hashtagsRaw = Array.isArray(raw.hashtags) ? raw.hashtags : (Array.isArray(raw.Hashtags) ? raw.Hashtags : []);
  const hashtags = [];
  const seenHash = new Set();
  for (const t of [...hashtagsRaw, ...captionParts.hashtags]) {
    const clean = String(t || '').trim().toLowerCase();
    if (!clean || seenHash.has(clean)) continue;
    seenHash.add(clean);
    hashtags.push(clean.startsWith('#') ? clean : `#${clean.replace(/^#+/, '')}`);
    if (hashtags.length >= 5) break;
  }
  const isListicle =
    raw.isListicle != null ? !!raw.isListicle
    : raw.is_listicle != null ? !!raw.is_listicle
    : raw.listicle != null ? !!raw.listicle
    : raw.isRanked != null ? !!raw.isRanked
    : raw.is_ranked != null ? !!raw.is_ranked
    : false;
  const rankHookHint =
    typeof raw.rankHookHint === 'string' ? raw.rankHookHint
    : typeof raw.rank_hook_hint === 'string' ? raw.rank_hook_hint
    : typeof raw.rankedHook === 'string' ? raw.rankedHook
    : typeof raw.ranked_hook === 'string' ? raw.ranked_hook
    : null;

  const hookColor =
    typeof raw.hookColor === 'string' ? raw.hookColor
    : typeof raw.hook_color === 'string' ? raw.hook_color
    : (raw.newHook && typeof raw.newHook.color === 'string') ? raw.newHook.color
    : (raw.new_hook && typeof raw.new_hook.color === 'string') ? raw.new_hook.color
    : null;

  const out = {
    hasOriginalHook: hasOriginal,
    oldHook: (hasOriginal && oldYPct != null && oldHPct != null) ? { yPct: oldYPct, hPct: oldHPct } : null,
    newHook: { text: String(text || '').trim(), yPx, boxOpacity },
    isListicle,
    rankHookHint: rankHookHint ? String(rankHookHint).trim() : null,
    hookColor: hookColor ? String(hookColor).trim() : null,
    caption: toSingleSentenceCaption(captionParts.caption || ''),
    oldHookText: stripEmoji(String(raw.old_hook_text || raw.oldHookText || '').trim()),
    hashtags: (hashtags || []).map(String).filter(Boolean).slice(0, 5),
    blurRegions: [],
    originalHeaderHeight: null
  };

  // y yoksa fallback 70–95
  if (!Number.isFinite(out.newHook.yPx)) out.newHook.yPx = 95;
  // boxOpacity yoksa: eski yazı yoksa 0.30–0.50
  if (!Number.isFinite(out.newHook.boxOpacity)) out.newHook.boxOpacity = randRange(0.30, 0.50);
  if (hasOriginal) out.newHook.boxOpacity = 1;
  // text boşsa fallback
  if (!out.newHook.text && out.isListicle) {
    out.newHook.text =
      out.rankHookHint ||
      pickOne(['Wait for #1…', 'The best is last…', 'Top picks — #1 is wild…', 'Wait for the final one…']);
  }
  if (!out.newHook.text) out.newHook.text = fallbackHookTextForBrand(brand);
  out.newHook.text = splitHookTwoLines(String(out.newHook.text || '').trim(), { titleHint: titleForHook });

  return out;
}

function normBrand(brand) {
  const b = String(brand || '').toLowerCase().trim();
  if (b === 'kaos') return 'kaos';
  if (b === 'umut') return 'umut';
  return 'terapi';
}

function getBrandFolderName(brand) {
  const n = normBrand(brand);
  if (n === 'kaos') return 'Kaos Atölyesi';
  if (n === 'umut') return 'Umut Atölyesi';
  return 'Terapi Atölyesi';
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
  const geminiProject = req.body?.geminiProject || req.query?.geminiProject || GEMINI_PROJECT_DEFAULT;
  const geminiLocation = req.body?.geminiLocation || req.query?.geminiLocation || GEMINI_LOCATION_DEFAULT;
  const geminiAuthPresent = !!String(geminiProject || '').trim();
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
      let lastThrow = e0;

      if (isYoutubeAgeSignInError(msg0)) {
        const ageClients = ['tv_embedded', 'web', 'ios'];
        let ageOk = false;
        for (const c of ageClients) {
          try {
            await run('yt-dlp', buildCrushDlArgs(c), { timeoutMs: dlTimeoutMs });
            ageOk = true;
            console.log(`[yt-dlp] Yaş/kısıt için alternatif player_client=${c} ile indirildi.`);
            break;
          } catch (eAge) {
            lastThrow = eAge;
          }
        }
        if (!ageOk) {
          const hint = !ytdlpCookieCliArgs().length
            ? ' Çözüm: YouTube’a tarayıcıda giriş yapın ve ortam değişkeni ayarlayın: YTDLP_COOKIES_FROM_BROWSER=chrome veya YTDLP_COOKIES_FILE=yol\\cookies.txt (Netscape formatı).'
            : ' Hâlâ olmuyorsa cookies dosyasını yenileyin veya farklı tarayıcı deneyin.';
          return res.status(400).json({
            error: 'YouTube bu videoyu yaş doğrulaması veya oturum istiyor; indirilemedi.' + hint,
            detail: String((lastThrow && lastThrow.message) || msg0).slice(0, 500)
          });
        }
      } else if (/did not get any data blocks|unable to download video data|http error 403|http error 416|http error 429|po token/i.test(msg0)) {
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
    const outW = 720;
    const outH = 1280;
    const hasAudio = await probeHasAudio(inFile);
    const musicFile = crush.pickRandomMusicFile(PUBLIC_DIR, brand);

    // Director v3: 20 kare + kısa audio preview → Gemini analizi
    let director = null;
    let directorError = null;
    let directorDiag = null;
    let geminiUsed = false;
    const tmpArtifacts = [];
    try {
      const t = inDur;
      // 20 kare:
      // - ilk 5 kare ilk ~2 saniyeden (eski yazıyı yakalamak için)
      // - kalan 15 kare 2sn → sona kadar eşit dağıt
      const early = [0.10, 0.50, 0.90, 1.30, 1.70].map((sec) => Math.max(0, Math.min(t - 0.05, sec)));
      const restStart = Math.min(Math.max(2.0, 0), Math.max(0, t - 0.05));
      const restEnd = Math.max(restStart, t - 0.05);
      const restCount = 15;
      const rest = [];
      if (restCount > 0) {
        const span = Math.max(0.001, restEnd - restStart);
        for (let i = 0; i < restCount; i++) {
          const k = restCount === 1 ? 0.5 : (i / (restCount - 1));
          rest.push(restStart + span * k);
        }
      }
      const times = [...early, ...rest].slice(0, 20).map((sec) => Math.max(0, Math.min(t - 0.05, sec)));
      const frames = times.map((_, i) => path.join(tmpDir, `frame_${String(i + 1).padStart(2, '0')}.png`));
      for (let i = 0; i < times.length; i++) {
        await ffmpegExtractFrame(inFile, frames[i], times[i]);
      }
      const audioPrev = path.join(tmpDir, 'audio_preview.mp3');
      await ffmpegExtractAudioPreview(inFile, audioPrev, Math.min(12, inDur));
      tmpArtifacts.push(...frames, audioPrev);
      if (geminiAuthPresent) {
        geminiUsed = true;
        const rawDir = await geminiDirectorAnalyze({ geminiProject, geminiLocation, brand, framePaths: frames, audioPath: audioPrev, title: metaTitle });
        if (rawDir && rawDir.__va_status === 'RATE_LIMIT_EXHAUSTED') {
          const rawMsg = String(rawDir.message || '');
          if (/high demand|spikes in demand|try again later|temporarily unavailable|service unavailable|overloaded/i.test(rawMsg)) {
            directorError = `Gemini yoğunlukta: tüm denemeler başarısız oldu. (${rawMsg || 'high demand'})`;
          } else {
            directorError = `Gemini kota/rate-limit: 5 denemede de başarısız. (${rawMsg || 'quota'})`;
          }
          directorDiag = rawDir.__va_diag || null;
          director = null;
        } else if (rawDir && rawDir.__va_status === 'PARSE_FAILED') {
          directorError = `${rawDir.message || 'Gemini parse hatası'} Raw: ${String(rawDir.rawSnippet || '').slice(0, 180)}`;
          directorDiag = rawDir.__va_diag || null;
          director = null;
        } else {
          director = rawDir ? normalizeDirectorResult(rawDir, outW, outH, brand, metaTitle) : null;
          directorDiag = rawDir && rawDir.__va_diag ? rawDir.__va_diag : null;
        }
      } else {
        directorError = 'Vertex proje ID yok veya ADC yapılandırılmamış.';
        director = null;
      }
    } catch (e) {
      directorError = (e && e.message) ? e.message : String(e);
      director = null;
    } finally {
      // İstenen temizlik: render başlamadan kare/mp3 dosyalarını sil (tmpDir zaten sonunda kalkıyor)
      for (const p of tmpArtifacts) {
        try { fs.unlinkSync(p); } catch {}
      }
    }

    // Gemini sonucu: eski yazı varsa opak kapatma kutusu + hook y/text
    let hook = null;
    let coverBox = null;
    let finalCaption = '';
    let finalHashtags = [];
    const cache = loadDirectorCache();

    if (director && director.newHook) {
      const isListicle = !!director.isListicle;
      const hookBase = String(director.newHook.text || '').trim();
      const oldHookRemix = remixHookFromOldHook(director.oldHookText, metaTitle, isListicle || titleIsListicle);
      const titleHook = buildHookFromTitle({ title: metaTitle, isListicle: isListicle || titleIsListicle });
      const hookPlain = normalizeHookEmoji(hookBase).text;
      const hookBaseGood =
        hookBase &&
        !looksGenericHook(hookBase) &&
        hookMakesSense(hookBase) &&
        hookFeelsComplete(hookPlain);
      const hookSeed = oldHookRemix || (hookBaseGood ? hookBase : (titleHook || hookBase));
      const hookText = splitHookTwoLines(makeUniqueHook(brand, hookSeed, cache, isListicle || titleIsListicle), {
        titleHint: metaTitle || ''
      });
      hook = {
        text: hookText,
        // bannerY: 0=ALT, 100=ÜST → ffmpeg y=0 üst olduğu için ters çevir
        bannerY: outH * (1 - (Number(director.newHook.yPx) / 100)),
        y: Number(director.newHook.yPx),
        boxOpacity: Number(director.newHook.boxOpacity),
        color: director.hookColor || null
      };

      // Caption: soru/CTA istemiyoruz; sadece videoyu anlatan doğal İngilizce caption kabul et.
      const capCandidate = toSingleSentenceCaption(director.caption || '');
      const capGood = captionLooksGood(capCandidate);
      const fallbackCaptionBits = splitCaptionPayload(buildFallbackCaptionFromTitle(metaTitle, isListicle || titleIsListicle));
      finalCaption = capGood ? capCandidate : toSingleSentenceCaption(fallbackCaptionBits.caption || buildFallbackCaptionFromTitle(metaTitle, isListicle || titleIsListicle));
      finalHashtags = ensureHashtagPack(brand, hookText, Array.isArray(director.hashtags) && director.hashtags.length ? director.hashtags : fallbackCaptionBits.hashtags);

      rememberUsed(cache, 'hooks', hookText);
      rememberUsed(cache, 'captions', finalCaption);
      saveDirectorCache(cache);

      // Force mask: üstte yazı/hook varsa siyah bant — original_header_height +/veya old_hook_box birleşimi.
      // Not: old_hook_box varsa bant yüksekliği "sadece hook arka planı kadar" olmalı (küçük güven payıyla).
      const minBandHdr = Math.round(outH * 0.22);
      const minBandHook = Math.round(outH * 0.10);
      const hdr = Number(director.originalHeaderHeight);
      let bandY = 0;
      let bandH = 0;
      let bandReason = 'none';
      if (director.oldHookBox && director.oldHookBox.w >= 8 && director.oldHookBox.h >= 8) {
        const ob = director.oldHookBox;
        const padY = Math.max(3, Math.round(outH * 0.004));
        // İkinci satır/emoji sızıntısı: kutu sadece 1. satıra sıkı ölçülmüş olabiliyor — ekstra güven payı.
        const antiLeakPad = Math.max(26, Math.round(outH * 0.034));
        const fromBoxBottom = Math.max(2, Math.min(outH, Math.round(ob.y + ob.h + padY + antiLeakPad)));
        const fromHdr =
          Number.isFinite(hdr) && hdr > 0
            ? Math.max(2, Math.min(outH, Math.round(hdr * 1.12)))
            : 0;
        // Kullanıcı kuralı: bant y=0’dan başlar; alt kenar = kutunun altı ile header_height ölçümünün MAX’i (+padding).
        bandY = 0;
        bandH = Math.max(minBandHook, Math.min(outH, Math.max(fromBoxBottom, fromHdr)));
        bandReason = 'gemini_old_hook_box_top_anchored';
      } else if (Number.isFinite(hdr) && hdr > 0) {
        bandY = 0;
        bandH = Math.max(2, Math.min(outH, Math.max(minBandHdr, Math.round(hdr * 1.35))));
        bandReason = 'gemini_header_height';
      }
      // Gemini üst yazıyı görmese bile: başlık listicle/ranked ise üstte yazı OLDUĞUNU kabul et
      // ve otomatik bant çek. Bu, eski hook'un sızmasını engeller.
      if (bandH === 0 && (isListicle || titleIsListicle)) {
        bandY = 0;
        bandH = Math.max(minBandHdr, Math.round(outH * 0.22));
        bandReason = 'auto_listicle_fallback';
      }
      if (bandH > 0) {
        coverBox = { y: bandY, h: bandH, w: outW, opacity: 1 };
        if (hook) {
          hook.boxOpacity = 1;
          hook.bannerY = bandY;
        }
      }
      console.log('[Crush Band]', JSON.stringify({
        reason: bandReason,
        bandY,
        bandH,
        titleListicle: !!titleIsListicle,
        geminiListicle: !!isListicle,
        hdr: Number.isFinite(hdr) ? hdr : 0,
        oldHookBox: director.oldHookBox || null
      }));

      if (
        director.hasOriginalHook &&
        director.oldHook &&
        Number.isFinite(director.oldHook.yPct) &&
        Number.isFinite(director.oldHook.hPct) &&
        !director.oldHookBox
      ) {
        // Strict masking:
        // - opaklık her koşulda 1.0
        // - genişlik tam video (outW)
        // - yükseklik: Gemini hPct * 1.5 (sızıntı olmasın)
        const baseY = outH * (Number(director.oldHook.yPct) / 100);
        const baseH = outH * (Number(director.oldHook.hPct) / 100);
        const safeH = Math.max(2, baseH * 1.5);
        // Y merkezini koru: yükseklik büyüdüyse yukarı taşı
        const safeY = baseY - (safeH - baseH) / 2;

        coverBox = {
          // biraz daha yukarı çek (padding)
          y: safeY - (outH * 0.01),
          h: safeH,
          w: outW,
          opacity: 1
        };

        // Hook'u eski yazının ortasına hizala (banner içinde)
        if (hook) {
          hook.boxOpacity = 1;
          // Banner'ı doğrudan coverBox üstüne taşı
          hook.bannerY = coverBox.y;
        }
      }
      // Eski yazı yoksa: 70–95 arası random (Gemini yanlış/vermemişse)
      if (!director.hasOriginalHook && (!Number.isFinite(hook.boxOpacity) || hook.boxOpacity <= 0)) {
        hook.boxOpacity = randRange(0.30, 0.50);
      }
    } else {
      // Fallback (Gemini hata/timeout): kod çökmesin, render devam etsin
      const titleHook = buildHookFromTitle({ title: metaTitle, isListicle: titleIsListicle });
      const seed = titleHook || fallbackHookTextForBrand(brand);
      const hookText = splitHookTwoLines(makeUniqueHook(brand, seed, cache, titleIsListicle), {
        titleHint: metaTitle || ''
      });
      hook = { text: hookText, bannerY: 0, y: 95, boxOpacity: 1, color: null };
      const fallbackCaptionBits = splitCaptionPayload(buildFallbackCaptionFromTitle(metaTitle || fallbackCaptionForBrand(brand), titleIsListicle));
      finalCaption = toSingleSentenceCaption(fallbackCaptionBits.caption || fallbackCaptionForBrand(brand));
      finalHashtags = ensureHashtagPack(brand, hookText, fallbackCaptionBits.hashtags);
      rememberUsed(cache, 'hooks', hookText);
      rememberUsed(cache, 'captions', finalCaption);
      saveDirectorCache(cache);
      if (!director) {
        director = { caption: finalCaption, hashtags: finalHashtags };
      }
    }

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
            blurRegions: effectiveBlurRegions,
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

    // Blur tamamen kapalı:
    // Gemini koordinat döndürse bile hiçbir bölgeye blur uygulanmaz.
    const geminiBlurs = Array.isArray(director?.blurRegions) ? director.blurRegions : [];
    const effectiveBlurRegions = [];
    console.log('[Crush Blur]', JSON.stringify({
      fromGemini: geminiBlurs.length,
      total: effectiveBlurRegions.length,
      regions: effectiveBlurRegions,
      disabled: true
    }));

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
      blurRegions: effectiveBlurRegions,
      hasAudio,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      useRubberband: true
    });
    plan = await renderPlanWithFallback(plan);

    const topBandSafety = { checked: false, leakDetected: false, rerendered: false, rounds: 0, reason: '', extraBandPx: 0 };
    if (coverBox && geminiAuthPresent) {
      const topPreview = path.join(tmpDir, 'top_band_preview.png');
      try {
        for (let round = 0; round < 2; round++) {
          const previewH = Math.min(outH, Math.max(260, Math.round((coverBox.y || 0) + (coverBox.h || 0) + 88)));
          await ffmpegExtractTopBandPreview(outFile, topPreview, previewH, 0.05);
          const topLeak = await geminiVerifyTopBandLeak({
            geminiProject,
            geminiLocation,
            previewPath: topPreview,
            hookText: hook && hook.text ? hook.text : '',
            coverBox
          });
          topBandSafety.checked = true;
          if (topLeak) {
            topBandSafety.reason = topLeak.reason || '';
            topBandSafety.extraBandPx = Number(topLeak.extraBandPx) || 0;
          }
          if (!topLeak || !topLeak.leak) break;
          topBandSafety.leakDetected = true;
          topBandSafety.rounds = round + 1;
          const growPx = clamp(topLeak.extraBandPx || 40, 24, 140);
          const oldBottom = Math.max(0, Math.round((coverBox.y || 0) + (coverBox.h || 0)));
          const newBottom = Math.min(outH, oldBottom + growPx);
          coverBox = { y: 0, h: newBottom, w: outW, opacity: 1 };
          if (hook) {
            hook.boxOpacity = 1;
            hook.bannerY = 0;
          }
          console.log('[Crush Safety]', JSON.stringify({
            round: round + 1,
            leakDetected: true,
            growPx,
            newCoverBox: coverBox,
            reason: topLeak.reason || ''
          }));
          plan = await crush.buildCrushRenderPlan({
            inFile,
            wmFile,
            musicFile,
            brand,
            outW,
            outH,
            sourceDurSec: inDur,
            hook,
            coverBox,
            blurRegions: effectiveBlurRegions,
            hasAudio,
            ffmpegPath: 'ffmpeg',
            ffprobePath: 'ffprobe',
            useRubberband: true
          });
          plan = await renderPlanWithFallback(plan);
          topBandSafety.rerendered = true;
        }
      } catch (eSafety) {
        topBandSafety.checked = true;
        topBandSafety.reason = `safety_check_failed: ${String((eSafety && eSafety.message) || eSafety)}`;
      } finally {
        try { fs.unlinkSync(topPreview); } catch {}
      }
    }

    const usernameBlurSafety = { checked: false, leakDetected: false, rerendered: false, fixes: [] };
    if (effectiveBlurRegions.length > 0 && geminiAuthPresent) {
      usernameBlurSafety.checked = true;
      let blurAdjusted = false;
      for (let i = 0; i < effectiveBlurRegions.length; i++) {
        const reg = effectiveBlurRegions[i];
        const previewPath = path.join(tmpDir, `blur_region_${i + 1}.png`);
        try {
          await ffmpegExtractRegionPreview(outFile, previewPath, reg, outW, outH, 0.05, 20);
          const check = await geminiVerifyUsernameBlurLeak({
            geminiProject,
            geminiLocation,
            previewPath,
            expectedUsername: reg && reg.text ? reg.text : ''
          });
          if (check && check.usernamePresent === false) {
            effectiveBlurRegions[i] = null;
            usernameBlurSafety.fixes.push({
              index: i,
              action: 'removed',
              reason: check.reason || 'username_not_present',
              region: reg
            });
            blurAdjusted = true;
            continue;
          }
          if (check && check.leak) {
            usernameBlurSafety.leakDetected = true;
            const next = {
              ...reg,
              x: clamp(reg.x - check.left, 0, outW - 8),
              y: clamp(reg.y - check.top, 0, outH - 8)
            };
            next.w = clamp((reg.w + check.left + check.right), 8, outW - next.x);
            next.h = clamp((reg.h + check.top + check.bottom), 8, outH - next.y);
            effectiveBlurRegions[i] = next;
            usernameBlurSafety.fixes.push({
              index: i,
              action: 'expanded',
              reason: check.reason || '',
              expand: { left: check.left, top: check.top, right: check.right, bottom: check.bottom },
              region: next
            });
            blurAdjusted = true;
          }
        } catch (eBlurSafe) {
          usernameBlurSafety.fixes.push({
            index: i,
            reason: `blur_safety_failed: ${String((eBlurSafe && eBlurSafe.message) || eBlurSafe)}`,
            region: reg
          });
        } finally {
          try { fs.unlinkSync(previewPath); } catch {}
        }
      }
      for (let i = effectiveBlurRegions.length - 1; i >= 0; i--) {
        if (!effectiveBlurRegions[i]) effectiveBlurRegions.splice(i, 1);
      }
      if (blurAdjusted) {
        console.log('[Crush Blur Safety]', JSON.stringify(usernameBlurSafety));
        plan = await crush.buildCrushRenderPlan({
          inFile,
          wmFile,
          musicFile,
          brand,
          outW,
          outH,
          sourceDurSec: inDur,
          hook,
          coverBox,
          blurRegions: effectiveBlurRegions,
          hasAudio,
          ffmpegPath: 'ffmpeg',
          ffprobePath: 'ffprobe',
          useRubberband: true
        });
        plan = await renderPlanWithFallback(plan);
        usernameBlurSafety.rerendered = true;
      }
    }

    const verify = await crush.selfCheckCrushOutput('ffmpeg', 'ffprobe', outFile);

    return res.json({
      ok: true,
      savedTo: brandDir,
      file: path.basename(outFile),
      settings: { ...plan.debug, topBandSafety, usernameBlurSafety },
      verify,
      geminiAttempted: geminiAuthPresent,
      geminiKeyPresent: geminiAuthPresent,
      geminiUsed,
      director: directorError
        ? {
            ok: false,
            error: directorError,
            diag: directorDiag,
            fallbackCaption: finalCaption || '',
            fallbackHashtags: finalHashtags && finalHashtags.length ? finalHashtags : []
          }
        : director
          ? {
              ok: true,
              ...director,
              diag: directorDiag,
              caption: (finalCaption || director.caption || ''),
              hashtags: (finalHashtags && finalHashtags.length ? finalHashtags : director.hashtags)
            }
          : { ok: false, error: 'Gemini key yok veya analiz çalışmadı', diag: directorDiag },
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

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Local Downloader running on http://127.0.0.1:${PORT}`);
  console.log('Download dir:', DOWNLOAD_DIR);
  console.log('Install yt-dlp then open your frontend and click Download.');
});

