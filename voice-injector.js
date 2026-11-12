/**
 * Voice Enjektör: her parçanın hemen önüne 5-6 kelimelik renkli kart koyar.
 * Kartın süresi ElevenLabs sesinin süresidir, 3 saniyeyi geçmez.
 * Ses bitince kart da biter ve parça başlar. Meme enjektörüne dokunmaz.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { synthesizeHook, spokenHookText } = require('./elevenlabs-hook');

const OUT_W = 1080;
const OUT_H = 1920;
const OUT_FPS = 30;
const MIN_PART = 0.4;
const MAX_PART = 30;
const MAX_PARTS = 12;
const MAX_CONTENT_SEC = 150;
const MAX_CARD_SEC = 3;

const DEFAULT_LINES = [
  'Wait until the very end',
  'Nobody expected this at all',
  'This one changes everything now',
  'Watch his reaction very closely',
  'Do not skip this one'
];

const HOOK_POOL = {
  general: [
    'Wait until the very end',
    'Nobody expected this at all',
    'This one changes everything now',
    'Watch his reaction very closely',
    'You will not believe this',
    'Do not skip this one',
    'The last second is insane',
    'This next clip is wild',
    'Watch what happens right now',
    'Nobody saw this coming today',
    'Keep watching for the twist',
    'This moment changes the video'
  ],
  shock: [
    'The next second is pure shock',
    'Nobody expected the next part',
    'This twist hits way too hard',
    'You are not ready for this',
    'The payoff is genuinely insane'
  ],
  reaction: [
    'Watch his reaction very closely',
    'Look at his face right now',
    'Their reaction says it all',
    'Watch what she does next',
    'That reaction is completely unreal'
  ],
  animal: [
    'This puppy does the unthinkable',
    'Wait until the dog reacts',
    'The baby notices something wild',
    'This cat ruins the whole plan',
    'Watch the animal choose sides'
  ],
  prank: [
    'The prank goes way too far',
    'He had no idea at all',
    'This prank should not exist',
    'Watch the prank completely collapse',
    'Nobody agreed to this prank'
  ],
  movie: [
    'This movie scene goes insane',
    'Wait for the film twist',
    'The scene changes everything now',
    'This show moment is unreal',
    'Watch the movie scene flip'
  ],
  kindness: [
    'This stranger changes everything here',
    'Wait for the kind ending',
    'One small act hits hard',
    'The hero moment is unreal',
    'Kindness comes out of nowhere'
  ],
  rank: [
    'Number three will shock you',
    'The next rank is way worse',
    'The last place wins everything',
    'Rank two changes the whole list',
    'The top spot is not ready'
  ]
};

const HOOK_KEYWORDS = [
  { bucket: 'animal', re: /\b(dog|cat|puppy|kitten|baby|animal|pet|bird)\b/i },
  { bucket: 'prank', re: /\b(prank|scare|troll|gotcha)\b/i },
  { bucket: 'movie', re: /\b(movie|film|scene|cinema|sitcom|series|tv)\b/i },
  { bucket: 'kindness', re: /\b(kind|hope|hero|rescue|help|wholesome|stranger)\b/i },
  { bucket: 'reaction', re: /\b(react|reaction|face|scream)\b/i },
  { bucket: 'shock', re: /\b(shock|unexpected|insane|crazy|unbelievable)\b/i },
  { bucket: 'rank', re: /\b(rank|ranking|top|best|worst|number)\b/i }
];

const VOICE_CARDS = [
  { bg: '0xFF1493', fg: '0xFFF200' },
  { bg: '0xFFD700', fg: '0x1A0533' },
  { bg: '0x7B2CFF', fg: '0xFFFFFF' },
  { bg: '0x00F0FF', fg: '0x14002A' },
  { bg: '0xFF4D00', fg: '0xFFFFFF' },
  { bg: '0xC6FF00', fg: '0x1A0533' }
];

function runFfmpeg(ffmpegPath, args, timeoutMs = 8 * 60 * 1000, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { cwd: cwd || undefined, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
    }, timeoutMs);
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 120000) stderr = stderr.slice(-120000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      const lines = String(stderr || '').split(/\r?\n/).map((l) => l.trim()).filter((l) =>
        l && !/^ffmpeg version/i.test(l) && !/^built with/i.test(l) && !/^configuration:/i.test(l) && !/^libav/i.test(l)
      );
      reject(new Error(lines.slice(-8).join(' ') || `ffmpeg exit ${code}`));
    });
  });
}

function probeDurationSec(ffprobePath, filePath) {
  return new Promise((resolve) => {
    const child = spawn(ffprobePath || 'ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration:stream=duration',
      '-of', 'json',
      filePath
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', () => resolve(null));
    child.on('close', () => {
      let best = 0;
      try {
        const parsed = JSON.parse(out);
        const formatDur = Number(parsed && parsed.format && parsed.format.duration);
        if (Number.isFinite(formatDur) && formatDur > best) best = formatDur;
        for (const stream of (parsed && parsed.streams) || []) {
          const n = Number(stream && stream.duration);
          if (Number.isFinite(n) && n > best) best = n;
        }
      } catch {}
      resolve(best > 0 ? best : null);
    });
  });
}

function probeHasAudio(ffmpegPath, filePath) {
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath, ['-hide_banner', '-i', filePath], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', () => resolve(false));
    child.on('close', () => resolve(/Audio:\s/.test(err)));
  });
}

function statusError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode || 400;
  return err;
}

function normalizeHookLine(raw) {
  const spoken = spokenHookText(raw);
  if (!spoken) return '';
  const words = spoken.split(' ').filter(Boolean);
  if (words.length < 5 || words.length > 6) {
    throw statusError(`Geçiş cümlesi 5 veya 6 kelime olmalı. Gelen: "${spoken}"`);
  }
  return words.join(' ');
}

function conceptFromName(name) {
  return String(name || '')
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[#_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function poolForName(name) {
  const concept = conceptFromName(name);
  const buckets = HOOK_KEYWORDS.filter((row) => row.re.test(concept)).map((row) => row.bucket);
  const lines = [];
  const seen = new Set();
  for (const bucket of (buckets.length ? buckets : ['general'])) {
    for (const line of HOOK_POOL[bucket] || []) {
      if (!seen.has(line)) {
        seen.add(line);
        lines.push(line);
      }
    }
  }
  if (buckets.length) {
    for (const line of HOOK_POOL.general) {
      if (!seen.has(line)) lines.push(line);
    }
  }
  return lines.length ? lines : HOOK_POOL.general.slice();
}

function pickPoolHook(name, used) {
  const taken = used || new Set();
  const fresh = poolForName(name).filter((line) => !taken.has(line));
  const bag = fresh.length ? fresh : HOOK_POOL.general.filter((line) => !taken.has(line));
  const list = bag.length ? bag : HOOK_POOL.general;
  const line = list[Math.floor(Math.random() * list.length)];
  taken.add(line);
  return line;
}

const VOICE_HOOK_SYSTEM = `You are an elite, viral TikTok/Shorts content creator. Your absolute only job is to watch the provided video clip and write a short, high-converting hook sentence that will be played IMMEDIATELY BEFORE this clip appears. 
CRITICAL RULES:
1. This text will be converted into AI voiceover (ElevenLabs) and displayed on a vibrant transition screen right before the clip starts.
2. It MUST act as a teaser or hype builder for the upcoming clip (e.g., 'Wait until you see this', 'Bro really thought he could do that', 'Watch his reaction closely', 'Nobody expected what happens next'). 
3. NEVER describe what already happened in the past. Always look forward to what is about to happen in the clip.
4. Maximum 5 to 6 words. Keep it punchy, aggressive, and curiosity-driven.
5. Be extremely creative and change wording every time. Never repeat generic templates.
6. Return ONLY the raw text sentence. No quotes, no markdown, no explanations.`;

function voiceGeminiModel() {
  const explicit = String(process.env.GEMINI_VOICE_MODEL || '').trim();
  if (explicit) return explicit;
  const shared = String(process.env.GEMINI_MODEL || '').trim();
  if (shared && shared !== 'gemini-2.0-flash') return shared;
  return 'gemini-3.6-flash';
}

async function geminiHookFromName(name, apiKey, used) {
  const key = String(apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
  const concept = conceptFromName(name);
  if (!key || concept.length < 4) return '';
  if (/^(src|import|in|voice|compilation)[_\s-]?\d*$/i.test(concept)) return '';
  const prompt = [
    'Write ONE English hook for a vertical Reel.',
    `The video name is: "${concept}".`,
    'Use the name as the subject. Exactly 5 or 6 words.',
    'No emoji. No hashtags. No quotes. No numbering.',
    'It must stop a stranger in the first 3 seconds.',
    'Output the line only.'
  ].join(' ');
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(voiceGeminiModel())}:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.9, maxOutputTokens: 40 }
        }),
        signal: AbortSignal.timeout(12000)
      }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return '';
    const text = data
      && data.candidates
      && data.candidates[0]
      && data.candidates[0].content
      && Array.isArray(data.candidates[0].content.parts)
      ? data.candidates[0].content.parts.map((part) => part.text || '').join(' ')
      : '';
    const cleaned = String(text || '')
      .replace(/\s+/g, ' ')
      .replace(/^["'`]+|["'`]+$/g, '')
      .replace(/[.!?]+$/g, '')
      .trim();
    const line = normalizeHookLine(cleaned);
    if (!line || (used && used.has(line))) return '';
    return line;
  } catch (err) {
    if (err && err.statusCode === 400) return '';
    return '';
  }
}

function polishHookLine(line) {
  return String(line || '')
    .replace(/^(hook|kanca)\s*:\s*/i, '')
    .replace(/^["'`“”]+|["'`“”]+$/g, '')
    .replace(/[.!?…]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isHookCommentary(line) {
  return /->|\bwords?\s*\)|\b(good|bad),?\s+but\b|\bmarkdown\b|\bexplanation\b/i.test(String(line || ''));
}

function cleanModelHook(text) {
  const lines = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .split(/\r?\n/)
    .map((line) => polishHookLine(line))
    .filter(Boolean);
  return lines.find((line) => !isHookCommentary(line)) || '';
}

function isTurkishHook(line) {
  const text = String(line || '');
  if (/[ğüşıöçĞÜŞİÖÇ]/.test(text)) return true;
  return /\b(ve|bir|bu|şu|icin|için|gibi|kadar|simdi|şimdi|bak|hazir|hazır|olacak|gordun|gördün|izle|izledin|degil|değil)\b/i.test(text);
}

function hookAsk(avoid, retry) {
  const banned = (avoid || []).map((line) => String(line || '').trim()).filter(Boolean).slice(0, 16);
  const skip = banned.length ? ` Do not repeat: ${banned.join(' | ')}.` : '';
  if (retry) return `Return only the raw hook sentence.${skip}`;
  return `Watch this clip.${skip}`;
}

function visibleGeminiText(data) {
  const parts = data
    && data.candidates
    && data.candidates[0]
    && data.candidates[0].content
    && data.candidates[0].content.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((part) => part && part.text && !part.thought)
    .map((part) => part.text)
    .join('\n');
}

async function geminiUploadClip(key, filePath) {
  const stat = await fs.promises.stat(filePath);
  const startRes = await fetch('https://generativelanguage.googleapis.com/upload/v1beta/files', {
    method: 'POST',
    headers: {
      'x-goog-api-key': key,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(stat.size),
      'X-Goog-Upload-Header-Content-Type': 'video/mp4',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ file: { display_name: 'voice-hook-clip' } }),
    signal: AbortSignal.timeout(45000)
  });
  const startData = await startRes.json().catch(() => ({}));
  if (!startRes.ok) {
    const msg = startData && startData.error && startData.error.message;
    throw statusError(msg || 'Gemini video yüklemesi reddedildi.', startRes.status || 502);
  }
  const uploadUrl = startRes.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw statusError('Gemini yükleme adresi gelmedi.', 502);
  const bytes = await fs.promises.readFile(filePath);
  const put = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length': String(bytes.length),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize'
    },
    body: bytes,
    signal: AbortSignal.timeout(90000)
  });
  const uploaded = await put.json().catch(() => ({}));
  if (!put.ok) {
    const msg = uploaded && uploaded.error && uploaded.error.message;
    throw statusError(msg || 'Gemini klibi alamadı.', put.status || 502);
  }
  let info = uploaded.file || uploaded;
  let state = String(info.state || 'ACTIVE');
  const name = info.name;
  for (let i = 0; i < 20 && state === 'PROCESSING' && name; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const poll = await fetch(`https://generativelanguage.googleapis.com/v1beta/${name}`, {
      headers: { 'x-goog-api-key': key },
      signal: AbortSignal.timeout(30000)
    });
    const pdata = await poll.json().catch(() => ({}));
    if (!poll.ok) {
      const msg = pdata && pdata.error && pdata.error.message;
      throw statusError(msg || 'Klip işlenemedi.', poll.status || 502);
    }
    info = pdata;
    state = String(pdata.state || 'ACTIVE');
  }
  if (state && state !== 'ACTIVE') throw statusError('Klip henüz hazır değil.', 502);
  if (!info.uri) throw statusError('Klip adresi gelmedi.', 502);
  return { uri: info.uri, name: info.name, mime: info.mimeType || 'video/mp4' };
}

async function geminiDeleteFile(key, name) {
  if (!key || !name) return;
  try {
    await fetch(`https://generativelanguage.googleapis.com/v1beta/${name}`, {
      method: 'DELETE',
      headers: { 'x-goog-api-key': key },
      signal: AbortSignal.timeout(10000)
    });
  } catch {}
}

function isTimeoutError(err) {
  const msg = String((err && err.message) || '');
  return !!(err && (err.name === 'TimeoutError' || err.name === 'AbortError' || /aborted due to timeout|timed out/i.test(msg)));
}

async function askGeminiClip(key, media, avoid, retry) {
  const videoPart = media && media.inline
    ? { inlineData: { mimeType: 'video/mp4', data: media.inline } }
    : { fileData: { mimeType: media.mime, fileUri: media.uri } };
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(voiceGeminiModel())}:generateContent?key=${encodeURIComponent(key)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: VOICE_HOOK_SYSTEM }] },
        contents: [{
          role: 'user',
          parts: [
            videoPart,
            { text: hookAsk(avoid, retry) }
          ]
        }],
        generationConfig: { temperature: retry ? 1 : 0.95, maxOutputTokens: 256 }
      }),
      signal: AbortSignal.timeout(120000)
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data && data.error && data.error.message;
    throw statusError(msg || 'Gemini kanca yazamadı.', res.status || 502);
  }
  return cleanModelHook(visibleGeminiText(data));
}

async function geminiHookFromClip(clipPath, apiKey, avoid) {
  const key = String(apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
  if (!key) throw statusError('Gemini API anahtarı yok.', 401);
  if (!clipPath || !fs.existsSync(clipPath)) throw statusError('Analiz klibi yok.');
  const taken = new Set((avoid || []).map((line) => String(line || '').trim()).filter(Boolean));
  const clipSize = fs.statSync(clipPath).size;
  let uploaded = null;
  let media;
  if (clipSize > 0 && clipSize <= 8 * 1024 * 1024) {
    media = { inline: (await fs.promises.readFile(clipPath)).toString('base64') };
  } else {
    uploaded = await geminiUploadClip(key, clipPath);
    media = uploaded;
  }
  let reason = 'Gemini 5 veya 6 kelimelik cümle döndürmedi.';
  try {
    for (const retry of [false, true]) {
      let raw = '';
      try {
        raw = await askGeminiClip(key, media, avoid, retry);
      } catch (err) {
        if (isTimeoutError(err)) {
          reason = 'Gemini yanıtı zaman aşımına uğradı.';
          continue;
        }
        throw err;
      }
      let line = '';
      try {
        line = normalizeHookLine(raw);
      } catch (err) {
        const heard = cleanModelHook(raw).slice(0, 80);
        reason = heard
          ? `Gemini'nin cümlesi 5 veya 6 kelime değildi: "${heard}"`
          : 'Gemini boş cevap verdi.';
        continue;
      }
      if (!line) {
        reason = 'Gemini boş cevap verdi.';
        continue;
      }
      if (isTurkishHook(line)) {
        reason = `Gemini Türkçe yazdı: "${line}"`;
        continue;
      }
      if (taken.has(line)) {
        reason = 'Gemini önceki cümleyi tekrar etti.';
        continue;
      }
      return line;
    }
    throw statusError(reason);
  } finally {
    if (uploaded) await geminiDeleteFile(key, uploaded.name);
  }
}

async function extractAnalysisClip(ffmpegPath, src, start, end, dest) {
  const startSec = Math.max(0, Number(start) || 0);
  const dur = Number(end) - startSec;
  if (!(dur >= 0.4) || dur > 30.05) throw statusError('Analiz kesiti 0.4 ile 30 saniye arasında olmalı.');
  const hasAudio = await probeHasAudio(ffmpegPath, src);
  const args = [
    '-y',
    '-ss', startSec.toFixed(3),
    '-t', dur.toFixed(3),
    '-i', src,
    '-vf', 'scale=480:-2:flags=fast_bilinear,fps=8,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '32', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart'
  ];
  if (hasAudio) args.push('-c:a', 'aac', '-ac', '1', '-ar', '22050', '-b:a', '48k');
  else args.push('-an');
  args.push(dest);
  await runFfmpeg(ffmpegPath, args, 120000);
  if (!fs.existsSync(dest) || fs.statSync(dest).size < 1000) throw statusError('Analiz klibi oluşmadı.');
  if (fs.statSync(dest).size > 16 * 1024 * 1024) {
    const smaller = `${dest}.small.mp4`;
    await runFfmpeg(ffmpegPath, [
      '-y', '-i', dest,
      '-vf', 'scale=320:-2,fps=6,format=yuv420p',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '34', '-an',
      '-movflags', '+faststart',
      smaller
    ], 90000);
    await fs.promises.rm(dest, { force: true });
    await fs.promises.rename(smaller, dest);
  }
}

async function resolveVoiceLine(clip, used, apiKey) {
  const custom = normalizeHookLine(clip && clip.afterHook);
  if (custom) {
    used.add(custom);
    return { text: custom, source: 'manual' };
  }
  const name = (clip && (clip.title || clip.label)) || path.basename((clip && clip.file) || '');
  const generated = await geminiHookFromName(name, apiKey, used);
  if (generated) {
    used.add(generated);
    return { text: generated, source: 'gemini' };
  }
  return { text: pickPoolHook(name, used), source: 'pool' };
}

function planCardDuration(rawSec) {
  const raw = Number(rawSec);
  if (!(raw > 0.2)) throw statusError('Kanca sesinin süresi okunamadı.');
  if (raw <= MAX_CARD_SEC) return { duration: raw, tempo: 1 };
  return { duration: MAX_CARD_SEC, tempo: raw / MAX_CARD_SEC };
}

function atempoChain(ratio) {
  const parts = [];
  let rest = Number(ratio);
  if (!Number.isFinite(rest) || rest <= 0) rest = 1;
  while (rest > 2) {
    parts.push('atempo=2');
    rest /= 2;
  }
  while (rest < 0.5) {
    parts.push('atempo=0.5');
    rest /= 0.5;
  }
  parts.push(`atempo=${rest.toFixed(5)}`);
  return parts.join(',');
}

function escapeDrawtext(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%')
    .replace(/,/g, '\\,');
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

function splitHookLines(text) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  if (words.length <= 3) return [words.join(' ')];
  const mid = Math.ceil(words.length / 2);
  return [words.slice(0, mid).join(' '), words.slice(mid).join(' ')];
}

function buildCardFilter(text, fg, fontFile) {
  const lines = splitHookLines(text);
  const size = lines.length > 1 ? 78 : 92;
  const gap = Math.round(size * 0.28);
  const block = lines.length * size + (lines.length - 1) * gap;
  const top = Math.max(80, Math.round((OUT_H - block) / 2));
  const font = fontFile
    ? `:fontfile='${escapeDrawtext(fontFile.replace(/\\/g, '/'))}'`
    : ':font=Arial';
  const draws = lines.map((line, i) => {
    const y = top + i * (size + gap);
    return (
      `drawtext=${font}:text='${escapeDrawtext(line)}':fontsize=${size}` +
      `:fontcolor=${fg}:borderw=12:bordercolor=0x000000` +
      `:x=(w-text_w)/2:y=${y}:expansion=none`
    );
  });
  return `${draws.join(',')},fps=${OUT_FPS}:start_time=0:round=near,setpts=PTS-STARTPTS,setsar=1,format=yuv420p`;
}

function vfNormalize() {
  return (
    `scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=decrease,` +
    `pad=${OUT_W}:${OUT_H}:(ow-iw)/2:(oh-ih)/2:color=black,` +
    `fps=${OUT_FPS}:start_time=0:round=near,setpts=PTS-STARTPTS,setsar=1,format=yuv420p`
  );
}

async function writeSegment({ ffmpegPath, inFile, outFile, start, duration, hasAudio }) {
  const ss = Math.max(0, Number(start) || 0);
  const durText = Number(duration).toFixed(3);
  const args = ['-y', '-i', inFile];
  if (!hasAudio) args.push('-f', 'lavfi', '-t', durText, '-i', 'anullsrc=r=44100:cl=stereo');
  args.push('-ss', ss.toFixed(3), '-t', durText);
  args.push(
    '-vf', vfNormalize(),
    '-map', '0:v:0',
    '-map', hasAudio ? '0:a:0?' : '1:a:0',
    '-af', `asetpts=PTS-STARTPTS,apad=whole_dur=${durText}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(OUT_FPS),
    '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '160k',
    '-muxdelay', '0', '-muxpreload', '0', '-avoid_negative_ts', 'make_zero',
    outFile
  );
  await runFfmpeg(ffmpegPath, args);
}

async function fitVoiceAudio(ffmpegPath, ffprobePath, src, dest, rawDur) {
  const plan = planCardDuration(rawDur);
  if (plan.tempo === 1) {
    await fs.promises.copyFile(src, dest);
    return plan.duration;
  }
  await runFfmpeg(ffmpegPath, [
    '-y', '-i', src,
    '-af', atempoChain(plan.tempo),
    '-c:a', 'libmp3lame', '-b:a', '192k',
    dest
  ]);
  const fitted = await probeDurationSec(ffprobePath, dest);
  if (!(fitted > 0.2)) return plan.duration;
  return Math.min(MAX_CARD_SEC, fitted);
}

async function renderVoiceCard({ ffmpegPath, ffprobePath, audioFile, text, card, outFile, workDir }) {
  const font = pickFont();
  const filterPath = path.join(workDir, `card_vf_${path.basename(outFile, '.mp4')}.txt`);
  await fs.promises.writeFile(filterPath, buildCardFilter(text, card.fg, font), 'utf8');
  const dur = await probeDurationSec(ffprobePath, audioFile);
  if (!(dur > 0.2)) throw statusError('Renkli kartın sesi okunamadı.');
  const durText = dur.toFixed(3);
  await runFfmpeg(ffmpegPath, [
    '-y',
    '-f', 'lavfi', '-t', durText, '-i', `color=c=${card.bg}:s=${OUT_W}x${OUT_H}:r=${OUT_FPS}`,
    '-i', audioFile,
    '-filter_script:v', filterPath,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-af', `asetpts=PTS-STARTPTS,apad=whole_dur=${durText}`,
    '-t', durText,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(OUT_FPS),
    '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '192k',
    '-muxdelay', '0', '-muxpreload', '0', '-avoid_negative_ts', 'make_zero',
    outFile
  ]);
  return dur;
}

async function mixVoiceCompilation({
  ffmpegPath,
  ffprobePath,
  clips,
  hooks,
  shuffle,
  outFile,
  geminiKey
}) {
  const pieces = (clips || []).filter((c) => c && c.file && fs.existsSync(c.file));
  if (pieces.length < 2) throw statusError('En az 2 geçerli parça gerekli.');
  if (pieces.length > MAX_PARTS) throw statusError(`En fazla ${MAX_PARTS} parça.`);
  const contentSec = pieces.reduce((sum, clip) => sum + (Number(clip.end) - Number(clip.start)), 0);
  if (contentSec > MAX_CONTENT_SEC) throw statusError(`Parça toplamı ${MAX_CONTENT_SEC} saniyeyi aşamaz.`);

  const order = pieces.map((clip, i) => Object.assign({}, clip, {
    afterHook: (hooks && hooks[i]) || ''
  }));
  if (shuffle) {
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = order[i];
      order[i] = order[j];
      order[j] = tmp;
    }
  }
  const lines = [];
  const lineSources = [];
  const usedLines = new Set();
  for (let i = 0; i < order.length; i++) {
    const resolved = await resolveVoiceLine(order[i], usedLines, geminiKey);
    lines.push(resolved.text);
    lineSources.push(resolved.source);
  }
  const colorShift = Math.floor(Math.random() * VOICE_CARDS.length);
  const cardAt = (i) => VOICE_CARDS[(i + colorShift) % VOICE_CARDS.length];

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'va-voice-'));
  const segFiles = [];
  const timeline = [];
  const voiceWindows = [];
  let cursorSec = 0;
  try {
    for (let i = 0; i < order.length; i++) {
      const clip = order[i];
      const len = Number(clip.end) - Number(clip.start);
      const text = lines[i];
      let mp3 = '';
      try {
        mp3 = await synthesizeHook({ text });
      } catch (err) {
        throw statusError(err && err.message ? err.message : 'ElevenLabs ses üretemedi.');
      }
      const rawDur = await probeDurationSec(ffprobePath, mp3);
      const fitted = path.join(tmpDir, `voice_${String(i).padStart(2, '0')}.mp3`);
      await fitVoiceAudio(ffmpegPath, ffprobePath, mp3, fitted, rawDur);
      const cardPath = path.join(tmpDir, `card_${String(i).padStart(2, '0')}.mp4`);
      const cardStart = cursorSec;
      const cardDur = await renderVoiceCard({
        ffmpegPath,
        ffprobePath,
        audioFile: fitted,
        text,
        card: cardAt(i),
        outFile: cardPath,
        workDir: tmpDir
      });
      await fs.promises.unlink(mp3).catch(() => {});
      const cardEnd = cursorSec + cardDur;
      segFiles.push(cardPath);
      voiceWindows.push({
        start: Number(cardStart.toFixed(3)),
        end: Number(cardEnd.toFixed(3)),
        text
      });
      cursorSec = cardEnd;
      timeline.push({
        kind: 'voice',
        text,
        color: cardAt(i).bg,
        duration: Number(cardDur.toFixed(3))
      });

      const segPath = path.join(tmpDir, `part_${String(i).padStart(2, '0')}.mp4`);
      const hasAudio = await probeHasAudio(ffmpegPath, clip.file);
      await writeSegment({
        ffmpegPath,
        inFile: clip.file,
        outFile: segPath,
        start: clip.start,
        duration: len,
        hasAudio
      });
      segFiles.push(segPath);
      timeline.push({ kind: 'part', label: clip.label || '', start: clip.start, end: clip.end });
      cursorSec += len;
    }

    const listBody = segFiles.map((p) => `file '${path.basename(p).replace(/'/g, "'\\''")}'`).join('\n');
    await fs.promises.writeFile(path.join(tmpDir, 'concat.txt'), listBody, 'utf8');
    await runFfmpeg(ffmpegPath, [
      '-y', '-f', 'concat', '-safe', '0', '-i', 'concat.txt', '-c', 'copy', outFile
    ], 8 * 60 * 1000, tmpDir);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  const durationOut = await probeDurationSec(ffprobePath, outFile);
  return {
    timeline,
    voiceWindows,
    lines,
    lineSources,
    contentSec: Number(contentSec.toFixed(3)),
    durationOut,
    shuffled: !!shuffle,
    size: `${OUT_W}x${OUT_H}`,
    fps: OUT_FPS
  };
}

module.exports = {
  mixVoiceCompilation,
  normalizeHookLine,
  conceptFromName,
  pickPoolHook,
  resolveVoiceLine,
  geminiHookFromClip,
  extractAnalysisClip,
  cleanModelHook,
  VOICE_HOOK_SYSTEM,
  planCardDuration,
  atempoChain,
  buildCardFilter,
  renderVoiceCard,
  fitVoiceAudio,
  HOOK_POOL,
  DEFAULT_LINES,
  VOICE_CARDS,
  OUT_FPS,
  MAX_CARD_SEC
};
