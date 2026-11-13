/**
 * Belgesel Fabrikası: Gemini yönetmen planı, Pixabay, ElevenLabs, FFmpeg.
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
const DOC_VOICE_ID = 'pNInz6obpgDQGcFmaJgB';
const DOC_VOICE_SETTINGS = Object.freeze({
  stability: 0.45,
  similarity_boost: 0.75,
  style: 0.35,
  use_speaker_boost: true
});

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

function hasVideoStream(ffprobePath, filePath) {
  return new Promise((resolve) => {
    const child = spawn(ffprobePath || 'ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_type',
      '-of', 'csv=p=0',
      filePath
    ], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('close', () => resolve(/video/i.test(out)));
    child.on('error', () => resolve(false));
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
    const visual_search_query = cleanVisualQuery(
      item.visual_search_query || item.search_keyword || item.keyword || ''
    );
    if (!narration || wordCount(narration) < 4 || !visual_search_query) continue;
    scenes.push({
      timestamp_sec: cleanTimestamp(item.timestamp_sec || item.timestamp || ''),
      narration,
      visual_search_query,
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
    'visual_search_query is a concrete English Pixabay video search for that exact sentence, visual and filmable.',
    'Example: "heavy winter blizzard storm over ancient medieval city walls cinematic".',
    'voice_tone is a short English direction for the narrator, such as "mysterious, deep, dramatic pause at the beginning".',
    'Do not ask for famous living people, logos, or copyrighted film clips.',
    'No markdown and no commentary.',
    retryNote ? `Fix: ${retryNote}` : '',
    'Return only a JSON array of scene objects with timestamp_sec, narration, visual_search_query, and voice_tone.'
  ].filter(Boolean).join('\n');
  const temperature = retryNote ? 0.4 : 0.7;
  const schema = {
    type: 'ARRAY',
    items: {
      type: 'OBJECT',
      properties: {
        timestamp_sec: { type: 'STRING' },
        narration: { type: 'STRING' },
        visual_search_query: { type: 'STRING' },
        voice_tone: { type: 'STRING' }
      },
      required: ['timestamp_sec', 'narration', 'visual_search_query', 'voice_tone']
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
  let { res, data } = await ask(true, true);
  if (res.status === 400) {
    ({ res, data } = await ask(false, false));
  }
  if (!res.ok) {
    const detail = JSON.stringify(data).slice(0, 500);
    if (res.status === 429 || /quota/i.test(detail)) {
      throw new DocumentaryError(quotaMessage(detail), 429);
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
      if (err && (err.statusCode === 401 || err.statusCode === 429)) throw err;
      lastError = err;
      note = err && err.message ? err.message : 'Return valid JSON with 5 or 6 scenes.';
    }
  }
  throw lastError || new DocumentaryError('Senaryo kurulamadı.');
}

function pickPixabayFile(hit) {
  const videos = hit && hit.videos && typeof hit.videos === 'object' ? hit.videos : {};
  const usable = Object.keys(videos).map((name) => {
    const file = videos[name] || {};
    return {
      name,
      url: String(file.url || ''),
      width: Number(file.width) || 0,
      height: Number(file.height) || 0,
      size: Number(file.size) || 0
    };
  }).filter((file) => file.url && file.height > 0 && (!file.size || file.size <= 80 * 1024 * 1024));
  const pool = usable.filter((file) => file.height > file.width && file.height >= 720);
  pool.sort((a, b) => {
    const score = (file) => {
      const portraitBonus = file.height >= file.width ? 0 : 4000;
      const hdBonus = file.height >= 1280 && file.height <= 2160 ? 0 : Math.abs(file.height - 1920);
      const heavy = file.size > 40 * 1024 * 1024 ? 800 : 0;
      return portraitBonus + hdBonus + heavy;
    };
    return score(a) - score(b);
  });
  return pool[0] || null;
}

async function searchPixabay(keyword, apiKey, page) {
  const params = new URLSearchParams({
    key: apiKey,
    q: keyword,
    orientation: 'vertical',
    video_type: 'film',
    safesearch: 'true',
    per_page: '40',
    page: String(page || 1)
  });
  const res = await fetch(`https://pixabay.com/api/videos/?${params.toString()}`, {
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
  if (!res.ok) throw new DocumentaryError(`Stok video indirilemedi (${res.status}).`);
  const audio = Buffer.from(await res.arrayBuffer());
  if (audio.length < 2048 || audio.length > 80 * 1024 * 1024) {
    throw new DocumentaryError('Stok video boyutu uygun değil.');
  }
  await fs.promises.writeFile(dest, audio);
}

async function downloadStock(keyword, apiKey, dest, usedIds) {
  const exact = String(keyword || '').trim();
  const withVertical = exact.toLowerCase().includes('vertical')
    ? ''
    : `${exact} vertical`.slice(0, 100);
  const queries = [exact, withVertical];
  for (const query of queries) {
    if (!query) continue;
    for (let page = 1; page <= 2; page++) {
      const videos = await searchPixabay(query, apiKey, page);
      if (!videos.length) break;
      for (const video of videos) {
        if (!video || usedIds.has(video.id)) continue;
        const file = pickPixabayFile(video);
        if (!file) continue;
        try {
          await downloadFile(file.url, dest);
          usedIds.add(video.id);
          return { id: video.id, keyword: query, width: file.width, height: file.height };
        } catch {
          try { fs.unlinkSync(dest); } catch {}
        }
      }
    }
  }
  throw new DocumentaryError(`Pixabay "${keyword}" için dikey video vermedi.`);
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

async function renderScene({ ffmpegPath, videoFile, audioFile, words, text, duration, outFile }) {
  const font = pickFont();
  const cues = (words && words.length) ? words : evenWordCues(text, duration);
  const durText = Number(duration).toFixed(3);
  const vf = [
    `scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase`,
    `crop=${OUT_W}:${OUT_H}`,
    buildCaptionFilter(cues, duration, font)
  ].join(',');
  await runFfmpeg(ffmpegPath, [
    '-y',
    '-stream_loop', '-1',
    '-i', videoFile,
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
  ffmpegPath,
  ffprobePath,
  outFile
}) {
  const subject = String(topic || '').replace(/\s+/g, ' ').trim();
  if (subject.length < 8) throw new DocumentaryError('Konu en az birkaç kelime olsun.', 400);
  if (subject.length > 240) throw new DocumentaryError('Konu 240 karakterden kısa olsun.', 400);
  const language = lang === 'tr' ? 'tr' : 'en';
  const pixabayKey = readEnvValue('PIXABAY_API_KEY');
  if (!pixabayKey) {
    throw new DocumentaryError('PIXABAY_API_KEY .env içinde yok. Pixabay anahtarını o satıra yaz.', 401);
  }
  const ffmpeg = ffmpegPath || 'ffmpeg';
  const ffprobe = ffprobePath || 'ffprobe';
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'va-doc-'));
  const usedIds = new Set();
  try {
    const plan = await buildPlan(subject, language, geminiKey);
    const segments = [];
    const sceneInfo = [];
    for (let i = 0; i < plan.scenes.length; i++) {
      const scene = plan.scenes[i];
      const spoken = shapeNarration(scene.narration, scene.voice_tone);
      const openingPause = spoken.startsWith('<break');
      const speech = await synthesizeSpeechAligned({
        text: spoken,
        outDir: tmpDir,
        fileName: `narration_${i}.mp3`,
        voiceId: DOC_VOICE_ID,
        voiceSettings: DOC_VOICE_SETTINGS
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
      const stock = path.join(tmpDir, `stock_${i}.mp4`);
      await downloadStock(scene.visual_search_query, pixabayKey, stock, usedIds);
      if (!(await hasVideoStream(ffprobe, stock))) {
        throw new DocumentaryError(`İndirilen stok videoda görüntü yok (${scene.visual_search_query}).`);
      }
      const segment = path.join(tmpDir, `scene_${i}.mp4`);
      await renderScene({
        ffmpegPath: ffmpeg,
        videoFile: stock,
        audioFile: fitted,
        words: synced.words,
        text: scene.narration,
        duration: synced.duration,
        outFile: segment
      });
      segments.push(segment);
      sceneInfo.push({
        timestamp_sec: scene.timestamp_sec,
        narration: scene.narration,
        visual_search_query: scene.visual_search_query,
        voice_tone: scene.voice_tone,
        duration: Number(synced.duration.toFixed(3))
      });
    }
    await fs.promises.mkdir(path.dirname(outFile), { recursive: true });
    await concatScenes(ffmpeg, segments, outFile, path.join(tmpDir, 'list.txt'));
    const duration = await probeDurationSec(ffprobe, outFile);
    return {
      scenes: sceneInfo,
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
  pickPixabayFile,
  buildCaptionFilter,
  captionPhrases,
  renderScene,
  cleanVisualQuery,
  voiceSettingsForTone,
  shapeNarration,
  DOC_VOICE_ID,
  DocumentaryError,
  OUT_FPS
};
