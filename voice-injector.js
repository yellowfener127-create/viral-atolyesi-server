/**
 * Voice Enjektör: sıralı parçaların arasına 5-6 kelimelik renkli kart koyar.
 * Kartın süresi ElevenLabs sesinin süresidir, 3 saniyeyi geçmez.
 * Ses bitince kart da biter. Meme enjektörüne dokunmaz.
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
  'Wait until you see this',
  'Number three will shock you',
  'Do not skip this one',
  'The next one is worse',
  'Watch what happens right now'
];

const VOICE_CARDS = [
  { bg: '0xFF2D87', fg: '0xFFF200' },
  { bg: '0xFFE500', fg: '0xFF148C' },
  { bg: '0x00E5FF', fg: '0x2A0A4A' },
  { bg: '0xB6FF00', fg: '0x240046' },
  { bg: '0xFF5A1F', fg: '0xFFFFFF' },
  { bg: '0x7B2CFF', fg: '0xFFE500' }
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

function normalizeHookLine(raw, index) {
  const spoken = spokenHookText(raw);
  if (!spoken) return DEFAULT_LINES[(Number(index) || 0) % DEFAULT_LINES.length];
  const words = spoken.split(' ').filter(Boolean);
  if (words.length < 5 || words.length > 6) {
    throw statusError(`Geçiş cümlesi 5 veya 6 kelime olmalı. Gelen: "${spoken}"`);
  }
  return words.join(' ');
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
  outFile
}) {
  const pieces = (clips || []).filter((c) => c && c.file && fs.existsSync(c.file));
  if (pieces.length < 2) throw statusError('En az 2 geçerli parça gerekli.');
  if (pieces.length > MAX_PARTS) throw statusError(`En fazla ${MAX_PARTS} parça.`);
  const contentSec = pieces.reduce((sum, clip) => sum + (Number(clip.end) - Number(clip.start)), 0);
  if (contentSec > MAX_CONTENT_SEC) throw statusError(`Parça toplamı ${MAX_CONTENT_SEC} saniyeyi aşamaz.`);

  const order = pieces.map((clip, i) => Object.assign({}, clip, {
    afterHook: i < pieces.length - 1 ? (hooks && hooks[i]) : ''
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
  for (let i = 0; i < order.length - 1; i++) {
    lines.push(normalizeHookLine(order[i].afterHook, i));
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'va-voice-'));
  const segFiles = [];
  const timeline = [];
  const voiceWindows = [];
  let cursorSec = 0;
  try {
    for (let i = 0; i < order.length; i++) {
      const clip = order[i];
      const len = Number(clip.end) - Number(clip.start);
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

      if (i < order.length - 1) {
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
          card: VOICE_CARDS[i % VOICE_CARDS.length],
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
          color: VOICE_CARDS[i % VOICE_CARDS.length].bg,
          duration: Number(cardDur.toFixed(3))
        });
      }
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
  planCardDuration,
  atempoChain,
  buildCardFilter,
  renderVoiceCard,
  fitVoiceAudio,
  DEFAULT_LINES,
  VOICE_CARDS,
  OUT_FPS,
  MAX_CARD_SEC
};
