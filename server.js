const express = require('express');
const cors = require('cors');
const ytdl = require('ytdl-core');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/download', async (req, res) => {
  const url = req.query.url;
  if (!url || !ytdl.validateURL(url)) {
    return res.status(400).json({ error: 'Geçersiz URL' });
  }
  try {
    const info = await ytdl.getInfo(url);
    const title = info.videoDetails.title.replace(/[^a-z0-9]/gi, '_');
    res.header('Content-Disposition', `attachment; filename="${title}.mp4"`);
    res.header('Content-Type', 'video/mp4');
    ytdl(url, { quality: 'highest', filter: 'audioandvideo' }).pipe(res);
  } catch (err) {
    res.status(500).json({ error: 'İndirme hatası: ' + err.message });
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'Viral Atölyesi Sunucu Çalışıyor!' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sunucu ${PORT} portunda çalışıyor`));
