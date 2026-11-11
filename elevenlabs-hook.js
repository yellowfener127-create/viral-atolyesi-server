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

/**
 * @param {string|{ text: string, voiceId?: string, outDir?: string, fileName?: string, modelId?: string }} input
 * @returns {Promise<string>} kaydedilen mp3'ün mutlak yolu
 */
async function synthesizeHook(input) {
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
    const url = `${TTS_URL}/${encodeURIComponent(voiceId)}?output_format=${OUTPUT_FORMAT}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg'
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

    const audio = Buffer.from(await res.arrayBuffer());
    if (audio.length < 64) {
      throw new ElevenLabsHookError('ElevenLabs boş bir ses dosyası döndürdü.');
    }

    await fs.promises.mkdir(outDir, { recursive: true });
    await fs.promises.writeFile(filePath, audio);
    return filePath;
  } catch (err) {
    if (err instanceof ElevenLabsHookError) throw err;
    if (err && err.name === 'TimeoutError') {
      throw new ElevenLabsHookError('ElevenLabs 30 saniye içinde yanıt vermedi.');
    }
    throw new ElevenLabsHookError(err && err.message ? err.message : 'Kanca sesi üretilemedi.');
  }
}

module.exports = {
  synthesizeHook,
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
