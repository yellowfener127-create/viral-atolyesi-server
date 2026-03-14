const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());

const YTDLP_PATH = path.join(__dirname, 'yt-dlp');

// Sunucu başlarken yt-dlp indir
function installYtDlp() {
  return new Promise((resolve) => {
    if (fs.existsSync(YTDLP_PATH)) {
      console.log('yt-dlp zaten mevcut');
      return resolve();
    }
    console.log('yt-dlp indiriliyor...');
    exec(
      `curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o ${YTDLP_PATH} && chmod +x ${YTDLP_PATH}`,
      (err) => {
        if (err) console.error('yt-dlp indirme hatası:', err);
        else console.log('yt-dlp hazır!');
        resolve();
      }
    );
  });
}

app.get('/download', (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'URL gerekli' });

  const filename = `video_${Date.now()}.mp4`;
  const filepath = path.join('/tmp', filename);
  const cmd = `${YTDLP_PATH} -f "best[ext=mp4]/best" -o "${filepath}" "${url}"`;

  exec(cmd, { timeout: 120000 }, (error, stdout, stderr) => {
    if (error) return res.status(500).json({ error: 'İndirme hatası: ' + stderr });
    res.download(filepath, 'video.mp4', (err) => {
      fs.unlink(filepath, () => {});
    });
  });
});

app.get('/', (req, res) => {
  res.json({ status: 'Viral Atölyesi Sunucu Çalışıyor!' });
});

const PORT = process.env.PORT || 3000;

installYtDlp().then(() => {
  app.listen(PORT, () => console.log(`Sunucu ${PORT} portunda çalışıyor`));
});
