/**
 * Derleme: birden fazla kaynaktan kesilen parçaları sıraya dizer,
 * her geçişin arasına chaos_snippets klibini kendi süresiyle koyar.
 * Çıktı mix klasörüne yazılır. Telif Ezici bu adımda çalışmaz.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const memeInjector = require('./meme-injector');

const OUT_W = 1080;
const OUT_H = 1920;
const OUT_FPS = 30;
const MIN_PART = 0.4;
const MAX_PART = 30;
const MAX_PARTS = 12;
const MAX_CONTENT_SEC = 150;

function runFfmpeg(ffmpegPath, args, timeoutMs = 8 * 60 * 1000, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { cwd: cwd || undefined, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
    }, timeoutMs);
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 120000) stderr = stderr.slice(-120000);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      reject(new Error(stderr.slice(-2500) || `ffmpeg exit ${code}`));
    });
  });
}

function probeDurationSec(ffprobePath, ffmpegPath, filePath) {
  return new Promise((resolve) => {
    const bin = ffprobePath || 'ffprobe';
    const child = spawn(bin, [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', filePath
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', () => resolve(null));
    child.on('close', () => {
      const n = parseFloat(String(out).trim());
      resolve(Number.isFinite(n) && n > 0 ? n : null);
    });
  });
}

function probeHasAudio(ffmpegPath, filePath) {
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath, ['-hide_banner', '-i', filePath], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', () => resolve(false));
    child.on('close', () => resolve(/Audio:\s/.test(err)));
  });
}

function vfNormalize() {
  return (
    `scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=decrease,` +
    `pad=${OUT_W}:${OUT_H}:(ow-iw)/2:(oh-ih)/2:color=black,` +
    `fps=${OUT_FPS},setsar=1,format=yuv420p`
  );
}

async function writeSegment({ ffmpegPath, inFile, outFile, start, duration, hasAudio }) {
  const ss = Math.max(0, Number(start) || 0);
  const dur = Math.max(0.08, Number(duration) || 0.08);
  const args = ['-y', '-i', inFile];
  if (!hasAudio) {
    args.push('-f', 'lavfi', '-t', dur.toFixed(3), '-i', 'anullsrc=r=44100:cl=stereo');
  }
  args.push(
    '-ss', ss.toFixed(3),
    '-t', dur.toFixed(3),
    '-vf', vfNormalize(),
    '-map', '0:v:0',
    '-map', hasAudio ? '0:a:0?' : '1:a:0',
    '-af', `apad=whole_dur=${dur.toFixed(3)}`,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-r', String(OUT_FPS),
    '-c:a', 'aac',
    '-ar', '44100',
    '-ac', '2',
    '-b:a', '128k',
    outFile
  );
  await runFfmpeg(ffmpegPath, args);
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

function snippetDeckPath(dir) {
  return path.join(dir, '.va-snippet-deck.json');
}

function loadSnippetDeck(dir, files) {
  const names = files.map((p) => path.basename(p));
  const known = new Set(names);
  let remaining = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(snippetDeckPath(dir), 'utf8'));
    if (Array.isArray(parsed.remaining)) {
      remaining = parsed.remaining.filter((n) => known.has(n));
    }
  } catch {}
  if (!remaining.length) remaining = shuffleInPlace(names.slice());
  return { remaining, names };
}

function saveSnippetDeck(dir, deck) {
  try {
    fs.writeFileSync(snippetDeckPath(dir), JSON.stringify({ remaining: deck.remaining }), 'utf8');
  } catch {}
}

/** Klasör bitene kadar tekrarsız. Havuz tükenince karılır ve baştan devam eder. */
function drawSnippet(deck, files, usedNames) {
  const byName = new Map(files.map((p) => [path.basename(p), p]));
  const known = new Set(deck.names);
  const refill = (skip) => shuffleInPlace(deck.names.filter((n) => known.has(n) && !skip.has(n)));
  deck.remaining = deck.remaining.filter((n) => known.has(n) && !usedNames.has(n));
  if (!deck.remaining.length) deck.remaining = refill(usedNames);
  if (!deck.remaining.length) {
    usedNames.clear();
    deck.remaining = refill(usedNames);
  }
  const name = deck.remaining.pop();
  if (!name) return null;
  usedNames.add(name);
  return byName.get(name) || null;
}

function parseCompilationSources(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const sources = [];
  for (const s of list) {
    const localPath = String((s && (s.local_path || s.localPath)) || '').trim();
    const url = localPath ? '' : String((s && s.url) || '').trim();
    const partsIn = Array.isArray(s && s.parts) ? s.parts : [];
    const parts = [];
    for (const p of partsIn) {
      let a = Number(p && (p.start ?? p.from));
      let b = Number(p && (p.end ?? p.to));
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      if (b < a) { const t = a; a = b; b = t; }
      const len = b - a;
      if (len < MIN_PART || len > MAX_PART) continue;
      parts.push({ start: Number(a.toFixed(3)), end: Number(b.toFixed(3)) });
    }
    if ((!url && !localPath) || !parts.length) continue;
    sources.push({ url, localPath, parts });
  }
  return sources;
}

/**
 * clips: [{ file, start, end, label }]
 * Her parça kendi [start,end] aralığından kesilir.
 * Parçalar arasına meme, klibin kendi süresiyle girer.
 */
async function mixCompilation({
  ffmpegPath,
  ffprobePath,
  clips,
  shuffle,
  outFile,
  projectRoot
}) {
  const pieces = (clips || []).filter((c) => c && c.file && fs.existsSync(c.file));
  if (pieces.length < 2) {
    const e = new Error('En az 2 geçerli parça gerekli.');
    e.statusCode = 400;
    throw e;
  }
  if (pieces.length > MAX_PARTS) {
    const e = new Error(`En fazla ${MAX_PARTS} parça.`);
    e.statusCode = 400;
    throw e;
  }
  const contentSec = pieces.reduce((s, c) => s + (Number(c.end) - Number(c.start)), 0);
  if (contentSec > MAX_CONTENT_SEC) {
    const e = new Error(`Parça toplamı ${MAX_CONTENT_SEC} saniyeyi aşamaz.`);
    e.statusCode = 400;
    throw e;
  }

  const dir = memeInjector.resolveChaosSnippetsDir(projectRoot || process.cwd());
  const memes = memeInjector.listSnippetFiles(dir);
  if (!memes.length) {
    const e = new Error(`chaos_snippets boş. Geçiş meme'i için klip koy: ${dir}`);
    e.statusCode = 400;
    throw e;
  }

  const order = pieces.slice();
  if (shuffle) shuffleInPlace(order);

  const deck = loadSnippetDeck(dir, memes);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'va-mix-'));
  const segFiles = [];
  const usedMemes = [];
  const usedMemeNames = new Set();
  const timeline = [];
  const memeWindows = [];
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
        const snip = drawSnippet(deck, memes, usedMemeNames);
        if (!snip) {
          const e = new Error('Uygun meme klibi bulunamadı.');
          e.statusCode = 400;
          throw e;
        }
        const snipDur = await probeDurationSec(ffprobePath, ffmpegPath, snip);
        if (!(snipDur > 0.12)) {
          const e = new Error(`Meme süresi okunamadı: ${path.basename(snip)}`);
          e.statusCode = 400;
          throw e;
        }
        const memePath = path.join(tmpDir, `meme_${String(i).padStart(2, '0')}.mp4`);
        const snipAudio = await probeHasAudio(ffmpegPath, snip);
        const memeStart = cursorSec;
        const memeEnd = cursorSec + snipDur;
        await writeSegment({
          ffmpegPath,
          inFile: snip,
          outFile: memePath,
          start: 0,
          duration: snipDur,
          hasAudio: snipAudio
        });
        segFiles.push(memePath);
        usedMemes.push(snip);
        memeWindows.push({
          start: Number(memeStart.toFixed(3)),
          end: Number(memeEnd.toFixed(3))
        });
        cursorSec = memeEnd;
        timeline.push({ kind: 'meme', file: path.basename(snip), duration: Number(snipDur.toFixed(3)) });
      }
    }

    const listPath = path.join(tmpDir, 'concat.txt');
    const listBody = segFiles
      .map((p) => `file '${path.basename(p).replace(/'/g, "'\\''")}'`)
      .join('\n');
    fs.writeFileSync(listPath, listBody, 'utf8');
    await runFfmpeg(ffmpegPath, [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', 'concat.txt',
      '-c', 'copy',
      outFile
    ], 8 * 60 * 1000, tmpDir);
    saveSnippetDeck(dir, deck);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  const durationOut = await probeDurationSec(ffprobePath, ffmpegPath, outFile);
  return {
    timeline,
    memeWindows,
    memes: usedMemes.map((p) => path.basename(p)),
    snippetsDir: dir,
    contentSec: Number(contentSec.toFixed(3)),
    durationOut,
    shuffled: !!shuffle,
    size: `${OUT_W}x${OUT_H}`,
    fps: OUT_FPS
  };
}

module.exports = {
  parseCompilationSources,
  mixCompilation,
  MIN_PART,
  MAX_PART,
  MAX_PARTS,
  MAX_CONTENT_SEC
};
