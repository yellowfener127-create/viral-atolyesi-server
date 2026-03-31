const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const os = require('os');

const app = express();
app.use(cors({ exposedHeaders: ['Content-Disposition'] }));
app.use(express.json({ limit: '1mb' }));

const YTDLP_PATH = path.join(__dirname, 'yt-dlp');
const COOKIES_PATH = path.join(__dirname, 'www.youtube.com_cookies.txt');
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;

function installYtDlp() {
  return new Promise((resolve) => {
    if (fs.existsSync(YTDLP_PATH)) return resolve();
    exec(`curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o ${YTDLP_PATH} && chmod +x ${YTDLP_PATH}`, (err) => resolve());
  });
}

// YouTube indirme
app.all('/download', (req, res) => {
  const url = req.query?.url || req.body?.url || req.body?.videoUrl || req.body?.link;
  if (!url) return res.status(400).json({ error: 'URL gerekli' });

  const filename = `video_${Date.now()}.mp4`;
  const filepath = path.join(os.tmpdir(), filename);
  const cookieFlag = fs.existsSync(COOKIES_PATH) ? `--cookies "${COOKIES_PATH}"` : '';
  const cmd = `${YTDLP_PATH} ${cookieFlag} --no-check-certificate -f "best[ext=mp4][height<=720]/best[ext=mp4]/best" --no-playlist -o "${filepath}" "${url}"`;

  exec(cmd, { timeout: 180000 }, (error, stdout, stderr) => {
    if (error) return res.status(500).json({ error: 'İndirme hatası: ' + (stderr || error.message) });
    if (!fs.existsSync(filepath)) return res.status(500).json({ error: 'Dosya oluşturulamadı' });

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="video.mp4"`);

    res.download(filepath, 'video.mp4', () => {
      fs.unlink(filepath, () => {});
    });
  });
});

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

// TikTok arama - RapidAPI
app.get('/search/tiktok', (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: 'Sorgu gerekli' });

  const options = {
    method: 'GET',
    hostname: 'tiktok-scraper7.p.rapidapi.com',
    path: '/trending/feed?region=TR&count=20',
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
        const parsed = JSON.parse(data);
        const items = parsed.data?.item_list || parsed.item_list || [];
        const videos = items.map(item => ({
          id: item.id,
          title: item.desc || 'TikTok Video',
          duration: item.video?.duration || 0,
          views: item.stats?.playCount || 0,
          likes: item.stats?.diggCount || 0,
          thumb: item.video?.cover || '',
          url: `https://www.tiktok.com/@${item.author?.uniqueId}/video/${item.id}`,
          platform: 'tiktok'
        })).filter(v => v.duration >= 1 && v.duration <= 70 && v.views >= 50000);
        res.json(videos);
      } catch(e) {
        res.status(500).json({ error: 'TikTok parse hatası: ' + e.message });
      }
    });
  });

  request.on('error', (e) => {
    res.status(500).json({ error: 'TikTok arama hatası: ' + e.message });
  });
  request.end();
});

// Instagram arama - RapidAPI
app.get('/search/instagram', (req, res) => {
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
        const parsed = JSON.parse(data);
        const items = parsed.data?.items || [];
        const videos = items
          .filter(item => item.media_type === 2)
          .map(item => ({
            id: item.id,
            title: item.caption?.text || 'Instagram Reels',
            duration: item.video_duration || 0,
            views: item.view_count || item.play_count || 0,
            likes: item.like_count || 0,
            thumb: item.image_versions2?.candidates?.[0]?.url || '',
            url: `https://www.instagram.com/reel/${item.code}/`,
            platform: 'instagram'
          })).filter(v => v.duration >= 1 && v.duration <= 70);
        res.json(videos);
      } catch(e) {
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

const HALK_DIR = path.join(__dirname, 'halk');
app.use(express.static(HALK_DIR));

app.get('*', (req, res) => {
  res.sendFile(path.join(HALK_DIR, 'index.html'));
});

const PORT = process.env.PORT || 3000;
installYtDlp().then(() => {
  app.listen(PORT, () => console.log(`Sunucu ${PORT} portunda çalışıyor`));
});
