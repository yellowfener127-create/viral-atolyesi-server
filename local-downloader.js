const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crush = require('./crush-pipeline');

const app = express();
app.use(cors());
app.use(express.json({ limit: '256kb' }));

const PORT = process.env.LOCAL_DOWNLOADER_PORT || 8787;
const DEFAULT_DIR = path.join(process.env.USERPROFILE || process.cwd(), 'Videos', 'Viral Atölyesi İndirilenler');
const DOWNLOAD_DIR = process.env.VA_DOWNLOAD_DIR || DEFAULT_DIR;
const PUBLIC_DIR = path.join(__dirname, 'public');
const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function stripJsonFences(s) {
  const t = String(s || '').trim();
  const m = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return (m && m[1]) ? m[1].trim() : t;
}

async function ffmpegExtractFrame(inFile, outFile, tSec) {
  const args = [
    '-y',
    '-ss', String(Math.max(0, tSec).toFixed(3)),
    '-i', inFile,
    '-frames:v', '1',
    '-q:v', '4',
    '-vf', 'scale=512:-1',
    outFile
  ];
  await run('ffmpeg', args, { timeoutMs: 45_000 });
}

async function ffmpegExtractAudioPreview(inFile, outFile, durSec = 10) {
  const args = [
    '-y',
    '-i', inFile,
    '-t', String(Math.max(1, Math.min(15, durSec)).toFixed(3)),
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-b:a', '32k',
    outFile
  ];
  await run('ffmpeg', args, { timeoutMs: 45_000 });
}

function fileToInlineData(filePath, mimeType) {
  const buf = fs.readFileSync(filePath);
  return { inlineData: { mimeType, data: buf.toString('base64') } };
}

async function geminiDirectorAnalyze({ geminiKey, brand, framePaths, audioPath }) {
  if (!geminiKey || String(geminiKey).trim().length < 10) return null;

  const concept =
    brand === 'kaos'
      ? 'KAOS: Komedi, eğlence, karmaşa ve aksiyon odaklı.'
      : brand === 'umut'
        ? 'UMUT: Motivasyon, başarı ve insanlık odaklı.'
        : 'TERAPİ: Çocuk, köpek, tatlı ve komik anlar, huzur odaklı.';

  const prompt =
`Sen bir \"AI Director\"sun. Aşağıdaki konseptten sapma:
${concept}

GÖREV:
1) Karelerde videonun orijinalinde HALİHAZIRDA bir yazı/başlık (hook) var mı? (videoya yakılmış yazı olabilir)
2) Varsa: yaklaşık konumu ve kapladığı alanı tespit et ve yeni hook'un bunu %100 kapatacağı şekilde bir KAPATMA KUTUSU öner.
3) Yoksa: yeni hook'u Y ekseninde 70–95 aralığında (üst kısım) konumlandır.
4) Yeni hook arka plan kuralı:
   - Eski yazı varsa: arka plan TAM OPAK (opacity=1.0) kutu
   - Yoksa: arka plan yarı saydam/gölgeli olabilir (0.30–0.50)
5) Videonun \"Ranked\" / \"Listicle\" (liste/sıralama) içeriği olup olmadığını kontrol et.
   - Eğer ranked/listicle ise hook metninde sıralamaya atıf yap (örn: \"Wait for #1…\", \"The best is last…\", \"Top picks — #1 is wild\" gibi).
6) Konsepte uygun 5–6 kelimelik etkileyici bir CAPTION ve 5 HASHTAG üret.

ÇIKTI FORMAT (SADECE JSON):
{
  \"hasOldHook\": true/false,
  \"oldHook\": {\"yPct\": 0-100, \"hPct\": 0-100} | null,
  \"newHook\": {\"text\": \"...\", \"yPx\": 70-95, \"boxOpacity\": 0-1},
  \"isListicle\": true/false,
  \"rankHookHint\": \"...\" | null,
  \"caption\": \"...\",\n  \"hashtags\": [\"#tag1\",\"#tag2\",\"#tag3\",\"#tag4\",\"#tag5\"]\n}
`;

  const parts = [{ text: prompt }];
  for (const p of framePaths || []) {
    if (p && fs.existsSync(p)) parts.push(fileToInlineData(p, 'image/jpeg'));
  }
  if (audioPath && fs.existsSync(audioPath)) {
    parts.push(fileToInlineData(audioPath, 'audio/mpeg'));
  }

  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0.4, maxOutputTokens: 500 }
  };

  const url = `${GEMINI_ENDPOINT}?key=${encodeURIComponent(String(geminiKey).trim())}`;
  const ac = new AbortController();
  const t = setTimeout(() => {
    try { ac.abort(); } catch {}
  }, 12_000);
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: ac.signal
  }).finally(() => clearTimeout(t));
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j && (j.error?.message || j.error)) ? (j.error.message || j.error) : `Gemini HTTP ${r.status}`);

  const text = (j.candidates?.[0]?.content?.parts || []).map(x => x.text || '').join('').trim();
  const parsed = safeJsonParse(stripJsonFences(text));
  return parsed || null;
}

function normalizeDirectorResult(raw, outH) {
  if (!raw || typeof raw !== 'object') return null;
  const hasOriginal =
    raw.has_original_hook != null ? !!raw.has_original_hook
    : raw.hasOriginalHook != null ? !!raw.hasOriginalHook
    : raw.hasOldHook != null ? !!raw.hasOldHook
    : false;

  const old = raw.old_hook || raw.oldHook || raw.original_hook || raw.originalHook || null;
  const oldYPct = old && Number.isFinite(Number(old.yPct)) ? Number(old.yPct) : (old && Number.isFinite(Number(old.y_pct)) ? Number(old.y_pct) : null);
  const oldHPct = old && Number.isFinite(Number(old.hPct)) ? Number(old.hPct) : (old && Number.isFinite(Number(old.h_pct)) ? Number(old.h_pct) : null);

  const nh = raw.new_hook || raw.newHook || raw.newHookPlacement || raw.new_hook_placement || raw.newHookPos || raw.new_hook_pos || raw.newHookPosition || raw.new_hook_position || raw.newHookText || raw.new_hook_text || raw.newHook || raw.newHook || raw.newHook || null;
  const newHook = raw.newHook || raw.new_hook || (raw.newHook && typeof raw.newHook === 'object' ? raw.newHook : null) || (raw.new_hook && typeof raw.new_hook === 'object' ? raw.new_hook : null) || (raw.newHookPlacement && typeof raw.newHookPlacement === 'object' ? raw.newHookPlacement : null) || (raw.new_hook_placement && typeof raw.new_hook_placement === 'object' ? raw.new_hook_placement : null) || null;

  const yPxRaw = newHook ? (newHook.yPx ?? newHook.y_px ?? newHook.y ?? null) : null;
  let yPx = Number.isFinite(Number(yPxRaw)) ? Number(yPxRaw) : null;
  if (yPx != null) {
    // sadece istenen aralıkta tut (70–95)
    yPx = Math.max(70, Math.min(95, yPx));
  }
  const boxOpacityRaw = newHook ? (newHook.boxOpacity ?? newHook.box_opacity ?? null) : null;
  let boxOpacity = Number.isFinite(Number(boxOpacityRaw)) ? Number(boxOpacityRaw) : null;
  if (boxOpacity != null) boxOpacity = Math.max(0, Math.min(1, boxOpacity));

  const text = newHook ? (newHook.text ?? newHook.hook ?? newHook.title ?? '') : '';

  const caption = typeof raw.caption === 'string' ? raw.caption : (typeof raw.Caption === 'string' ? raw.Caption : '');
  const hashtags = Array.isArray(raw.hashtags) ? raw.hashtags : (Array.isArray(raw.Hashtags) ? raw.Hashtags : []);
  const isListicle =
    raw.isListicle != null ? !!raw.isListicle
    : raw.is_listicle != null ? !!raw.is_listicle
    : raw.listicle != null ? !!raw.listicle
    : raw.isRanked != null ? !!raw.isRanked
    : raw.is_ranked != null ? !!raw.is_ranked
    : false;
  const rankHookHint =
    typeof raw.rankHookHint === 'string' ? raw.rankHookHint
    : typeof raw.rank_hook_hint === 'string' ? raw.rank_hook_hint
    : typeof raw.rankedHook === 'string' ? raw.rankedHook
    : typeof raw.ranked_hook === 'string' ? raw.ranked_hook
    : null;

  const out = {
    hasOriginalHook: hasOriginal,
    oldHook: (hasOriginal && oldYPct != null && oldHPct != null) ? { yPct: oldYPct, hPct: oldHPct } : null,
    newHook: { text: String(text || '').trim(), yPx, boxOpacity },
    isListicle,
    rankHookHint: rankHookHint ? String(rankHookHint).trim() : null,
    caption: String(caption || '').trim(),
    hashtags: (hashtags || []).map(String).filter(Boolean).slice(0, 5)
  };

  // y yoksa fallback 70–95
  if (!Number.isFinite(out.newHook.yPx)) out.newHook.yPx = randRange(70, 95);
  // boxOpacity yoksa: eski yazı yoksa 0.30–0.50
  if (!Number.isFinite(out.newHook.boxOpacity)) out.newHook.boxOpacity = randRange(0.30, 0.50);
  // text boşsa fallback
  if (!out.newHook.text && out.isListicle) {
    out.newHook.text =
      out.rankHookHint ||
      pickOne(['Wait for #1…', 'The best is last…', 'Top picks — #1 is wild…', 'Wait for the final one…']);
  }
  if (!out.newHook.text) out.newHook.text = '';

  return out;
}

function normBrand(brand) {
  const b = String(brand || '').toLowerCase().trim();
  if (b === 'kaos') return 'kaos';
  if (b === 'umut') return 'umut';
  return 'terapi';
}

function getBrandFolderName(brand) {
  const n = normBrand(brand);
  if (n === 'kaos') return 'Kaos Atölyesi';
  if (n === 'umut') return 'Umut Atölyesi';
  return 'Terapi Atölyesi';
}

function getBrandDir(brand) {
  // Araç çıktıları: brand'e göre alt klasöre yaz
  return path.join(DOWNLOAD_DIR, getBrandFolderName(brand));
}

/** Telif Ezici: Kaos / Terapi / Umut için PNG yolu. İşlem hattı Terapi ile aynı; sadece bu dosya değişir. */
function crushWatermarkPngPath(brand) {
  const n = normBrand(brand);
  const name =
    n === 'kaos' ? 'watermark-kaos.png' : n === 'umut' ? 'watermark-umut.png' : 'watermark-terapi.png';
  return path.join(PUBLIC_DIR, name);
}

function existsOnPath(cmd) {
  try {
    const isWin = process.platform === 'win32';
    const probe = spawn(isWin ? 'where' : 'which', [cmd], { stdio: ['ignore', 'ignore', 'ignore'] });
    return new Promise((resolve) => probe.on('close', (code) => resolve(code === 0)));
  } catch {
    return Promise.resolve(false);
  }
}

function safeName(s) {
  return String(s || 'video')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180) || 'video';
}

function run(bin, args, { timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer =
      timeoutMs && timeoutMs > 0
        ? setTimeout(() => {
            try {
              if (process.platform === 'win32' && child.pid) {
                try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
              }
              child.kill();
            } catch {}
          }, timeoutMs)
        : null;

    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 120_000) stderr = stderr.slice(-120_000);
    });
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) return resolve({ stderr });
      reject(new Error(stderr || `exit ${code}`));
    });
  });
}

function pickNewestFile(dir, exts) {
  const files = fs.readdirSync(dir)
    .map((f) => path.join(dir, f))
    .filter((p) => fs.statSync(p).isFile());
  const picked = files
    .map((p) => ({ p, m: fs.statSync(p).mtimeMs, s: fs.statSync(p).size }))
    .filter((x) => x.s > 0 && (!exts || !exts.length || exts.includes(path.extname(x.p).toLowerCase())))
    .sort((a, b) => b.m - a.m)[0];
  return picked ? picked.p : null;
}

function randRange(min, max) {
  const a = Number(min), b = Number(max);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return min;
  return a + Math.random() * (b - a);
}

function clamp(n, lo, hi) {
  const x = Number(n);
  if (!Number.isFinite(x)) return lo;
  return Math.min(hi, Math.max(lo, x));
}

async function ytDlpGetDurationSec(url) {
  // duration in seconds if available, else null
  try {
    const { stderr } = await run('yt-dlp', [
      '--no-playlist',
      '--print',
      '%(duration)s',
      url
    ], { timeoutMs: 45_000 });
    // run() returns stderr only; duration is printed to stdout, so we can't read it here.
    // Fallback: use spawn to capture stdout for this one call.
  } catch {}

  return await new Promise((resolve) => {
    try {
      const child = spawn('yt-dlp', ['--no-playlist', '--print', '%(duration)s', url], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      const t = setTimeout(() => {
        try {
          if (process.platform === 'win32' && child.pid) {
            try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
          }
          child.kill();
        } catch {}
        resolve(null);
      }, 45_000);
      child.stdout.on('data', (d) => { out += d.toString(); });
      child.on('close', () => {
        clearTimeout(t);
        const v = Number(String(out || '').trim());
        if (!Number.isFinite(v) || v <= 0) return resolve(null);
        resolve(v);
      });
      child.on('error', () => { clearTimeout(t); resolve(null); });
    } catch {
      resolve(null);
    }
  });
}

async function probeDurationSec(filePath) {
  // Requires ffprobe available with ffmpeg install
  const args = [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath
  ];
  const child = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  return await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(err || `ffprobe exit ${code}`));
      const v = Number(String(out).trim());
      if (!Number.isFinite(v) || v <= 0) return reject(new Error('Süre okunamadı'));
      resolve(v);
    });
  });
}

async function probeVideoDurationSec(filePath) {
  // Prefer stream duration to avoid "hours-long" bad container timestamps.
  const args = [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath
  ];
  const child = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  return await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(err || `ffprobe exit ${code}`));
      const v = Number(String(out).trim());
      if (!Number.isFinite(v) || v <= 0) return reject(new Error('Video süre okunamadı'));
      resolve(v);
    });
  });
}

async function probeHasAudio(filePath) {
  const args = [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=index',
    '-of', 'csv=p=0',
    filePath
  ];
  const child = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  return await new Promise((resolve) => {
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('close', (code) => {
      if (code !== 0) return resolve(false);
      resolve(String(out || '').trim().length > 0);
    });
    child.on('error', () => resolve(false));
  });
}

async function probeHasVideo(filePath) {
  const args = [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=index',
    '-of', 'csv=p=0',
    filePath
  ];
  const child = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  return await new Promise((resolve) => {
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('close', (code) => {
      if (code !== 0) return resolve(false);
      resolve(String(out || '').trim().length > 0);
    });
    child.on('error', () => resolve(false));
  });
}

async function runYtDlpToResponse(res, url) {
  // Requires: yt-dlp installed on user's machine (in PATH)
  // This avoids server-side bot blocks by running from the user's own network/session.
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  const outTpl = path.join(DOWNLOAD_DIR, '%(title).120s [%(id)s].%(ext)s');

  // Yerel: dosyayı direkt hedef klasöre indir. Tarayıcı indirme klasörüne bağlı kalmayız.
  const args = [
    '--no-playlist',
    '--newline',
    '--no-part',
    '--no-mtime',
    // MP4 + AAC ses: Windows/MPC/telefonlarda "Opus desteklenmiyor" hatasını önler.
    '--merge-output-format',
    'mp4',
    '-f',
    // Öncelik: mp4 video + m4a (aac) ses; yoksa tek parça mp4; en sonda best.
    // 1080p hedefi: Shorts'ta genişlik genelde 1080 (yükseklik 1920), yatayda yükseklik 1080 (genişlik 1920).
    // Önce 1080 wide/1080 tall mp4+ m4a dene; yoksa "1080'e kadar" mp4; yoksa genel mp4.
    'bv*[ext=mp4][vcodec!=none][width=1080]+ba[ext=m4a][acodec!=none]/' +
      'bv*[ext=mp4][vcodec!=none][height=1080]+ba[ext=m4a][acodec!=none]/' +
      'bv*[ext=mp4][vcodec!=none][width<=1080][height<=1920]+ba[ext=m4a][acodec!=none]/' +
      'bv*[ext=mp4][vcodec!=none][height<=1080]+ba[ext=m4a][acodec!=none]/' +
      'bv*[ext=mp4][vcodec!=none]+ba[ext=m4a][acodec!=none]/' +
      'b[ext=mp4][acodec!=none][vcodec!=none]/best',
    '-o',
    outTpl,
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
      const newest = pickNewestFile(DOWNLOAD_DIR);
      if (!newest) return res.status(500).json({ error: 'Dosya bulunamadı (0 byte)' });
      return res.json({ ok: true, savedTo: DOWNLOAD_DIR, file: path.basename(newest) });
    } catch (e) {
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

// Telif Ezici (PC): indir -> 9:16 + zoom + renk + 1.10x + seken watermark
app.post('/crush', async (req, res) => {
  const url = req.body?.url || req.query?.url;
  const brand = normBrand(req.body?.brand || req.query?.brand || 'terapi');
  const geminiKey = req.body?.geminiKey || req.query?.geminiKey || '';
  if (!url) return res.status(400).json({ error: 'url gerekli' });

  const brandDir = getBrandDir(brand);
  fs.mkdirSync(brandDir, { recursive: true });

  const hasYtDlp = await existsOnPath('yt-dlp');
  if (!hasYtDlp) return res.status(500).json({ error: 'yt-dlp bulunamadı. Önce bilgisayara yt-dlp kur.' });

  const hasFfmpeg = await existsOnPath('ffmpeg');
  const hasFfprobe = await existsOnPath('ffprobe');
  if (!hasFfmpeg || !hasFfprobe) return res.status(500).json({ error: 'ffmpeg/ffprobe bulunamadı. Önce bilgisayara ffmpeg kur.' });

  const wmFile = crushWatermarkPngPath(brand);
  if (!fs.existsSync(wmFile)) return res.status(500).json({ error: 'Watermark dosyası yok (public/watermark-*.png).' });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'va-local-crush-'));
  const inTpl = path.join(tmpDir, 'in.%(ext)s');
  const outName = `crushed_${brand}_9x16_${Date.now()}.mp4`;
  const outFile = path.join(brandDir, outName);

  try {
    const metaDur = await ytDlpGetDurationSec(url);
    if (metaDur && metaDur > 60) {
      return res.status(400).json({ error: `Bu araç sadece 60 saniye altı videolarda çalışır. Video süresi: ${Math.round(metaDur)}s` });
    }
    // İndirme kodu baştan: ana sayfadaki indir mantığı (finite MP4 A+V).
    // Download-sections gibi kesme işlerini burada yapmıyoruz; kesmeyi ffmpeg processing tarafında outDur ile garanti ediyoruz.
    const dlTimeoutMs = Math.round(clamp(((metaDur || 20) * 8000) + 60_000, 90_000, 3 * 60 * 1000));

    const dlArgs = [
      '--no-playlist',
      '--newline',
      '--no-part',
      '--no-mtime',
      '--match-filter', '!is_live',
      '--merge-output-format', 'mp4',
      '-f',
      'best[ext=mp4][acodec!=none][vcodec!=none]/best[acodec!=none][vcodec!=none]/best',
      '-o',
      inTpl,
      url
    ];
    await run('yt-dlp', dlArgs, { timeoutMs: dlTimeoutMs });

    const inFile = pickNewestFile(tmpDir);
    if (!inFile) return res.status(500).json({ error: 'İndirilen dosya bulunamadı' });
    const hasVideo = await probeHasVideo(inFile);
    if (!hasVideo) {
      return res.status(500).json({
        error: 'İndirilen dosyada video akışı yok (sadece ses geldi). Bu videoda uygun mp4 A+V formatı bulunamadı.'
      });
    }

    const probedDur = await probeVideoDurationSec(inFile).catch(() => probeDurationSec(inFile).catch(() => null));
    // Süreyi meta'dan almayı tercih et: bazı dosyalarda container timestamp'leri bozuk olup saatler gösterebiliyor.
    const inDur = clamp(metaDur || probedDur || 20, 1, 60);
    if (inDur > 60) {
      return res.status(400).json({ error: `Bu araç sadece 60 saniye altı videolarda çalışır. Video süresi: ${Math.round(inDur)}s` });
    }
    const outW = 720;
    const outH = 1280;
    const hasAudio = await probeHasAudio(inFile);
    const musicFile = crush.pickRandomMusicFile(PUBLIC_DIR, brand);

    // Director v3: 5 kare + kısa audio preview → Gemini analizi
    let director = null;
    const tmpArtifacts = [];
    try {
      const t = inDur;
      const times = [0.1, 0.25, 0.5, 0.75, 0.9].map((k) => Math.max(0, Math.min(t - 0.05, t * k)));
      const frames = times.map((_, i) => path.join(tmpDir, `frame_${i + 1}.jpg`));
      for (let i = 0; i < times.length; i++) {
        await ffmpegExtractFrame(inFile, frames[i], times[i]);
      }
      const audioPrev = path.join(tmpDir, 'audio_preview.mp3');
      await ffmpegExtractAudioPreview(inFile, audioPrev, Math.min(12, inDur));
      tmpArtifacts.push(...frames, audioPrev);
      const rawDir = await geminiDirectorAnalyze({ geminiKey, brand, framePaths: frames, audioPath: audioPrev });
      director = rawDir ? normalizeDirectorResult(rawDir, outH) : null;
    } catch (e) {
      director = { error: (e && e.message) ? e.message : String(e) };
    } finally {
      // İstenen temizlik: render başlamadan kare/mp3 dosyalarını sil (tmpDir zaten sonunda kalkıyor)
      for (const p of tmpArtifacts) {
        try { fs.unlinkSync(p); } catch {}
      }
    }

    // Gemini sonucu: eski yazı varsa opak kapatma kutusu + hook y/text
    let hook = null;
    let coverBox = null;
    if (director && !director.error && director.newHook) {
      hook = {
        text: director.newHook.text,
        y: Number(director.newHook.yPx),
        boxOpacity: Number(director.newHook.boxOpacity)
      };
      if (director.hasOriginalHook && director.oldHook && Number.isFinite(director.oldHook.yPct) && Number.isFinite(director.oldHook.hPct)) {
        coverBox = {
          y: (outH * (Number(director.oldHook.yPct) / 100)),
          h: (outH * (Number(director.oldHook.hPct) / 100)),
          opacity: 1
        };
        // Eski yazı varsa hook arka planı da opak olsun
        if (hook) hook.boxOpacity = 1;
      }
      // Eski yazı yoksa: 70–95 arası random (Gemini yanlış/vermemişse)
      if (!director.hasOriginalHook && (!Number.isFinite(hook.y) || hook.y < 70 || hook.y > 95)) {
        hook.y = randRange(70, 95);
      }
      if (!director.hasOriginalHook && (!Number.isFinite(hook.boxOpacity) || hook.boxOpacity <= 0)) {
        hook.boxOpacity = randRange(0.30, 0.50);
      }
    } else {
      // Fallback (Gemini hata/timeout): kod çökmesin, render devam etsin
      hook = { text: '', y: randRange(70, 95), boxOpacity: randRange(0.30, 0.50) };
    }

    const runFfmpeg = async (plan) => {
      await run('ffmpeg', [...plan.ffmpegArgsTail, outFile], { timeoutMs: 8 * 60 * 1000 });
    };

    let plan = await crush.buildCrushRenderPlan({
      inFile,
      wmFile,
      musicFile,
      brand,
      outW,
      outH,
      sourceDurSec: inDur,
      hook,
      coverBox,
      hasAudio,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      useRubberband: true
    });
    try {
      await runFfmpeg(plan);
    } catch (e1) {
      const msg = String((e1 && e1.message) || e1);
      if (/rubberband|No such filter|not found|Invalid argument/i.test(msg)) {
        plan = await crush.buildCrushRenderPlan({
          inFile,
          wmFile,
          musicFile,
          brand,
          outW,
          outH,
          sourceDurSec: inDur,
          hasAudio,
          ffmpegPath: 'ffmpeg',
          ffprobePath: 'ffprobe',
          useRubberband: false
        });
        await runFfmpeg(plan);
      } else {
        throw e1;
      }
    }

    const verify = await crush.selfCheckCrushOutput('ffmpeg', 'ffprobe', outFile);

    return res.json({
      ok: true,
      savedTo: brandDir,
      file: path.basename(outFile),
      settings: plan.debug,
      verify,
      director: director && director.error
        ? { ok: false, error: director.error }
        : director
          ? { ok: true, ...director }
          : { ok: false, error: 'Gemini key yok veya analiz çalışmadı' },
      musicDir: crush.getCrushMusicDir(PUBLIC_DIR, brand),
      musicHint:
        crush.listMusicFiles(crush.getCrushMusicDir(PUBLIC_DIR, brand)).length < 1
          ? 'BGM yok: public/audio/crush/<konsept>/ içine lisanslı .mp3/.m4a ekleyin (README).'
          : null
    });
  } catch (e) {
    return res.status(500).json({ error: (e && e.message) ? e.message : String(e) });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Local Downloader running on http://127.0.0.1:${PORT}`);
  console.log('Download dir:', DOWNLOAD_DIR);
  console.log('Install yt-dlp then open your frontend and click Download.');
});

