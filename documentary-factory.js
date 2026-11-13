/**
 * Belgesel Fabrikası: Gemini yönetmen planı, Pixabay fotoğraf, pan, ElevenLabs, FFmpeg.
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
  antony: 'ErXwobaYiN019PkySvjV',
  arnold: 'VR6AewLTigWG4xSOukaG'
});
const DOC_VOICE_LABELS = Object.freeze({
  [DOC_VOICES.adam]: 'Ses 1 - Adam (Tok & Derin)',
  [DOC_VOICES.antony]: 'Ses 2 - Antony (Sinematik Anlatıcı)',
  [DOC_VOICES.arnold]: 'Ses 3 - Arnold (Güçlü/Tok)'
});
const DOC_VOICE_KEYS = Object.freeze({
  [DOC_VOICES.adam]: 'adam',
  [DOC_VOICES.antony]: 'antony',
  [DOC_VOICES.arnold]: 'arnold'
});
const DOC_VOICE_SETTINGS = Object.freeze({
  stability: 0.45,
  similarity_boost: 0.75,
  style: 0.35,
  use_speaker_boost: true
});

function resolveDocVoice(choice) {
  const raw = String(choice || '').trim();
  const key = raw.toLowerCase();
  const pool = Object.values(DOC_VOICES);
  let id = '';
  if (!key || key === 'random' || key === 'rastgele') {
    id = pool[Math.floor(Math.random() * pool.length)];
  } else if (key === 'adam' || key === 'deep' || key === 'ses1' || key === '1' || raw === DOC_VOICES.adam) {
    id = DOC_VOICES.adam;
  } else if (key === 'antony' || key === 'cinematic' || key === 'ses2' || key === '2' || raw === DOC_VOICES.antony) {
    id = DOC_VOICES.antony;
  } else if (key === 'arnold' || key === 'resonant' || key === 'tok' || key === 'ses3' || key === '3' || raw === DOC_VOICES.arnold) {
    id = DOC_VOICES.arnold;
  }
  if (!id) throw new DocumentaryError('Belgesel için yalnızca Adam, Antony veya Arnold seçilebilir.', 400);
  const pickedAtRandom = !key || key === 'random' || key === 'rastgele';
  return { id, label: DOC_VOICE_LABELS[id], choice: pickedAtRandom ? 'random' : DOC_VOICE_KEYS[id] };
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

function voiceRestrictionError() {
  return new DocumentaryError(
    'Seçilen ses ve Adam varsayılan sesi bu hesapta API ile kullanılamıyor. Ücretsiz planda kütüphane sesleri kapalı; resmi varsayılan seslerden birini seç.',
    402
  );
}

class DocumentaryError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'DocumentaryError';
    this.statusCode = statusCode || 500;
  }
}

function readEnvValue(name) {
  const live = String(process.env[name] || '').trim();
  if (live) return live;
  let raw = '';
  try {
    raw = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  } catch {
    return '';
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq).trim() !== name) continue;
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    return value.trim();
  }
  return '';
}

function geminiModel() {
  const explicit = String(process.env.GEMINI_VOICE_MODEL || '').trim();
  if (explicit) return explicit;
  const shared = String(process.env.GEMINI_MODEL || '').trim();
  if (shared && shared !== 'gemini-2.0-flash') return shared;
  return 'gemini-3.6-flash';
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
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
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
  const list = (words || []).filter((item) => item && item.word);
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

function cleanVisualQuery(raw) {
  const words = String(raw || '')
    .replace(/["']/g, '')
    .replace(/[^\w\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((word) => word.length > 1);
  if (words.length < 2) return '';
  let query = '';
  for (const word of words) {
    const next = query ? `${query} ${word}` : word;
    if (next.length > 100) break;
    query = next;
  }
  return query;
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

function parseScenePlan(raw) {
  const parsed = parseJsonLoose(raw);
  if (!parsed) throw new DocumentaryError('Gemini sahne planı JSON döndürmedi.');
  if (Array.isArray(parsed)) return normalizeScenes({ scenes: parsed });
  return normalizeScenes(parsed);
}

function normalizeScenes(data) {
  const raw = Array.isArray(data) ? data : (data && Array.isArray(data.scenes) ? data.scenes : []);
  const scenes = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const narration = spokenHookText(item.narration || item.text || '');
    const image_search_query = cleanVisualQuery(
      item.image_search_query || item.visual_search_query || item.search_keyword || item.keyword || ''
    );
    if (!narration || wordCount(narration) < 4 || !image_search_query) continue;
    scenes.push({
      timestamp_sec: cleanTimestamp(item.timestamp_sec || item.timestamp || ''),
      narration,
      image_search_query,
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

function quotaMessage(detail) {
  const m = String(detail || '').match(/retry in\s+([\d.]+)s/i);
  if (!m) return 'Gemini ücretsiz günlük hakkı doldu. Araçlar bölümünden başka anahtarı aktif yap.';
  const sec = Number(m[1]);
  const h = Math.floor(sec / 3600);
  const min = Math.round((sec % 3600) / 60);
  return `Gemini ücretsiz günlük hakkı doldu. Yaklaşık ${h} saat ${min} dakika sonra yeniden açılır.`;
}

async function askGeminiPlan(topic, lang, apiKey, retryNote) {
  const key = String(apiKey || '').trim();
  if (!key) throw new DocumentaryError('Gemini API anahtarı yok. Araçlar → Gemini bölümünden bir anahtarı aktif yap.', 401);
  const language = lang === 'tr'
    ? 'Turkish'
    : 'English';
  const prompt = [
    'You are the director of a vertical documentary.',
    'Write one plan that the editor, stock search, and voice actor must follow together.',
    `Topic: ${topic}`,
    `Narration language: ${language}.`,
    'Cover about 45 to 55 seconds, 110 to 130 spoken words, in 5 to 7 scenes.',
    'timestamp_sec values are contiguous, start at 0, and look like "0-7".',
    'Scene 1 is a strong hook that lands inside the first 3 seconds.',
    'narration is only the words to be spoken. No stage directions inside it.',
    'image_search_query is a concrete English Pixabay photo search for a vertical historical or mythological still that matches that sentence.',
    'Example: "ancient roman marble ruins in winter rain".',
    'voice_tone is a short English direction for the narrator, such as "mysterious, deep, dramatic pause at the beginning".',
    'Do not ask for famous living people, logos, or copyrighted film stills.',
    'No markdown and no commentary.',
    retryNote ? `Fix: ${retryNote}` : '',
    'Return only a JSON array of scene objects with timestamp_sec, narration, image_search_query, and voice_tone.'
  ].filter(Boolean).join('\n');
  const temperature = retryNote ? 0.4 : 0.7;
  const schema = {
    type: 'ARRAY',
    items: {
      type: 'OBJECT',
      properties: {
        timestamp_sec: { type: 'STRING' },
        narration: { type: 'STRING' },
        image_search_query: { type: 'STRING' },
        voice_tone: { type: 'STRING' }
      },
      required: ['timestamp_sec', 'narration', 'image_search_query', 'voice_tone']
    }
  };
  const ask = async (jsonMode, thinking) => {
    const generationConfig = {
      temperature,
      maxOutputTokens: 8192
    };
    if (thinking) generationConfig.thinkingConfig = { thinkingBudget: 256 };
    if (jsonMode) {
      generationConfig.responseMimeType = 'application/json';
      generationConfig.responseSchema = schema;
    }
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel())}:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig
        }),
        signal: AbortSignal.timeout(90000)
      }
    );
    const data = await res.json().catch(() => ({}));
    return { res, data };
  };
  let jsonMode = true;
  let thinking = true;
  let res;
  let data;
  for (let tryNo = 0; tryNo < 4; tryNo++) {
    try {
      ({ res, data } = await ask(jsonMode, thinking));
    } catch (err) {
      if (tryNo < 3) {
        await new Promise((resolve) => setTimeout(resolve, 1500 * (tryNo + 1)));
        continue;
      }
      throw new DocumentaryError('Gemini şu an yanıt vermiyor. Birkaç saniye sonra tekrar dene.', 503);
    }
    if (res.status === 400 && jsonMode) {
      jsonMode = false;
      thinking = false;
      continue;
    }
    if ((res.status === 502 || res.status === 503 || res.status === 504) && tryNo < 3) {
      jsonMode = false;
      thinking = false;
      await new Promise((resolve) => setTimeout(resolve, 1500 * (tryNo + 1)));
      continue;
    }
    break;
  }
  if (!res.ok) {
    const detail = JSON.stringify(data).slice(0, 500);
    if (res.status === 429 || /quota/i.test(detail)) {
      throw new DocumentaryError(quotaMessage(detail), 429);
    }
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      throw new DocumentaryError('Gemini şu an meşgul. Birkaç saniye bekleyip yeniden üret.', 503);
    }
    throw new DocumentaryError(`Gemini senaryoyu yazamadı (${res.status}).`);
  }
  const text = visibleGeminiText(data);
  if (!text) throw new DocumentaryError('Gemini boş bir senaryo döndürdü.');
  return text;
}

async function buildPlan(topic, lang, apiKey) {
  let note = '';
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await askGeminiPlan(topic, lang, apiKey, note);
      const scenes = parseScenePlan(raw);
      const total = scenes.reduce((sum, scene) => sum + wordCount(scene.narration), 0);
      if (total < 90 || total > 160) {
        note = `The narration is ${total} words. Return the same JSON array with 110 to 130 spoken words and contiguous timestamp_sec values.`;
        lastError = new DocumentaryError(`Senaryo ${total} kelime çıktı. 110-130 kelime bekleniyor.`);
        continue;
      }
      return { scenes, words: total };
    } catch (err) {
      if (err && (err.statusCode === 401 || err.statusCode === 429 || err.statusCode === 503)) throw err;
      lastError = err;
      note = err && err.message ? err.message : 'Return valid JSON with 5 or 6 scenes.';
    }
  }
  throw lastError || new DocumentaryError('Senaryo kurulamadı.');
}

function pickPixabayPhoto(hit) {
  if (!hit) return null;
  const url = String(hit.largeImageURL || hit.webformatURL || '').trim();
  const width = Number(hit.imageWidth) || 0;
  const height = Number(hit.imageHeight) || 0;
  if (!url || height < 400) return null;
  return { url, width, height, id: hit.id };
}

function stockQueries(keyword) {
  const words = String(keyword || '').trim().split(/\s+/).filter(Boolean);
  const variants = [];
  if (words.length) variants.push(words.join(' '));
  if (words.length > 4) variants.push(words.slice(0, 4).join(' '));
  if (words.length > 3) variants.push(words.slice(0, 3).join(' '));
  if (words.length > 2) variants.push(words.slice(0, 2).join(' '));
  return [...new Set(variants.map((item) => item.slice(0, 100)).filter(Boolean))];
}

async function searchPixabay(keyword, apiKey, page) {
  const params = new URLSearchParams({
    key: apiKey,
    q: keyword,
    image_type: 'photo',
    orientation: 'vertical',
    safesearch: 'true',
    per_page: '20',
    page: String(page || 1)
  });
  const res = await fetch(`https://pixabay.com/api/?${params.toString()}`, {
    signal: AbortSignal.timeout(30000)
  });
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    throw new DocumentaryError('PIXABAY_API_KEY geçersiz. .env içindeki anahtarı kontrol et.', 401);
  }
  if (!res.ok) throw new DocumentaryError(`Pixabay araması başarısız (${res.status}).`);
  const data = await res.json();
  return Array.isArray(data.hits) ? data.hits : [];
}

async function downloadFile(url, dest) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new DocumentaryError(`Fotoğraf indirilemedi (${res.status}).`);
  const audio = Buffer.from(await res.arrayBuffer());
  if (audio.length < 2048 || audio.length > 80 * 1024 * 1024) {
    throw new DocumentaryError('Fotoğraf boyutu uygun değil.');
  }
  await fs.promises.writeFile(dest, audio);
}

async function downloadPhoto(keyword, apiKey, dest, usedIds) {
  const queries = stockQueries(keyword);
  for (const query of queries) {
    let hits = [];
    try {
      hits = await searchPixabay(query, apiKey, 1);
    } catch (err) {
      if (err && err.statusCode === 401) throw err;
      continue;
    }
    const ranked = hits
      .map((hit) => pickPixabayPhoto(hit))
      .filter((photo) => photo && !usedIds.has(photo.id))
      .sort((a, b) => (b.width * b.height) - (a.width * a.height));
    for (const photo of ranked) {
      try {
        await downloadFile(photo.url, dest);
        usedIds.add(photo.id);
        return { id: photo.id, keyword: query, width: photo.width, height: photo.height };
      } catch {
        try { fs.unlinkSync(dest); } catch {}
      }
    }
  }
  throw new DocumentaryError(`Pixabay "${keyword}" için dikey fotoğraf vermedi.`);
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

async function produceDocumentary({
  topic,
  lang,
  geminiKey,
  narrator,
  ffmpegPath,
  ffprobePath,
  outFile
}) {
  const subject = String(topic || '').replace(/\s+/g, ' ').trim();
  if (subject.length < 8) throw new DocumentaryError('Konu en az birkaç kelime olsun.', 400);
  if (subject.length > 240) throw new DocumentaryError('Konu 240 karakterden kısa olsun.', 400);
  const language = lang === 'tr' ? 'tr' : 'en';
  let narratorVoice = resolveDocVoice(narrator);
  let voiceWarning = '';
  const pixabayKey = readEnvValue('PIXABAY_API_KEY');
  if (!pixabayKey) {
    throw new DocumentaryError('PIXABAY_API_KEY .env içinde yok. Pixabay anahtarını o satıra yaz.', 401);
  }
  const ffmpeg = ffmpegPath || 'ffmpeg';
  const ffprobe = ffprobePath || 'ffprobe';
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'va-doc-'));
  const usedIds = new Set();
  async function narrateScene(input) {
    const request = {
      text: input.text,
      outDir: input.outDir,
      fileName: input.fileName,
      voiceId: narratorVoice.id,
      voiceSettings: DOC_VOICE_SETTINGS
    };
    try {
      return await synthesizeSpeechAligned(request);
    } catch (err) {
      if (!isVoiceRestricted(err)) throw err;
      if (narratorVoice.id === DOC_VOICES.adam) throw voiceRestrictionError();
      const blocked = narratorVoice.label;
      narratorVoice = resolveDocVoice('adam');
      voiceWarning = `Seçilen ses (${blocked}) bu hesapta kısıtlı. Adam (varsayılan) ile devam edildi.`;
      try {
        return await synthesizeSpeechAligned({ ...request, voiceId: narratorVoice.id });
      } catch (fallbackErr) {
        if (isVoiceRestricted(fallbackErr)) throw voiceRestrictionError();
        throw fallbackErr;
      }
    }
  }
  try {
    const plan = await buildPlan(subject, language, geminiKey);
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
      const photo = path.join(tmpDir, `photo_${i}.jpg`);
      await downloadPhoto(scene.image_search_query, pixabayKey, photo, usedIds);
      const segment = path.join(tmpDir, `scene_${i}.mp4`);
      await renderScene({
        ffmpegPath: ffmpeg,
        ffprobePath: ffprobe,
        imageFile: photo,
        audioFile: fitted,
        words: synced.words,
        text: scene.narration,
        duration: synced.duration,
        sceneIndex: i,
        outFile: segment
      });
      segments.push(segment);
      sceneInfo.push({
        timestamp_sec: scene.timestamp_sec,
        narration: scene.narration,
        image_search_query: scene.image_search_query,
        voice_tone: scene.voice_tone,
        duration: Number(synced.duration.toFixed(3))
      });
    }
    await fs.promises.mkdir(path.dirname(outFile), { recursive: true });
    await concatScenes(ffmpeg, segments, outFile, path.join(tmpDir, 'list.txt'));
    const duration = await probeDurationSec(ffprobe, outFile);
    return {
      scenes: sceneInfo,
      narrator: narratorVoice,
      warning: voiceWarning,
      words: plan.words,
      duration: Number(duration.toFixed(3)),
      lang: language
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
  pickPixabayPhoto,
  buildPanFilter,
  stockQueries,
  buildCaptionFilter,
  captionPhrases,
  renderScene,
  cleanVisualQuery,
  voiceSettingsForTone,
  shapeNarration,
  resolveDocVoice,
  isVoiceRestricted,
  DOC_VOICES,
  DocumentaryError,
  OUT_FPS
};
