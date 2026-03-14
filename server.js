const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/download', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'URL gerekli' });

  const filename = `video_${Date.now()}.mp4`;
  const filepath = path.join('/tmp', filename);

  const cmd = `yt-dlp -f "best[ext=mp4]/best" -o "${filepath}" "${url}"`;

  exec(cmd, (error, stdout, stderr) => {
    if (error) {
      return res.status(500).json({ error: 'İndirme hatası: ' + stderr });
    }
    res.download(filepath, 'video.mp4', (err) => {
      fs.unlink(filepath, () => {});
    });
  });
});

app.get('/', (req, res) => {
  res.json({ status: 'Viral Atölyesi Sunucu Çalışıyor!' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sunucu ${PORT} portunda çalışıyor`));
