const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const os = require('os');

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

function installYtDlp() {
  return new Promise((resolve) => {
    exec(
      `curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o "${YTDLP_PATH}" && chmod +x "${YTDLP_PATH}"`,
      () => resolve()
    );
  });
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

  const cookieFlag = cookieFile && fs.existsSync(cookieFile) ? `--cookies "${cookieFile}"` : '';
  const ytAndroid = isYt ? ' --extractor-args "youtube:player_client=android"' : '';
  const execOpts = { timeout: 300000, maxBuffer: 12 * 1024 * 1024 };
  // YouTube'da bazen progressive mp4 yok; önce mp4 dener, yoksa best'e düşer.
  const format = isYt ? 'best[ext=mp4]/best' : 'best';

  const outBase1 = path.join(os.tmpdir(), `va_${Date.now()}_a`);
  const cmd1 = `"${YTDLP_PATH}" ${cookieFlag} --no-check-certificate --no-playlist${ytAndroid} -f "${format}" -o "${outBase1}.%(ext)s" "${url}"`;

  exec(cmd1, execOpts, (err1, so1, se1) => {
    let filepath = findYtDlpOutput(outBase1);
    if (filepath && fs.existsSync(filepath)) return sendDownloadedFile(res, filepath);

    const outBase2 = path.join(os.tmpdir(), `va_${Date.now()}_b`);
    const ytWeb = isYt ? ' --extractor-args "youtube:player_client=web"' : '';
    const cmd2 = `"${YTDLP_PATH}" ${cookieFlag} --no-check-certificate --no-playlist${ytWeb} -f "${format}" -o "${outBase2}.%(ext)s" "${url}"`;

    exec(cmd2, execOpts, (err2, so2, se2) => {
      filepath = findYtDlpOutput(outBase2);
      if (filepath && fs.existsSync(filepath)) return sendDownloadedFile(res, filepath);

      const outBase3 = path.join(os.tmpdir(), `va_${Date.now()}_c`);
      // Son çare: herhangi bir format (YouTube'da mp4 şartını kaldır)
      const lastFormat = isYt ? 'best' : format;
      const cmd3 = `"${YTDLP_PATH}" ${cookieFlag} --no-check-certificate --no-playlist -f "${lastFormat}" -o "${outBase3}.%(ext)s" "${url}"`;
      exec(cmd3, execOpts, (err3, so3, se3) => {
        filepath = findYtDlpOutput(outBase3);
        if (filepath && fs.existsSync(filepath)) return sendDownloadedFile(res, filepath);
        const msg = se3 || se2 || se1 || err3?.message || err2?.message || err1?.message || 'Dosya oluşturulamadı';
        console.error('yt-dlp download failed:', msg);
        res.status(500).json({ error: 'İndirme hatası: ' + msg });
      });
    });
  });
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
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Sunucu ${PORT} portunda çalışıyor`);
  });
});
