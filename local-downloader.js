const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '256kb' }));

const PORT = process.env.LOCAL_DOWNLOADER_PORT || 8787;
const DEFAULT_DIR = path.join(process.env.USERPROFILE || process.cwd(), 'Videos', 'Viral Atölyesi İndirilenler');
const DOWNLOAD_DIR = process.env.VA_DOWNLOAD_DIR || DEFAULT_DIR;
const PUBLIC_DIR = path.join(__dirname, 'public');

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
            try { child.kill('SIGKILL'); } catch {}
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
    // Prefer a single-file progressive mp4 when possible; otherwise fallback to best.
    '-f',
    'best[ext=mp4][acodec!=none][vcodec!=none]/best',
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
      if (code !== 0) return res.status(500).json({ error: stderr || `yt-dlp exit ${code}` });
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
app.post('/crush', async (req, res) => {
  const url = req.body?.url || req.query?.url;
  const brand = String(req.body?.brand || req.query?.brand || 'terapi').toLowerCase();
  if (!url) return res.status(400).json({ error: 'url gerekli' });

  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

  const hasYtDlp = await existsOnPath('yt-dlp');
  if (!hasYtDlp) return res.status(500).json({ error: 'yt-dlp bulunamadı. Önce bilgisayara yt-dlp kur.' });

  const hasFfmpeg = await existsOnPath('ffmpeg');
  if (!hasFfmpeg) return res.status(500).json({ error: 'ffmpeg bulunamadı. Önce bilgisayara ffmpeg kur.' });

  const wmFile =
    brand === 'kaos'
      ? path.join(PUBLIC_DIR, 'watermark-kaos.png')
      : path.join(PUBLIC_DIR, 'watermark-terapi.png');
  if (!fs.existsSync(wmFile)) return res.status(500).json({ error: 'Watermark dosyası yok (public/watermark-*.png).' });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'va-local-crush-'));
  const inTpl = path.join(tmpDir, 'in.%(ext)s');
  const outName = `crushed_${brand}_9x16_${Date.now()}.mp4`;
  const outFile = path.join(DOWNLOAD_DIR, outName);

  try {
    // indir (en iyi mp4 -> best)
    const dlArgs = [
      '--no-playlist',
      '--newline',
      '--no-part',
      '--no-mtime',
      '-f',
      'best[ext=mp4][acodec!=none][vcodec!=none]/best',
      '-o',
      inTpl,
      url
    ];
    await run('yt-dlp', dlArgs, { timeoutMs: 6 * 60 * 1000 });

    const inFile = pickNewestFile(tmpDir);
    if (!inFile) return res.status(500).json({ error: 'İndirilen dosya bulunamadı' });

    const speed = 1.10;
    const wmSize = 110;
    const vx = 130;
    const vy = 85;
    const filter = [
      // Performans: 720x1280 (daha az kasar). Tek şablon sabit.
      `[0:v]scale=-2:1280,crop=720:1280,scale=iw*1.07:ih*1.07,crop=720:1280,eq=contrast=1.06:saturation=1.10:brightness=0.02,setsar=1[v0]`,
      `[1:v]scale=${wmSize}:${wmSize}:force_original_aspect_ratio=decrease,format=rgba,colorchannelmixer=aa=0.35[wm]`,
      `[v0][wm]overlay=` +
        `x='abs(mod(t*${vx},2*(W-w))-(W-w))':` +
        `y='abs(mod(t*${vy},2*(H-h))-(H-h))':` +
        `format=auto[v]`
    ].join(';');

    const ffArgs = [
      '-y',
      '-i', inFile,
      '-loop', '1',
      '-i', wmFile,
      '-filter_complex', filter,
      '-map', '[v]',
      '-map', '0:a?',
      // Ses bazen erken biter -> video kesilmesin diye silence ile uzat.
      // Ayrıca VFR videolarda titreme azaltmak için async resample.
      '-af', `atempo=${speed},aresample=async=1:first_pts=0,apad=pad_dur=120`,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '24',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-shortest',
      outFile
    ];
    await run('ffmpeg', ffArgs, { timeoutMs: 8 * 60 * 1000 });

    return res.json({ ok: true, savedTo: DOWNLOAD_DIR, file: path.basename(outFile) });
  } catch (e) {
    return res.status(500).json({ error: (e && e.message) ? e.message : String(e) });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Local Downloader running on http://127.0.0.1:${PORT}`);
  console.log('Download dir:', DOWNLOAD_DIR);
  console.log('Install yt-dlp then open your frontend and click Download.');
});

