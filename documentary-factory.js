/**
 * Belgesel Fabrikası: kanal (epoch / chaos / therapy), Gemini yönetmen planı,
 * Pollinations 9:16 görsel, pan, ElevenLabs, FFmpeg.
 * Meme ve Voice Enjektör dosyalarına bağlı değildir.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const {
  synthesizeSpeechAligned,
  spokenHookText,
  ElevenLabsHookError
} = require('./elevenlabs-hook');

const OUT_W = 1080;
const OUT_H = 1920;
const OUT_FPS = 30;
const DOC_VOICES = Object.freeze({
  adam: 'pNInz6obpgDQGcFmaJgB',
  george: 'JBFqnCBsd6RMkjVDRZzb',
  brian: 'nPczCjzI2devNBz1zQrb',
  story: 'SAxJUlDKRc79XAyeWyMu'
});
const DOC_VOICE_LABELS = Object.freeze({
  [DOC_VOICES.adam]: 'Ses 1 - Adam (Tok & Derin)',
  [DOC_VOICES.george]: 'Ses 2 - George (Sinematik Anlatıcı)',
  [DOC_VOICES.brian]: 'Ses 3 - Brian (Derin & Tok)',
  [DOC_VOICES.story]: 'Ses 4 - Derin Hikâye'
});
const DOC_VOICE_KEYS = Object.freeze({
  [DOC_VOICES.adam]: 'adam',
  [DOC_VOICES.george]: 'george',
  [DOC_VOICES.brian]: 'brian',
  [DOC_VOICES.story]: 'story'
});
const DOC_VOICE_ALIASES = Object.freeze({
  ErXwobaYiN019PkySvjV: DOC_VOICES.george,
  VR6AewLTigWG4xSOukaG: DOC_VOICES.brian,
  auq43ws1oslv0tO4BDa7: DOC_VOICES.story
});
const DOC_VOICE_SETTINGS = Object.freeze({
  stability: 0.45,
  similarity_boost: 0.75,
  style: 0.35,
  use_speaker_boost: true
});
const DOC_PREVIEW_LINES = Object.freeze({
  en: 'The corridor was silent, and a buried truth finally found its voice.',
  tr: 'Koridor sessizdi ve gömülü bir gerçek sonunda sesini buldu.'
});

function resolveDocVoice(choice) {
  const raw = String(choice || '').trim();
  const key = raw.toLowerCase();
  const pool = Object.values(DOC_VOICES);
  let id = '';
  let pickedAtRandom = false;
  if (!key) {
    id = DOC_VOICES.adam;
  } else if (key === 'random' || key === 'rastgele') {
    id = pool[Math.floor(Math.random() * pool.length)];
    pickedAtRandom = true;
  } else if (DOC_VOICE_ALIASES[raw]) {
    id = DOC_VOICE_ALIASES[raw];
  } else if (pool.indexOf(raw) >= 0) {
    id = raw;
  } else if (key === 'adam' || key === 'deep' || key === 'ses1' || key === '1') {
    id = DOC_VOICES.adam;
  } else if (key === 'george' || key === 'antony' || key === 'cinematic' || key === 'ses2' || key === '2') {
    id = DOC_VOICES.george;
  } else if (key === 'brian' || key === 'arnold' || key === 'resonant' || key === 'tok' || key === 'ses3' || key === '3') {
    id = DOC_VOICES.brian;
  } else if (key === 'story' || key === 'narrator' || key === 'morgan' || key === 'ses4' || key === '4' || key === 'ses5' || key === '5') {
    id = DOC_VOICES.story;
  }
  if (!id || !DOC_VOICE_LABELS[id]) {
    throw new DocumentaryError('Belgesel için listeden bir anlatıcı seç.', 400);
  }
  return { id, label: DOC_VOICE_LABELS[id], choice: pickedAtRandom ? 'random' : DOC_VOICE_KEYS[id] };
}

function documentaryVoiceFromRequest(body) {
  const requested = String(
    (body && (body.voice_id || body.voiceId || body.narrator || body.voice)) || ''
  ).trim();
  const voice = resolveDocVoice(requested);
  console.log(`[belgesel] gelen voice_id=${requested || '(yok, Adam)'} -> ElevenLabs voice_id=${voice.id}`);
  return voice;
}

function shapeNarration(narration, tone) {
  let text = String(narration || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const hint = String(tone || '').toLowerCase();
  const wantsPause = /pause|duraks|breath|beat|dramatic|emphasis|emphas|vurg/.test(hint);
  const atStart = /beginning|start|opening|baş/.test(hint);
  if (wantsPause && atStart) text = `<break time="0.8s" /> ${text}`;
  if (wantsPause) text = text.replace(/([.!?])(\s+)/g, '$1 <break time="0.4s" />$2');
  return text;
}

function voiceSettingsForTone() {
  return DOC_VOICE_SETTINGS;
}

function isVoiceRestricted(err) {
  if (!(err instanceof ElevenLabsHookError)) return false;
  const status = Number(err.details && err.details.status);
  const msg = String(err.message || '');
  if (status === 402) return true;
  return /library voice|free users|cannot use|can not use|voice restriction|not available for|paid plan/i.test(msg);
}

function isVoiceFallbackError(err) {
  if (isVoiceRestricted(err)) return true;
  if (!(err instanceof ElevenLabsHookError)) return false;
  const status = Number(err.details && err.details.status);
  const msg = String(err.message || '');
  if (status === 404) return true;
  if (status === 400 && /voice|ses id|voice_id|voice id/i.test(msg)) return true;
  return /voice_not_found|invalid voice|unknown voice|voice does not exist|no voice/i.test(msg);
}

class DocumentaryError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'DocumentaryError';
    this.statusCode = statusCode || 500;
  }
}

function geminiModel() {
  const explicit = String(process.env.GEMINI_VOICE_MODEL || '').trim();
  if (explicit) return explicit;
  const shared = String(process.env.GEMINI_MODEL || '').trim();
  if (shared && shared !== 'gemini-2.0-flash') return shared;
  return 'gemini-3.5-flash-lite';
}

function geminiFailReason(err) {
  const name = String(err && err.name || '');
  const code = err && err.cause ? String(err.cause.code || err.cause.name || '') : '';
  const msg = String(err && err.message || '')
    .replace(/AIza[0-9A-Za-z_-]{8,}/g, 'AIzaREDACTED')
    .replace(/key=[^\s&]+/gi, 'key=REDACTED');
  return `${name} ${code} ${msg}`.replace(/\s+/g, ' ').trim().slice(0, 220);
}

function geminiFailText(err) {
  const name = String(err && err.name || '');
  const code = err && err.cause && err.cause.code ? String(err.cause.code) : '';
  if (name === 'TimeoutError' || name === 'AbortError' || /timeout|aborted/i.test(String(err && err.message || ''))) {
    return 'Gemini süre dolmadan cevap yazmadı. Tekrar dene.';
  }
  if (code) return `Gemini bağlantısı koptu (${code}). Tekrar dene.`;
  return 'Gemini bağlantısı koptu. Tekrar dene.';
}

function geminiCandidates() {
  return [...new Set(
    ['gemini-3.5-flash-lite', geminiModel(), 'gemini-3.6-flash', 'gemini-3.8-flash']
      .map((name) => String(name || '').trim())
      .filter(Boolean)
  )];
}

function geminiIsDemand(status, message) {
  const msg = String(message || '');
  if (/high demand|spikes in demand|try again later|unavailable|overloaded|currently experiencing/i.test(msg)) return true;
  return status === 500 || status === 502 || status === 503 || status === 504;
}

function geminiIsQuota(status, message) {
  const msg = String(message || '');
  if (/high demand|spikes in demand/i.test(msg)) return false;
  return status === 429 || /quota|free_tier|exceeded your current quota|resource_exhausted/i.test(msg);
}

function geminiErrorMessage(data) {
  const msg = data && data.error && (data.error.message || data.error.status);
  return String(msg || '').replace(/\s+/g, ' ').trim().slice(0, 180);
}

async function geminiFetch(key, body, timeoutMs, model) {
  const name = model || geminiModel();
  return fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(name)}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': String(key || '').trim()
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    }
  );
}

function runFfmpeg(ffmpegPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 160000) stderr = stderr.slice(-160000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve();
      const lines = String(stderr || '').split(/\r?\n/).map((l) => l.trim()).filter((l) =>
        l && !/^ffmpeg version/i.test(l) && !/^built with/i.test(l) && !/^configuration:/i.test(l) && !/^libav/i.test(l)
      );
      const interesting = lines.filter((l) => /error|invalid|unable|no such|matches no/i.test(l));
      reject(new DocumentaryError((interesting.slice(-4).join(' ') || lines.slice(-4).join(' ') || `ffmpeg exit ${code}`).slice(0, 500)));
    });
  });
}

function probeDurationSec(ffprobePath, filePath) {
  return new Promise((resolve) => {
    const child = spawn(ffprobePath || 'ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('close', () => {
      const n = Number(String(out).trim());
      resolve(Number.isFinite(n) ? n : 0);
    });
    child.on('error', () => resolve(0));
  });
}

function pickFont() {
  const candidates = process.platform === 'win32'
    ? ['C:\\Windows\\Fonts\\arialbd.ttf', 'C:\\Windows\\Fonts\\arial.ttf']
    : [
      '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
      '/usr/share/fonts/truetype/freefont/FreeSansBold.ttf'
    ];
  return candidates.find((p) => {
    try { return fs.existsSync(p); } catch { return false; }
  }) || '';
}

function quoteDrawtext(value) {
  const body = String(value)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/%/g, '\\%')
    .replace(/,/g, '\\,')
    .replace(/'/g, '\u2019');
  return `'${body}'`;
}

function wordCount(text) {
  return String(text || '')
    .replace(/\[[^\]]*\]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .length;
}

function captionCueWords(words) {
  let depth = 0;
  const out = [];
  for (const item of words || []) {
    let kept = '';
    for (const ch of String(item && item.word || '')) {
      if (ch === '[') {
        depth += 1;
        continue;
      }
      if (ch === ']' && depth > 0) {
        depth -= 1;
        continue;
      }
      if (depth === 0) kept += ch;
    }
    kept = kept.trim();
    if (kept) out.push({ word: kept, start: item.start, end: item.end });
  }
  return out;
}

function evenWordCues(text, duration) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const dur = Math.max(0.4, Number(duration) || 1);
  const slice = dur / Math.max(1, words.length);
  return words.map((word, i) => ({
    word,
    start: i * slice,
    end: Math.min(dur, (i + 1) * slice)
  }));
}

function captionPhrases(words, duration) {
  const list = captionCueWords(words).filter((item) => item && item.word);
  const dur = Math.max(0.4, Number(duration) || 0.4);
  if (!list.length) return [];
  const phrases = [];
  for (let i = 0; i < list.length; i += 4) {
    const chunk = list.slice(i, i + 4);
    chunk.forEach((item, k) => {
      const start = Math.max(0, Math.min(dur, Number(item.start) || 0));
      const next = k < chunk.length - 1
        ? Number(chunk[k + 1].start)
        : (i + 4 < list.length ? Number(list[i + 4].start) : dur);
      const end = Math.max(start + 0.05, Math.min(dur, Number.isFinite(next) ? next : dur));
      phrases.push({
        phrase: chunk.slice(0, k + 1).map((part) => part.word).join(' '),
        start,
        end: (i + k === list.length - 1) ? dur : end
      });
    });
  }
  return phrases;
}

function buildCaptionFilter(words, duration, fontFile) {
  const phrases = captionPhrases(words, duration);
  const font = fontFile
    ? `fontfile=${quoteDrawtext(fontFile.replace(/\\/g, '/'))}`
    : 'font=Arial';
  const base = Math.round(OUT_H * 0.74);
  const draws = phrases.map((cue) => {
    const start = cue.start.toFixed(3);
    const enable = `gte(t,${start})*lt(t,${cue.end.toFixed(3)})`;
    const fade = `min(1,(t-${start})/0.045)`;
    const shown = cue.phrase.replace(/'/g, '\u2019');
    return (
      `drawtext=${font}:text=${quoteDrawtext(shown)}` +
      `:fontsize=58:fontcolor=0xFFFFFF:borderw=4:bordercolor=0x000000` +
      `:shadowx=2:shadowy=2:shadowcolor=0x000000` +
      `:x=(w-text_w)/2:y='${base}-18*exp(-(t-${start})/0.07)'` +
      `:alpha='${fade}'` +
      `:expansion=none:enable='${enable}'`
    );
  });
  return draws.concat([
    `fps=${OUT_FPS}:start_time=0:round=near`,
    'setpts=PTS-STARTPTS',
    'setsar=1',
    'format=yuv420p'
  ]).join(',');
}

const STYLE_LOCK = ', cinematic dark horror/mystery documentary still, moody chiaroscuro lighting, dramatic shadows, desaturated cold color palette, hyper-realistic, 8k resolution, film grain, grim atmosphere, no bright colors';
const THERAPY_STYLE_LOCK = ', surreal psychological thriller cinematography, dark shadows, silhouette in fog, eerie minimalist lighting, cold blue and black tones, hyper-realistic, 8k resolution, film grain, no bright colors';
const STYLE_MARKS = [
  'cinematic dark horror/mystery documentary still',
  'cinematic dark historical documentary still',
  'surreal psychological thriller cinematography'
];

function cleanImagePrompt(raw) {
  let text = String(raw || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^["']+|["']+$/g, '')
    .trim();
  const lower = text.toLowerCase();
  let cut = text.length;
  for (const mark of STYLE_MARKS) {
    const at = lower.indexOf(mark);
    if (at >= 0 && at < cut) cut = at;
  }
  if (cut < text.length) text = text.slice(0, cut).replace(/[\s,.:;-]+$/g, '').trim();
  if (text.length > 700) text = text.slice(0, 700).replace(/\s+\S*$/, '').trim();
  const words = text.split(/\s+/).filter((word) => word.length > 1);
  if (words.length < 8) return '';
  return text;
}

function styleLockFor(channel) {
  return resolveDocChannel(channel) === 'therapy' ? THERAPY_STYLE_LOCK : STYLE_LOCK;
}

function withStyleLock(prompt, channel) {
  return String(prompt || '').replace(/[\s,.:;-]+$/g, '') + styleLockFor(channel);
}

function cleanTimestamp(raw) {
  const text = String(raw || '').trim();
  const match = text.match(/(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)/);
  if (!match) return '';
  return `${match[1]}-${match[2]}`;
}

function cleanVoiceTone(raw) {
  return String(raw || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function repairTruncatedJson(input) {
  let out = '';
  const stack = [];
  let inStr = false;
  let esc = false;
  for (const ch of String(input || '')) {
    out += ch;
    if (inStr) {
      if (esc) {
        esc = false;
        continue;
      }
      if (ch === '\\') {
        esc = true;
        continue;
      }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if ((ch === '}' || ch === ']') && stack.length) stack.pop();
  }
  if (inStr) {
    out = out.replace(/\\+$/, (slashes) => (slashes.length % 2 ? slashes.slice(0, -1) : slashes));
    out += '"';
  }
  out = out.replace(/,\s*$/, '');
  while (stack.length) out += stack.pop();
  return out;
}

function parseJsonLoose(text) {
  const cleaned = String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .trim();
  const objAt = cleaned.indexOf('{');
  const arrAt = cleaned.indexOf('[');
  let start = objAt;
  if (arrAt >= 0 && (objAt < 0 || arrAt < objAt)) start = arrAt;
  if (start < 0) return null;
  let slice = cleaned.slice(start).replace(/,\s*([}\]])/g, '$1');
  for (let cut = 0; cut < 8; cut++) {
    const attempts = [slice, repairTruncatedJson(slice)];
    for (const attempt of attempts) {
      try {
        return JSON.parse(attempt);
      } catch {}
    }
    const prev = slice.lastIndexOf('}');
    if (prev <= 0) break;
    slice = slice.slice(0, prev).replace(/,\s*$/, '');
  }
  return null;
}

const MUSIC_MOODS = Object.freeze(['mystery', 'epic', 'sad', 'science']);
const MUSIC_VOLUME = 0.07;
const MUSIC_DIR = path.join(__dirname, 'assets', 'music');
const MUSIC_EXTS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac']);
const MOOD_HINTS = Object.freeze({
  mystery: ['mystery', 'suspense', 'thriller', 'mysterious', 'dark', 'tension'],
  epic: ['epic', 'intense', 'cinematic', 'battle'],
  sad: ['sad', 'anxiety', 'grief', 'tense'],
  science: ['science', 'investigation', 'crime']
});

function cleanMusicMood(value, narrationBlob) {
  const key = String(value || '').toLowerCase();
  if (/epic|war|battle|savaş|kırıl/.test(key)) return 'epic';
  if (/sad|grief|collapse|çök|felaket|famine|kıtlık/.test(key)) return 'sad';
  if (/science|bilim|kanıt|evidence|discover/.test(key)) return 'science';
  if (/mystery|gizem|secret|tarih/.test(key)) return 'mystery';
  const blob = String(narrationBlob || '').toLowerCase();
  if (/war|battle|empire fell|invasion|revolution|conquest|army/.test(blob)) return 'epic';
  if (/famine|plague|death|collapse|ruin|disaster|starv|grief|extinct/.test(blob)) return 'sad';
  if (/science|experiment|discover|evidence|atom|orbit|vaccine|laboratory/.test(blob)) return 'science';
  return 'mystery';
}

function musicTokens(file) {
  return path.basename(file, path.extname(file))
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function listMusicFiles() {
  let names = [];
  try {
    names = fs.readdirSync(MUSIC_DIR);
  } catch {
    throw new DocumentaryError('Müzik klasörü yok: assets/music');
  }
  const files = names
    .filter((name) => MUSIC_EXTS.has(path.extname(name).toLowerCase()))
    .map((name) => path.join(MUSIC_DIR, name))
    .filter((file) => {
      try { return fs.statSync(file).isFile(); } catch { return false; }
    });
  if (!files.length) throw new DocumentaryError('assets/music içinde müzik dosyası yok.');
  return files;
}

function musicFileForMood(mood) {
  const name = MUSIC_MOODS.indexOf(mood) >= 0 ? mood : 'mystery';
  const files = listMusicFiles();
  const hints = MOOD_HINTS[name] || MOOD_HINTS.mystery;
  const ranked = files.map((file) => {
    const tokens = musicTokens(file);
    const score = hints.reduce((n, hint) => n + (tokens.indexOf(hint) >= 0 ? 1 : 0), 0);
    return { file, score };
  });
  const matched = ranked.filter((row) => row.score > 0);
  const pool = matched.length ? matched : ranked;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  return { mood: name, file: pick.file, title: path.basename(pick.file) };
}

function parseScenePlan(raw) {
  const parsed = parseJsonLoose(raw);
  if (!parsed) throw new DocumentaryError('Gemini sahne planı JSON döndürmedi.');
  const scenes = normalizeScenes(parsed);
  const blob = scenes.map((scene) => scene.narration).join(' ');
  const hinted = Array.isArray(parsed) ? '' : (parsed.music_mood || parsed.mood || '');
  return { scenes, music_mood: cleanMusicMood(hinted, blob) };
}

function normalizeScenes(data) {
  const raw = Array.isArray(data) ? data : (data && Array.isArray(data.scenes) ? data.scenes : []);
  const scenes = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const narration = spokenHookText(item.narration || item.text || '');
    const image_prompt = cleanImagePrompt(
      item.image_prompt || item.image_search_query || item.visual_search_query || item.prompt || ''
    );
    if (!narration || wordCount(narration) < 4 || !image_prompt) continue;
    scenes.push({
      timestamp_sec: cleanTimestamp(item.timestamp_sec || item.timestamp || ''),
      narration,
      image_prompt,
      voice_tone: cleanVoiceTone(item.voice_tone || item.tone || '') || 'deep documentary'
    });
  }
  if (scenes.length < 5) {
    throw new DocumentaryError('Sahne planı 5 sahneden kısa kaldı. Konuyu biraz daha açıp yeniden dene.');
  }
  return scenes.slice(0, 8);
}

function geminiParts(data) {
  const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content
    ? data.candidates[0].content.parts
    : null;
  return Array.isArray(parts) ? parts : [];
}

function visibleGeminiText(data) {
  const parts = geminiParts(data);
  const visible = parts.filter((part) => part && part.text && !part.thought).map((part) => part.text).join('\n').trim();
  if (visible) return visible;
  return parts.filter((part) => part && part.text).map((part) => part.text).join('\n').trim();
}

function stripTopicDecor(line) {
  let text = String(line || '').trim();
  for (let i = 0; i < 4; i++) {
    const next = text
      .replace(/^[*_#>\-\d\.\)\s]+/, '')
      .replace(/^(\([^)]{0,48}\)\s*[:*\-–.]+\s*)+/i, '')
      .replace(/^(hidden fact|what-if|what if|topic|title|hook|konu|başlık|baslik)\s*[:*\-–.]+\s*/i, '')
      .replace(/^["'`“”]+|["'`“”*_:]+$/g, '')
      .trim();
    if (next === text) break;
    text = next;
  }
  return text.replace(/\s+/g, ' ').trim();
}

function isSpokenTopic(text) {
  if (!text || text.length < 8 || text.length > 180) return false;
  if (/^(hidden fact|what-if|topic|title|konu|başlık)\b/i.test(text)) return false;
  if (/^[\(\*_:]/.test(text)) return false;
  const words = text.split(/\s+/).filter(Boolean);
  return words.length >= 4 && words.length <= 22;
}

function cleanTopicLine(raw) {
  const source = String(raw || '').replace(/```[\s\S]*?```/g, ' ').trim();
  let parsed = '';
  const jsonStart = source.indexOf('{');
  const jsonEnd = source.lastIndexOf('}');
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    try {
      const obj = JSON.parse(source.slice(jsonStart, jsonEnd + 1));
      if (obj && obj.topic) parsed = String(obj.topic);
    } catch {}
  }
  const blob = parsed || source;
  const quoted = [];
  const quoteRe = /["“]([^"”\n]{8,180})["”]/g;
  let match;
  while ((match = quoteRe.exec(blob))) quoted.push(match[1]);
  const pieces = quoted.concat(blob.split(/\r?\n/));
  const cleaned = pieces.map(stripTopicDecor).filter(isSpokenTopic);
  cleaned.sort((a, b) => b.length - a.length);
  return (cleaned[0] || '').slice(0, 240);
}

const DOC_CHANNELS = Object.freeze(['epoch', 'chaos', 'therapy']);
const CHAOS_SUBREDDITS = Object.freeze(['LetsNotMeet', 'NoSleep', 'UnresolvedMysteries']);

function resolveDocChannel(raw) {
  const value = String(raw || 'epoch').trim().toLowerCase();
  if (!value || value === 'epoch' || value === 'umut' || value === 'epochlab' || value === 'epoch lab') return 'epoch';
  if (value === 'chaos' || value === 'kaos' || value === 'chaoslab' || value === 'chaos lab') return 'chaos';
  if (value === 'therapy' || value === 'terapi' || value === 'therapylab' || value === 'therapy lab') return 'therapy';
  throw new DocumentaryError('Kanal epoch, chaos veya therapy olmalı.', 400);
}

function isChaosPost(post) {
  if (!post || post.stickied || post.over_18 || post.promoted) return false;
  if (post.removed_by_category || post.banned_by) return false;
  const title = String(post.title || '').replace(/\s+/g, ' ').trim();
  const text = String(post.selftext || '').trim();
  if (title.length < 8 || text.length < 400) return false;
  if (/^\[(removed|deleted)\]$/i.test(text)) return false;
  const blob = `${title}\n${text}`.toLowerCase();
  if (/\b(child porn|csam|underage sex|preteen sex)\b/.test(blob)) return false;
  return true;
}

function pickChaosPost(posts, avoid) {
  const skip = String(avoid || '').trim().toLowerCase();
  const ranked = (Array.isArray(posts) ? posts : [])
    .filter(isChaosPost)
    .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
  const fresh = ranked.filter((post) => {
    const title = String(post.title || '').trim().toLowerCase();
    return title !== skip && String(post.id || '').toLowerCase() !== skip;
  });
  const pool = (fresh.length ? fresh : ranked).slice(0, 6);
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * Math.min(pool.length, 4))];
}

function shapeChaosStory(post) {
  const text = String(post.selftext || '').replace(/\s+/g, ' ').trim();
  return {
    id: String(post.id || ''),
    title: String(post.title || '').replace(/\s+/g, ' ').trim().slice(0, 300),
    subreddit: String(post.subreddit || ''),
    score: Number(post.score) || 0,
    permalink: String(post.permalink || ''),
    selftext: text.slice(0, 6000)
  };
}

function postsFromListing(json) {
  const children = json && json.data && Array.isArray(json.data.children) ? json.data.children : [];
  return children.map((child) => child && child.data).filter(Boolean);
}

async function officialReddit(pathname) {
  try {
    const res = await fetch(`https://www.reddit.com${pathname}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Accept: 'application/json'
      },
      signal: AbortSignal.timeout(12000)
    });
    const type = String(res.headers.get('content-type') || '');
    if (!res.ok || type.includes('text/html')) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function arcticRows(params) {
  try {
    const res = await fetch(`https://arctic-shift.photon-reddit.com/api/posts/search?${params}`, {
      headers: {
        'User-Agent': 'ViralAtolyesiDocumentary/1.0 (local documentary tool)',
        Accept: 'application/json'
      },
      signal: AbortSignal.timeout(30000)
    });
    if (!res.ok) return [];
    const data = await res.json().catch(() => ({}));
    return Array.isArray(data.data) ? data.data : [];
  } catch {
    return [];
  }
}

async function arcticWindow(sub, query) {
  const now = Math.floor(Date.now() / 1000);
  const after = now - 14 * 24 * 3600;
  let before = now;
  const rows = [];
  for (let page = 0; page < 2; page++) {
    const params = new URLSearchParams({
      subreddit: sub,
      after: String(after),
      before: String(before),
      limit: '100',
      sort: 'desc'
    });
    const batch = await arcticRows(params);
    rows.push(...batch);
    if (batch.length < 100) break;
    const oldest = batch.reduce((min, row) => {
      const stamp = Number(row.created_utc) || min;
      return stamp < min ? stamp : min;
    }, before);
    if (!(oldest < before)) break;
    before = oldest;
  }
  const needle = String(query || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!needle) return rows;
  const words = needle.split(/[^a-z0-9]+/).filter((word) => word.length > 3).slice(0, 6);
  return rows.filter((row) => {
    const blob = `${row.title || ''} ${String(row.selftext || '').slice(0, 1500)}`.toLowerCase();
    if (blob.includes(needle.slice(0, 80))) return true;
    if (!words.length) return false;
    const hits = words.filter((word) => blob.includes(word)).length;
    return hits >= Math.min(2, words.length);
  });
}

async function postsForSub(sub, query, state) {
  if (state.official) {
    const path = query
      ? `/r/${sub}/search.json?q=${encodeURIComponent(query)}&restrict_sr=1&sort=top&t=year&limit=25&raw_json=1`
      : `/r/${sub}/hot.json?limit=25&raw_json=1`;
    const data = await officialReddit(path);
    const posts = data ? postsFromListing(data) : null;
    if (posts && posts.length) return posts;
    state.official = false;
  }
  state.archive = true;
  return arcticWindow(sub, query);
}

async function storyById(id) {
  const clean = String(id || '').trim();
  if (!/^[a-z0-9]{4,12}$/i.test(clean)) return null;
  try {
    const data = await officialReddit(`/comments/${encodeURIComponent(clean)}.json?raw_json=1&limit=1`);
    const children = Array.isArray(data) && data[0] && data[0].data && data[0].data.children;
    const post = children && children[0] && children[0].data;
    if (post && isChaosPost(post)) return shapeChaosStory(post);
  } catch {}
  try {
    const res = await fetch(
      `https://arctic-shift.photon-reddit.com/api/posts/ids?ids=${encodeURIComponent(clean)}`,
      {
        headers: {
          'User-Agent': 'ViralAtolyesiDocumentary/1.0 (local documentary tool)',
          Accept: 'application/json'
        },
        signal: AbortSignal.timeout(20000)
      }
    );
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({}));
    const post = Array.isArray(data.data) ? data.data[0] : null;
    if (!post || !isChaosPost(post)) return null;
    return shapeChaosStory(post);
  } catch {
    return null;
  }
}

async function pullChaosStory({ query, redditId, avoid } = {}) {
  const direct = await storyById(redditId);
  if (direct) {
    console.log(`[belgesel] reddit=r/${direct.subreddit} id=${direct.id} score=${direct.score}`);
    return direct;
  }
  const q = String(query || '').replace(/\s+/g, ' ').trim();
  const state = { official: true, archive: false };
  const searched = [];
  if (q.length >= 3) {
    for (const sub of CHAOS_SUBREDDITS) searched.push(...await postsForSub(sub, q, state));
  }
  let picked = pickChaosPost(searched, '');
  if (!picked && q.length < 3) {
    const hot = [];
    for (const sub of CHAOS_SUBREDDITS) hot.push(...await postsForSub(sub, '', state));
    picked = pickChaosPost(hot, avoid || q);
  }
  if (state.archive) console.log('[belgesel] Reddit JSON kapalı, halka açık arşiv kullanıldı.');
  if (!picked) {
    throw new DocumentaryError(
      q.length >= 3
        ? 'Bu aramayla Reddit hikayesi bulunamadı.'
        : 'Reddit korku ve gizem akışında kullanılabilir hikaye bulunamadı.',
      502
    );
  }
  const story = shapeChaosStory(picked);
  console.log(`[belgesel] reddit=r/${story.subreddit} id=${story.id} score=${story.score}`);
  return story;
}

async function suggestDocumentaryTopic({ lang, apiKey, avoid, channel }) {
  const key = String(apiKey || '').trim();
  if (!key) throw new DocumentaryError('Gemini API anahtarı yok. Araçlar → Gemini bölümünden bir anahtarı aktif yap.', 401);
  const therapy = resolveDocChannel(channel || 'epoch') === 'therapy';
  const language = lang === 'tr' ? 'Turkish' : 'English';
  const previous = cleanTopicLine(avoid);
  const examples = therapy
    ? (lang === 'tr'
      ? [
        'Öğrencileri gardiyan yapan bodrum',
        'İtaati ölçen elektrik deneyi',
        'Üçüzlerin bilmediği çalışma'
      ]
      : [
        'The basement that turned students into guards',
        'The shock test that measured obedience',
        'Three identical strangers and the study they never knew'
      ])
    : (lang === 'tr'
      ? [
        'Nil on yıl kurusaydı ne olurdu?',
        'Konstantinopolis’i kurtaran fırtına',
        'İskenderiye kütüphanesi neden yok oldu?'
      ]
      : [
        'What if the Nile had dried up for ten years?',
        'The storm that saved Constantinople',
        'Why the Library of Alexandria vanished'
      ]);
  const prompt = (therapy
    ? [
      'Invent one new title for a 50 to 60 second vertical documentary.',
      'The subject is dark psychology and one real psychological experiment.',
      'Think of documented studies such as the Stanford Prison Experiment, the Milgram obedience study, or the secret triplets study.',
      `Write it in ${language}, the way a viewer would read it on screen.`,
      '8 to 16 words. Name the experiment, the test, or the people who were studied.',
      'No self-help, no therapy advice, and no fictional horror.'
    ]
    : [
      'Invent one new title for a 50-second vertical history documentary.',
      `Write it in ${language}, the way a viewer would read it on screen.`,
      '8 to 16 words. Concrete place, person from history, or a what-if question.'
    ]).concat([
    'Return JSON only: {"topic":"..."}',
    'The topic value is plain text. No label, no parentheses, no asterisk, no quotes inside it.',
    'Do not copy these examples. Match their tone:',
    examples.join('\n'),
    previous ? `Do not repeat: ${previous}` : ''
  ]).filter(Boolean).join('\n');
  let lastError = null;
  const models = geminiCandidates();
  for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
    const model = models[modelIndex];
    let jsonMode = true;
    for (let attempt = 0; attempt < 2; attempt++) {
      let res;
      let data;
      const generationConfig = { maxOutputTokens: 256 };
      if (jsonMode) generationConfig.responseMimeType = 'application/json';
      try {
        res = await geminiFetch(key, {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig
        }, 25000, model);
        data = await res.json().catch(() => ({}));
      } catch (err) {
        console.log(`[belgesel] gemini konu model=${model} ${geminiFailReason(err)}`);
        lastError = new DocumentaryError(geminiFailText(err), 503);
        jsonMode = false;
        continue;
      }
      if (res.ok) {
        const topic = cleanTopicLine(visibleGeminiText(data));
        if (topic.length >= 8 && topic.toLowerCase() !== previous.toLowerCase()) {
          if (model !== models[0]) console.log(`[belgesel] gemini konu model=${model}`);
          return topic;
        }
        lastError = new DocumentaryError('Gemini çok kısa bir konu döndürdü.');
        break;
      }
      const detail = geminiErrorMessage(data);
      console.log(`[belgesel] gemini konu model=${model} http=${res.status} ${detail}`);
      const blob = JSON.stringify(data).slice(0, 500);
      if (geminiIsQuota(res.status, detail)) throw new DocumentaryError(quotaMessage(blob), 429);
      if (res.status === 401 || res.status === 403) {
        throw new DocumentaryError('Gemini API anahtarı geçersiz. Araçlar listesinden başka bir anahtar seç.', 401);
      }
      if (res.status === 400 && jsonMode) {
        jsonMode = false;
        continue;
      }
      if (res.status === 404) break;
      if (geminiIsDemand(res.status, detail)) {
        lastError = new DocumentaryError('Gemini şu an çok yoğun. Birkaç saniye sonra tekrar dene.', 503);
        if (attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        break;
      }
      throw new DocumentaryError(`Gemini konu yazamadı (${res.status}).`, res.status);
    }
  }
  throw lastError || new DocumentaryError('Gemini konu yazamadı.');
}

function quotaMessage(detail) {
  const m = String(detail || '').match(/retry in\s+([\d.]+)s/i);
  if (!m) return 'Gemini ücretsiz günlük hakkı doldu. Araçlar bölümünden başka anahtarı aktif yap.';
  const sec = Number(m[1]);
  const h = Math.floor(sec / 3600);
  const min = Math.round((sec % 3600) / 60);
  return `Gemini ücretsiz günlük hakkı doldu. Yaklaşık ${h} saat ${min} dakika sonra yeniden açılır.`;
}

function narrationPerformanceRules() {
  return [
    'Sen profesyonel bir seslendirmen ve ses yönetmenisin. Yazdığın her hikaye veya belgesel metnini, ElevenLabs üzerinden okunacak şekilde duygu etiketleriyle ve duraklama komutlarıyla birlikte yazmalısın.',
    'Şu kurallara kesinlikle uy:',
    '1. Metin içinde sesin tonunun değişeceği yerlere [whisper: fısıltıyla], [dramatic pause: 2 seconds], [tension building: hızlanarak] gibi yönlendirici etiketler koy.',
    '2. Cümlelerin akışını ve nefes alma noktalarını virgüllerle ve üç noktalarla (...) belirginleştir; böylece seslendirme motoru asla düz bir tonda okumaz.',
    '3. Heyecan, korku, gizem veya trajedi anlarında cümle yapılarını kısa tutarak sesin tonuna dramatik bir duygu kat.',
    'Put the square-bracket directions inside narration only. image_prompt stays a visual description and contains none of these tags.',
    'Text inside square brackets is a voice direction, not a spoken word, and it does not count toward the spoken word total.'
  ].join('\n');
}

function therapyPlanPrompt(topic, language, retryNote) {
  return [
    'You are the director of a vertical documentary about dark psychology and a real psychological experiment.',
    'Write one plan in the same dark cinematic voice used for history and horror documentaries.',
    `Topic: ${topic}`,
    `Narration language: ${language}.`,
    'Cover about 50 to 60 seconds, 120 to 145 spoken words, in 5 to 7 scenes.',
    'timestamp_sec values are contiguous, start at 0, and look like "0-8".',
    'Scene 1 is a strong hook that lands inside the first second.',
    'Tell the documented experiment: who was tested, what the setup was, and what it revealed. Do not invent a new study.',
    narrationPerformanceRules(),
    'image_prompt is a detailed English visual scene description, not a search keyword.',
    'Describe the room, the test apparatus, the era, and the camera framing in 25 to 55 words.',
    'Keep faces anonymous or in silhouette.',
    'Example: "A 1971 basement corridor dressed as a prison, numbered doors, a single overhead bulb, a figure in silhouette behind frosted glass, low wide shot."',
    'Do not add color grading or a style suffix. The editor locks the look.',
    'voice_tone is a short English direction for the narrator, such as "quiet, clinical, pause after the first sentence".',
    'music_mood is exactly one of mystery, epic, sad, science.',
    'mystery is the hidden design of the study. epic is pressure and rupture. sad is the harm left behind. science is the method and the evidence.',
    'The music bed is chosen from the local suspense library: tension, mystery, dark investigation, intense thriller, and cinematic anxiety. Pick the closest mood.',
    'Do not ask for famous living people, logos, or copyrighted film stills.',
    'No markdown and no commentary.',
    retryNote ? `Fix: ${retryNote}` : '',
    'Return only a JSON object with music_mood and a scenes array. Each scene has timestamp_sec, narration, image_prompt, and voice_tone.'
  ].filter(Boolean).join('\n');
}

function chaosPlanPrompt(story, language, retryNote) {
  return [
    'You are the director of a vertical horror and mystery documentary.',
    'Turn the source post into an original micro-documentary in a dark cinematic voice.',
    'Do not quote the post. Do not say Reddit, subreddit, or the author name.',
    'Open on a concrete image. Scene 1 must land the hook inside the first 3 seconds.',
    `Source title: ${story.title}`,
    `Source text: ${story.selftext}`,
    `Narration language: ${language}.`,
    'Cover about 45 to 55 seconds, 110 to 130 spoken words, in 5 to 7 scenes.',
    'timestamp_sec values are contiguous, start at 0, and look like "0-7".',
    narrationPerformanceRules(),
    'image_prompt is a detailed English visual scene description, not a search keyword.',
    'Describe the place, time of night, objects, weather, and camera framing in 25 to 55 words.',
    'Example: "An empty motel corridor at 3 a.m., one flickering fluorescent tube, a wet footprint trail, a door ajar at the far end, low tracking shot."',
    'Do not add color grading or a style suffix. The editor locks the look.',
    'voice_tone is a short English direction for the narrator, such as "hushed, tense, pause after the first sentence".',
    'music_mood is exactly one of mystery, epic, sad, science.',
    'mystery is secrets and dread. epic is pursuit and rupture. sad is loss and aftermath. science is evidence and explanation.',
    'The music bed is chosen from the local suspense library: tension, mystery, dark investigation, intense thriller, and cinematic anxiety. Pick the closest mood.',
    'Do not ask for famous living people, logos, or copyrighted film stills. Keep faces anonymous.',
    'No markdown and no commentary.',
    retryNote ? `Fix: ${retryNote}` : '',
    'Return only a JSON object with music_mood and a scenes array. Each scene has timestamp_sec, narration, image_prompt, and voice_tone.'
  ].filter(Boolean).join('\n');
}

async function askGeminiPlan(topic, lang, apiKey, retryNote, source, channel) {
  const key = String(apiKey || '').trim();
  if (!key) throw new DocumentaryError('Gemini API anahtarı yok. Araçlar → Gemini bölümünden bir anahtarı aktif yap.', 401);
  const language = lang === 'tr'
    ? 'Turkish'
    : 'English';
  const prompt = source && source.selftext
    ? chaosPlanPrompt(source, language, retryNote)
    : channel === 'therapy'
      ? therapyPlanPrompt(topic, language, retryNote)
      : [
      'You are the director of a vertical documentary.',
      'Write one plan that the editor, image generator, and voice actor must follow together.',
      `Topic: ${topic}`,
      `Narration language: ${language}.`,
      'Cover about 45 to 55 seconds, 110 to 130 spoken words, in 5 to 7 scenes.',
      'timestamp_sec values are contiguous, start at 0, and look like "0-7".',
      'Scene 1 is a strong hook that lands inside the first 3 seconds.',
      narrationPerformanceRules(),
      'image_prompt is a detailed English visual scene description, not a search keyword.',
      'Describe the place, century, objects, weather, and camera framing in 25 to 55 words.',
      'Example: "A ruined Roman library at night, wet marble columns, scattered scorched scrolls, a single oil lamp, low wide shot through drifting smoke."',
      'Do not add color grading or a style suffix. The editor locks the look.',
      'voice_tone is a short English direction for the narrator, such as "mysterious, deep, dramatic pause at the beginning".',
      'music_mood is exactly one of mystery, epic, sad, science, chosen from the tone of the whole film.',
      'mystery is secrets and old history. epic is war and rupture. sad is collapse, famine, and disaster. science is evidence and explanation.',
      'The music bed is chosen from the local suspense library: tension, mystery, dark investigation, intense thriller, and cinematic anxiety. Pick the closest mood.',
      'Do not ask for famous living people, logos, or copyrighted film stills.',
      'No markdown and no commentary.',
      retryNote ? `Fix: ${retryNote}` : '',
      'Return only a JSON object with music_mood and a scenes array. Each scene has timestamp_sec, narration, image_prompt, and voice_tone.'
    ].filter(Boolean).join('\n');
  const schema = {
    type: 'OBJECT',
    properties: {
      music_mood: { type: 'STRING', enum: MUSIC_MOODS },
      scenes: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            timestamp_sec: { type: 'STRING' },
            narration: { type: 'STRING' },
            image_prompt: { type: 'STRING' },
            voice_tone: { type: 'STRING' }
          },
          required: ['timestamp_sec', 'narration', 'image_prompt', 'voice_tone']
        }
      }
    },
    required: ['music_mood', 'scenes']
  };
  const models = geminiCandidates();
  let lastError = new DocumentaryError('Gemini şu an meşgul. Birkaç saniye bekleyip yeniden üret.', 503);
  for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
    const model = models[modelIndex];
    let jsonMode = true;
    let thinking = true;
    for (let attempt = 0; attempt < 2; attempt++) {
      const generationConfig = { maxOutputTokens: 8192 };
      if (thinking) generationConfig.thinkingConfig = { thinkingLevel: 'LOW' };
      if (jsonMode) {
        generationConfig.responseMimeType = 'application/json';
        generationConfig.responseSchema = schema;
      }
      let res;
      let data;
      try {
        res = await geminiFetch(key, {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig
        }, 60000, model);
        data = await res.json().catch(() => ({}));
      } catch (err) {
        console.log(`[belgesel] gemini senaryo model=${model} ${geminiFailReason(err)}`);
        if (thinking) thinking = false;
        else jsonMode = false;
        if (attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        lastError = new DocumentaryError(geminiFailText(err), 503);
        break;
      }
      if (res.ok) {
        const text = visibleGeminiText(data);
        if (!text) {
          lastError = new DocumentaryError('Gemini boş bir senaryo döndürdü.');
          jsonMode = false;
          thinking = false;
          continue;
        }
        if (model !== models[0]) console.log(`[belgesel] gemini senaryo model=${model}`);
        return text;
      }
      const detail = geminiErrorMessage(data);
      console.log(`[belgesel] gemini senaryo model=${model} http=${res.status} ${detail}`);
      if (res.status === 400 && (jsonMode || thinking)) {
        jsonMode = false;
        thinking = false;
        continue;
      }
      if (geminiIsQuota(res.status, detail)) throw new DocumentaryError(quotaMessage(JSON.stringify(data).slice(0, 500)), 429);
      if (res.status === 401 || res.status === 403) {
        throw new DocumentaryError('Gemini API anahtarı geçersiz. Araçlar listesinden başka bir anahtar seç.', 401);
      }
      if (res.status === 404) break;
      if (geminiIsDemand(res.status, detail)) {
        lastError = new DocumentaryError('Gemini şu an meşgul. Birkaç saniye bekleyip yeniden üret.', 503);
        if (attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        break;
      }
      throw new DocumentaryError(`Gemini senaryoyu yazamadı (${res.status}).`, res.status);
    }
  }
  throw lastError;
}

async function buildPlan(topic, lang, apiKey, source, channel) {
  const therapy = channel === 'therapy';
  let note = '';
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await askGeminiPlan(topic, lang, apiKey, note, source, channel);
      const plan = parseScenePlan(raw);
      const scenes = plan.scenes;
      const total = scenes.reduce((sum, scene) => sum + wordCount(scene.narration), 0);
      const minWords = therapy ? 110 : 90;
      const maxWords = 160;
      if (total < minWords || total > maxWords) {
        note = therapy
          ? `The narration is ${total} spoken words. Square-bracket voice tags do not count. Return one JSON object with music_mood and 120 to 145 spoken words for a 50 to 60 second film. Keep the emotion and pause tags in the narration.`
          : `The narration is ${total} spoken words. Square-bracket voice tags do not count. Return one JSON object with music_mood and 110 to 130 spoken words. Keep the emotion and pause tags in the narration.`;
        lastError = new DocumentaryError(
          therapy
            ? `Senaryo ${total} kelime çıktı. 50-60 saniye için 120-145 kelime bekleniyor.`
            : `Senaryo ${total} kelime çıktı. 110-130 kelime bekleniyor.`
        );
        continue;
      }
      return { scenes, words: total, music_mood: plan.music_mood };
    } catch (err) {
      if (err && (err.statusCode === 401 || err.statusCode === 429 || err.statusCode === 503)) throw err;
      lastError = err;
      note = err && err.message ? err.message : 'Return valid JSON with 5 or 6 scenes.';
    }
  }
  throw lastError || new DocumentaryError('Senaryo kurulamadı.');
}

function runProcess(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
    }, timeoutMs);
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      reject(new Error(stderr.trim() || `${bin} exit ${code}`));
    });
  });
}

async function downloadPollinationsStill(prompt, dest, channel) {
  const locked = withStyleLock(prompt, channel);
  const promptFile = path.join(path.dirname(dest), `prompt_${path.basename(dest, path.extname(dest))}.txt`);
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await fs.promises.writeFile(promptFile, locked, 'utf8');
  const script = path.join(__dirname, 'pollinations_image.py');
  const bins = process.platform === 'win32' ? [['py', ['-3']], ['python', []]] : [['python3', []], ['python', []]];
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const [bin, prefix] of bins) {
      try {
        await runProcess(bin, [...prefix, script, promptFile, dest], 300000);
        const size = fs.statSync(dest).size;
        if (size < 2048) throw new Error('Pollinations boş bir görsel yazdı.');
        console.log(`[belgesel] görsel=${path.basename(dest)} bytes=${size}`);
        return dest;
      } catch (err) {
        lastErr = err;
        if (err && err.code === 'ENOENT') continue;
        try { fs.unlinkSync(dest); } catch {}
        break;
      }
    }
  }
  const detail = lastErr && lastErr.message ? lastErr.message : 'görsel inemedi';
  throw new DocumentaryError(`Pollinations görseli üretemedi. ${detail}`.slice(0, 400));
}

function probeImageSize(ffprobePath, filePath) {
  return new Promise((resolve) => {
    const child = spawn(ffprobePath || 'ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'json',
      filePath
    ], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('close', () => {
      try {
        const stream = (JSON.parse(out).streams || [])[0] || {};
        resolve({ width: Number(stream.width) || 0, height: Number(stream.height) || 0 });
      } catch {
        resolve({ width: 0, height: 0 });
      }
    });
    child.on('error', () => resolve({ width: 0, height: 0 }));
  });
}

function evenSize(value) {
  const n = Math.max(2, Math.round(value));
  return n + (n % 2);
}

function buildPanFilter(width, height, duration, sceneIndex) {
  const dur = Math.max(0.4, Number(duration) || 1);
  const durText = dur.toFixed(3);
  const aspect = width / Math.max(1, height);
  const frameAspect = OUT_W / OUT_H;
  const grow = 1.32;
  let scaledW;
  let scaledH;
  if (aspect >= frameAspect) {
    scaledH = evenSize(OUT_H * grow);
    scaledW = evenSize(scaledH * aspect);
    if (scaledW < OUT_W + 80) scaledW = evenSize(OUT_W + 240);
  } else {
    scaledW = evenSize(OUT_W * grow);
    scaledH = evenSize(scaledW / aspect);
    if (scaledH < OUT_H + 80) scaledH = evenSize(OUT_H + 360);
  }
  const maxX = Math.max(0, scaledW - OUT_W);
  const maxY = Math.max(0, scaledH - OUT_H);
  const forward = sceneIndex % 2 === 0;
  const progress = `(t/${durText})*(t/${durText})*(3-2*(t/${durText}))`;
  const slide = (span, goForward) => (
    goForward ? `(${span})*${progress}` : `(${span})*(1-${progress})`
  );
  const x = maxX >= maxY ? slide(maxX, forward) : String(Math.round(maxX / 2));
  const y = maxX >= maxY ? String(Math.round(maxY / 2)) : slide(maxY, forward);
  return `scale=${scaledW}:${scaledH}:flags=lanczos,crop=${OUT_W}:${OUT_H}:x='${x}':y='${y}'`;
}

async function fitNarration(ffmpegPath, ffprobePath, src, words, text, dest, options) {
  const rawDur = await probeDurationSec(ffprobePath, src);
  if (!(rawDur > 0.3)) throw new DocumentaryError('Sahne sesinin süresi okunamadı.');
  const spoken = (words && words.length) ? words : evenWordCues(text, rawDur);
  const first = Math.max(0, Number(spoken[0].start) || 0);
  const keepOpeningPause = !!(options && options.keepOpeningPause);
  const lead = keepOpeningPause ? 0 : Math.max(0, first - 0.02);
  const lastEnd = Number(spoken[spoken.length - 1].end);
  const tail = Math.min(rawDur, Math.max(lead + 0.4, (Number.isFinite(lastEnd) ? lastEnd : rawDur) + 0.06));
  await runFfmpeg(ffmpegPath, [
    '-y', '-i', src,
    '-af', `atrim=start=${lead.toFixed(3)}:end=${tail.toFixed(3)},asetpts=PTS-STARTPTS,aresample=44100:first_pts=0`,
    '-c:a', 'libmp3lame', '-b:a', '192k',
    dest
  ]);
  const duration = await probeDurationSec(ffprobePath, dest);
  if (!(duration > 0.3)) throw new DocumentaryError('Sahne sesi kesilemedi.');
  const shifted = spoken.map((item) => ({
    word: item.word,
    start: Math.max(0, (Number(item.start) || 0) - lead),
    end: Math.max(0, (Number(item.end) || 0) - lead)
  }));
  if (shifted.length && !keepOpeningPause) shifted[0].start = 0;
  return { duration, words: shifted };
}

function breathSeconds(tone, sceneBoundary) {
  const hint = String(tone || '').toLowerCase();
  const dramatic = sceneBoundary || /dramatic|pause|emphasis|tragic|solemn|collapse|grief/.test(hint);
  return dramatic ? 1.5 : 1.15;
}

function sentenceSpans(words, narration) {
  const parts = String(narration || '').match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [];
  const spans = [];
  let index = 0;
  for (const part of parts) {
    const count = part.trim().split(/\s+/).filter(Boolean).length;
    const slice = words.slice(index, index + count);
    index += count;
    if (!slice.length) continue;
    spans.push({
      end: Number(slice[slice.length - 1].end) || 0,
      fromWord: index - slice.length,
      toWord: index
    });
  }
  if (!spans.length || index !== words.length) {
    const end = Number(words[words.length - 1] && words[words.length - 1].end) || 0;
    return [{ end, fromWord: 0, toWord: words.length }];
  }
  return spans;
}

async function breatheSentences(ffmpegPath, ffprobePath, src, words, narration, tone, dest, sceneBoundary) {
  const spoken = (words && words.length) ? words : [];
  if (spoken.length < 2) {
    await fs.promises.copyFile(src, dest);
    const duration = await probeDurationSec(ffprobePath, dest);
    return { duration, words: spoken };
  }
  const spans = sentenceSpans(spoken, narration).filter((span) => span.end > 0.05);
  if (!spans.length) {
    await fs.promises.copyFile(src, dest);
    const duration = await probeDurationSec(ffprobePath, dest);
    return { duration, words: spoken };
  }
  const nextWords = spoken.map((item) => ({ word: item.word, start: item.start, end: item.end }));
  const filters = [`[0:a]asplit=${spans.length}${spans.map((_, i) => `[s${i}]`).join('')}`];
  let from = 0;
  let shift = 0;
  spans.forEach((span, i) => {
    const pause = breathSeconds(tone, sceneBoundary && i === spans.length - 1);
    const end = Math.max(from + 0.05, span.end);
    filters.push(
      `[s${i}]atrim=start=${from.toFixed(3)}:end=${end.toFixed(3)},asetpts=PTS-STARTPTS,apad=pad_dur=${pause.toFixed(3)}[p${i}]`
    );
    for (let w = span.fromWord; w < span.toWord; w++) {
      nextWords[w].start = Math.max(0, (Number(nextWords[w].start) || 0) + shift);
      nextWords[w].end = Math.max(0, (Number(nextWords[w].end) || 0) + shift);
    }
    shift += pause;
    from = end;
  });
  filters.push(`${spans.map((_, i) => `[p${i}]`).join('')}concat=n=${spans.length}:v=0:a=1[out]`);
  await runFfmpeg(ffmpegPath, [
    '-y', '-i', src,
    '-filter_complex', filters.join(';'),
    '-map', '[out]',
    '-c:a', 'libmp3lame', '-b:a', '192k',
    dest
  ]);
  const duration = await probeDurationSec(ffprobePath, dest);
  if (!(duration > 0.3)) throw new DocumentaryError('Cümle arası nefes eklenemedi.');
  return { duration, words: nextWords };
}

async function mixMusicBed(ffmpegPath, ffprobePath, videoFile, musicFile, dest) {
  const duration = await probeDurationSec(ffprobePath, videoFile);
  if (!(duration > 0.5)) throw new DocumentaryError('Müzik bindirilecek video süresi yok.');
  const vol = MUSIC_VOLUME.toFixed(2);
  const graph = [
    `[1:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${vol},atrim=duration=${duration.toFixed(3)},asetpts=PTS-STARTPTS[bg]`,
    '[0:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS[vo]',
    '[vo][bg]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]'
  ].join(';');
  await runFfmpeg(ffmpegPath, [
    '-y',
    '-i', videoFile,
    '-stream_loop', '-1',
    '-i', musicFile,
    '-filter_complex', graph,
    '-map', '0:v:0',
    '-map', '[a]',
    '-c:v', 'copy',
    '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '192k',
    '-movflags', '+faststart',
    dest
  ]);
}

async function renderScene({ ffmpegPath, ffprobePath, imageFile, audioFile, words, text, duration, sceneIndex, outFile }) {
  const font = pickFont();
  const size = await probeImageSize(ffprobePath, imageFile);
  if (!(size.width > 0 && size.height > 0)) throw new DocumentaryError('Fotoğraf boyutu okunamadı.');
  const cues = (words && words.length) ? words : evenWordCues(text, duration);
  const durText = Number(duration).toFixed(3);
  const vf = [
    buildPanFilter(size.width, size.height, duration, sceneIndex || 0),
    buildCaptionFilter(cues, duration, font)
  ].join(',');
  await runFfmpeg(ffmpegPath, [
    '-y',
    '-loop', '1',
    '-framerate', String(OUT_FPS),
    '-i', imageFile,
    '-i', audioFile,
    '-vf', vf,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-af', 'aresample=44100:first_pts=0,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS',
    '-t', durText,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(OUT_FPS),
    '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '192k',
    '-muxdelay', '0', '-muxpreload', '0', '-avoid_negative_ts', 'make_zero',
    '-movflags', '+faststart',
    outFile
  ]);
}

function writeConcatList(files, listPath) {
  const body = files.map((file) => {
    const safe = file.replace(/\\/g, '/').replace(/'/g, "'\\''");
    return `file '${safe}'`;
  }).join('\n');
  fs.writeFileSync(listPath, body);
}

async function concatScenes(ffmpegPath, files, outFile, listPath) {
  writeConcatList(files, listPath);
  try {
    await runFfmpeg(ffmpegPath, [
      '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
      '-c', 'copy', '-movflags', '+faststart', outFile
    ]);
  } catch {
    await runFfmpeg(ffmpegPath, [
      '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(OUT_FPS),
      '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '192k',
      '-movflags', '+faststart',
      outFile
    ]);
  }
}

function previewCacheFile(voiceId, lang) {
  return path.join(os.tmpdir(), 'va-doc-voice-previews', `${voiceId}_${lang}.mp3`);
}

async function trimPreviewAudio(ffmpegPath, ffprobePath, sourceFile, destFile) {
  const duration = await probeDurationSec(ffprobePath || 'ffprobe', sourceFile);
  const args = ['-y', '-i', sourceFile, '-vn'];
  if (duration > 5) args.push('-t', '5', '-af', 'afade=t=out:st=4.6:d=0.4');
  args.push('-c:a', 'libmp3lame', '-b:a', '128k', destFile);
  await runFfmpeg(ffmpegPath || 'ffmpeg', args);
}

async function previewDocumentaryVoice({ narrator, lang, elevenKey, ffmpegPath, ffprobePath }) {
  const voice = resolveDocVoice(narrator);
  if (voice.choice === 'random') {
    throw new DocumentaryError('5 saniye dinlemek için listeden tek bir anlatıcı seç.', 400);
  }
  const language = lang === 'tr' ? 'tr' : 'en';
  const cached = previewCacheFile(voice.id, language);
  if (fs.existsSync(cached) && fs.statSync(cached).size > 64) {
    console.log(`[belgesel] ses ornegi voice_id=${voice.id} onbellek=1`);
    return { filePath: cached, narrator: voice };
  }
  const documentaryKey = String(elevenKey || '').trim();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'va-doc-preview-'));
  try {
    console.log(`[belgesel] ses ornegi voice_id=${voice.id} anahtar=${documentaryKey ? 'arayuz' : 'env'}`);
    const speech = await synthesizeSpeechAligned({
      text: DOC_PREVIEW_LINES[language],
      outDir: tmpDir,
      fileName: 'preview.mp3',
      voiceId: voice.id,
      voiceSettings: DOC_VOICE_SETTINGS,
      apiKey: documentaryKey
    });
    const trimmed = path.join(tmpDir, 'preview_5s.mp3');
    await trimPreviewAudio(ffmpegPath, ffprobePath, speech.filePath, trimmed);
    fs.mkdirSync(path.dirname(cached), { recursive: true });
    fs.copyFileSync(trimmed, cached);
    return { filePath: cached, narrator: voice, source: 'tts' };
  } catch (err) {
    if (isVoiceFallbackError(err)) {
      throw new DocumentaryError(
        `${voice.label} (${voice.id}) bu hesapta API ile kullanılamadı. 5 saniyelik örnek çalınamadı.`,
        402
      );
    }
    if (/quota|credits remaining|exceeds your quota/i.test(String(err && err.message || ''))) {
      throw new DocumentaryError('Bu anahtarın ElevenLabs kredisi 5 saniyelik örnek için yetmiyor.', 429);
    }
    if (err instanceof DocumentaryError || err instanceof ElevenLabsHookError) throw err;
    throw new DocumentaryError(err && err.message ? err.message : 'Ses örneği üretilemedi.');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

async function produceDocumentary({
  topic,
  lang,
  channel,
  redditId,
  geminiKey,
  narrator,
  elevenKey,
  ffmpegPath,
  ffprobePath,
  outFile
}) {
  const selected = resolveDocChannel(channel);
  console.log(`[belgesel] kanal=${selected}`);
  let subject = String(topic || '').replace(/\s+/g, ' ').trim();
  let reddit = null;
  if (selected === 'chaos') {
    if (subject.length > 300) throw new DocumentaryError('Arama 300 karakterden kısa olsun.', 400);
    reddit = await pullChaosStory({ query: subject, redditId, avoid: '' });
    subject = reddit.title;
  } else {
    if (subject.length < 8) throw new DocumentaryError('Konu en az birkaç kelime olsun.', 400);
    if (subject.length > 240) throw new DocumentaryError('Konu 240 karakterden kısa olsun.', 400);
  }
  const language = lang === 'tr' ? 'tr' : 'en';
  let narratorVoice = resolveDocVoice(narrator);
  let voiceWarning = '';
  const documentaryKey = String(elevenKey || '').trim();
  const ffmpeg = ffmpegPath || 'ffmpeg';
  const ffprobe = ffprobePath || 'ffprobe';
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'va-doc-'));
  const imageDir = path.join(tmpDir, 'temp_images');
  fs.mkdirSync(imageDir, { recursive: true });
  async function narrateScene(input) {
    const request = {
      text: input.text,
      outDir: input.outDir,
      fileName: input.fileName,
      voiceId: narratorVoice.id,
      voiceSettings: DOC_VOICE_SETTINGS,
      apiKey: documentaryKey
    };
    console.log(`[belgesel] ElevenLabs voice_id=${request.voiceId} anahtar=${documentaryKey ? 'arayuz' : 'env'}`);
    try {
      return await synthesizeSpeechAligned(request);
    } catch (err) {
      const fallbackId = DOC_VOICES.adam;
      if (!isVoiceFallbackError(err) || narratorVoice.id === fallbackId) throw err;
      const failed = narratorVoice;
      const detail = String(err && err.message || '')
        .replace(/sk_[A-Za-z0-9_-]+/g, 'sk_REDACTED')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 180);
      narratorVoice = resolveDocVoice(fallbackId);
      voiceWarning = `${failed.label} (${failed.id}) bu hesapta API ile kullanılamadı. Üretim ${narratorVoice.label} ile sürdürüldü.`;
      console.warn(`[belgesel] uyarı: ${voiceWarning} neden=${detail}`);
      request.voiceId = narratorVoice.id;
      console.log(`[belgesel] ElevenLabs voice_id=${request.voiceId} anahtar=${documentaryKey ? 'arayuz' : 'env'} yedek=1`);
      try {
        return await synthesizeSpeechAligned(request);
      } catch (fallbackErr) {
        const fallbackDetail = String(fallbackErr && fallbackErr.message || 'yedek ses de üretilemedi')
          .replace(/sk_[A-Za-z0-9_-]+/g, 'sk_REDACTED')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 180);
        throw new DocumentaryError(`${voiceWarning} Yedek ses de üretilemedi: ${fallbackDetail}`, 502);
      }
    }
  }
  try {
    const plan = await buildPlan(subject, language, geminiKey, selected === 'chaos' ? reddit : null, selected);
    const segments = [];
    const sceneInfo = [];
    for (let i = 0; i < plan.scenes.length; i++) {
      const scene = plan.scenes[i];
      const spoken = shapeNarration(scene.narration, scene.voice_tone);
      const openingPause = spoken.startsWith('<break');
      const speech = await narrateScene({
        text: spoken,
        outDir: tmpDir,
        fileName: `narration_${i}.mp3`
      });
      const fitted = path.join(tmpDir, `fit_${i}.mp3`);
      const synced = await fitNarration(
        ffmpeg,
        ffprobe,
        speech.filePath,
        speech.words,
        scene.narration,
        fitted,
        { keepOpeningPause: openingPause }
      );
      const breathedFile = path.join(tmpDir, `breath_${i}.mp3`);
      const breathed = await breatheSentences(
        ffmpeg,
        ffprobe,
        fitted,
        synced.words,
        scene.narration,
        scene.voice_tone,
        breathedFile,
        i < plan.scenes.length - 1
      );
      const photo = path.join(imageDir, `scene_${i}.jpg`);
      await downloadPollinationsStill(scene.image_prompt, photo, selected);
      const segment = path.join(tmpDir, `scene_${i}.mp4`);
      await renderScene({
        ffmpegPath: ffmpeg,
        ffprobePath: ffprobe,
        imageFile: photo,
        audioFile: breathedFile,
        words: breathed.words,
        text: scene.narration,
        duration: breathed.duration,
        sceneIndex: i,
        outFile: segment
      });
      segments.push(segment);
      sceneInfo.push({
        timestamp_sec: scene.timestamp_sec,
        narration: scene.narration,
        image_prompt: scene.image_prompt,
        voice_tone: scene.voice_tone,
        duration: Number(breathed.duration.toFixed(3))
      });
    }
    await fs.promises.mkdir(path.dirname(outFile), { recursive: true });
    const joined = path.join(tmpDir, 'joined.mp4');
    await concatScenes(ffmpeg, segments, joined, path.join(tmpDir, 'list.txt'));
    const music = musicFileForMood(plan.music_mood);
    console.log(`[belgesel] müzik=${music.mood} dosya=${music.title} volume=${MUSIC_VOLUME}`);
    await mixMusicBed(ffmpeg, ffprobe, joined, music.file, outFile);
    const duration = await probeDurationSec(ffprobe, outFile);
    return {
      scenes: sceneInfo,
      narrator: narratorVoice,
      music_mood: music.mood,
      music_file: music.title,
      warning: voiceWarning,
      words: plan.words,
      duration: Number(duration.toFixed(3)),
      lang: language,
      channel: selected,
      reddit: reddit ? { id: reddit.id, subreddit: reddit.subreddit, title: reddit.title, score: reddit.score } : null
    };
  } catch (err) {
    if (err instanceof DocumentaryError || err instanceof ElevenLabsHookError) throw err;
    throw new DocumentaryError(err && err.message ? err.message : 'Belgesel üretilemedi.');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

module.exports = {
  produceDocumentary,
  parseScenePlan,
  buildPanFilter,
  STYLE_LOCK,
  THERAPY_STYLE_LOCK,
  styleLockFor,
  cleanImagePrompt,
  withStyleLock,
  buildCaptionFilter,
  captionPhrases,
  renderScene,
  voiceSettingsForTone,
  shapeNarration,
  cleanMusicMood,
  musicFileForMood,
  breatheSentences,
  mixMusicBed,
  MUSIC_VOLUME,
  resolveDocVoice,
  documentaryVoiceFromRequest,
  previewDocumentaryVoice,
  suggestDocumentaryTopic,
  cleanTopicLine,
  resolveDocChannel,
  pullChaosStory,
  pickChaosPost,
  isChaosPost,
  DOC_CHANNELS,
  isVoiceRestricted,
  isVoiceFallbackError,
  DOC_VOICES,
  DocumentaryError,
  OUT_FPS
};
