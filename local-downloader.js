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

function randRange(min, max) {
  const a = Number(min), b = Number(max);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return min;
  return a + Math.random() * (b - a);
}

function pickOne(arr) {
  if (!arr || !arr.length) return '';
  return arr[Math.floor(Math.random() * arr.length)];
}

function escapeDrawtextText(s) {
  // drawtext special chars: \ : ' % need escaping
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%');
}

function pickHookText(brand) {
  const kaos = [
    'Ending is unbelievable ⚠️',
    'Watch for the end! 🤣',
    'Did not expect that 😂',
    'End is crazy! 😱'
  ];
  const terapi = [
    'Ending is so sweet ✨',
    'Wait for the sweet end! 😍',
    'Watch till the end ❤️',
    'Too cute to be real 🥰'
  ];
  return pickOne(brand === 'kaos' ? kaos : terapi);
}

function pickFontFileForDrawtext() {
  // drawtext on Windows is most reliable with fontfile.
  // Prefer emoji-capable font to render the hook templates.
  const candidates =
    process.platform === 'win32'
      ? [
          'C:\\Windows\\Fonts\\seguiemj.ttf', // Segoe UI Emoji
          'C:\\Windows\\Fonts\\segoeui.ttf',
          'C:\\Windows\\Fonts\\arial.ttf'
        ]
      : [
          '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
          '/usr/share/fonts/truetype/freefont/FreeSans.ttf'
        ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

function clamp(n, lo, hi) {
  const x = Number(n);
  if (!Number.isFinite(x)) return lo;
  return Math.min(hi, Math.max(lo, x));
}

function formatHms(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad2 = (v) => String(v).padStart(2, '0');
  // keep milliseconds for tighter cut
  const ssStr = ss.toFixed(3).padStart(6, '0'); // "SS.mmm" but might be "0.000"
  return `${pad2(h)}:${pad2(m)}:${ssStr}`;
}

async function ytDlpGetDurationSec(url) {
  // duration in seconds if available, else null
  try {
    const { stderr } = await run('yt-dlp', [
      '--no-playlist',
      '--print',
      '%(duration)s',
      url
    ], { timeoutMs: 45_000 });
    // run() returns stderr only; duration is printed to stdout, so we can't read it here.
    // Fallback: use spawn to capture stdout for this one call.
  } catch {}

  return await new Promise((resolve) => {
    try {
      const child = spawn('yt-dlp', ['--no-playlist', '--print', '%(duration)s', url], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(null); }, 45_000);
      child.stdout.on('data', (d) => { out += d.toString(); });
      child.on('close', () => {
        clearTimeout(t);
        const v = Number(String(out || '').trim());
        if (!Number.isFinite(v) || v <= 0) return resolve(null);
        resolve(v);
      });
      child.on('error', () => { clearTimeout(t); resolve(null); });
    } catch {
      resolve(null);
    }
  });
}

async function probeDurationSec(filePath) {
  // Requires ffprobe available with ffmpeg install
  const args = [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath
  ];
  const child = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  return await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(err || `ffprobe exit ${code}`));
      const v = Number(String(out).trim());
      if (!Number.isFinite(v) || v <= 0) return reject(new Error('Süre okunamadı'));
      resolve(v);
    });
  });
}

async function probeHasAudio(filePath) {
  const args = [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=index',
    '-of', 'csv=p=0',
    filePath
  ];
  const child = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  return await new Promise((resolve) => {
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('close', (code) => {
      if (code !== 0) return resolve(false);
      resolve(String(out || '').trim().length > 0);
    });
    child.on('error', () => resolve(false));
  });
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
    // En iyi kalite (4K dahil) — sadece indirme süresini limitleriz.
    '--merge-output-format',
    'mp4',
    '-f',
    'bv*+ba/best',
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
  const hasFfprobe = await existsOnPath('ffprobe');
  if (!hasFfmpeg || !hasFfprobe) return res.status(500).json({ error: 'ffmpeg/ffprobe bulunamadı. Önce bilgisayara ffmpeg kur.' });

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
    // Önce süresini öğren (çok uzun/sonsuz indirmeyi engellemek için)
    const metaDur = await ytDlpGetDurationSec(url);
    // Hedef: video 1.10x olacağı için çıktının saniyesi kadar (outDur) indirmeyi kes.
    // meta yoksa: 30s ile sınırla (YouTube Shorts/Reels için yeterli)
    const speed = 1.10;
    const targetSectionSec = metaDur ? clamp((metaDur / speed) + 0.25, 5, 60) : 30;
    const section = `*${formatHms(0)}-${formatHms(targetSectionSec)}`;
    const dlTimeoutMs = Math.round(clamp(targetSectionSec * 8000, 90_000, 8 * 60 * 1000));

    const dlArgs = [
      '--no-playlist',
      '--newline',
      '--no-part',
      '--no-mtime',
      '--merge-output-format',
      'mp4',
      '-f',
      // En iyi kalite (4K dahil)
      'bv*+ba/best',
      // Çok uzun indirmeyi engelle: sadece ilk N saniyeyi indir
      '--download-sections',
      section,
      '--force-keyframes-at-cuts',
      '-o',
      inTpl,
      url
    ];
    await run('yt-dlp', dlArgs, { timeoutMs: dlTimeoutMs });

    const inFile = pickNewestFile(tmpDir);
    if (!inFile) return res.status(500).json({ error: 'İndirilen dosya bulunamadı' });

    const wmSize = 96;
    const vx = 130;
    const vy = 85;
    const inDur = await probeDurationSec(inFile);
    const outDur = Math.max(1, inDur / speed);
    const outW = 720, outH = 1280;

    // İzleyici konforu için küçük varyasyonlar (her videoda hafif değişsin)
    const zoom = randRange(1.04, 1.08);
    const contrast = randRange(1.03, 1.09);
    const saturation = randRange(1.05, 1.15);
    const brightness = randRange(-0.02, 0.04);

    // Hook text (ilk 3 saniye)
    const hookText = pickHookText(brand);
    const hookY = Math.round(randRange(110, 150)); // üstte ama tam tepede değil
    const hookAlpha = randRange(0.85, 0.90);
    const fontFile = pickFontFileForDrawtext();
    const fontFileFilterPart = fontFile
      ? `:fontfile='${escapeDrawtextText(fontFile.replace(/\\/g, '/'))}'`
      : '';

    // Hafif şablon: sadece main video (outro yok)
    const filter = [
      `[0:v]setpts=(PTS-STARTPTS)/${speed},scale=-2:${outH},crop=${outW}:${outH},` +
        `scale=iw*${zoom.toFixed(4)}:ih*${zoom.toFixed(4)},crop=${outW}:${outH},` +
        `eq=contrast=${contrast.toFixed(4)}:saturation=${saturation.toFixed(4)}:brightness=${brightness.toFixed(4)},` +
        `setsar=1,trim=0:${outDur.toFixed(3)},setpts=PTS-STARTPTS[v0]`,
      `[v0]drawtext=text='${escapeDrawtextText(hookText)}'${fontFileFilterPart}:` +
        `fontcolor=white@${hookAlpha.toFixed(3)}:fontsize=48:x=(w-text_w)/2:y=${hookY}:` +
        `box=1:boxcolor=black@0.30:boxborderw=18:enable='between(t,0,3)'[v1]`,
      `[1:v]scale=${wmSize}:${wmSize}:force_original_aspect_ratio=decrease,format=rgba,` +
        `rotate='0.15*sin(2*PI*t/1.2)':c=none:ow=iw:oh=ih[wm0]`,
      `[wm0]split=2[wmA][wmB]`,
      `[wmA]alphaextract,geq=lum='if(lte((X-W/2)*(X-W/2)+(Y-H/2)*(Y-H/2),(min(W,H)/2)*(min(W,H)/2)),255,0)'[mask]`,
      `[wmB][mask]alphamerge,colorchannelmixer=aa=0.30[wm]`,
      `[v1][wm]overlay=` +
        `x='abs(mod(t*${vx},2*(W-w))-(W-w))':` +
        `y='abs(mod(t*${vy},2*(H-h))-(H-h))':format=auto[v]`
    ].join(';');

    const ffArgs = [
      '-y',
      '-i', inFile,
      '-loop', '1',
      '-i', wmFile,
      '-filter_complex', filter,
      '-map', '[v]',
      '-map', '0:a?',
      // Ses: (1) pitch shift (çok hafif) + (2) video ile birebir aynı hız (1.10x) + (3) hafif volume bump
      '-af', (() => {
        const semitone = -0.4;
        const pitchFactor = Math.pow(2, semitone / 12); // <1 => pitch aşağı
        // asetrate ile süre/pitch değişir; atempo ile hedef hıza (speed) getiriyoruz.
        // Hedef: final audio duration == inDur/speed => atempo = speed / pitchFactor
        const atempoTotal = speed * (1 / pitchFactor);
        // küçük dalga: her birinde 0.25s %2 artış
        const bumpDur = 0.25;
        const bump = (t) => `between(t,${t.toFixed(3)},${(t + bumpDur).toFixed(3)})`;
        const volExpr = `if(${bump(3)}+${bump(8)}+${bump(10)},1.02,1)`;
        return [
          `asetrate=48000*${pitchFactor.toFixed(8)}`,
          `aresample=48000`,
          `atempo=${atempoTotal.toFixed(6)}`,
          `volume='${volExpr}'`,
          `aresample=async=1:first_pts=0`,
          `apad=pad_dur=${(outDur + 0.5).toFixed(3)}`,
          `atrim=0:${outDur.toFixed(3)}`,
          `asetpts=PTS-STARTPTS`
        ].join(',');
      })(),
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '24',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      // Gizlilik: metadata/chapter temizle
      '-map_metadata', '-1',
      '-map_chapters', '-1',
      '-c:a', 'aac',
      '-b:a', '128k',
      outFile
    ];
    await run('ffmpeg', ffArgs, { timeoutMs: 8 * 60 * 1000 });

    return res.json({
      ok: true,
      savedTo: DOWNLOAD_DIR,
      file: path.basename(outFile),
      settings: {
        speed,
        zoom: Number(zoom.toFixed(4)),
        contrast: Number(contrast.toFixed(4)),
        saturation: Number(saturation.toFixed(4)),
        brightness: Number(brightness.toFixed(4))
      }
    });
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

