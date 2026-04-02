const express = require('express');
const cors = require('cors');
const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const os = require('os');
const { pipeline } = require('stream/promises');

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

const YTDLP_PATH = path.join(__dirname, 'yt-dlp');
const COOKIES_PATH = path.join(__dirname, 'www.youtube.com_cookies.txt');
const COOKIES_TIKTOK_PATH = path.join(__dirname, 'www.tiktok.com_cookies.txt');
const COOKIES_INSTAGRAM_PATH = path.join(__dirname, 'www.instagram.com_cookies.txt');
// Render tarafında env set edilmese bile çalışabilsin diye fallback ekliyoruz.
// Not: Bu key'i herkese açık repoya koyma; sadece kullandığın deploy ortamında kullan.
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || 'fa585a7e00mshd7e15329a3e4fe2p17ec23jsn54ade22ae56f';
const PUBLIC_DIR = path.join(__dirname, 'public');

function ensureCookieFileFromEnv(envName, filePath) {
  const b64 = process.env[envName];
  if (!b64) return;
  try {
    const decoded = Buffer.from(String(b64), 'base64').toString('utf8');
    if (!decoded || decoded.length < 50) return;
    fs.writeFileSync(filePath, decoded, { encoding: 'utf8' });
  } catch (e) {
    console.error(`ensureCookieFileFromEnv failed (${envName}):`, e && e.message ? e.message : e);
  }
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
  const startUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

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
      fs.chmodSync(YTDLP_PATH, 0o755);
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

async function attemptStreamToResponse(res, url, { cookieFile, format, extraArgs, filenameHint, forceExt } = {}) {
  const args = buildYtDlpArgs(url, { cookieFile, format, extraArgs });
  const base = safeFilename(filenameHint || 'video');
  const extGuess = forceExt || ((format && /mp4/i.test(format)) ? 'mp4' : 'bin');
  const downloadName = `${base}.${extGuess}`;

  return await new Promise((resolve) => {
    const child = spawn(YTDLP_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let started = false;

    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 80_000) stderr = stderr.slice(-80_000);
    });

    child.on('error', (e) => {
      resolve({ ok: false, started: false, stderr: 'yt-dlp spawn hatası: ' + e.message });
    });

    child.stdout.once('data', (chunk) => {
      started = true;
      res.setHeader('Content-Type', extGuess === 'mp4' ? 'video/mp4' : 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${downloadName.replace(/"/g, '')}"`);
      res.flushHeaders?.();
      res.write(chunk);
      child.stdout.pipe(res);
      resolve({ ok: true, started: true, stderr: '' });
    });

    child.on('close', (code) => {
      if (started) {
        if (code !== 0) console.error('yt-dlp stream failed:', stderr || `exit ${code}`);
        try { res.end(); } catch {}
        return;
      }
      if (code === 0) return resolve({ ok: false, started: false, stderr: 'Boş çıktı (0 byte)' });
      resolve({ ok: false, started: false, stderr: stderr || `exit ${code}` });
    });
  });
}

// YouTube / TikTok / Instagram indirme (yt-dlp; ffmpeg gerekmez — tek parça "best")
app.all('/download', (req, res) => {
  const url = req.query?.url || req.body?.url || req.body?.videoUrl || req.body?.link;
  if (!url) return res.status(400).json({ error: 'URL gerekli' });

  const isYt = /youtube\.com|youtu\.be/i.test(url);
  const isTiktok = /tiktok\.com/i.test(url);
  const isInstagram = /instagram\.com|instagr\.am/i.test(url);

  let cookieFile = null;
  if (isYt) cookieFile = COOKIES_PATH;
  else if (isTiktok) cookieFile = COOKIES_TIKTOK_PATH;
  else if (isInstagram) cookieFile = COOKIES_INSTAGRAM_PATH;

  // Render 502 sebebi genelde: indirme tamamlanana kadar response boş kalıyor ve proxy timeout oluyor.
  // Çözüm: yt-dlp çıktısını doğrudan response'a stream et (ilk byte hemen gitsin).
  const ytNetArgs = isYt
    ? [
        '--geo-bypass',
        '--force-ipv4',
        '--referer',
        'https://www.youtube.com/',
        '--user-agent',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
      ]
    : [];

  if (isYt) {
    (async () => {
      const hasCookies = !!(cookieFile && fs.existsSync(cookieFile));
      // Cookies varsa android client cookie desteklemediği için WEB kullan.
      const ytClient = hasCookies ? 'youtube:player_client=web' : 'youtube:player_client=android';
      const baseArgs = ['--extractor-args', ytClient, ...ytNetArgs];

      // 1) Progressive MP4 (ses+video aynı dosya) dene
      let r = await attemptStreamToResponse(res, url, {
        cookieFile,
        format: 'best[ext=mp4][acodec!=none][vcodec!=none]/best[acodec!=none][vcodec!=none]',
        extraArgs: baseArgs,
        filenameHint: 'youtube_video',
        forceExt: 'mp4'
      });
      if (r.ok) return;

      // 2) Web client bazen bot/consent sayfasına takılır. iOS client çoğu zaman daha stabil.
      // Cookies varsa iOS + cookies dene (android cookies desteklemiyor ama iOS destekler).
      r = await attemptStreamToResponse(res, url, {
        cookieFile: hasCookies ? cookieFile : null,
        format: 'best[ext=mp4][acodec!=none][vcodec!=none]/best[acodec!=none][vcodec!=none]',
        extraArgs: ['--extractor-args', 'youtube:player_client=ios', ...ytNetArgs],
        filenameHint: 'youtube_video',
        forceExt: 'mp4'
      });
      if (r.ok) return;

      // 2) MP4 yoksa: best (webm vs) — en azından video insin
      r = await attemptStreamToResponse(res, url, {
        cookieFile,
        format: 'best',
        extraArgs: baseArgs,
        filenameHint: 'youtube_video'
      });
      if (r.ok) return;

      // 3) Son çare: cookies kapalı + android client + best (bazı videolarda web blocked iken çalışır)
      r = await attemptStreamToResponse(res, url, {
        cookieFile: null,
        format: 'best',
        extraArgs: ['--extractor-args', 'youtube:player_client=android', ...ytNetArgs],
        filenameHint: 'youtube_video'
      });
      if (r.ok) return;

      const errText = String(r.stderr || '');
      console.error('yt-dlp download failed:', errText);
      if (/confirm you're not a bot|sign in|cookies-from-browser/i.test(errText)) {
        return res.status(403).json({
          error:
            'YouTube indirme engellendi (bot doğrulaması / giriş gerekiyor). ' +
            'Çözüm: `www.youtube.com_cookies.txt` dosyasını güncelle (Chrome’dan export, Netscape format) ve tekrar dene.'
        });
      }
      res.status(500).json({ error: 'İndirme hatası: ' + errText });
    })();
    return;
  }

  (async () => {
    const r = await attemptStreamToResponse(res, url, {
      cookieFile,
      format: 'best',
      extraArgs: ytNetArgs,
      filenameHint: (isTiktok ? 'tiktok_video' : isInstagram ? 'instagram_video' : 'video')
    });
    if (r.ok) return;
    console.error('yt-dlp download failed:', r.stderr);
    res.status(500).json({ error: 'İndirme hatası: ' + r.stderr });
  })();
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
    parsed.item_list ||
    parsed.aweme_list ||
    parsed.data?.aweme_list ||
    parsed.items ||
    parsed.data?.items ||
    []
  );
}

// TikTok arama - RapidAPI
app.get('/search/tiktok', (req, res) => {
  if (!RAPIDAPI_KEY) return res.status(503).json({ error: 'RAPIDAPI_KEY tanımlı değil' });
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: 'Sorgu gerekli' });

  const options = {
    method: 'GET',
    hostname: 'tiktok-scraper7.p.rapidapi.com',
    path: '/trending/feed?region=TR&count=30',
    headers: {
      'x-rapidapi-key': RAPIDAPI_KEY,
      'x-rapidapi-host': 'tiktok-scraper7.p.rapidapi.com'
    }
  };

  const request = https.request(options, (response) => {
    let data = '';
    response.on('data', (chunk) => { data += chunk; });
    response.on('end', () => {
      try {
        if (response.statusCode && response.statusCode >= 400) {
          // RapidAPI abonelik/plan hatalarını kullanıcıya net göster
          const msg = String(data || '');
          if (/not subscribed/i.test(msg) || /You are not subscribed/i.test(msg)) {
            return res.status(402).json({
              error: 'TikTok API aboneliği yok. RapidAPI panelinden bu API’ye Subscribe olmalısın (tiktok-scraper7).'
            });
          }
          return res.status(response.statusCode).json({ error: 'TikTok upstream hata: ' + data });
        }
        const parsed = JSON.parse(data);
        const items = tiktokRawItems(parsed);
        const videos = items
          .map((item, idx) => {
            const uid = item.author?.uniqueId || item.author?.unique_id || 'user';
            const vidCandidates = [
              item.id,
              item.aweme_id,
              item.video?.id,
              item.video_id,
              item.video?.video_id,
              item.stats?.videoId,
              item.stats?.video_id,
              item.aweme?.id,
              idx
            ].filter(Boolean);

            const vid = vidCandidates[0];

            const directUrl =
              item.url ||
              item.share_url ||
              item.shareUrl ||
              item.web_url ||
              item.link ||
              item.video?.url ||
              item.video?.play_url ||
              item.video?.download_url ||
              item.play_url ||
              item.download_url ||
              '';

            const computedUrl = uid && vid ? `https://www.tiktok.com/@${uid}/video/${vid}` : null;
            const finalUrl = directUrl || computedUrl;
            if (!finalUrl) return null;

            const idVal = vid || idx;
            return {
              id: String(idVal),
              title: item.desc || item.title || item.caption || 'TikTok Video',
              channel: uid,
              duration: item.video?.duration || item.duration || 0,
              views: item.stats?.playCount || item.stats?.play_count || item.play_count || 0,
              likes: item.stats?.diggCount || item.stats?.digg_count || 0,
              thumb: item.video?.cover || item.video?.originCover || item.cover || item.video?.originCoverUrl || '',
              url: finalUrl,
              platform: 'tiktok'
            };
          })
          .filter(Boolean)
          .filter((v) => v && v.url);
        res.json(videos);
      } catch (e) {
        res.status(500).json({ error: 'TikTok parse hatası: ' + e.message });
      }
    });
  });

  request.on('error', (e) => {
    res.status(500).json({ error: 'TikTok arama hatası: ' + e.message });
  });
  request.end();
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

  const options = {
    method: 'GET',
    hostname: 'instagram-scraper-api2.p.rapidapi.com',
    path: `/v1/hashtag?hashtag=${encodeURIComponent(query)}`,
    headers: {
      'x-rapidapi-key': RAPIDAPI_KEY,
      'x-rapidapi-host': 'instagram-scraper-api2.p.rapidapi.com'
    }
  };

  const request = https.request(options, (response) => {
    let data = '';
    response.on('data', (chunk) => { data += chunk; });
    response.on('end', () => {
      try {
        if (response.statusCode && response.statusCode >= 400) {
          return res.status(response.statusCode).json({ error: 'Instagram upstream hata: ' + data });
        }
        const parsed = JSON.parse(data);
        const items = instagramRawItems(parsed);
        const videos = items
          .map((item) => {
            const urlStr = item.url || item.link || item.web_url || '';
            const codeFromUrl = typeof urlStr === 'string' ? ((urlStr.match(/reel\/([^/?#]+)/i) || [])[1]) : null;
            const code = item.code || item.shortcode || item.media_code || codeFromUrl;
            if (!code) return null;
            const finalUrl = (typeof urlStr === 'string' && urlStr.includes('instagram.com'))
              ? urlStr
              : `https://www.instagram.com/reel/${code}/`;
            return {
              id: String(item.id || code),
              title: typeof item.caption === 'string' ? item.caption : (item.caption?.text || item.caption?.text?.value || 'Instagram Reels'),
              channel: item.user?.username || item.owner?.username || '',
              duration: item.video_duration || 0,
              views: item.view_count || item.play_count || item.video_view_count || 0,
              likes: item.like_count || 0,
              thumb: item.image_versions2?.candidates?.[0]?.url || item.thumbnail_url || '',
              url: finalUrl,
              platform: 'instagram'
            };
          })
          .filter(Boolean)
          .filter((v) => v && v.url);
        res.json(videos);
      } catch (e) {
        res.status(500).json({ error: 'Instagram parse hatası: ' + e.message });
      }
    });
  });

  request.on('error', (e) => {
    res.status(500).json({ error: 'Instagram arama hatası: ' + e.message });
  });
  request.end();
});

// Uyku modu engelleme
app.get('/ping', (req, res) => { res.json({ status: 'alive' }); });

app.get('/status', (req, res) => {
  res.json({ status: 'Viral Atölyesi Sunucu Çalışıyor!' });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

const PORT = process.env.PORT || 3000;
installYtDlp().then(() => {
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

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Sunucu ${PORT} portunda çalışıyor`);
  });
});
