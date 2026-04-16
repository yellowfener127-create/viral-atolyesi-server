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
// Model: kota sorunları için 1.5 flash latest
const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent';

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function stripJsonFences(s) {
  const t = String(s || '').trim();
  const m = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return (m && m[1]) ? m[1].trim() : t;
}

function pickOne(arr) {
  if (!arr || !arr.length) return '';
  return arr[Math.floor(Math.random() * arr.length)];
}

function getDirectorCachePath() {
  return path.join(DOWNLOAD_DIR, '.va_director_cache_v1.json');
}

function loadDirectorCache() {
  try {
    const p = getDirectorCachePath();
    if (!fs.existsSync(p)) return { hooks: [], captions: [] };
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return {
      hooks: Array.isArray(j.hooks) ? j.hooks : [],
      captions: Array.isArray(j.captions) ? j.captions : []
    };
  } catch {
    return { hooks: [], captions: [] };
  }
}

function saveDirectorCache(cache) {
  try {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
    fs.writeFileSync(getDirectorCachePath(), JSON.stringify(cache || {}, null, 2), 'utf8');
  } catch {}
}

function normTextKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function isRecentlyUsed(list, text, windowSize = 160) {
  const key = normTextKey(text);
  if (!key) return false;
  const recent = (list || []).slice(-windowSize);
  return recent.includes(key);
}

function rememberUsed(cache, kind, text, maxKeep = 400) {
  const key = normTextKey(text);
  if (!key) return;
  if (!cache[kind]) cache[kind] = [];
  cache[kind].push(key);
  if (cache[kind].length > maxKeep) cache[kind] = cache[kind].slice(-maxKeep);
}

function makeVideoSpecificHashtagFromHook(hookText) {
  const stop = new Set([
    'the','a','an','and','or','to','of','in','on','for','with','this','that','these','those',
    'is','are','was','were','be','been','being','so','too','very','just','really','crazy','best',
    'wait','watch','ending','end','moment','moments','ranking','ranked','top','baby','dads','dad'
  ]);
  const words = String(hookText || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s#]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter(w => !stop.has(w) && !/^#/.test(w));
  const w = words[0] || '';
  const cleaned = w.replace(/[^a-z0-9]/g, '');
  if (!cleaned) return '#viral';
  return ('#' + cleaned).slice(0, 24);
}

function ensureHashtagPack(brand, hookText, hashtags) {
  const specific = makeVideoSpecificHashtagFromHook(hookText);
  const base = fallbackHashtagsForBrand(brand);
  const base4 = base.filter(Boolean).map(String).slice(0, 4);
  const all = [specific, ...base4].filter(Boolean);
  // uniq + keep order, ensure 5
  const uniq = [];
  const seen = new Set();
  for (const t of all) {
    const k = String(t).toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(String(t));
    if (uniq.length >= 5) break;
  }
  // if specific collapsed to #viral etc, top up with base tags
  for (const t of base) {
    const k = String(t).toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(String(t));
    if (uniq.length >= 5) break;
  }
  while (uniq.length < 5) uniq.push('#viral');
  return uniq.slice(0, 5);
}

function makeUniqueHook(brand, base, cache, isListicle) {
  const b = String(brand || 'terapi').toLowerCase();
  const core = String(base || '').trim();
  const listicleHints = [
    'Best one is #1',
    'Wait for #1',
    '#1 is unreal'
  ];
  const kaos = [
    'That crash was brutal',
    'Instant regret moment',
    'This went so wrong',
    'One slip, pure chaos'
  ];
  const terapi = [
    'Too cute to be real',
    'This is pure joy',
    'The sweetest little moment',
    'My heart can’t handle this'
  ];
  const umut = [
    'This is why hope matters',
    'Humanity still wins',
    'A win you can feel',
    'Faith restored today'
  ];
  const pool = (b === 'kaos') ? kaos : (b === 'umut' ? umut : terapi);

  const candidates = [];
  if (core) candidates.push(core);
  // small structured variations to avoid repeats
  for (const p of pool) candidates.push(p);
  if (isListicle) for (const p of listicleHints) candidates.push(p);

  // pick first that is not recently used; else fall back to random
  for (const c of candidates) {
    if (!isRecentlyUsed(cache.hooks, c)) return c;
  }
  return pickOne(candidates);
}

function stripEmoji(s) {
  return String(s || '').replace(/[\p{Extended_Pictographic}\uFE0F]/gu, '').replace(/\s+/g, ' ').trim();
}

function makeUniqueCaption(brand, base, cache) {
  const core = String(base || '').trim();
  const pool = [
    fallbackCaptionForBrand(brand),
    'You can’t make this up',
    'I’m not okay after this',
    'This is your sign today'
  ];
  const candidates = [];
  if (core) candidates.push(core);
  candidates.push(...pool);
  for (const c of candidates) {
    if (!isRecentlyUsed(cache.captions, c)) return c;
  }
  return pickOne(candidates);
}

function looksGenericHook(s) {
  const t = normTextKey(s);
  if (!t) return true;
  const banned = [
    'wait for it',
    'wait for the end',
    'watch until the end',
    'amazing end',
    'sweet end',
    'end is crazy',
    'ending is crazy',
    'crazy',
    'viral',
    'insane'
  ];
  return banned.some((b) => t.includes(b));
}

function extractKeywordsFromTitle(title) {
  const t = String(title || '').toLowerCase();
  const raw = t.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const stop = new Set([
    'the','a','an','and','or','to','of','in','on','for','with','this','that','these','those',
    'is','are','was','were','be','been','being','so','too','very','just','really','crazy','best',
    'wait','watch','ending','end','moment','moments','ranking','ranked','top','baby','dads','dad',
    'shorts','reels','tiktok','viral','compilation','clips'
  ]);
  const keep = [];
  for (const w of raw) {
    if (stop.has(w)) continue;
    if (w.length < 3) continue;
    keep.push(w);
    if (keep.length >= 6) break;
  }
  return keep;
}

function buildHookFromTitle({ title, isListicle }) {
  const kw = extractKeywordsFromTitle(title);
  const subject = kw[0] || '';
  if (!subject) return '';
  if (isListicle) {
    return `Best ${subject} moment — #1`;
  }
  return `${subject} moment you can’t ignore`;
}

function buildFallbackCaptionFromTitle(title) {
  const kw = extractKeywordsFromTitle(title);
  const topic = kw.slice(0, 2).join(' ') || 'this moment';
  const line1 = `Did you catch what happened with ${topic}?`;
  const line2 = pickOne(['What would you do?', 'Rate this 1–10.', 'Would you try this?']);
  const tags = [
    '#' + (kw[0] || 'viral'),
    '#shorts',
    '#fyp',
    '#trending',
    '#wow'
  ].map((t) => String(t).replace(/[^#a-zA-Z0-9]/g, '').toLowerCase()).filter(Boolean);
  // ensure at least 5 unique hashtags
  const uniq = [];
  const seen = new Set();
  for (const t of tags) {
    if (seen.has(t)) continue;
    seen.add(t);
    uniq.push(t);
    if (uniq.length >= 5) break;
  }
  while (uniq.length < 5) uniq.push('#viral');
  return `${line1}\n${line2}\n${uniq.slice(0, 5).join(' ')}`.trim();
}

function captionLooksGood(caption) {
  const s = String(caption || '').trim();
  if (s.length < 24) return false;
  const hasCTA = /what would you do\??|rate this|rate it|1-10|1–10|would you/i.test(s);
  const hashCount = (s.match(/#[a-z0-9_]+/gi) || []).length;
  return hasCTA && hashCount >= 5;
}

function splitHookTwoLines(hookText) {
  const t = stripEmoji(String(hookText || '')).replace(/\s+/g, ' ').trim();
  if (!t) return '';
  // Prefer splitting near the middle on a space
  const words = t.split(' ').filter(Boolean);
  if (words.length <= 2) return t;
  const mid = Math.max(1, Math.floor(words.length / 2));
  const a = words.slice(0, mid).join(' ');
  const b = words.slice(mid).join(' ');
  return `${a}\\n${b}`.trim();
}

async function ytDlpGetTitle(url) {
  return await new Promise((resolve) => {
    try {
      const child = spawn('yt-dlp', ['--no-playlist', '--print', '%(title)s', url], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      const t = setTimeout(() => {
        try {
          if (process.platform === 'win32' && child.pid) {
            try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
          }
          child.kill();
        } catch {}
        resolve('');
      }, 45_000);
      child.stdout.on('data', (d) => { out += d.toString(); });
      child.on('close', () => { clearTimeout(t); resolve(String(out || '').trim()); });
      child.on('error', () => { clearTimeout(t); resolve(''); });
    } catch {
      resolve('');
    }
  });
}

function guessListicleFromTitle(title) {
  const t = String(title || '').toLowerCase();
  return /(^|\s)(top|rank|ranking|ranked|#\s*1|#1|1\.)/.test(t);
}

function fallbackHookTextForBrand(brand) {
  const b = String(brand || 'terapi').toLowerCase();
  if (b === 'kaos') {
    return pickOne([
      'Ending is unbelievable ⚠️',
      'Watch for the end! 🤣',
      'Did not expect that 😂',
      'End is crazy! 😱'
    ]);
  }
  if (b === 'umut') {
    return pickOne([
      'This moment hits different ✨',
      'Wait for the payoff',
      'Proof people are amazing',
      'Ending feels earned'
    ]);
  }
  return pickOne([
    'Ending is so sweet ✨',
    'Wait for the sweet end! 😍',
    'Watch till the end ❤️',
    'Too cute to be real 🥰'
  ]);
}

async function ffmpegExtractFrame(inFile, outFile, tSec) {
  const args = [
    '-y',
    '-ss', String(Math.max(0, tSec).toFixed(3)),
    '-i', inFile,
    '-frames:v', '1',
    // Token tasarrufu için daha küçük kareler
    '-vf', 'scale=512:-1',
    // Bu FFmpeg build'inde JPEG(mjpeg) encoder strictness hatası çıkabiliyor.
    // PNG ile garanti alıyoruz.
    '-c:v', 'png',
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms || 0)));
}

function isGeminiRateLimitError({ status, message, json }) {
  const msg = String(message || '');
  const jmsg = json && (json.error?.message || json.error);
  const s = String(jmsg || '');
  const merged = (msg + '\n' + s).toLowerCase();
  return (
    status === 429 ||
    /resource_exhausted/.test(merged) ||
    /rate limit/.test(merged) ||
    /quota exceeded/.test(merged) ||
    /exceeded your current quota/.test(merged)
  );
}

async function geminiDirectorAnalyze({ geminiKey, brand, framePaths, audioPath, title }) {
  if (!geminiKey || String(geminiKey).trim().length < 10) return null;

  const concept =
    brand === 'kaos'
      ? 'KAOS: Komedi, eğlence, karmaşa ve aksiyon odaklı.'
      : brand === 'umut'
        ? 'UMUT: Motivasyon, başarı ve insanlık odaklı.'
        : 'TERAPİ: Çocuk, köpek, tatlı ve komik anlar, huzur odaklı.';

  const prompt =
`Sistemin beyni olan "Viral Atölyesi AI Director v3.0" olarak görevlendirildin.

ELİNDEKİ KISITLI VERİ (KURAL):
- Sana daha fazla kare gönderiyorum. Her kareyi TEK TEK analiz et ve videodaki en küçük aksiyonu yakala (kaş kalkması, el hareketi, arkadaki detay vb.).
- Bu istek için toplam ${framePaths && framePaths.length ? framePaths.length : 'N'} adet kare + kısa bir ses önizlemesi var.
- İlk kareler videonun başından (metin yakalama için), kalan kareler videonun tamamına yayılmış (aksiyon/hikaye için).
- Ayrıca kısa bir ses önizlemesi var (tek kanallı, düşük bitrate).
- Tam videoyu izlemiyorsun. Bu yüzden sadece bu ipuçlarıyla en iyi tahmini yap.

KONSEPT (SAPMA YASAK):
${concept}

VIDEO BAŞLIĞI (yt-dlp):
${String(title || '').trim() || '(başlık alınamadı)'}

ANALİZ PROTOKOLÜ:
1) İlk karelerde METİN ara (üst/orta). Varsa bu “İmha Bölgesi”dir.
2) Tüm karelerde AKSİYON/HİKAYE ara (düşme, çarpma, koşma, sarılma, kurtarma, ring kırılması, vb.).
3) Ses önizlemesinde PİKLERİ ara (pat/çarpma, gülme, çığlık). Görsel net değilse ses ipucuna ağırlık ver.

SU İŞARETİ / LOGO AVI (ÇOK KRİTİK):
- Karelerde @username, kanal logosu veya sosyal medya filigranı görürsen MUTLAKA blur_regions içine koordinatını ekle.
- Örnek: "@pet&wildlifewonders" gibi watermark yazılarını sakın kaçırma; koordinat ver.

ZORUNLU SİYAH BANT (FORCE MASK) KURALI:
- Videonun en üst kısmında herhangi bir yazı/başlık/hook görürsen (arkasında şerit olsun olmasın),
  original_header_height değerini mutlaka ölç ve döndür (px). Bu değer 0 olamaz.
- Sadece gerçekten hiçbir yazı yoksa original_header_height=0 döndür.

JENERİK YASAKLAR (KESİN):
Hook şu kalıpları içeremez: "wait for it", "wait for the end", "watch until the end", "amazing end", "sweet end" (ve benzerleri).
EK YASAK (KESİN): Hook içinde şu kelimeler GEÇEMEZ: "crazy", "viral", "insane".

SOMUTLUK ŞARTI (KESİN):
Hook İngilizce olacak ve mutlaka 1 SOMUT NESNE veya 1 SOMUT EYLEM kelimesi içerecek.
Örnek nesne: skateboard, dog, baby, car, stairs, door, bike, ball
Örnek eylem: slips, crashes, falls, lands, saves, hits, drops, flips

RANKED/LISTICLE KURALI:
Karelerde 1/2/3 gibi sıralama veya "ranked/top" vb. görüyorsan isListicle=true yap.
Bu durumda hook’ta #1 referansı kullanabilirsin ama yine SOMUT NESNEYİ yazmak zorundasın.

  MASKELME (OLD HOOK) — SERT İMHA:
Eğer hasOldHook=true ise görevin o eski yazıyı “süslemek” değil, tamamen YOK ETMEK:
- newHook.boxOpacity = 1.0 (tam opak)
  - newHook.yPx banner'ın başlangıç Y konumudur (0–100 birim; 0=ALT, 100=ÜST)
    Eski yazıyı tamamen yutacak şekilde ayarla (gerekirse 95–100 bandına yakın).

ÇIKTI KURALI (KESİN):
- SADECE JSON döndür. Başka hiçbir metin, açıklama, markdown, code fence yazma.
- Aşağıdaki şema DIŞINA çıkma. Anahtar isimleri birebir aynı olmalı.

KOORDİNAT SİSTEMİ (KESİN):
- Çıktı koordinatları piksel cinsinden ve render hedefi 720x1280 içindir.
- x,y: sol-üst köşe (0,0) sol-üst.
- w,h: genişlik/yükseklik (px).

ZORUNLU JSON ŞEMASI (KATI):
{
  "hook": "2 satır olacak şekilde yaz: Line1\\nLine2 (emoji-free, no crazy/viral/insane)",
  "caption": "3 satır: (1) merak uyandıran cümle (2) CTA: What would you do? / Rate this 1-10 (3) en az 5 hashtag",
  "detect_garbage_text": {"x": 0, "y": 0, "w": 0, "h": 0},
  "original_header_height": 0,
  "blur_regions": [{"x": 0, "y": 0, "w": 0, "h": 0}]
}

KURALLAR:
- hook kesinlikle emoji içermez.
- hook içinde "crazy", "viral", "insane" kelimeleri geçemez.
- detect_garbage_text: Eğer kullanıcı adı/watermark/logo/rahatsız edici metin görürsen en kritik alanı tek kutu olarak ver; yoksa {0,0,0,0}.
- blur_regions: rahatsız edici yazı/logo alanlarını listele (maks 3 kutu); yoksa [] döndür.
- original_header_height: Üstte orijinal başlık/yazı varsa kapladığı yüksekliği px olarak ver (örn 160). Yoksa 0.

NOT:
Eğer karelerde aksiyon net değilse, ses piklerine göre mantıklı bir fail/impact/surprise hook’u üret; ama yine de jenerik yasaklara uy.
Eğer Gemini hata verse bile: Bu video başlığına ve bu görsel karelere dayanarak, her ikisiyle de uyumlu bir hook oluştur.

ŞİMDİ SADECE JSON DÖNDÜR.`;

  const parts = [{ text: prompt }];
  let imageBytes = 0;
  let audioBytes = 0;
  for (const p of framePaths || []) {
    if (!p || !fs.existsSync(p)) continue;
    const ext = path.extname(p).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
    try { imageBytes += fs.statSync(p).size || 0; } catch {}
    parts.push(fileToInlineData(p, mime));
  }
  if (audioPath && fs.existsSync(audioPath)) {
    try { audioBytes += fs.statSync(audioPath).size || 0; } catch {}
    parts.push(fileToInlineData(audioPath, 'audio/mpeg'));
  }

  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: 0.55,
      maxOutputTokens: 1024
    }
  };

  const url = `${GEMINI_ENDPOINT}?key=${encodeURIComponent(String(geminiKey).trim())}`;
  // Rate Limit Kurtarma:
  // 429 / Quota hatasında süreci durdurma; 60 sn bekle ve aynı isteği tekrar dene.
  // En fazla 5 deneme (toplam).
  const maxAttempts = 5;
  const retryWaitMs = 60_000;
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ac = new AbortController();
    const t = setTimeout(() => {
      try { ac.abort(); } catch {}
    }, 28_000);

    let r = null;
    let j = {};
    try {
      r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ac.signal
      }).finally(() => clearTimeout(t));

      j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = (j && (j.error?.message || j.error)) ? (j.error.message || j.error) : `Gemini HTTP ${r.status}`;
        const err = new Error(msg);
        err.httpStatus = r.status;
        err.geminiJson = j;
        throw err;
      }

      const text = (j.candidates?.[0]?.content?.parts || []).map(x => x.text || '').join('').trim();
      const parsed = safeJsonParse(stripJsonFences(text));
      if (parsed && typeof parsed === 'object') {
        const usage = j.usageMetadata || j.usage_metadata || null;
        const promptTokens = Number(usage?.promptTokenCount ?? usage?.prompt_token_count ?? NaN);
        const candTokens = Number(usage?.candidatesTokenCount ?? usage?.candidates_token_count ?? NaN);
        const totalTokens = Number(usage?.totalTokenCount ?? usage?.total_token_count ?? NaN);
        const tierGuess = (String(j?.error?.message || '').toLowerCase().includes('free_tier') || String(text).toLowerCase().includes('free_tier'))
          ? 'free'
          : 'paid_or_unknown';
        parsed.__va_diag = {
          model: 'gemini-1.5-flash-latest',
          imageBytes,
          audioBytes,
          promptTokens: Number.isFinite(promptTokens) ? promptTokens : null,
          candidateTokens: Number.isFinite(candTokens) ? candTokens : null,
          totalTokens: Number.isFinite(totalTokens) ? totalTokens : null,
          tier: tierGuess
        };
        console.log('[Gemini Diag]', JSON.stringify(parsed.__va_diag));
      }
      return parsed || null;
    } catch (e) {
      lastErr = e;
      const status = Number(e?.httpStatus) || Number(r?.status) || null;
      const message = (e && e.message) ? e.message : String(e);
      if (attempt < maxAttempts && isGeminiRateLimitError({ status, message, json: e?.geminiJson || j })) {
        console.log('[Gemini Quota] Kota doldu, 60 saniye bekleniyor ve tekrar denenecek....');
        await sleep(retryWaitMs);
        continue;
      }
      break;
    } finally {
      clearTimeout(t);
    }
  }

  // 5 deneme sonunda hala kota/rate-limit ise videoyu pas geç: Gemini yokmuş gibi devam et.
  // (Render devam eder; UI'da director.ok=false olarak görülecek.)
  if (lastErr) {
    const status = Number(lastErr?.httpStatus) || null;
    const message = (lastErr && lastErr.message) ? lastErr.message : String(lastErr);
    if (isGeminiRateLimitError({ status, message, json: lastErr?.geminiJson })) {
      return {
        __va_status: 'RATE_LIMIT_EXHAUSTED',
        message,
        __va_diag: { model: 'gemini-1.5-flash-latest', imageBytes, audioBytes, tier: 'paid_or_unknown' }
      };
    }
    throw lastErr;
  }
  return null;
}

function fallbackCaptionForBrand(brand) {
  const b = String(brand || 'terapi').toLowerCase();
  if (b === 'kaos') return 'Chaos in one perfect moment';
  if (b === 'umut') return 'A small moment of hope';
  return 'This made my whole day';
}

function fallbackHashtagsForBrand(brand) {
  const b = String(brand || 'terapi').toLowerCase();
  if (b === 'kaos') return ['#fail', '#funny', '#oops', '#viral', '#chaos'];
  if (b === 'umut') return ['#hope', '#motivation', '#inspiration', '#humanity', '#viral'];
  return ['#cute', '#wholesome', '#animals', '#funny', '#viral'];
}

function normalizeDirectorResult(raw, outH, brand) {
  if (!raw || typeof raw !== 'object') return null;
  // New strict schema support:
  if (typeof raw.hook === 'string' || typeof raw.caption === 'string' || raw.original_header_height != null || Array.isArray(raw.blur_regions)) {
    const hook = stripEmoji(String(raw.hook || '').trim());
    const caption = stripEmoji(String(raw.caption || '').trim());
    const headerH = Number(raw.original_header_height);
    const originalHeaderHeight = Number.isFinite(headerH) && headerH > 0 ? headerH : 0;
    const clampRegion = (r) => {
      const x = Math.max(0, Math.min(719, Math.round(Number(r?.x) || 0)));
      const y = Math.max(0, Math.min(1279, Math.round(Number(r?.y) || 0)));
      const w = Math.max(0, Math.min(720 - x, Math.round(Number(r?.w) || 0)));
      const h = Math.max(0, Math.min(1280 - y, Math.round(Number(r?.h) || 0)));
      return (w >= 8 && h >= 8) ? { x, y, w, h } : null;
    };
    const blurRegions = [];
    const list = Array.isArray(raw.blur_regions) ? raw.blur_regions : [];
    for (const r of list.slice(0, 3)) {
      const rr = clampRegion(r);
      if (rr) blurRegions.push(rr);
    }
    const garbage = clampRegion(raw.detect_garbage_text);
    if (garbage && !blurRegions.some(b => b.x === garbage.x && b.y === garbage.y && b.w === garbage.w && b.h === garbage.h)) {
      blurRegions.unshift(garbage);
      if (blurRegions.length > 3) blurRegions.length = 3;
    }

    const out = {
      hasOriginalHook: originalHeaderHeight > 0,
      oldHook: originalHeaderHeight > 0 ? { yPct: 0, hPct: (originalHeaderHeight / outH) * 100 } : null,
      newHook: { text: hook, yPx: 95, boxOpacity: 1 },
      isListicle: false,
      rankHookHint: null,
      hookColor: null,
      caption,
      hashtags: [],
      blurRegions,
      originalHeaderHeight
    };
    if (!out.newHook.text) out.newHook.text = fallbackHookTextForBrand(brand);
    if (!out.caption) out.caption = fallbackCaptionForBrand(brand);
    return out;
  }
  const hasOriginal =
    raw.has_original_hook != null ? !!raw.has_original_hook
    : raw.has_old_hook != null ? !!raw.has_old_hook
    : raw.hasOriginalHook != null ? !!raw.hasOriginalHook
    : raw.hasOldHook != null ? !!raw.hasOldHook
    : false;

  const old = raw.old_hook || raw.oldHook || raw.original_hook || raw.originalHook || null;
  const oldYPct = old && Number.isFinite(Number(old.yPct)) ? Number(old.yPct) : (old && Number.isFinite(Number(old.y_pct)) ? Number(old.y_pct) : null);
  const oldHPct = old && Number.isFinite(Number(old.hPct)) ? Number(old.hPct) : (old && Number.isFinite(Number(old.h_pct)) ? Number(old.h_pct) : null);

  const newHook = raw.newHook || raw.new_hook || (raw.newHook && typeof raw.newHook === 'object' ? raw.newHook : null) || (raw.new_hook && typeof raw.new_hook === 'object' ? raw.new_hook : null) || (raw.newHookPlacement && typeof raw.newHookPlacement === 'object' ? raw.newHookPlacement : null) || (raw.new_hook_placement && typeof raw.new_hook_placement === 'object' ? raw.new_hook_placement : null) || null;

  const yPxRaw = newHook ? (newHook.yPx ?? newHook.y_px ?? newHook.y ?? null) : null;
  let yPx = Number.isFinite(Number(yPxRaw)) ? Number(yPxRaw) : null;
  if (yPx != null) {
    // 0=ALT, 100=ÜST koordinat sistemi (tam serbest)
    yPx = Math.max(0, Math.min(100, yPx));
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

  const hookColor =
    typeof raw.hookColor === 'string' ? raw.hookColor
    : typeof raw.hook_color === 'string' ? raw.hook_color
    : (raw.newHook && typeof raw.newHook.color === 'string') ? raw.newHook.color
    : (raw.new_hook && typeof raw.new_hook.color === 'string') ? raw.new_hook.color
    : null;

  const out = {
    hasOriginalHook: hasOriginal,
    oldHook: (hasOriginal && oldYPct != null && oldHPct != null) ? { yPct: oldYPct, hPct: oldHPct } : null,
    newHook: { text: String(text || '').trim(), yPx, boxOpacity },
    isListicle,
    rankHookHint: rankHookHint ? String(rankHookHint).trim() : null,
    hookColor: hookColor ? String(hookColor).trim() : null,
    caption: String(caption || '').trim(),
    hashtags: (hashtags || []).map(String).filter(Boolean).slice(0, 5),
    blurRegions: [],
    originalHeaderHeight: null
  };

  // y yoksa fallback 70–95
  if (!Number.isFinite(out.newHook.yPx)) out.newHook.yPx = 95;
  // boxOpacity yoksa: eski yazı yoksa 0.30–0.50
  if (!Number.isFinite(out.newHook.boxOpacity)) out.newHook.boxOpacity = randRange(0.30, 0.50);
  if (hasOriginal) out.newHook.boxOpacity = 1;
  // text boşsa fallback
  if (!out.newHook.text && out.isListicle) {
    out.newHook.text =
      out.rankHookHint ||
      pickOne(['Wait for #1…', 'The best is last…', 'Top picks — #1 is wild…', 'Wait for the final one…']);
  }
  if (!out.newHook.text) out.newHook.text = fallbackHookTextForBrand(brand);

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
  const geminiKeyPresent = !!(geminiKey && String(geminiKey).trim().length >= 10);
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
    const metaTitle = await ytDlpGetTitle(url).catch(() => '');
    const titleIsListicle = guessListicleFromTitle(metaTitle);
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
    let geminiUsed = false;
    const tmpArtifacts = [];
    try {
      const t = inDur;
      // 20 kare:
      // - ilk 5 kare ilk ~2 saniyeden (eski yazıyı yakalamak için)
      // - kalan 15 kare 2sn → sona kadar eşit dağıt
      const early = [0.10, 0.50, 0.90, 1.30, 1.70].map((sec) => Math.max(0, Math.min(t - 0.05, sec)));
      const restStart = Math.min(Math.max(2.0, 0), Math.max(0, t - 0.05));
      const restEnd = Math.max(restStart, t - 0.05);
      const restCount = 15;
      const rest = [];
      if (restCount > 0) {
        const span = Math.max(0.001, restEnd - restStart);
        for (let i = 0; i < restCount; i++) {
          const k = restCount === 1 ? 0.5 : (i / (restCount - 1));
          rest.push(restStart + span * k);
        }
      }
      const times = [...early, ...rest].slice(0, 20).map((sec) => Math.max(0, Math.min(t - 0.05, sec)));
      const frames = times.map((_, i) => path.join(tmpDir, `frame_${String(i + 1).padStart(2, '0')}.png`));
      for (let i = 0; i < times.length; i++) {
        await ffmpegExtractFrame(inFile, frames[i], times[i]);
      }
      const audioPrev = path.join(tmpDir, 'audio_preview.mp3');
      await ffmpegExtractAudioPreview(inFile, audioPrev, Math.min(12, inDur));
      tmpArtifacts.push(...frames, audioPrev);
      if (geminiKeyPresent) {
        geminiUsed = true;
        const rawDir = await geminiDirectorAnalyze({ geminiKey, brand, framePaths: frames, audioPath: audioPrev, title: metaTitle });
        if (rawDir && rawDir.__va_status === 'RATE_LIMIT_EXHAUSTED') {
          director = { error: `Gemini kota/rate-limit: 5 denemede de başarısız. (${rawDir.message || 'quota'})`, __va_diag: rawDir.__va_diag || null };
        } else {
          director = rawDir ? normalizeDirectorResult(rawDir, outH, brand) : null;
        }
      } else {
        director = { error: 'Gemini key yok (localStorage -> gemini_api_key boş geldi).' };
      }
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
    let finalCaption = '';
    let finalHashtags = [];
    const cache = loadDirectorCache();

    if (director && !director.error && director.newHook) {
      const isListicle = !!director.isListicle;
      const hookBase = String(director.newHook.text || '').trim();
      const titleHook = buildHookFromTitle({ title: metaTitle, isListicle: isListicle || titleIsListicle });
      const hookSeed = (!looksGenericHook(hookBase) && hookBase) ? hookBase : (titleHook || hookBase);
      const hookText = splitHookTwoLines(stripEmoji(makeUniqueHook(brand, hookSeed, cache, isListicle || titleIsListicle)));
      hook = {
        text: hookText,
        // bannerY: 0=ALT, 100=ÜST → ffmpeg y=0 üst olduğu için ters çevir
        bannerY: outH * (1 - (Number(director.newHook.yPx) / 100)),
        y: Number(director.newHook.yPx),
        boxOpacity: Number(director.newHook.boxOpacity),
        color: director.hookColor || null
      };

      // Caption: Gemini bazen boş/yüzeysel döndürebiliyor. Zorunlu 3 satır + CTA + >=5 hashtag doğrula.
      const capCandidate = stripEmoji(String(director.caption || '').trim());
      finalCaption = captionLooksGood(capCandidate) ? capCandidate : buildFallbackCaptionFromTitle(metaTitle);
      finalHashtags = ensureHashtagPack(brand, hookText, director.hashtags);

      rememberUsed(cache, 'hooks', hookText);
      rememberUsed(cache, 'captions', finalCaption);
      saveDirectorCache(cache);

      // Force mask: üstte herhangi bir yazı varsa siyah bant zorunlu.
      const hdr = Number(director.originalHeaderHeight);
      if (Number.isFinite(hdr) && hdr > 0) {
        // Gemini bazen header yüksekliğini düşük ölçebilir → minimum bant yüksekliği uygula.
        const minBand = Math.round(outH * 0.22);
        const hpx = Math.max(2, Math.min(outH, Math.max(minBand, Math.round(hdr * 1.50))));
        coverBox = { y: 0, h: hpx, w: outW, opacity: 1 };
        if (hook) {
          hook.boxOpacity = 1;
          hook.bannerY = 0;
        }
      }

      if (director.hasOriginalHook && director.oldHook && Number.isFinite(director.oldHook.yPct) && Number.isFinite(director.oldHook.hPct)) {
        // Strict masking:
        // - opaklık her koşulda 1.0
        // - genişlik tam video (outW)
        // - yükseklik: Gemini hPct * 1.5 (sızıntı olmasın)
        const baseY = outH * (Number(director.oldHook.yPct) / 100);
        const baseH = outH * (Number(director.oldHook.hPct) / 100);
        const safeH = Math.max(2, baseH * 1.5);
        // Y merkezini koru: yükseklik büyüdüyse yukarı taşı
        const safeY = baseY - (safeH - baseH) / 2;

        coverBox = {
          // biraz daha yukarı çek (padding)
          y: safeY - (outH * 0.01),
          h: safeH,
          w: outW,
          opacity: 1
        };

        // Hook'u eski yazının ortasına hizala (banner içinde)
        if (hook) {
          hook.boxOpacity = 1;
          // Banner'ı doğrudan coverBox üstüne taşı
          hook.bannerY = coverBox.y;
        }
      }
      // Eski yazı yoksa: 70–95 arası random (Gemini yanlış/vermemişse)
      if (!director.hasOriginalHook && (!Number.isFinite(hook.boxOpacity) || hook.boxOpacity <= 0)) {
        hook.boxOpacity = randRange(0.30, 0.50);
      }
    } else {
      // Fallback (Gemini hata/timeout): kod çökmesin, render devam etsin
      const titleHook = buildHookFromTitle({ title: metaTitle, isListicle: titleIsListicle });
      const seed = titleHook || fallbackHookTextForBrand(brand);
      const hookText = splitHookTwoLines(stripEmoji(makeUniqueHook(brand, seed, cache, titleIsListicle)));
      hook = { text: hookText, bannerY: 0, y: 95, boxOpacity: 1, color: null };
      finalCaption = buildFallbackCaptionFromTitle(metaTitle || fallbackCaptionForBrand(brand));
      finalHashtags = ensureHashtagPack(brand, hookText, null);
      rememberUsed(cache, 'hooks', hookText);
      rememberUsed(cache, 'captions', finalCaption);
      saveDirectorCache(cache);
      director = { caption: finalCaption, hashtags: finalHashtags };
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
      blurRegions: Array.isArray(director?.blurRegions) ? director.blurRegions : [],
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
          hook,
          coverBox,
          blurRegions: Array.isArray(director?.blurRegions) ? director.blurRegions : [],
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
      geminiAttempted: geminiKeyPresent,
      geminiKeyPresent,
      geminiUsed,
      director: director && director.error
        ? { ok: false, error: director.error }
        : director
          ? { ok: true, ...director, caption: (finalCaption || director.caption || ''), hashtags: (finalHashtags && finalHashtags.length ? finalHashtags : director.hashtags) }
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

