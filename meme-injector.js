/**
 * Manuel kesit + meme enjektörü: ana videoda [start,end] aralıklarını
 * chaos_snippets içinden rastgele kliplerle değiştirir; 9:16 CRF18 çıktı.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SNIPPET_EXTS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.m4v']);
const OUT_W = 1080;
const OUT_H = 1920;
const OUT_FPS = 30; // asla 60+
const MIN_RANGE = 0.35;
const MAX_RANGE = 12;

function runFfmpeg(ffmpegPath, args, timeoutMs = 8 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer =
      timeoutMs > 0
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
      if (stderr.length > 160000) stderr = stderr.slice(-160000);
    });
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) return resolve({ stderr });
      reject(new Error(stderr.slice(-4000) || `ffmpeg exit ${code}`));
    });
  });
}

function resolveChaosSnippetsDir(rootDir) {
  const env = String(process.env.CHAOS_SNIPPETS_DIR || '').trim();
  const candidates = [
    env,
    path.join(rootDir, 'chaos_snippets'),
    path.join(rootDir, 'public', 'chaos_snippets'),
    path.join(rootDir, 'public', 'video', 'chaos_snippets')
  ].filter(Boolean);
  for (const d of candidates) {
    try {
      if (fs.existsSync(d) && fs.statSync(d).isDirectory()) return d;
    } catch {}
  }
  const def = path.join(rootDir, 'chaos_snippets');
  try { fs.mkdirSync(def, { recursive: true }); } catch {}
  return def;
}

function listSnippetFiles(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map((n) => path.join(dir, n))
    .filter((p) => {
      try {
        return fs.statSync(p).isFile() && SNIPPET_EXTS.has(path.extname(p).toLowerCase());
      } catch {
        return false;
      }
    });
}

function parseMemeRanges(raw) {
  let arr = raw;
  if (typeof raw === 'string') {
    try { arr = JSON.parse(raw); } catch { arr = []; }
  }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const r of arr) {
    const start = Number(r && (r.start ?? r.from ?? r.t0));
    const end = Number(r && (r.end ?? r.to ?? r.t1));
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    out.push({ start, end });
  }
  return out;
}

function normalizeRanges(ranges, duration) {
  const d = Math.max(0.5, Number(duration) || 0);
  const cleaned = [];
  for (const r of ranges || []) {
    let a = Math.max(0, Number(r.start));
    let b = Math.max(0, Number(r.end));
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    if (b < a) { const t = a; a = b; b = t; }
    a = Math.min(a, d - MIN_RANGE);
    b = Math.min(b, d);
    if (a < 0) a = 0;
    let len = b - a;
    if (len < MIN_RANGE) continue;
    if (len > MAX_RANGE) b = a + MAX_RANGE;
    cleaned.push({ start: Number(a.toFixed(3)), end: Number(b.toFixed(3)) });
  }
  cleaned.sort((x, y) => x.start - y.start);
  for (let i = 1; i < cleaned.length; i++) {
    if (cleaned[i].start < cleaned[i - 1].end - 0.02) {
      const err = new Error('Meme aralıkları üst üste binemez. Aralıkları ayır.');
      err.statusCode = 400;
      throw err;
    }
  }
  return cleaned;
}

function probeDurationSec(ffprobePath, ffmpegPath, filePath) {
  const probeBin = ffprobePath && fs.existsSync(ffprobePath) ? ffprobePath : null;
  return new Promise((resolve) => {
    if (probeBin) {
      const child = spawn(probeBin, [
        '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', filePath
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (c) => { out += c.toString(); });
      child.on('error', () => resolve(null));
      child.on('close', () => {
        const n = parseFloat(String(out).trim());
        resolve(Number.isFinite(n) && n > 0 ? n : null);
      });
      return;
    }
    const child = spawn(ffmpegPath, ['-hide_banner', '-i', filePath], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (c) => { err += c.toString(); });
    child.on('error', () => resolve(null));
    child.on('close', () => {
      const m = err.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!m) return resolve(null);
      const n = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      resolve(Number.isFinite(n) && n > 0 ? n : null);
    });
  });
}

function probeHasAudio(ffmpegPath, filePath) {
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath, ['-hide_banner', '-i', filePath], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (c) => { err += c.toString(); });
    child.on('error', () => resolve(false));
    child.on('close', () => resolve(/Audio:\s/.test(err)));
  });
}

function pickRandom(arr, used) {
  const pool = (arr || []).filter((p) => !used.has(p));
  const src = pool.length ? pool : arr;
  if (!src || !src.length) return null;
  return src[Math.floor(Math.random() * src.length)];
}

function vfNormalize() {
  return (
    `scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=decrease,` +
    `pad=${OUT_W}:${OUT_H}:(ow-iw)/2:(oh-ih)/2:color=black,` +
    `fps=${OUT_FPS},setsar=1,format=yuv420p`
  );
}

async function writeNormalizedSegment({
  ffmpegPath,
  inFile,
  outFile,
  start,
  duration,
  hasAudio
}) {
  const ss = Math.max(0, Number(start) || 0);
  const dur = Math.max(MIN_RANGE, Number(duration) || MIN_RANGE);
  const args = ['-y', '-ss', ss.toFixed(3), '-t', dur.toFixed(3), '-i', inFile];
  if (!hasAudio) {
    args.push('-f', 'lavfi', '-t', dur.toFixed(3), '-i', 'anullsrc=r=44100:cl=stereo');
  }
  args.push(
    '-vf', vfNormalize(),
    '-map', '0:v:0',
    '-map', hasAudio ? '0:a:0?' : '1:a:0',
    '-shortest',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-r', String(OUT_FPS),
    '-c:a', 'aac',
    '-ar', '44100',
    '-ac', '2',
    '-b:a', '128k',
    '-movflags', '+faststart',
    outFile
  );
  await runFfmpeg(ffmpegPath, args);
}

async function concatSegments(ffmpegPath, listPath, outFile) {
  await runFfmpeg(ffmpegPath, [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', listPath,
    '-c:v', 'libx264',
    '-preset', 'slower',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-r', String(OUT_FPS),
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    '-map_metadata', '-1',
    '-map_chapters', '-1',
    outFile
  ]);
}

/**
 * @returns {{ outFile, ranges, snippetsUsed, durationIn, durationOut }}
 */
async function injectMemes({
  ffmpegPath,
  ffprobePath,
  inFile,
  outFile,
  ranges,
  snippetsDir,
  projectRoot
}) {
  const dir = snippetsDir || resolveChaosSnippetsDir(projectRoot || process.cwd());
  const files = listSnippetFiles(dir);
  if (!files.length) {
    const e = new Error(
      `chaos_snippets boş. MP4 klipleri şuraya koy: ${dir}`
    );
    e.statusCode = 400;
    throw e;
  }
  const dur = (await probeDurationSec(ffprobePath, ffmpegPath, inFile)) || 0;
  if (!(dur > 0.8)) {
    const e = new Error('Ana video süresi okunamadı.');
    e.statusCode = 400;
    throw e;
  }
  const norm = normalizeRanges(ranges, dur);
  if (!norm.length) {
    const e = new Error('Geçerli saniye aralığı yok (min 0.35s, max 12s).');
    e.statusCode = 400;
    throw e;
  }
  const mainHasAudio = await probeHasAudio(ffmpegPath, inFile);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'va-meme-'));
  const used = new Set();
  const snippetsUsed = [];
  const timeline = [];
  let cursor = 0;
  for (const r of norm) {
    if (r.start > cursor + 0.04) {
      timeline.push({ kind: 'main', start: cursor, end: r.start });
    }
    timeline.push({ kind: 'meme', start: r.start, end: r.end });
    cursor = r.end;
  }
  if (cursor < dur - 0.04) timeline.push({ kind: 'main', start: cursor, end: dur });

  const segFiles = [];
  try {
    for (let i = 0; i < timeline.length; i++) {
      const piece = timeline[i];
      const len = piece.end - piece.start;
      if (len < 0.12) continue;
      const segPath = path.join(tmpDir, `seg_${String(i).padStart(3, '0')}.mp4`);
      if (piece.kind === 'main') {
        await writeNormalizedSegment({
          ffmpegPath,
          inFile,
          outFile: segPath,
          start: piece.start,
          duration: len,
          hasAudio: mainHasAudio
        });
      } else {
        const snip = pickRandom(files, used);
        if (!snip) {
          const e = new Error('Uygun meme klibi bulunamadı.');
          e.statusCode = 400;
          throw e;
        }
        used.add(snip);
        const snipDur = (await probeDurationSec(ffprobePath, ffmpegPath, snip)) || len;
        const take = Math.min(len, snipDur, MAX_RANGE);
        const snipHasAudio = await probeHasAudio(ffmpegPath, snip);
        await writeNormalizedSegment({
          ffmpegPath,
          inFile: snip,
          outFile: segPath,
          start: 0,
          duration: take,
          hasAudio: snipHasAudio
        });
        snippetsUsed.push({ file: path.basename(snip), duration: Number(take.toFixed(3)), at: piece.start });
      }
      segFiles.push(segPath);
    }
    if (!segFiles.length) {
      const e = new Error('Kesit üretilemedi. Aralıkları ve videoyu kontrol et.');
      e.statusCode = 400;
      throw e;
    }
    const listPath = path.join(tmpDir, 'concat.txt');
    // Relative names: Windows path quoting in concat demuxer is brittle.
    const listBody = segFiles
      .map((p) => `file '${path.basename(p).replace(/'/g, "'\\''")}'`)
      .join('\n');
    fs.writeFileSync(listPath, listBody, 'utf8');
    await concatSegments(ffmpegPath, listPath, outFile);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
  const durationOut = (await probeDurationSec(ffprobePath, ffmpegPath, outFile)) || null;
  return {
    ranges: norm,
    snippetsUsed,
    snippetsDir: dir,
    durationIn: Number(dur.toFixed(3)),
    durationOut,
    fps: OUT_FPS,
    size: `${OUT_W}x${OUT_H}`
  };
}

module.exports = {
  injectMemes,
  resolveChaosSnippetsDir,
  listSnippetFiles,
  parseMemeRanges,
  normalizeRanges,
  OUT_W,
  OUT_H,
  OUT_FPS
};
