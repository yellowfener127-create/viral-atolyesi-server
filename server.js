const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());

const YTDLP_PATH = path.join(__dirname, 'yt-dlp');
const COOKIES_PATH = path.join(__dirname, 'youtube.com_cookies.txt');

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

// TikTok arama
app.get('/search/tiktok', (req, res) => {
  const query = req.query.q;
  const limit = req.query.limit || 20;
  if (!query) return res.status(400).json({ error: 'Sorgu gerekli' });

  const cmd = `${YTDLP_PATH} --cookies "${path.join(__dirname, 'tiktok.com_cookies.txt')}" "https://www.tiktok.com/search/video?q=${encodeURIComponent(query)}" --flat-playlist --print "%(id)s|%(title)s|%(duration)s|%(view_count)s|%(like_count)s|%(thumbnail)s|%(webpage_url)s" --playlist-end ${limit} --no-warnings 2>/dev/null`;

  exec(cmd, { timeout: 60000 }, (error, stdout, stderr) => {
    if (error) return res.status(500).json({ error: 'TikTok arama hatası' });
    const videos = stdout.trim().split('\n').filter(Boolean).map(line => {
      const [id, title, duration, views, likes, thumb, url] = line.split('|');
      return { id, title, duration: parseInt(duration)||0, views: parseInt(views)||0, likes: parseInt(likes)||0, thumb, url, platform: 'tiktok' };
    }).filter(v => v.duration >= 1 && v.duration <= 70 && v.views >= 50000);
    res.json(videos);
  });
});

// Instagram Reels arama
app.get('/search/instagram', (req, res) => {
  const query = req.query.q;
  const limit = req.query.limit || 20;
  if (!query) return res.status(400).json({ error: 'Sorgu gerekli' });

  const cmd = `${YTDLP_PATH} --cookies "${path.join(__dirname, 'instagram.com_cookies.txt')}" "https://www.instagram.com/explore/tags/${encodeURIComponent(query)}/" --flat-playlist --print "%(id)s|%(title)s|%(duration)s|%(view_count)s|%(like_count)s|%(thumbnail)s|%(webpage_url)s" --playlist-end ${limit} --no-warnings 2>/dev/null`;

  exec(cmd, { timeout: 60000 }, (error, stdout, stderr) => {
    if (error) return res.status(500).json({ error: 'Instagram arama hatası' });
    const videos = stdout.trim().split('\n').filter(Boolean).map(line => {
      const [id, title, duration, views, likes, thumb, url] = line.split('|');
      return { id, title, duration: parseInt(duration)||0, views: parseInt(views)||0, likes: parseInt(likes)||0, thumb, url, platform: 'instagram' };
    }).filter(v => v.duration >= 1 && v.duration <= 70 && v.views >= 50000);
    res.json(videos);
  });
});

// Uyku modu engelleme
app.get('/ping', (req, res) => { res.json({ status: 'alive' }); });

app.get('/', (req, res) => { res.json({ status: 'Viral Atölyesi Sunucu Çalışıyor!' }); });

const PORT = process.env.PORT || 3000;
installYtDlp().then(() => {
  app.listen(PORT, () => console.log(`Sunucu ${PORT} portunda çalışıyor`));
});
