const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');

const app = express();
app.use(cors());

const YTDLP_PATH = path.join(__dirname, 'yt-dlp');
const COOKIES_PATH = path.join(__dirname, 'youtube.com_cookies.txt');
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;

function installYtDlp() {
  return new Promise((resolve) => {
    if (fs.existsSync(YTDLP_PATH)) return resolve();
    exec(`curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o ${YTDLP_PATH} && chmod +x ${YTDLP_PATH}`, (err) => resolve());
  });
}

// YouTube indirme
app.get('/download', (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'URL gerekli' });
  const filename = `video_${Date.now()}.mp4`;
  const filepath = path.join('/tmp', filename);
  const cookieFlag = fs.existsSync(COOKIES_PATH) ? `--cookies "${COOKIES_PATH}"` : '';
  const cmd = `${YTDLP_PATH} ${cookieFlag} --no-check-certificate -f "best[ext=mp4][height<=720]/best[ext=mp4]/best" --no-playlist -o "${filepath}" "${url}"`;
  exec(cmd, { timeout: 180000 }, (error, stdout, stderr) => {
    if (error) return res.status(500).json({ error: 'İndirme hatası: ' + stderr });
    if (!fs.existsSync(filepath)) return res.status(500).json({ error: 'Dosya oluşturulamadı' });
    res.download(filepath, 'video.mp4', (err) => { fs.unlink(filepath, () => {}); });
  });
});

// TikTok arama - RapidAPI
app.get('/search/tiktok', (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: 'Sorgu gerekli' });

  const options = {
    method: 'GET',
    hostname: 'tiktok-api23.p.rapidapi.com',
    path: `/api/search/general?keyword=${encodeURIComponent(query)}&count=20&cursor=0`,
    headers: {
      'x-rapidapi-key': RAPIDAPI_KEY,
      'x-rapidapi-host': 'tiktok-api23.p.rapidapi.com'
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

app.get('/', (req, res) => { res.json({ status: 'Viral Atölyesi Sunucu Çalışıyor!' }); });

const PORT = process.env.PORT || 3000;
installYtDlp().then(() => {
  app.listen(PORT, () => console.log(`Sunucu ${PORT} portunda çalışıyor`));
});
