const express = require('express');
const cors = require('cors');
const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const os = require('os');
const { pipeline } = require('stream/promises');
const ffmpegPath = require('ffmpeg-static');

const app = express(); // 1. Sırada bu olmalı

// Statik dosyalar için public klasörünü kullan
app.use(express.static(path.join(__dirname, 'public'))); // 2. Sırada bu olmalı

app.use(cors({ exposedHeaders: ['Content-Disposition'] }));
app.use(express.json({ limit: '1mb' }));

// API response caching/etag kapat (304 dönüp frontend'in json() kırılmasını engeller)
app.set('etag', false);
app.use((req, res, next) => {
  if (
    req.path === '/download' ||
    req.path === '/tools/crush' ||
    req.path.startsWith('/search/') ||
    req.path.startsWith('/youtube/') ||
    req.path.startsWith('/anthropic/')
  ) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
  }
  next();
});

// Request log (Render loglarında istekleri görebilmek için)
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)`);
  });
  next();
});

const YTDLP_PATH = path.join(__dirname, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const COOKIES_PATH = path.join(__dirname, 'www.youtube.com_cookies.txt');
const COOKIES_TIKTOK_PATH = path.join(__dirname, 'www.tiktok.com_cookies.txt');
const COOKIES_INSTAGRAM_PATH = path.join(__dirname, 'www.instagram.com_cookies.txt');
// Render tarafında env set edilmese bile çalışabilsin diye fallback ekliyoruz.
// Not: Bu key'i herkese açık repoya koyma; sadece kullandığın deploy ortamında kullan.
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || 'fa585a7e00mshd7e15329a3e4fe2p17ec23jsn54ade22ae56f';
const PUBLIC_DIR = path.join(__dirname, 'public');

/** Telif Ezici: Terapi/Umut/Kaos için sadece PNG dosyası değişir; ffmpeg filtresi markaya göre ayrılmaz. */
function crushWatermarkAbsPath(brandRaw) {
  const b = String(brandRaw || 'terapi').toLowerCase();
  const key = b === 'kaos' ? 'kaos' : b === 'umut' ? 'umut' : 'terapi';
  const file =
    key === 'kaos' ? 'watermark-kaos.png' : key === 'umut' ? 'watermark-umut.png' : 'watermark-terapi.png';
  return path.join(PUBLIC_DIR, file);
}

// Simple in-memory cache to avoid RapidAPI 429 (per instance)
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 10 * 60 * 1000); // 10 min
const apiCache = new Map();
function cacheGet(key) {
  const v = apiCache.get(key);
  if (!v) return null;
  if (Date.now() > v.expiresAt) {
    apiCache.delete(key);
    return null;
  }
  return v.value;
}
function cacheSet(key, value, ttlMs = CACHE_TTL_MS) {
  apiCache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function normalizeNetscapeCookies(text) {
  let s = String(text || '').replace(/^\uFEFF/, '');
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!/#\s*Netscape HTTP Cookie File/i.test(s.split('\n', 1)[0] || '')) {
    if (!s.trim().startsWith('#')) s = '# Netscape HTTP Cookie File\n' + s;
  }
  return s;
}

function ensureCookieFileFromEnv(envName, filePath) {
  const b64 = process.env[envName];
  if (!b64) return;
  try {
    const trimmed = String(b64).trim().replace(/\s+/g, '');
    const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
    if (!decoded || decoded.length < 50) return;
    const normalized = normalizeNetscapeCookies(decoded);
    fs.writeFileSync(filePath, normalized, { encoding: 'utf8' });
  } catch (e) {
    console.error(`ensureCookieFileFromEnv failed (${envName}):`, e && e.message ? e.message : e);
  }
}

/** Render "Gizli Dosyalar" → /etc/secrets/<dosya> */
const YT_COOKIES_SECRET = '/etc/secrets/www.youtube.com_cookies.txt';

function resolveYoutubeCookieFile() {
  if (fs.existsSync(YT_COOKIES_SECRET)) {
    try {
      if (fs.statSync(YT_COOKIES_SECRET).size > 100) return YT_COOKIES_SECRET;
    } catch {}
  }
  if (fs.existsSync(COOKIES_PATH)) {
    try {
      if (fs.statSync(COOKIES_PATH).size > 100) return COOKIES_PATH;
    } catch {}
  }
  return null;
}

function cookieFileInfo(filePath) {
  try {
    if (!fs.existsSync(filePath)) return { exists: false, bytes: 0 };
    const st = fs.statSync(filePath);
    return { exists: true, bytes: st.size || 0 };
  } catch {
    return { exists: false, bytes: 0 };
  }
}

function installYtDlp() {
  // Render ortamında curl her zaman yok; Node ile indir (redirect destekli, EBADF'siz).
  const startUrl =
    process.platform === 'win32'
      ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
      : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

  function getWithRedirect(url, redirectsLeft = 5) {
    return new Promise((resolve, reject) => {
      const req = https.get(url, (res) => {
        const code = res.statusCode || 0;
        if (code >= 300 && code < 400 && res.headers.location && redirectsLeft > 0) {
          res.resume();
          resolve(getWithRedirect(res.headers.location, redirectsLeft - 1));
          return;
        }
        if (code >= 400) {
          const err = new Error(`yt-dlp download HTTP ${code}`);
          res.resume();
          reject(err);
          return;
        }
        resolve(res);
      });
      req.on('error', reject);
    });
  }

  return (async () => {
    const tmp = path.join(os.tmpdir(), `yt-dlp_${Date.now()}`);
    try {
      const res = await getWithRedirect(startUrl);
      const out = fs.createWriteStream(tmp);
      await pipeline(res, out);
      fs.copyFileSync(tmp, YTDLP_PATH);
      if (process.platform !== 'win32') fs.chmodSync(YTDLP_PATH, 0o755);
    } catch (e) {
      console.error('installYtDlp failed:', e && e.message ? e.message : e);
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {}
    }
  })();
}

function guessMimeFromPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.mp4' || ext === '.m4v') return 'video/mp4';
  if (ext === '.webm') return 'video/webm';
  if (ext === '.mkv') return 'video/x-matroska';
  if (ext === '.mov') return 'video/quicktime';
  return 'application/octet-stream';
}

function findYtDlpOutput(outBase) {
  const dir = path.dirname(outBase);
  const prefix = path.basename(outBase);
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => f.startsWith(prefix + '.'));
  if (!files.length) return null;
  return path.join(dir, files[0]);
}

function safeFilename(name) {
  return String(name || 'video')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180) || 'video';
}

function buildYtDlpArgs(url, { cookieFile, format, extraArgs } = {}) {
  const cookieFlag = cookieFile && fs.existsSync(cookieFile) ? ['--cookies', cookieFile] : [];
  return [
    ...cookieFlag,
    '--no-check-certificate',
    '--no-playlist',
    '--newline',
    '-f',
    format || 'best',
    ...((extraArgs && Array.isArray(extraArgs)) ? extraArgs : []),
    '-o',
    '-',
    url
  ];
}

async function attemptStreamToResponse(res, url, { cookieFile, format, extraArgs, filenameHint, forceExt, timeoutMs } = {}) {
  const args = buildYtDlpArgs(url, { cookieFile, format, extraArgs });
  const base = safeFilename(filenameHint || 'video');
  const extGuess = forceExt || ((format && /mp4/i.test(format)) ? 'mp4' : 'bin');
  const downloadName = `${base}.${extGuess}`;
  const maxWait = typeof timeoutMs === 'number' ? timeoutMs : 120000;

  return await new Promise((resolve) => {
    const child = spawn(YTDLP_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let started = false;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      try { child.kill('SIGKILL'); } catch {}
      stderr += '\n[timeout] yt-dlp ' + maxWait + 'ms içinde başlamadı veya takıldı.';
    }, maxWait);

    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 80_000) stderr = stderr.slice(-80_000);
    });

    child.on('error', (e) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ ok: false, started: false, stderr: 'yt-dlp spawn hatası: ' + e.message });
    });

    child.stdout.once('data', (chunk) => {
      if (settled) return;
      started = true;
      clearTimeout(timer);
      res.setHeader('Content-Type', extGuess === 'mp4' ? 'video/mp4' : 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${downloadName.replace(/"/g, '')}"`);
      res.flushHeaders?.();
      res.write(chunk);
      child.stdout.pipe(res);
      resolve({ ok: true, started: true, stderr: '' });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (started) {
        if (code !== 0) console.error('yt-dlp stream failed:', stderr || `exit ${code}`);
        try { res.end(); } catch {}
        return;
      }
      if (settled) return;
      settled = true;
      if (code === 0) return resolve({ ok: false, started: false, stderr: 'Boş çıktı (0 byte)' });
      resolve({ ok: false, started: false, stderr: stderr || `exit ${code}` });
    });
  });
}

function safeUnlink(p) {
  try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch {}
}

function runChild(bin, args, { timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const killTimer =
      timeoutMs && timeoutMs > 0
        ? setTimeout(() => {
            try { child.kill('SIGKILL'); } catch {}
          }, timeoutMs)
        : null;
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => {
      if (killTimer) clearTimeout(killTimer);
      reject(e);
    });
    child.on('close', (code) => {
      if (killTimer) clearTimeout(killTimer);
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(stderr || stdout || `exit ${code}`));
    });
  });
}

async function downloadVideoToFile(url, filepath, { cookieFile, format, extraArgs } = {}) {
  const args = buildYtDlpArgs(url, { cookieFile, format, extraArgs });
  // buildYtDlpArgs zaten -o outBase.* kullanıyor; bunu dosya adına sabitlemek için override edelim.
  // İstenmeyen ext sürprizlerini azaltmak için mp4'e zorla.
  const finalArgs = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-o' || a === '--output') {
      i += 1;
      finalArgs.push('-o', filepath);
      continue;
    }
    finalArgs.push(a);
  }
  // Eğer buildYtDlpArgs -o koymadıysa ekle
  if (!finalArgs.includes('-o') && !finalArgs.includes('--output')) {
    finalArgs.push('-o', filepath);
  }
  await runChild(YTDLP_PATH, finalArgs, { timeoutMs: 4 * 60 * 1000 });
}

// YouTube / TikTok / Instagram indirme (yt-dlp; ffmpeg gerekmez — tek parça "best")
app.all('/download', (req, res) => {
  const url = req.query?.url || req.body?.url || req.body?.videoUrl || req.body?.link;
  if (!url) return res.status(400).json({ error: 'URL gerekli' });

  const isYt = /youtube\.com|youtu\.be/i.test(url);
  const isTiktok = /tiktok\.com/i.test(url);
  const isInstagram = /instagram\.com|instagr\.am/i.test(url);

  let cookieFile = null;
  if (isYt) {
    ensureCookieFileFromEnv('YT_COOKIES_B64', COOKIES_PATH);
    cookieFile = resolveYoutubeCookieFile();
  } else if (isTiktok) {
    ensureCookieFileFromEnv('TT_COOKIES_B64', COOKIES_TIKTOK_PATH);
    cookieFile = fs.existsSync(COOKIES_TIKTOK_PATH) ? COOKIES_TIKTOK_PATH : null;
  } else if (isInstagram) {
    ensureCookieFileFromEnv('IG_COOKIES_B64', COOKIES_INSTAGRAM_PATH);
    cookieFile = fs.existsSync(COOKIES_INSTAGRAM_PATH) ? COOKIES_INSTAGRAM_PATH : null;
  }

  // Render 502 sebebi genelde: indirme tamamlanana kadar response boş kalıyor ve proxy timeout oluyor.
  // Çözüm: yt-dlp çıktısını doğrudan response'a stream et (ilk byte hemen gitsin).
  const ytUa =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';
  const ytNetArgs = isYt
    ? ['--geo-bypass', '--force-ipv4', '--referer', 'https://www.youtube.com/', '--user-agent', ytUa]
    : [];
  const ytNetArgsNoForce4 = isYt
    ? ['--geo-bypass', '--referer', 'https://www.youtube.com/', '--user-agent', ytUa]
    : [];

  if (isYt) {
    (async () => {
      const hasCookies = !!(cookieFile && fs.existsSync(cookieFile));
      // MP4 + AAC ses tercih et: bazı mp4'ler Opus audio ile gelebiliyor (Windows "ses çalınamıyor").
      const fmtProg =
        // 1080p hedefi: Shorts'ta genişlik genelde 1080 (yükseklik 1920), yatayda yükseklik 1080 (genişlik 1920).
        // Önce 1080 wide/1080 tall mp4+m4a dene; yoksa 1080'e kadar mp4; yoksa genel mp4; en sonda best.
        'bv*[ext=mp4][vcodec!=none][width=1080]+ba[ext=m4a][acodec!=none]/' +
        'bv*[ext=mp4][vcodec!=none][height=1080]+ba[ext=m4a][acodec!=none]/' +
        'bv*[ext=mp4][vcodec!=none][width<=1080][height<=1920]+ba[ext=m4a][acodec!=none]/' +
        'bv*[ext=mp4][vcodec!=none][height<=1080]+ba[ext=m4a][acodec!=none]/' +
        'bv*[ext=mp4][vcodec!=none]+ba[ext=m4a][acodec!=none]/' +
        'best[ext=mp4][acodec!=none][vcodec!=none]/best[acodec!=none][vcodec!=none]';
      const fmtBest = 'best';

      const tries = [
        { name: 'web+mp4', cookieFile, format: fmtProg, extra: ['--extractor-args', 'youtube:player_client=web', ...ytNetArgs], forceExt: 'mp4' },
        { name: 'ios+mp4', cookieFile: hasCookies ? cookieFile : null, format: fmtProg, extra: ['--extractor-args', 'youtube:player_client=ios', ...ytNetArgs], forceExt: 'mp4' },
        { name: 'tv_embedded+mp4', cookieFile, format: fmtProg, extra: ['--extractor-args', 'youtube:player_client=tv_embedded', ...ytNetArgs], forceExt: 'mp4' },
        { name: 'mweb+mp4', cookieFile, format: fmtProg, extra: ['--extractor-args', 'youtube:player_client=mweb', ...ytNetArgs], forceExt: 'mp4' },
        { name: 'web+best', cookieFile, format: fmtBest, extra: ['--extractor-args', 'youtube:player_client=web', ...ytNetArgs] },
        { name: 'ios+best', cookieFile: hasCookies ? cookieFile : null, format: fmtBest, extra: ['--extractor-args', 'youtube:player_client=ios', ...ytNetArgs] },
        { name: 'tv_embedded+best', cookieFile, format: fmtBest, extra: ['--extractor-args', 'youtube:player_client=tv_embedded', ...ytNetArgs] },
        { name: 'web+mp4 (no force-ipv4)', cookieFile, format: fmtProg, extra: ['--extractor-args', 'youtube:player_client=web', ...ytNetArgsNoForce4], forceExt: 'mp4' },
        { name: 'android no cookies', cookieFile: null, format: fmtBest, extra: ['--extractor-args', 'youtube:player_client=android', ...ytNetArgs] }
      ];

      let lastErr = '';
      for (const t of tries) {
        const r = await attemptStreamToResponse(res, url, {
          cookieFile: t.cookieFile,
          format: t.format,
          extraArgs: t.extra,
          filenameHint: 'youtube_video',
          forceExt: t.forceExt,
          timeoutMs: 100000
        });
        if (r.ok) return;
        lastErr = r.stderr || lastErr;
        console.error(`yt-dlp try "${t.name}" failed`);
      }

      const errText = String(lastErr || '');
      console.error('yt-dlp download failed:', errText);
      if (/confirm you're not a bot|sign in|cookies-from-browser|oturum açın/i.test(errText)) {
        return res.status(403).json({
          error:
            'YouTube hâlâ bot doğrulaması istiyor. Olası nedenler: (1) Cookie dosyasında LOGIN_INFO / güncel oturum yok — ' +
            'Chrome’da youtube.com’a giriş yapıp "Get cookies.txt LOCALLY" ile yeniden export et; Render’da YT_COOKIES_B64’ü güncelle. ' +
            '(2) Bazı videolar veya Render IP’si sunucu tarafında bloklanır; o durumda indirmeyi kendi bilgisayarında yt-dlp ile yap.'
        });
      }
      res.status(500).json({ error: 'İndirme hatası: ' + errText });
    })();
    return;
  }

  (async () => {
    const r = await attemptStreamToResponse(res, url, {
      cookieFile,
      // MP4 + AAC ses tercih et (TikTok/IG dahil)
      format: 'bv*[ext=mp4][vcodec!=none]+ba[ext=m4a][acodec!=none]/best[ext=mp4][acodec!=none][vcodec!=none]/best',
      extraArgs: ytNetArgs,
      filenameHint: (isTiktok ? 'tiktok_video' : isInstagram ? 'instagram_video' : 'video')
    });
    if (r.ok) return;
    console.error('yt-dlp download failed:', r.stderr);
    res.status(500).json({ error: 'İndirme hatası: ' + r.stderr });
  })();
});

// Telif Ezici: indir -> 9:16 + hafif zoom + küçük hız + seken watermark
app.post('/tools/crush', async (req, res) => {
  const url = req.body?.url || req.query?.url;
  const brand = String(req.body?.brand || req.query?.brand || 'terapi').toLowerCase();
  if (!url) return res.status(400).json({ error: 'URL gerekli' });

  if (!ffmpegPath) return res.status(500).json({ error: 'FFmpeg bulunamadı (ffmpeg-static).' });

  const isYt = /youtube\.com|youtu\.be/i.test(url);
  const isTiktok = /tiktok\.com/i.test(url);
  const isInstagram = /instagram\.com|instagr\.am/i.test(url);

  let cookieFile = null;
  if (isYt) {
    ensureCookieFileFromEnv('YT_COOKIES_B64', COOKIES_PATH);
    cookieFile = resolveYoutubeCookieFile();
  } else if (isTiktok) {
    ensureCookieFileFromEnv('TT_COOKIES_B64', COOKIES_TIKTOK_PATH);
    cookieFile = fs.existsSync(COOKIES_TIKTOK_PATH) ? COOKIES_TIKTOK_PATH : null;
  } else if (isInstagram) {
    ensureCookieFileFromEnv('IG_COOKIES_B64', COOKIES_INSTAGRAM_PATH);
    cookieFile = fs.existsSync(COOKIES_INSTAGRAM_PATH) ? COOKIES_INSTAGRAM_PATH : null;
  }

  const wmFile = crushWatermarkAbsPath(brand);
  if (!fs.existsSync(wmFile)) return res.status(500).json({ error: 'Watermark dosyası yok.' });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'va-crush-'));
  const inFile = path.join(tmpDir, 'in.mp4');
  const outFile = path.join(tmpDir, 'out.mp4');

  const ytUa =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';
  const ytNetArgs = isYt
    ? ['--geo-bypass', '--force-ipv4', '--referer', 'https://www.youtube.com/', '--user-agent', ytUa]
    : [];
  const ytNetArgsNoForce4 = isYt
    ? ['--geo-bypass', '--referer', 'https://www.youtube.com/', '--user-agent', ytUa]
    : [];

  try {
    // YouTube tarafı bazen "signature / n challenge" yüzünden formatları göstermeyebiliyor.
    // /download ile aynı mantık: farklı player_client kombinasyonlarını sırayla dene.
    const fmtProg = 'best[ext=mp4][acodec!=none][vcodec!=none]/best[acodec!=none][vcodec!=none]';
    const fmtBest = 'best';

    const hasCookies = !!(cookieFile && fs.existsSync(cookieFile));
    const tries = isYt
      ? [
          { name: 'web+mp4', cookieFile, format: fmtProg, extra: ['--extractor-args', 'youtube:player_client=web', ...ytNetArgs] },
          { name: 'ios+mp4', cookieFile: hasCookies ? cookieFile : null, format: fmtProg, extra: ['--extractor-args', 'youtube:player_client=ios', ...ytNetArgs] },
          { name: 'tv_embedded+mp4', cookieFile, format: fmtProg, extra: ['--extractor-args', 'youtube:player_client=tv_embedded', ...ytNetArgs] },
          { name: 'mweb+mp4', cookieFile, format: fmtProg, extra: ['--extractor-args', 'youtube:player_client=mweb', ...ytNetArgs] },
          { name: 'web+best', cookieFile, format: fmtBest, extra: ['--extractor-args', 'youtube:player_client=web', ...ytNetArgs] },
          { name: 'ios+best', cookieFile: hasCookies ? cookieFile : null, format: fmtBest, extra: ['--extractor-args', 'youtube:player_client=ios', ...ytNetArgs] },
          { name: 'tv_embedded+best', cookieFile, format: fmtBest, extra: ['--extractor-args', 'youtube:player_client=tv_embedded', ...ytNetArgs] },
          { name: 'web+mp4 (no force-ipv4)', cookieFile, format: fmtProg, extra: ['--extractor-args', 'youtube:player_client=web', ...ytNetArgsNoForce4] },
          { name: 'android no cookies', cookieFile: null, format: fmtBest, extra: ['--extractor-args', 'youtube:player_client=android', ...ytNetArgs] }
        ]
      : [{ name: 'best', cookieFile, format: fmtBest, extra: ytNetArgs }];

    let lastErr = '';
    for (const t of tries) {
      try {
        await downloadVideoToFile(url, inFile, { cookieFile: t.cookieFile, format: t.format, extraArgs: t.extra });
        lastErr = '';
        break;
      } catch (e) {
        lastErr = e && e.message ? e.message : String(e);
        console.error(`/tools/crush yt-dlp try "${t.name}" failed`);
      }
    }
    if (lastErr) {
      if (/confirm you're not a bot|sign in|cookies-from-browser|oturum açın/i.test(lastErr)) {
        return res.status(403).json({
          error:
            'YouTube bot doğrulaması istiyor. Çözüm: Render tarafında YT_COOKIES_B64 (güncel girişli cookies) güncelle. ' +
            'Bazen bazı videolar/Render IP’si bloklu olabilir; o videolarda indirme başarısız olur.'
        });
      }
      return res.status(500).json({ error: lastErr.slice(0, 1500) });
    }

    // 9:16 + hafif zoom + küçük hız (1.03) + watermark "seken top"
    // watermark konumu: DVD tarzı sekme (x,y mod/abs)
    // Not: tek şablon — her video için aynı değerler.
    const speed = 1.1; // her daim 1.10x
    const wmSize = 110; // Kaos / Terapi / Umut aynı (Umut = Kaos ile aynı px)
    const vx = 130; // px/s
    const vy = 85; // px/s
    const uniqHex = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
    const uniqAlpha = 0.08; // tek karede çok hafif
    const noiseOpacity = 0.005; // %0.5 opaklık

    const filter = [
      // 9:16: dar genişlik (ör. 1078px) ile scale=-2:1920 sonrası crop=1080 geçersiz olabiliyor; increase + crop güvenli.
      `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,scale=iw*1.07:ih*1.07,crop=1080:1920,eq=contrast=1.06:saturation=1.10:brightness=0.02,setsar=1[v0]`,
      // Unique tek kare: ilk kareye çok hafif renk katmanı (hash'i değiştirir, gözle fark edilmez)
      `color=c=#${uniqHex}@${uniqAlpha}:s=1080x1920:d=1[uniq]`,
      `[v0][uniq]overlay=0:0:enable='eq(n,0)'[v0u]`,
      // Watermark: daha saydam (aa)
      `[1:v]scale=${wmSize}:${wmSize}:force_original_aspect_ratio=decrease,format=rgba,pad=${wmSize}:${wmSize}:(ow-iw)/2:(oh-ih)/2:color=black@0,colorchannelmixer=aa=0.35[wm]`,
      `[v0u][wm]overlay=` +
        `x='abs(mod(t*${vx},2*(W-w))-(W-w))':` +
        `y='abs(mod(t*${vy},2*(H-h))-(H-h))':` +
        `format=auto[v1]`,
      // Gizli piksel katmanı (noise): çok düşük opaklıkla overlay
      `[v1]split=2[vA][vB]`,
      `[vB]noise=alls=10:allf=t+u,format=yuv420p[vN]`,
      `[vA][vN]blend=all_mode=overlay:all_opacity=${noiseOpacity},format=yuv420p[v]`
    ].join(';');

    const args = [
      '-y',
      '-i', inFile,
      '-loop', '1',
      '-i', wmFile,
      '-filter_complex', filter,
      '-map', '[v]',
      // audio olmayabilir; varsa map et + hızlandır
      '-map', '0:a?',
      '-af', `atempo=${speed}`,
      '-r', '30',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '22',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-shortest',
      outFile
    ];

    await runChild(ffmpegPath, args, { timeoutMs: 6 * 60 * 1000 });

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="crushed_${brand}_9x16.mp4"`);
    fs.createReadStream(outFile)
      .on('error', (e) => res.status(500).end(String(e && e.message ? e.message : e)))
      .on('close', () => {})
      .pipe(res)
      .on('finish', () => {});
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    console.error('/tools/crush error:', msg);
    res.status(500).json({ error: msg.slice(0, 1500) });
  } finally {
    safeUnlink(inFile);
    safeUnlink(outFile);
    try { fs.rmdirSync(tmpDir, { recursive: true }); } catch {}
  }
});

// Render YouTube bot doğrulaması durumunda: işlemi PC'de yapmak için .bat üret
app.get('/tools/crush.bat', (req, res) => {
  const url = req.query?.url;
  const brand = String(req.query?.brand || 'terapi').toLowerCase();
  if (!url) return res.status(400).send('URL gerekli');

  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').toString().split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').toString().split(',')[0].trim();
  const origin = host ? `${proto}://${host}` : '';
  const wmUrl =
    brand === 'kaos'
      ? `${origin}/watermark-kaos.png`
      : brand === 'umut'
        ? `${origin}/watermark-umut.png`
        : `${origin}/watermark-terapi.png`;

  // Not: Bu .bat, kullanıcının bilgisayarında çalışır:
  // - yt-dlp.exe indirir
  // - ffmpeg (essentials) indirir
  // - videoyu indirir, 9:16 + zoom + renk + seken watermark + 1.10x hız uygular
  const bat = `@echo off
setlocal EnableExtensions EnableDelayedExpansion

REM Viral Atölyesi - Telif Ezici (PC)

set "URL=${String(url).replace(/"/g, '""')}"
set "BRAND=${brand === 'kaos' ? 'kaos' : (brand === 'umut' ? 'umut' : 'terapi')}"
set "WM_URL=${wmUrl}"

set "WORK=%CD%\\va_crush"
if not exist "%WORK%" mkdir "%WORK%"
cd /d "%WORK%"

echo [1/4] yt-dlp indiriliyor...
powershell -NoProfile -Command "Invoke-WebRequest -Uri 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' -OutFile 'yt-dlp.exe'" || goto :err

echo [2/4] ffmpeg indiriliyor (ilk sefer biraz uzun surer)...
if not exist "ffmpeg\\bin\\ffmpeg.exe" (
  powershell -NoProfile -Command "Invoke-WebRequest -Uri 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' -OutFile 'ffmpeg.zip'" || goto :err
  powershell -NoProfile -Command "Expand-Archive -Force 'ffmpeg.zip' 'ffmpeg_tmp'" || goto :err
  for /d %%D in (ffmpeg_tmp\\ffmpeg-*) do set "FFDIR=%%D"
  if not exist "!FFDIR!\\bin\\ffmpeg.exe" goto :err
  mkdir ffmpeg
  xcopy /E /I /Y "!FFDIR!\\*" "ffmpeg\\" >nul
  rmdir /S /Q ffmpeg_tmp
  del /Q ffmpeg.zip
)

echo [3/4] watermark indiriliyor...
powershell -NoProfile -Command "Invoke-WebRequest -Uri '%WM_URL%' -OutFile 'wm.png'" || goto :err

echo [4/4] video indiriliyor...
yt-dlp.exe --no-playlist --no-check-certificate -f "best[ext=mp4][acodec!=none][vcodec!=none]/best" -o "in.%%(ext)s" "%URL%" || goto :err

REM input dosyasini bul
set "INFILE="
for %%F in (in.*) do set "INFILE=%%F"
if "%INFILE%"=="" goto :err

echo isleniyor...
set "SPEED=1.10"
set "WMSIZE=110"
set "VX=130"
set "VY=85"

set "FILTER=[0:v]scale=-2:1920,crop=1080:1920,scale=iw*1.07:ih*1.07,crop=1080:1920,eq=contrast=1.06:saturation=1.10:brightness=0.02,setsar=1[v0];[1:v]scale=%WMSIZE%:%WMSIZE%:force_original_aspect_ratio=decrease,format=rgba,colorchannelmixer=aa=0.35[wm];[v0][wm]overlay=x='abs(mod(t*%VX%,2*(W-w))-(W-w))':y='abs(mod(t*%VY%,2*(H-h))-(H-h))':format=auto[v]"

ffmpeg\\bin\\ffmpeg.exe -y -i "%INFILE%" -loop 1 -i "wm.png" -filter_complex "%FILTER%" -map "[v]" -map 0:a? -af "atempo=%SPEED%" -r 30 -c:v libx264 -preset veryfast -crf 22 -pix_fmt yuv420p -movflags +faststart -c:a aac -b:a 128k -shortest "crushed_%BRAND%_9x16.mp4" || goto :err

echo OK: %WORK%\\crushed_%BRAND%_9x16.mp4
exit /b 0

:err
echo HATA oldu. Istersen tekrar dene veya farkli video linki kullan.
exit /b 1
`;

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename="crush.bat"');
  res.send(bat);
});

function sendDownloadedFile(res, filepath) {
  const mime = guessMimeFromPath(filepath);
  const base = path.basename(filepath);
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `attachment; filename="${base.replace(/"/g, '')}"`);
  res.download(filepath, base, () => {
    fs.unlink(filepath, () => {});
  });
}

// YouTube Data API proxy (kanal istatistikleri vb.) — anahtar: query ?key= veya YOUTUBE_API_KEY
app.get('/youtube/channels', (req, res) => {
  const part = req.query.part || 'statistics';
  const id = req.query.id;
  const key = req.query.key || process.env.YOUTUBE_API_KEY;
  if (!id) return res.status(400).json({ error: 'id gerekli' });
  if (!key) return res.status(400).json({ error: 'API key gerekli' });

  const apiPath = `/youtube/v3/channels?part=${encodeURIComponent(part)}&id=${encodeURIComponent(id)}&key=${encodeURIComponent(key)}`;
  const request = https.request(
    { hostname: 'www.googleapis.com', path: apiPath, method: 'GET' },
    (upstream) => {
      let data = '';
      upstream.on('data', (chunk) => { data += chunk; });
      upstream.on('end', () => {
        const ct = upstream.headers['content-type'];
        if (ct) res.setHeader('Content-Type', ct);
        res.status(upstream.statusCode || 502).send(data);
      });
    }
  );
  request.on('error', (e) => res.status(502).json({ error: e.message }));
  request.end();
});

function proxyYoutubeV3(req, res, resource) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query)) {
    if (Array.isArray(v)) v.forEach((x) => qs.append(k, x));
    else if (v != null) qs.append(k, String(v));
  }
  const apiPath = `/youtube/v3/${resource}?${qs.toString()}`;
  const request = https.request(
    { hostname: 'www.googleapis.com', path: apiPath, method: 'GET' },
    (upstream) => {
      let data = '';
      upstream.on('data', (chunk) => { data += chunk; });
      upstream.on('end', () => {
        const ct = upstream.headers['content-type'];
        if (ct) res.setHeader('Content-Type', ct);
        res.status(upstream.statusCode || 502).send(data);
      });
    }
  );
  request.on('error', (e) => res.status(502).json({ error: e.message }));
  request.end();
}

app.get('/youtube/search', (req, res) => proxyYoutubeV3(req, res, 'search'));
app.get('/youtube/videos', (req, res) => proxyYoutubeV3(req, res, 'videos'));

function extractYoutubeVideoId(input) {
  if (!input) return null;
  const s = String(input).trim();
  const fromUrl = s.match(/(?:v=|\/embed\/|youtu\.be\/|\/shorts\/)([0-9A-Za-z_-]{11})/);
  if (fromUrl) return fromUrl[1];
  if (/^[0-9A-Za-z_-]{11}$/.test(s)) return s;
  return null;
}

// YouTube transcript (public altyazılar; video ID veya watch URL)
app.get('/youtube/transcript', async (req, res) => {
  const raw = req.query.videoId || req.query.url || req.query.v || '';
  const id = extractYoutubeVideoId(raw);
  if (!id) return res.status(400).json({ error: 'Geçerli videoId veya YouTube URL gerekli' });
  try {
    const { YoutubeTranscript } = require('youtube-transcript');
    const chunks = await YoutubeTranscript.fetchTranscript(id);
    const text = (chunks || []).map((c) => String(c.text || '').trim()).filter(Boolean).join(' ');
    if (!text) return res.json({ videoId: id, available: false, error: 'Boş transcript' });
    return res.json({ videoId: id, available: true, text, lineCount: chunks.length });
  } catch (e) {
    return res.json({ videoId: id, available: false, error: e.message || 'Transcript alınamadı' });
  }
});

// Toplu: transcript var mı (liste sıralaması için; tam metin dönmez)
app.post('/youtube/transcript/batch', async (req, res) => {
  const idsIn = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const clean = [...new Set(idsIn.map((x) => extractYoutubeVideoId(x)).filter(Boolean))].slice(0, 30);
  if (!clean.length) return res.status(400).json({ error: 'ids dizisi gerekli (max 30)' });
  let YoutubeTranscript;
  try {
    YoutubeTranscript = require('youtube-transcript').YoutubeTranscript;
  } catch (e) {
    return res.status(501).json({ error: 'youtube-transcript paketi yüklü değil' });
  }
  const results = {};
  const batch = 4;
  for (let i = 0; i < clean.length; i += batch) {
    const slice = clean.slice(i, i + batch);
    await Promise.all(
      slice.map(async (id) => {
        try {
          const chunks = await YoutubeTranscript.fetchTranscript(id);
          results[id] = { available: !!(chunks && chunks.length) };
        } catch {
          results[id] = { available: false };
        }
      })
    );
  }
  res.json({ results });
});

// Anthropic (caption) — ANTHROPIC_API_KEY sunucuda; istemci sadece bu adrese POST atar
app.post('/anthropic/messages', (req, res) => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(501).json({ error: 'Anthropic API anahtarı sunucuda tanımlı değil (ANTHROPIC_API_KEY)' });

  const body = JSON.stringify(req.body);
  const opts = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'x-api-key': key,
      'anthropic-version': '2023-06-01'
    }
  };
  const request = https.request(opts, (upstream) => {
    let data = '';
    upstream.on('data', (chunk) => { data += chunk; });
    upstream.on('end', () => {
      const ct = upstream.headers['content-type'];
      if (ct) res.setHeader('Content-Type', ct);
      res.status(upstream.statusCode || 502).send(data);
    });
  });
  request.on('error', (e) => res.status(502).json({ error: e.message }));
  request.write(body);
  request.end();
});

function tiktokRawItems(parsed) {
  if (Array.isArray(parsed)) return parsed;
  return (
    parsed.data?.item_list ||
    parsed.data?.data?.item_list ||
    parsed.item_list ||
    parsed.aweme_list ||
    parsed.data?.aweme_list ||
    parsed.data?.data?.aweme_list ||
    parsed.data?.feed ||
    parsed.feed ||
    parsed.data?.list ||
    parsed.list ||
    parsed.data?.videos ||
    parsed.data?.data?.videos ||
    parsed.items ||
    parsed.data?.items ||
    parsed.data?.data?.items ||
    []
  );
}

function tryJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function asArray(x) {
  if (Array.isArray(x)) return x;
  return [];
}

function pickFirstNonEmpty(...arrs) {
  for (const a of arrs) {
    if (Array.isArray(a) && a.length) return a;
  }
  return [];
}

function anyArrayIn(obj) {
  if (!obj || typeof obj !== 'object') return [];
  const candidates = [
    obj.items,
    obj.data?.items,
    obj.data?.data?.items,
    obj.data?.videos,
    obj.data?.data?.videos,
    obj.videos,
    obj.aweme_list,
    obj.data?.aweme_list,
    obj.data?.data?.aweme_list,
    obj.data?.item_list,
    obj.data?.data?.item_list,
    obj.item_list,
    obj.data?.feed,
    obj.feed,
    obj.data?.list,
    obj.data?.data?.list,
    obj.list,
    obj.data
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  return [];
}

function looksLikeTikTokItem(o) {
  if (!o || typeof o !== 'object') return false;
  return !!(
    o.aweme_id ||
    o.share_url ||
    o.author ||
    o.video?.play_url ||
    o.video?.download_url ||
    o.stats?.playCount
  );
}

function looksLikeInstagramItem(o) {
  if (!o || typeof o !== 'object') return false;
  const u = o.url || o.link || o.web_url;
  return !!(
    o.shortcode ||
    o.code ||
    o.media_code ||
    (typeof u === 'string' && /instagram\.com\/(reel|p)\//i.test(u)) ||
    o.video_duration ||
    o.thumbnail_url
  );
}

function deepFindItems(root, predicate, maxDepth = 4, maxNodes = 2000) {
  const out = [];
  const q = [{ v: root, d: 0 }];
  const seen = new Set();
  let nodes = 0;
  while (q.length && nodes < maxNodes) {
    const { v, d } = q.shift();
    nodes++;
    if (!v || typeof v !== 'object') continue;
    if (seen.has(v)) continue;
    seen.add(v);
    if (Array.isArray(v)) {
      // If this array itself looks like items array, return it fast
      let hit = 0;
      for (let i = 0; i < Math.min(v.length, 10); i++) if (predicate(v[i])) hit++;
      if (hit >= 2) return v;
      if (d < maxDepth) for (const it of v) q.push({ v: it, d: d + 1 });
      continue;
    }
    if (d >= maxDepth) continue;
    for (const val of Object.values(v)) q.push({ v: val, d: d + 1 });
  }
  return out;
}

function applyPathTemplate(tpl, vars) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(vars[k] ?? ''));
}

function mapToVideoList(items, platform) {
  return asArray(items)
    .map((item, idx) => {
      if (!item || typeof item !== 'object') return null;
      const urlStr =
        item.url ||
        item.share_url ||
        item.shareUrl ||
        item.web_url ||
        item.link ||
        item.video_url ||
        item.play_url ||
        item.download_url ||
        item.video?.play_url ||
        item.video?.download_url ||
        item.video?.url ||
        item.video?.playUrl ||
        item.video?.downloadUrl ||
        '';

      const idVal = item.id || item.aweme_id || item.video_id || item.shortcode || item.code || idx;
      const title = item.desc || item.title || item.caption || item.text || (platform === 'tiktok' ? 'TikTok Video' : 'Instagram Reels');
      const channel = item.author?.uniqueId || item.author?.unique_id || item.user?.username || item.owner?.username || '';
      const thumb =
        item.thumb ||
        item.thumbnail ||
        item.cover ||
        item.video?.cover ||
        item.video?.originCover ||
        item.image_versions2?.candidates?.[0]?.url ||
        item.thumbnail_url ||
        '';

      let finalUrl = urlStr;
      if (!finalUrl && platform === 'tiktok') {
        const uid = channel || 'user';
        const vid = idVal;
        if (uid && vid) finalUrl = `https://www.tiktok.com/@${uid}/video/${vid}`;
      }
      if (!finalUrl && platform === 'instagram') {
        const codeFromUrl = typeof urlStr === 'string' ? ((urlStr.match(/reel\/([^/?#]+)/i) || [])[1]) : null;
        const code = item.code || item.shortcode || item.media_code || codeFromUrl;
        if (code) finalUrl = `https://www.instagram.com/reel/${code}/`;
      }
      if (!finalUrl) return null;

      return {
        id: String(idVal),
        title,
        channel,
        duration: item.video?.duration || item.duration || item.video_duration || 0,
        views: item.stats?.playCount || item.stats?.play_count || item.view_count || item.play_count || 0,
        likes: item.stats?.diggCount || item.stats?.digg_count || item.like_count || 0,
        thumb,
        url: finalUrl,
        platform
      };
    })
    .filter(Boolean)
    .filter((v) => v.url);
}

function rapidApiGet(hostname, path, cb) {
  const options = {
    method: 'GET',
    hostname,
    path,
    headers: {
      'x-rapidapi-key': RAPIDAPI_KEY,
      'x-rapidapi-host': hostname
    }
  };
  const request = https.request(options, (response) => {
    let data = '';
    response.on('data', (chunk) => { data += chunk; });
    response.on('end', () => cb(null, response.statusCode || 0, data, response.headers || {}));
  });
  request.on('error', (e) => cb(e));
  request.end();
}

// TikTok arama - RapidAPI
app.get('/search/tiktok', (req, res) => {
  if (!RAPIDAPI_KEY) return res.status(503).json({ error: 'RAPIDAPI_KEY tanımlı değil' });
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: 'Sorgu gerekli' });

  const cacheKey = `tiktok:${String(query).toLowerCase().trim()}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);

  // Auto-adapter: birden fazla RapidAPI sağlayıcısını dener.
  const q = String(query || '').trim().replace(/^@+/, '');
  const envHost = (process.env.RAPIDAPI_TIKTOK_HOST || '').trim();
  const envHostIsScraper7 = envHost && /tiktok-scraper7\.p\.rapidapi\.com/i.test(envHost);
  const envPathTpl = (process.env.RAPIDAPI_TIKTOK_PATH_TEMPLATE || '').trim(); // e.g. /feed/list?region=TR&count=30  OR /user/{q}

  const providers = [
    // 1) Env ile verilen host (senin aboneliğin)
    ...(envHost
      ? [
          {
            name: 'env-host',
            host: envHost,
            path: envPathTpl
              ? applyPathTemplate(envPathTpl, { q })
              : (envHostIsScraper7 ? '/feed/list?region=TR&count=30' : `/user/${encodeURIComponent(q)}`)
          }
        ]
      : []),

    // 2) TikTok scraper7 — RapidAPI playground: GET /feed/list?region=...&count=...
    { name: 'tiktok-scraper7', host: 'tiktok-scraper7.p.rapidapi.com', path: '/feed/list?region=TR&count=30' },

    // 3) Downloader API (bazı hesaplarda user endpoint olabilir)
    { name: 'tiktok-video-downloader-api', host: 'tiktok-video-downloader-api.p.rapidapi.com', path: `/user/${encodeURIComponent(q)}` }
  ];

  (function next(i, lastErr) {
    if (i >= providers.length) {
      return res.status(502).json({ error: lastErr || 'TikTok: Uygun RapidAPI endpoint bulunamadı (abonelik/host).' });
    }
    const p = providers[i];
    rapidApiGet(p.host, p.path, (err, status, body) => {
      if (err) return next(i + 1, `TikTok ${p.name} hata: ${err.message}`);
      if (status >= 400) {
        const msg = String(body || '');
        if (/not subscribed/i.test(msg) || /You are not subscribed/i.test(msg)) {
          return next(i + 1, `TikTok ${p.name}: RapidAPI aboneliği yok veya plan yetersiz.`);
        }
        if (status === 429) {
          return res.status(429).json({ error: `TikTok ${p.name}: 429 Too Many Requests (RapidAPI limit). Birkaç dakika sonra tekrar dene.` });
        }
        return next(i + 1, `TikTok ${p.name} upstream HTTP ${status}: ${msg.slice(0, 400)}`);
      }
      const parsed = tryJsonParse(body) || {};
      const items = pickFirstNonEmpty(
        anyArrayIn(parsed),
        tiktokRawItems(parsed),
        deepFindItems(parsed, looksLikeTikTokItem)
      );
      const videos = mapToVideoList(items, 'tiktok');
      if (videos.length) {
        cacheSet(cacheKey, videos);
        return res.json(videos);
      }
      // Eğer env-host tiktok-scraper7 ise downloader'a düşmek çoğu zaman yanıltıcı; direkt net hata ver.
      if (p.name === 'env-host' && envHostIsScraper7) {
        return res.status(502).json({
          error:
            `TikTok ${p.name}: boş sonuç (yanıt formatı farklı). ` +
            `RAPIDAPI_TIKTOK_PATH_TEMPLATE ayarlayıp (RapidAPI playground'daki path) tekrar dene.`
        });
      }
      return next(i + 1, `TikTok ${p.name}: boş sonuç (yanıt formatı farklı olabilir).`);
    });
  })(0, '');
});

function instagramRawItems(parsed) {
  return parsed.data?.items || parsed.items || parsed.data?.media || parsed.media || [];
}

function isIgVideo(item) {
  if (item.media_type === 2) return true;
  if (item.type === 'VIDEO' || item.media_type === 'VIDEO') return true;
  if (item.video_versions || item.video_duration) return true;
  return false;
}

// Instagram arama - RapidAPI
app.get('/search/instagram', (req, res) => {
  if (!RAPIDAPI_KEY) return res.status(503).json({ error: 'RAPIDAPI_KEY tanımlı değil' });
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: 'Sorgu gerekli' });

  const cacheKey = `ig:${String(query).toLowerCase().trim()}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);

  const host = (process.env.RAPIDAPI_INSTAGRAM_HOST || 'instagram-scraper-api2.p.rapidapi.com').trim();
  const tag = String(query).trim().replace(/^#/, '');
  const envPathTpl = (process.env.RAPIDAPI_INSTAGRAM_PATH_TEMPLATE || '').trim(); // e.g. /v1/hashtag?hashtag={tag}

  // RapidAPI'de IG sağlayıcıları path/param isimlerini çok değiştiriyor.
  // Bu yüzden yaygın kombinasyonları sırayla deneriz ve "array yakalayıp" map'leriz.
  const providers = [
    ...(envPathTpl ? [{ name: 'env-path', host, path: applyPathTemplate(envPathTpl, { tag }) }] : []),
    // v1 style
    { name: 'v1-hashtag-hashtag', host, path: `/v1/hashtag?hashtag=${encodeURIComponent(tag)}` },
    { name: 'v1-hashtag-tag', host, path: `/v1/hashtag?tag=${encodeURIComponent(tag)}` },
    // stable api'lerde bazen /hashtag veya /hashtag/posts olur
    { name: 'hashtag-hashtag', host, path: `/hashtag?hashtag=${encodeURIComponent(tag)}` },
    { name: 'hashtag-tag', host, path: `/hashtag?tag=${encodeURIComponent(tag)}` },
    { name: 'hashtag-posts', host, path: `/hashtag/posts?hashtag=${encodeURIComponent(tag)}` },
    { name: 'hashtag-feed', host, path: `/hashtag/feed?hashtag=${encodeURIComponent(tag)}` },
    { name: 'hashtag-path', host, path: `/hashtag/${encodeURIComponent(tag)}` },
    // generic query param
    { name: 'search-q', host, path: `/search?query=${encodeURIComponent(tag)}` },
    { name: 'search-q2', host, path: `/search?q=${encodeURIComponent(tag)}` }
  ];

  (function next(i, lastErr) {
    if (i >= providers.length) {
      return res.status(502).json({ error: lastErr || 'Instagram: Uygun RapidAPI endpoint bulunamadı (abonelik/host).' });
    }
    const p = providers[i];
    rapidApiGet(p.host, p.path, (err, status, body, headers) => {
      if (err) return next(i + 1, `Instagram ${p.name} hata: ${err.message}`);
      if (status >= 400) {
        const msg = String(body || '');
        if (/not subscribed/i.test(msg) || /You are not subscribed/i.test(msg)) {
          return next(i + 1, `Instagram ${p.name}: RapidAPI aboneliği yok veya plan yetersiz.`);
        }
        if (status === 429) {
          const ra = headers && (headers['retry-after'] || headers['Retry-After']);
          return res.status(429).json({
            error: `Instagram ${p.name}: 429 Too Many Requests (RapidAPI limit). ${ra ? `Retry-After: ${ra}` : 'Biraz bekleyip tekrar dene.'}`
          });
        }
        return next(i + 1, `Instagram ${p.name} upstream HTTP ${status}: ${msg.slice(0, 400)}`);
      }
      const parsed = tryJsonParse(body) || {};
      const items = pickFirstNonEmpty(
        anyArrayIn(parsed),
        instagramRawItems(parsed),
        deepFindItems(parsed, looksLikeInstagramItem)
      );
      const mapped = mapToVideoList(items, 'instagram');
      if (mapped.length) {
        cacheSet(cacheKey, mapped);
        return res.json(mapped);
      }
      return next(i + 1, `Instagram ${p.name}: boş sonuç (yanıt formatı farklı olabilir).`);
    });
  })(0, '');
});

// Uyku modu engelleme
app.get('/ping', (req, res) => { res.json({ status: 'alive' }); });

app.get('/status', (req, res) => {
  res.json({
    status: 'Viral Atölyesi Sunucu Çalışıyor!',
    cookies: {
      yt: cookieFileInfo(COOKIES_PATH),
      tt: cookieFileInfo(COOKIES_TIKTOK_PATH),
      ig: cookieFileInfo(COOKIES_INSTAGRAM_PATH)
    },
    env: {
      yt: !!process.env.YT_COOKIES_B64,
      tt: !!process.env.TT_COOKIES_B64,
      ig: !!process.env.IG_COOKIES_B64
    },
    youtubeCookieSource: {
      secretFile: fs.existsSync(YT_COOKIES_SECRET),
      resolved: resolveYoutubeCookieFile() ? 'ok' : 'missing'
    },
    rapidapi: {
      keySet: !!process.env.RAPIDAPI_KEY,
      tiktokHost: process.env.RAPIDAPI_TIKTOK_HOST || 'tiktok-video-downloader-api.p.rapidapi.com (default)',
      instagramHost: process.env.RAPIDAPI_INSTAGRAM_HOST || 'instagram-scraper-api2.p.rapidapi.com (default)',
      tiktokPathTemplateSet: !!process.env.RAPIDAPI_TIKTOK_PATH_TEMPLATE,
      instagramPathTemplateSet: !!process.env.RAPIDAPI_INSTAGRAM_PATH_TEMPLATE
    }
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

const PORT = process.env.PORT || 3000;

// Cookies'leri repoya koymak yerine Render ENV üzerinden ver.
// Render Dashboard -> Environment:
// - YT_COOKIES_B64 : base64(Netscape cookies.txt)
// - TT_COOKIES_B64 : base64(...)
// - IG_COOKIES_B64 : base64(...)
ensureCookieFileFromEnv('YT_COOKIES_B64', COOKIES_PATH);
ensureCookieFileFromEnv('TT_COOKIES_B64', COOKIES_TIKTOK_PATH);
ensureCookieFileFromEnv('IG_COOKIES_B64', COOKIES_INSTAGRAM_PATH);

console.log('Cookie files:', {
  yt: cookieFileInfo(COOKIES_PATH),
  tt: cookieFileInfo(COOKIES_TIKTOK_PATH),
  ig: cookieFileInfo(COOKIES_INSTAGRAM_PATH),
  yt_env: !!process.env.YT_COOKIES_B64,
  tt_env: !!process.env.TT_COOKIES_B64,
  ig_env: !!process.env.IG_COOKIES_B64
});

// ÖNEMLİ: Önce dinlemeye başla. yt-dlp indirmesi Render health check'ten önce bitmeyebilir;
// listen gecikirse deploy "Failed" görünür (/ping yanıt vermez).
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Sunucu ${PORT} portunda çalışıyor`);
});

installYtDlp().then(() => {
  console.log('yt-dlp hazır:', YTDLP_PATH);
});
