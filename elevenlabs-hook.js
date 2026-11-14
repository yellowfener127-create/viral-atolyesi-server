/**
 * Gemini kanca metnini ElevenLabs TTS ile seslendirir ve .mp3 kaydeder.
 * Ana crush akışına bağlı değildir. Çağrı:
 *   const { synthesizeHook } = require('./elevenlabs-hook');
 *   const filePath = await synthesizeHook({ text, voiceId });
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TTS_URL = 'https://api.elevenlabs.io/v1/text-to-speech';
const OUTPUT_FORMAT = 'mp3_44100_128';
const DEFAULT_MODEL_ID = 'eleven_multilingual_v2';
const MAX_HOOK_CHARS = 120;

/**
 * Dikey video kancası: düşük stability = ElevenLabs arayüzündeki Creative ton.
 * similarity_boost sesi seçilen karaktere kilitler (netlik).
 * style kısa cümleye vurgu verir. Konuşmacı boost'u boğuk kaydı toparlar.
 */
const HOOK_VOICE_SETTINGS = Object.freeze({
  stability: 0.32,
  similarity_boost: 0.84,
  style: 0.48,
  use_speaker_boost: true
});

class ElevenLabsHookError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'ElevenLabsHookError';
    this.details = details || null;
  }
}

function loadEnvFile(filePath) {
  let raw = '';
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null || process.env[key] === '') {
      process.env[key] = value;
    }
  }
}

loadEnvFile(path.join(__dirname, '.env'));

function spokenHookText(raw) {
  return String(raw || '')
    .replace(/<break\b[^>]*\/?>/gi, ' ')
    .replace(/<\/?emphasis\b[^>]*>/gi, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function readApiKey() {
  const key = String(process.env.ELEVENLABS_API_KEY || process.env.XI_API_KEY || '').trim();
  if (!key) {
    throw new ElevenLabsHookError('ELEVENLABS_API_KEY .env içinde yok.');
  }
  return key;
}

function resolveSpeechApiKey(explicit) {
  const given = String(explicit || '').trim();
  if (!given) return readApiKey();
  if (given.length > 256 || !/^[A-Za-z0-9_-]+$/.test(given)) {
    throw new ElevenLabsHookError('Belgesel ElevenLabs anahtarı geçersiz.');
  }
  return given;
}

function resolveVoiceId(explicit) {
  const voiceId = String(explicit || process.env.ELEVENLABS_VOICE_ID || '').trim();
  if (!/^[A-Za-z0-9]{10,40}$/.test(voiceId)) {
    throw new ElevenLabsHookError(
      'Geçerli bir voice_id yok. ElevenLabs kütüphanesinden ID kopyalayıp ELEVENLABS_VOICE_ID olarak yazın veya voiceId parametresi verin.'
    );
  }
  return voiceId;
}

function resolveOutDir(explicit) {
  const dir = String(explicit || process.env.ELEVENLABS_HOOK_DIR || path.join(__dirname, 'output', 'hooks')).trim();
  return path.resolve(dir);
}

function uniqueFileName() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const salt = crypto.randomBytes(3).toString('hex');
  return `hook_${stamp}_${salt}.mp3`;
}

function safeFileName(name) {
  const base = path.basename(String(name || ''));
  if (!base || base === '.' || base === '..') return uniqueFileName();
  return base.toLowerCase().endsWith('.mp3') ? base : `${base}.mp3`;
}

async function readErrorBody(res) {
  const raw = await res.text();
  const clipped = raw.replace(/\s+/g, ' ').trim().slice(0, 500);
  try {
    const data = JSON.parse(raw);
    const detail = data && data.detail;
    if (typeof detail === 'string') return detail;
    if (detail && typeof detail.message === 'string') return detail.message;
    if (Array.isArray(detail) && detail[0] && detail[0].msg) return String(detail[0].msg);
  } catch {
    /* JSON değilse düz metin döner */
  }
  return clipped || `HTTP ${res.status}`;
}

function wordsFromAlignment(text, alignment) {
  const expected = spokenHookText(text).split(' ').filter(Boolean);
  const chars = alignment && Array.isArray(alignment.characters) ? alignment.characters : [];
  const starts = alignment && Array.isArray(alignment.character_start_times_seconds)
    ? alignment.character_start_times_seconds
    : [];
  const ends = alignment && Array.isArray(alignment.character_end_times_seconds)
    ? alignment.character_end_times_seconds
    : [];
  const timed = [];
  let buf = '';
  let wStart = null;
  let wEnd = null;
  for (let i = 0; i < chars.length; i++) {
    const ch = String(chars[i] || '');
    if (!ch || /\s/.test(ch)) {
      if (buf) {
        timed.push({ start: wStart, end: wEnd });
        buf = '';
        wStart = null;
        wEnd = null;
      }
      continue;
    }
    const start = Number(starts[i]);
    const end = Number(ends[i]);
    if (wStart == null) wStart = Number.isFinite(start) ? start : 0;
    wEnd = Number.isFinite(end) ? end : wStart;
    buf += ch;
  }
  if (buf) timed.push({ start: wStart, end: wEnd });
  if (!expected.length) return [];
  if (timed.length === expected.length) {
    return expected.map((word, i) => ({
      word,
      start: Math.max(0, Number(timed[i].start) || 0),
      end: Math.max(0, Number(timed[i].end) || 0)
    }));
  }
  if (!timed.length) return [];
  const t0 = Math.max(0, Number(timed[0].start) || 0);
  const t1 = Math.max(t0 + 0.2, Number(timed[timed.length - 1].end) || t0);
  const span = t1 - t0;
  return expected.map((word, i) => ({
    word,
    start: t0 + (span * i) / expected.length,
    end: t0 + (span * (i + 1)) / expected.length
  }));
}

/**
 * @param {string|{ text: string, voiceId?: string, outDir?: string, fileName?: string, modelId?: string }} input
 * @returns {Promise<string>} kaydedilen mp3'ün mutlak yolu
 */
async function synthesizeHook(input) {
  const aligned = await synthesizeHookAligned(input);
  return aligned.filePath;
}

/**
 * Sesle birlikte kelime zamanlarını döndürür. Zaman damgası gelmezse ses yine kaydedilir.
 * @returns {Promise<{ filePath: string, words: { word: string, start: number, end: number }[] }>}
 */
async function synthesizeHookAligned(input) {
  const opts = typeof input === 'string' ? { text: input } : (input || {});
  try {
    const text = spokenHookText(opts.text);
    if (!text) {
      throw new ElevenLabsHookError('Seslendirilecek kanca metni boş.');
    }
    if (text.length > MAX_HOOK_CHARS) {
      throw new ElevenLabsHookError(`Kanca ${MAX_HOOK_CHARS} karakterden uzun. Bu modül 5-6 kelimelik satır içindir.`);
    }

    const apiKey = readApiKey();
    const voiceId = resolveVoiceId(opts.voiceId);
    const modelId = String(opts.modelId || process.env.ELEVENLABS_MODEL_ID || DEFAULT_MODEL_ID).trim();
    const outDir = resolveOutDir(opts.outDir);
    const fileName = opts.fileName ? safeFileName(opts.fileName) : uniqueFileName();
    const filePath = path.join(outDir, fileName);
    const url = `${TTS_URL}/${encodeURIComponent(voiceId)}/with-timestamps?output_format=${OUTPUT_FORMAT}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
        voice_settings: HOOK_VOICE_SETTINGS
      }),
      signal: AbortSignal.timeout(30000)
    });

    if (!res.ok) {
      const detail = await readErrorBody(res);
      throw new ElevenLabsHookError(`ElevenLabs ${res.status}: ${detail}`, { status: res.status });
    }

    const data = await res.json();
    const audio = Buffer.from(String(data.audio_base64 || ''), 'base64');
    if (audio.length < 64) {
      throw new ElevenLabsHookError('ElevenLabs boş bir ses dosyası döndürdü.');
    }
    await fs.promises.mkdir(outDir, { recursive: true });
    await fs.promises.writeFile(filePath, audio);
    const alignment = data.normalized_alignment || data.alignment || null;
    return { filePath, words: wordsFromAlignment(text, alignment) };
  } catch (err) {
    if (err instanceof ElevenLabsHookError) throw err;
    if (err && err.name === 'TimeoutError') {
      throw new ElevenLabsHookError('ElevenLabs 30 saniye içinde yanıt vermedi.');
    }
    throw new ElevenLabsHookError(err && err.message ? err.message : 'Kanca sesi üretilemedi.');
  }
}

const MAX_SPEECH_CHARS = 900;

/**
 * Belgesel sahnesi gibi daha uzun metin. Kanca limiti burada uygulanmaz.
 * @returns {Promise<{ filePath: string, words: { word: string, start: number, end: number }[] }>}
 */
async function synthesizeSpeechAligned(input) {
  const opts = typeof input === 'string' ? { text: input } : (input || {});
  try {
    const text = spokenHookText(opts.text);
    if (!text) throw new ElevenLabsHookError('Seslendirilecek metin boş.');
    if (text.length > MAX_SPEECH_CHARS) {
      throw new ElevenLabsHookError(`Sahne metni ${MAX_SPEECH_CHARS} karakterden uzun.`);
    }
    const apiKey = resolveSpeechApiKey(opts.apiKey);
    const voiceId = String(opts.voiceId || '').trim();
    if (!/^[A-Za-z0-9]{10,40}$/.test(voiceId)) {
      throw new ElevenLabsHookError('Belgesel ses ID gelmedi. İstek .env sesine düşmez.');
    }
    const modelId = String(opts.modelId || process.env.ELEVENLABS_MODEL_ID || DEFAULT_MODEL_ID).trim();
    const outDir = resolveOutDir(opts.outDir);
    const fileName = opts.fileName ? safeFileName(opts.fileName) : uniqueFileName();
    const filePath = path.join(outDir, fileName);
    const settings = opts.voiceSettings || HOOK_VOICE_SETTINGS;
    const url = `${TTS_URL}/${encodeURIComponent(voiceId)}/with-timestamps?output_format=${OUTPUT_FORMAT}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
        voice_settings: settings
      }),
      signal: AbortSignal.timeout(90000)
    });
    if (!res.ok) {
      const detail = await readErrorBody(res);
      throw new ElevenLabsHookError(`ElevenLabs ${res.status}: ${detail}`, { status: res.status });
    }
    const data = await res.json();
    const audio = Buffer.from(String(data.audio_base64 || ''), 'base64');
    if (audio.length < 64) throw new ElevenLabsHookError('ElevenLabs boş bir ses dosyası döndürdü.');
    await fs.promises.mkdir(outDir, { recursive: true });
    await fs.promises.writeFile(filePath, audio);
    const alignment = data.normalized_alignment || data.alignment || null;
    return { filePath, words: wordsFromAlignment(text, alignment) };
  } catch (err) {
    if (err instanceof ElevenLabsHookError) throw err;
    if (err && err.name === 'TimeoutError') {
      throw new ElevenLabsHookError('ElevenLabs 90 saniye içinde yanıt vermedi.');
    }
    throw new ElevenLabsHookError(err && err.message ? err.message : 'Ses üretilemedi.');
  }
}

module.exports = {
  synthesizeHook,
  synthesizeHookAligned,
  synthesizeSpeechAligned,
  wordsFromAlignment,
  spokenHookText,
  HOOK_VOICE_SETTINGS,
  ElevenLabsHookError
};

if (require.main === module) {
  const text = process.argv.slice(2).join(' ').trim();
  synthesizeHook(text)
    .then((filePath) => {
      process.stdout.write(`${filePath}\n`);
    })
    .catch((err) => {
      process.stderr.write(`${err.message}\n`);
      process.exitCode = 1;
    });
}
