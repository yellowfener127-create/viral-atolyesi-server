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

function safeName(s) {
  return String(s || 'video')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180) || 'video';
}

async function runYtDlpToResponse(res, url) {
  // Requires: yt-dlp installed on user's machine (in PATH)
  // This avoids server-side bot blocks by running from the user's own network/session.
  const base = safeName('video');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'va_local_'));
  const outBase = path.join(dir, `${base}_%(id)s.%(ext)s`);

  // Local'de timeout yok, o yüzden dosyaya indirip gerçek uzantıyla gönderiyoruz (mp4/webm/mkv).
  const args = [
    '--no-playlist',
    '--newline',
    '--no-part',
    '--no-mtime',
    // Prefer a single-file progressive mp4 when possible; otherwise fallback to best.
    '-f',
    'best[ext=mp4][acodec!=none][vcodec!=none]/best',
    '-o',
    outBase,
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

      const files = fs.readdirSync(dir).map((f) => path.join(dir, f));
      const picked = files.find((f) => fs.statSync(f).size > 0);
      if (!picked) return res.status(500).json({ error: 'Dosya bulunamadı (0 byte)' });

      const filename = path.basename(picked);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '')}"`);
      const rs = fs.createReadStream(picked);
      rs.on('error', (e) => res.status(500).json({ error: e.message }));
      rs.pipe(res);
      res.on('finish', () => {
        try { fs.unlinkSync(picked); } catch {}
        try { fs.rmdirSync(dir); } catch {}
      });
    } catch (e) {
      try { fs.rmdirSync(dir, { recursive: true }); } catch {}
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

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Local Downloader running on http://127.0.0.1:${PORT}`);
  console.log('Install yt-dlp then open your frontend and click Download.');
});

