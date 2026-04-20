/**
 * Telif Ezici — ortak render planı (transformative kurgu, lisanslı BGM, gizlilik metadata).
 * Platform tespitini “aşmak” için değil; editoryal kalite + yasal müzik kullanımı + metadata temizliği için.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BASE_EDIT_SPEED = 1.1; // mevcut 1.10x hız
const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.wav', '.aac', '.ogg', '.flac']);

const MOBILE_DEVICE_LABELS = [
  'iPhone 13',
  'iPhone 14',
  'iPhone 15'
];

function randRange(min, max) {
  const a = Number(min);
  const b = Number(max);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return min;
  return a + Math.random() * (b - a);
}

function randInt(min, max) {
  return Math.floor(randRange(min, max + 1));
}

function pickOne(arr) {
  if (!arr || !arr.length) return '';
  return arr[Math.floor(Math.random() * arr.length)];
}

function escapeDrawtextText(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%');
}

function resolveFfprobePath(ffmpegPath, explicit) {
  if (explicit && typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  if (process.env.FFPROBE_PATH) return String(process.env.FFPROBE_PATH);
  if (ffmpegPath && typeof ffmpegPath === 'string') {
    try {
      const dir = path.dirname(ffmpegPath);
      const n = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
      const p = path.join(dir, n);
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return 'ffprobe';
}

function brandFolderKey(brand) {
  const b = String(brand || 'terapi').toLowerCase();
  if (b === 'kaos') return 'kaos';
  if (b === 'umut') return 'umut';
  return 'terapi';
}

function getCrushMusicDir(publicDir, brand) {
  const p = path.join(publicDir, 'audio', 'crush', brandFolderKey(brand));
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch {}
  return p;
}

function listMusicFiles(musicDir) {
  if (!musicDir || !fs.existsSync(musicDir)) return [];
  return fs
    .readdirSync(musicDir)
    .filter((f) => AUDIO_EXTS.has(path.extname(f).toLowerCase()))
    .map((f) => path.join(musicDir, f));
}

function pickRandomMusicFile(publicDir, brand) {
  const files = listMusicFiles(getCrushMusicDir(publicDir, brand));
  if (!files.length) return null;
  return pickOne(files);
}

function pickHookText(brand) {
  const kaos = [
    'Ending is unbelievable',
    'Watch for the end',
    'Did not expect that',
    'That ending hits hard'
  ];
  const terapi = [
    'Ending is so sweet',
    'Wait for the sweet end',
    'Watch till the end',
    'Too cute to be real'
  ];
  const umut = [
    'This moment hits different',
    'Proof people are still good',
    'Wait for the payoff',
    'Small kindness, huge impact'
  ];
  const b = String(brand || '').toLowerCase();
  if (b === 'kaos') return pickOne(kaos);
  if (b === 'umut') return pickOne(umut);
  return pickOne(terapi);
}

/** ffmpeg stderr’den Duration: 00:00:12.34 */
function probeDurationViaFfmpeg(ffmpegPath, filePath) {
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath, ['-hide_banner', '-i', filePath], {
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let err = '';
    child.stderr.on('data', (d) => {
      err += d.toString();
    });
    child.on('close', () => {
      const m = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(err);
      if (!m) return resolve(null);
      const h = Number(m[1]);
      const min = Number(m[2]);
      const sec = Number(m[3]);
      const t = h * 3600 + min * 60 + sec;
      if (!Number.isFinite(t) || t <= 0) return resolve(null);
      resolve(t);
    });
    child.on('error', () => resolve(null));
  });
}

/** ffprobe varsa süre */
function probeDurationViaFfprobe(ffprobePath, filePath) {
  if (!ffprobePath) return Promise.resolve(null);
  const fp = resolveFfprobePath(null, ffprobePath);
  return new Promise((resolve) => {
    const child = spawn(
      fp,
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        filePath
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let out = '';
    child.stdout.on('data', (d) => {
      out += d.toString();
    });
    child.on('close', (code) => {
      if (code !== 0) return resolve(null);
      const v = Number(String(out).trim());
      resolve(Number.isFinite(v) && v > 0 ? v : null);
    });
    child.on('error', () => resolve(null));
  });
}

async function probeAudioDuration(ffmpegPath, ffprobePath, filePath) {
  const a = await probeDurationViaFfprobe(ffprobePath, filePath);
  if (a) return a;
  return probeDurationViaFfmpeg(ffmpegPath, filePath);
}

function parseRFrameRateToInt(rate) {
  const s = String(rate || '').trim();
  if (!s) return null;
  const frac = s.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (frac) {
    const a = Number(frac[1]);
    const b = Number(frac[2]);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
    const v = a / b;
    const r = Math.round(v);
    return Number.isFinite(r) && r > 0 ? r : null;
  }
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

async function probeOriginalFpsInt(ffmpegPath, ffprobePath, filePath) {
  const fp = resolveFfprobePath(ffmpegPath, ffprobePath);
  return await new Promise((resolve) => {
    const child = spawn(
      fp,
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate', '-of', 'default=nw=1:nk=1', filePath],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let out = '';
    child.stdout.on('data', (d) => {
      out += d.toString();
    });
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code !== 0) return resolve(null);
      resolve(parseRFrameRateToInt(out));
    });
  });
}

function computeTargetFpsInt(orig) {
  const o = Number(orig);
  if (!Number.isFinite(o) || o <= 0) return 31;
  if (o <= 30) return Math.min(62, Math.round(o) + 1);
  if (o >= 55) return o <= 60 ? 61 : 62;
  return Math.min(62, Math.round(o) + 1);
}

function probeHasAudioStream(ffmpegPath, filePath) {
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath, ['-hide_banner', '-i', filePath], {
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let err = '';
    child.stderr.on('data', (d) => {
      err += d.toString();
    });
    child.on('close', () => {
      resolve(/\bAudio:\b/i.test(err));
    });
    child.on('error', () => resolve(false));
  });
}

function pickThreeFonts() {
  if (process.platform === 'win32') {
    return [
      // Popüler “social” fontlar (kuruluysa otomatik seçilir)
      'C:\\Windows\\Fonts\\Montserrat-Bold.ttf', // kullanıcı yüklediyse
      'C:\\Windows\\Fonts\\arialbd.ttf', // Arial Bold (Reels / IG üst yazı)
      'C:\\Windows\\Fonts\\LuckiestGuy-Regular.ttf', // kullanıcı yüklediyse
      'C:\\Windows\\Fonts\\ariblk.ttf', // Arial Black
      'C:\\Windows\\Fonts\\impact.ttf' // Impact
    ];
  }
  return [
    '/usr/share/fonts/truetype/montserrat/Montserrat-Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/freefont/FreeSansBold.ttf'
  ];
}

function pickExistingFontForDrawtext() {
  const fonts = pickThreeFonts();
  const existing = fonts.filter((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
  // Kullanıcının örnek görseline yakın "social bold" stil:
  // önce Montserrat, sonra Arial Black / Impact.
  const prefer = (existing.length ? existing : fonts).map(String);
  const montserrat = prefer.find((p) => /montserrat-bold\.ttf$/i.test(p));
  if (montserrat) return montserrat;
  const arialbd = prefer.find((p) => /arialbd\.ttf$/i.test(p));
  if (arialbd) return arialbd;
  const ariblk = prefer.find((p) => /ariblk\.ttf$/i.test(p));
  if (ariblk) return ariblk;
  const impact = prefer.find((p) => /impact\.ttf$/i.test(p));
  if (impact) return impact;
  return pickOne(prefer);
}

/** Terapi/Umut Reels üst yazısı: renkli emoji + Latin (Windows’ta Segoe UI Emoji). */
function pickFontForReelsHookDrawtext() {
  if (process.platform === 'win32') {
    const emojiFirst = [
      'C:\\Windows\\Fonts\\seguiemj.ttf',
      'C:\\Windows\\Fonts\\SegoeUIEmoji.ttf'
    ];
    for (const p of emojiFirst) {
      try {
        if (p && fs.existsSync(p)) return p;
      } catch {}
    }
  }
  const linuxEmoji = '/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf';
  try {
    if (fs.existsSync(linuxEmoji)) return linuxEmoji;
  } catch {}
  return pickExistingFontForDrawtext();
}

function sanitizeHexColor(c, fallback) {
  const s = String(c || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s;
  return fallback;
}

function titleCaseHookText(s) {
  return String(s || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
    .trim();
}

function splitHookForDisplay(hookText) {
  const words = String(hookText || '')
    .replace(/[\p{Extended_Pictographic}\uFE0F]/gu, '')
    .replace(/\u200D/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 7);
  if (!words.length) return { line1: '', line2: '' };
  if (words.length <= 2) return { line1: words.join(' '), line2: '' };
  if (words.length === 3) return { line1: words.slice(0, 2).join(' '), line2: words.slice(2).join(' ') };
  if (words.length === 4) return { line1: words.slice(0, 3).join(' '), line2: words.slice(3).join(' ') };
  if (words.length === 5) return { line1: words.slice(0, 3).join(' '), line2: words.slice(3).join(' ') };
  if (words.length === 6) return { line1: words.slice(0, 4).join(' '), line2: words.slice(4).join(' ') };
  return { line1: words.slice(0, 4).join(' '), line2: words.slice(4).join(' ') };
}

/** Instagram / Reels tarzı tuval: üstte çok satırlı hook, taşmayı sınırla. */
function wrapCaptionLinesForReels(text, maxCharsPerLine, maxLines) {
  const raw = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return [];
  const cap = Math.max(12, Math.min(48, Math.round(Number(maxCharsPerLine) || 34)));
  const lim = Math.max(1, Math.min(6, Math.round(Number(maxLines) || 5)));
  const lines = [];
  let rest = raw;
  while (rest && lines.length < lim) {
    if (rest.length <= cap) {
      lines.push(rest);
      break;
    }
    let chunk = rest.slice(0, cap);
    const sp = chunk.lastIndexOf(' ');
    if (sp > Math.floor(cap * 0.55)) chunk = rest.slice(0, sp);
    const line = chunk.trim();
    if (!line) {
      lines.push(rest.slice(0, cap));
      rest = rest.slice(cap).trim();
      continue;
    }
    lines.push(line);
    const step = chunk.length;
    if (!step) {
      lines.push(rest.slice(0, cap));
      break;
    }
    rest = rest.slice(step).trim();
  }
  return lines;
}

function trimToMaxCodepointsKeepFinalEmoji(text, maxLen) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const cps = [...s];
  if (cps.length <= maxLen) return s;
  // Try to keep a final emoji if present at end.
  const last = cps[cps.length - 1];
  const hasEmojiEnd = /[\p{Extended_Pictographic}\uFE0F]/u.test(last);
  const keepEmoji = hasEmojiEnd ? last : '';
  const budget = Math.max(1, maxLen - (keepEmoji ? 2 : 0)); // keep space + emoji
  const head = cps.slice(0, budget).join('').trimEnd();
  return keepEmoji ? `${head} ${keepEmoji}`.trim() : head.trim();
}

/**
 * Yeni hook kuralı:
 * - Toplam max 55 karakter (codepoint)
 * - 29'u geçince (30. karakter) kelime bölmeden alt satıra geçir.
 * - Eğer tek kelimeyse, kelimenin tamamı alt satıra insin.
 */
function splitHookIntoLines55(text) {
  const s0 = trimToMaxCodepointsKeepFinalEmoji(text, 55);
  if (!s0) return [];
  const cps = [...s0];
  if (cps.length <= 29) return [s0];
  if (!/\s/.test(s0)) return ['', s0]; // tek kelime: komple yeni satıra
  // break near 30 without splitting a word
  const limit = 29;
  const left = cps.slice(0, limit + 1).join('');
  let br = left.lastIndexOf(' ');
  if (br < 6) {
    // fallback: first space after limit
    br = s0.indexOf(' ', limit);
  }
  if (br < 0) return ['', s0];
  const l1 = s0.slice(0, br).trim();
  const l2 = s0.slice(br + 1).trim();
  if (!l1) return ['', l2];
  return l2 ? [l1, l2] : [l1];
}

/**
 * Terapi/Umut: kesin dikey tuval (outW×outH, tipik 1080×1920).
 * Üstte 120px beyaz başlık şeridi + emojili hook, altta pastel tuval üzerinde video.
 * Arka planda 45° çapraz marka pattern sadece boşluklarda görünür (video üstüne binmez).
 * Girdi [v0], çıkış [v1].
 */
function buildReelsInstagramCanvasFilters({
  brandNorm,
  outW,
  outH,
  fontPart,
  hookEnable,
  escapedLines,
  frameFileExists
}) {
  const sy = outH / 1920;
  const sx = outW / 1080;
  const s = Math.min(sx, sy);
  // Premium frame PNG window geometry (matches public/terapi_zrh_arka_plan.png)
  // window: x=113,y=412,w=853,h=1229 on 1080×1920
  const wx = Math.round(113 * sx);
  const wy = Math.round(412 * sy);
  const ww = Math.round(853 * sx);
  const wh = Math.round(1229 * sy);
  const fontSize = Math.max(20, Math.round(44 * s));
  const lineStep = Math.max(Math.round(fontSize * 1.30), fontSize + 4);
  const maxCapLines = 2;
  const lines = (escapedLines || []).slice(0, maxCapLines);
  const padX = Math.max(18, Math.round(52 * sx));
  const blockH = lines.length ? ((lines.length - 1) * lineStep + Math.round(fontSize * 1.08)) : Math.round(fontSize * 1.08);
  const hookYTop = Math.max(Math.round(18 * sy), Math.round(wy - Math.round(14 * sy) - blockH));

  // Reels frame mode requires the 2nd video input [1:v] (frame).
  // If it's missing, fall back to a safe solid background.
  const bgHex = brandNorm === 'umut' ? '0xF5F5F5' : '0xF0F8FF';

  const parts = frameFileExists ? [
    `color=c=white:s=${outW}x${outH}:d=99999[base]`,
    `[1:v]scale=${outW}:${outH},format=rgba,setsar=1[frame]`,
    `[v0]scale=${ww}:${wh}:force_original_aspect_ratio=increase,crop=${ww}:${wh},setsar=1[vid]`,
    `[base][vid]overlay=x=${wx}:y=${wy}:shortest=1[vb]`,
    `[vb][frame]overlay=x=0:y=0:format=auto[vt0]`
  ] : [
    `color=c=${bgHex}:s=${outW}x${outH}:d=99999[bg]`,
    `[v0]scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH},setsar=1[vid]`,
    `[bg][vid]overlay=x=(W-w)/2:y=(H-h)/2:shortest=1[vt0]`
  ];
  if (!lines.length) {
    parts.push(`[vt0]format=yuv420p[v1]`);
    return parts;
  }
  let cur = 'vt0';
  lines.forEach((line, i) => {
    const last = i === lines.length - 1;
    const next = last ? 'v1b' : `vth${i}`;
    const y = hookYTop + i * lineStep;
    parts.push(
      `[${cur}]drawtext=text='${line}'${fontPart}:fontsize=${fontSize}:fontcolor=0x1a1a1a:` +
        `fix_bounds=1:text_shaping=1:` +
        `x='max(${padX}\\,min((w-text_w)/2\\,w-text_w-${padX}))':y=${y}:enable='${hookEnable}'[${next}]`
    );
    cur = next;
  });
  parts.push(`[${cur}]format=yuv420p[v1]`);
  return parts;
}

/** ±%2–%4 hız varyasyonu (1.0 etrafında) */
function pickSpeedRampFactor() {
  const sign = Math.random() < 0.5 ? -1 : 1;
  const mag = randRange(0.02, 0.04);
  return 1 + sign * mag;
}

function buildCreationTimeUtc() {
  // Her zaman işlem anı (şimdi)
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}.000000Z`
  );
}

function buildMetadataArgs() {
  const device = pickOne(MOBILE_DEVICE_LABELS);
  const ct = buildCreationTimeUtc();
  return [
    '-map_metadata',
    '-1',
    '-map_chapters',
    '-1',
    '-metadata',
    `creation_time=${ct}`,
    '-metadata',
    'handler_name=VideoHandler',
    '-metadata',
    `encoder=Viral Atölyesi — ${device}`
  ];
}

/**
 * Tek render: filter_complex + ffmpeg argümanları.
 * @param {object} o
 * @param {string} o.inFile
 * @param {string} o.wmFile
 * @param {string|null} o.musicFile
 * @param {string} o.brand
 * @param {number} o.outW
 * @param {number} o.outH
 * @param {number} o.sourceDurSec kaynak video süresi (saniye; kısa video aracı için max 60)
 * @param {boolean} o.hasAudio
 * @param {string} o.ffmpegPath
 * @param {string|null} o.ffprobePath
 * @param {boolean} o.useRubberband local true
 */
function clampDur(n, lo, hi) {
  const x = Number(n);
  if (!Number.isFinite(x)) return lo;
  return Math.min(hi, Math.max(lo, x));
}

const MANUAL_BLUR_REF_W = 720;
const MANUAL_BLUR_REF_H = 1280;

/** İstek gövdesinden {x,y,w,h} dizisi (px, 720×1280 referansı). */
function parseManualBlurRectsInput(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const x = Math.round(Number(r.x));
    const y = Math.round(Number(r.y));
    const w = Math.round(Number(r.w));
    const h = Math.round(Number(r.h));
    if (![x, y, w, h].every((n) => Number.isFinite(n))) continue;
    if (w < 4 || h < 4) continue;
    const x0 = Math.max(0, Math.min(MANUAL_BLUR_REF_W - 1, x));
    const y0 = Math.max(0, Math.min(MANUAL_BLUR_REF_H - 1, y));
    const w0 = Math.max(4, Math.min(MANUAL_BLUR_REF_W - x0, w));
    const h0 = Math.max(4, Math.min(MANUAL_BLUR_REF_H - y0, h));
    out.push({ x: x0, y: y0, w: w0, h: h0 });
  }
  return out.slice(0, 10);
}

/** 720×1280 px alanı → gerçek çıktı çözünürlüğü (outW×outH). */
function scaleManualBlurRectsToOutputPx(rects, refW, refH, outW, outH) {
  const rw = Math.max(1, Number(refW) || MANUAL_BLUR_REF_W);
  const rh = Math.max(1, Number(refH) || MANUAL_BLUR_REF_H);
  const sx = outW / rw;
  const sy = outH / rh;
  return (rects || []).map((r) => ({
    x: Math.round(r.x * sx),
    y: Math.round(r.y * sy),
    w: Math.round(r.w * sx),
    h: Math.round(r.h * sy)
  }));
}

/**
 * outW×outH akışında manuel dikdörtgenler — delogo zinciri (ilk scale+crop sonrası).
 * @param {string} inputLabel
 * @param {Array<{x:number,y:number,w:number,h:number}>} rects çıktı pikseli (outW×outH)
 * @param {number} outW
 * @param {number} outH
 * @param {string} finalLabel
 * @returns {{ chain: string, outLabel: string }}
 */
function buildManualBlurDelogoChain(inputLabel, rects, outW, outH, finalLabel) {
  const list = (rects || []).filter((r) =>
    r &&
    Number.isFinite(r.x) &&
    Number.isFinite(r.y) &&
    Number.isFinite(r.w) &&
    Number.isFinite(r.h) &&
    r.w >= 8 &&
    r.h >= 8
  ).slice(0, 10);
  if (!list.length) return { chain: '', outLabel: inputLabel };

  const parts = [];
  let cur = inputLabel;
  list.forEach((r, i) => {
    const x = Math.max(0, Math.min(outW - 2, Math.round(r.x)));
    const y = Math.max(0, Math.min(outH - 2, Math.round(r.y)));
    let w = Math.min(outW - x, Math.max(8, Math.round(r.w)));
    let h = Math.min(outH - y, Math.max(8, Math.round(r.h)));
    w -= w % 2;
    h -= h % 2;
    if (w < 8 || h < 8) return;
    const nextLab = i === list.length - 1 ? finalLabel : `dlb${i}`;
    // Bazı Windows FFmpeg derlemelerinde delogo "band" seçeneği yok — sadece x,y,w,h (+ show).
    parts.push(`[${cur}]delogo=x=${x}:y=${y}:w=${w}:h=${h}:show=0[${nextLab}]`);
    cur = nextLab;
  });
  if (!parts.length) return { chain: '', outLabel: inputLabel };
  return { chain: parts.join(';'), outLabel: finalLabel };
}

async function buildCrushRenderPlan(o) {
  const {
    inFile,
    wmFile,
    musicFile,
    brand,
    outW,
    outH,
    sourceDurSec,
    hook,
    coverBox,
    hasAudio,
    ffmpegPath,
    ffprobePath,
    useRubberband
  } = o;

  const brandNorm = brandFolderKey(brand);
  const useLabFrame =
    (brandNorm === 'terapi' || brandNorm === 'umut' || brandNorm === 'kaos') && o.useReelsInstagramCanvas !== false;
  const useReelsInstagramCanvas =
    (brandNorm === 'terapi' || brandNorm === 'umut') && o.useReelsInstagramCanvas !== false;
  const framePng = useLabFrame
    ? path.join(
        __dirname,
        'public',
        brandNorm === 'kaos'
          ? 'kaos_zrh_arka_plan.png'
          : (brandNorm === 'umut' ? 'umut_zrh_arka_plan.png' : 'terapi_zrh_arka_plan.png')
      )
    : null;
  const frameExists = !!(framePng && fs.existsSync(framePng));

  // Watermark boyutu yarıya indir
  const wmSize = outW >= 1080 ? 55 : 48;
  // Watermark: eski basit opaklık + tek ek: DVD gibi köşelerden seken hareket + hafif rastgele eğim
  const wmMargin = 10;
  // Hızı yarıya düşür (daha sakin hareket)
  const wmBounceVx = randRange(0.055, 0.10);
  const wmBounceVy = randRange(0.050, 0.095);
  // t=0’da farklı köşelere yakın başlat (px,py ∈ {0,1} → abs(mod(px,2)-1) ile min/max)
  const corner = pickOne([
    { px: 1, py: 1 },
    { px: 0, py: 1 },
    { px: 1, py: 0 },
    { px: 0, py: 0 }
  ]);
  const phaseX = Math.min(1.98, Math.max(0.02, corner.px + randRange(-0.08, 0.08)));
  const phaseY = Math.min(1.98, Math.max(0.02, corner.py + randRange(-0.08, 0.08)));
  const tiltAmp = randRange(0.09, 0.22);
  const tiltPeriod = randRange(7.6, 17.0);
  const tiltRotateExpr = `${tiltAmp.toFixed(4)}*sin(2*PI*t/${tiltPeriod.toFixed(3)})`;
  // filtergraph içinde virgül seçenek ayırıcı; mod(a\,2) içindeki virgül kaçırılmalı
  const wmComma = '\\,';
  // Merkez kaçınma (ilk 2 bounce): ekranın orta %30 çevresi (0.35..0.65) bölgesine girmesin.
  // p = abs(mod(u,2)-1) ∈ [0..1]; hit=floor(u) bounce sayacı gibi davranır.
  // hit<2 iken p' = [0..0.35] U [0.65..1] (ortayı atla).
  const uXExpr = `${wmBounceVx.toFixed(4)}*t+(${phaseX.toFixed(4)})`;
  const pXExpr = `abs(mod(${uXExpr}${wmComma}2)-1)`;
  const hitXExpr = `floor(${uXExpr})`;
  const pXSafeExpr = `if(lt(${hitXExpr},2),if(lt(${pXExpr},0.5),${pXExpr}*0.7,0.65+(${pXExpr}-0.5)*0.7),${pXExpr})`;
  const wmXExpr = `${wmMargin}+(W-w-2*${wmMargin})*(${pXSafeExpr})`;

  const uYExpr = `${wmBounceVy.toFixed(4)}*t+(${phaseY.toFixed(4)})`;
  const pYExpr = `abs(mod(${uYExpr}${wmComma}2)-1)`;
  const hitYExpr = `floor(${uYExpr})`;
  const pYSafeExpr = `if(lt(${hitYExpr},2),if(lt(${pYExpr},0.5),${pYExpr}*0.7,0.65+(${pYExpr}-0.5)*0.7),${pYExpr})`;
  const wmYExpr = `${wmMargin}+(H-h-2*${wmMargin})*(${pYSafeExpr})`;
  const speedRamp = pickSpeedRampFactor();
  const effectiveSpeed = BASE_EDIT_SPEED * speedRamp;
  const inDur = clampDur(sourceDurSec, 1, 60);
  const outDur = Math.min(60, Math.max(1, inDur / effectiveSpeed));

  const origFps = (await probeOriginalFpsInt(ffmpegPath, ffprobePath, inFile)) || 30;
  const targetFps = computeTargetFpsInt(origFps);

  const edge = randInt(4, 6);
  const cropW = Math.max(16, outW - 2 * edge);
  const cropH = Math.max(16, outH - 2 * edge);

  const zoom = useReelsInstagramCanvas ? randRange(1.02, 1.05) : randRange(1.04, 1.08);
  const contrast = randRange(1.03, 1.09);
  const saturation = randRange(1.05, 1.15);
  const brightness = randRange(-0.02, 0.04);

  const uniqHex = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
  const uniqAlpha = 0.08;
  const noiseOpacity = 0.005;
  const grainOpacity = 0.018;
  // Saydamlığı bir tık arttır (daha transparan)
  const wmAlphaFinal = randRange(0.30, 0.42);

  const hookText = pickHookText(brand);
  // Director yoksa: istenen aralık (70–95) içinde konumlandır.
  const hookY = Number.isFinite(hook?.y) ? Math.round(hook.y) : Math.round(randRange(70, 95));
  function stripAllEmoji(s) {
    return String(s || '')
      .replace(/[\p{Extended_Pictographic}\uFE0F]/gu, '')
      .replace(/\u200D/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
  // Apostrof / ters tek-tırnak ffmpeg drawtext parser'ını (bu build'de) bozuyor.
  const sanitizeHookForDrawtext = (s) => String(s || '')
    .replace(/['\u2018\u2019\u02BC\u0060\u00B4]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const rawHook =
    (hook && typeof hook.text === 'string' && hook.text.trim())
      ? hook.text.trim()
      : hookText;
  const hookTextFinal = sanitizeHookForDrawtext(
    useReelsInstagramCanvas ? String(rawHook || '') : stripAllEmoji(rawHook)
  );
  const hookTextBandStyled = useLabFrame ? hookTextFinal : titleCaseHookText(hookTextFinal);
  const hookDisplay = splitHookForDisplay(hookTextBandStyled);
  const hookColorPool = ['#FFFFFF', '#FFD400', '#9BFF57']; // Beyaz / Sarı / Açık yeşil
  const hookColor = sanitizeHexColor(hook?.color, pickOne(hookColorPool));
  const hookAlpha = randRange(0.88, 0.94);
  const boxOpacity =
    typeof hook?.boxOpacity === 'number' && Number.isFinite(hook.boxOpacity)
      ? Math.max(0, Math.min(1, hook.boxOpacity))
      : 0.38;

  let cover = coverBox && Number.isFinite(coverBox.y) && Number.isFinite(coverBox.h)
    ? {
        y: Math.max(0, Math.min(outH - 2, Math.round(coverBox.y))),
        h: Math.max(2, Math.min(outH, Math.round(coverBox.h))),
        opacity: typeof coverBox.opacity === 'number' && Number.isFinite(coverBox.opacity)
          ? Math.max(0, Math.min(1, coverBox.opacity))
          : 1
      }
    : null;

  // KAOS: üst hook için opak siyah bant (eski davranış). Terapi/Umut: yalnızca gelen coverBox ile bant.
  if (String(brand || '').toLowerCase() === 'kaos' && !cover) {
    const bandH = Math.max(140, Math.min(520, Math.round(outH * 0.22)));
    cover = { y: 0, h: bandH, w: outW, opacity: 1 };
  }

  const syntheticKaosTopBand =
    String(brand || '').toLowerCase() === 'kaos' &&
    !!cover &&
    !(coverBox && Number.isFinite(coverBox.y) && Number.isFinite(coverBox.h));

  // Force-mask hybrid:
  // - cover varsa: opak siyah bant + hook bant üzerinde
  // - cover yoksa: bantsız, konturlu + gölgeli hook
  const hasBand = !!cover;
  const bannerYPxOverride = syntheticKaosTopBand
    ? cover.y
    : Number.isFinite(hook?.bannerY)
      ? Math.round(hook.bannerY)
      : null;
  const bannerY = Math.max(0, Math.min(outH - 2, bannerYPxOverride != null ? bannerYPxOverride : (cover ? cover.y : 0)));
  const bannerH = cover ? cover.h : 0;
  const bandSidePad = 52;
  const hookCharCount = Math.max(1, String(hookTextBandStyled || '').length);
  const hasTwoBandLines = !!(hookDisplay.line1 && hookDisplay.line2);
  // Bant içindeki yazıyı hem bant yüksekliğine hem yaklaşık satır genişliğine göre büyüt.
  const bandFontSizeByHeight = hasBand
    ? (hasTwoBandLines ? (bannerH * 0.315) : (bannerH * 0.565))
    : 44;
  const bandFontSizeByWidth = hasBand ? ((outW - (bandSidePad * 2)) / Math.max(6, hookCharCount * (hasTwoBandLines ? 0.50 : 0.70))) : 44;
  const bandFontSize = hasBand
    ? Math.round(Math.max(32, Math.min(80, Math.min(bandFontSizeByHeight, bandFontSizeByWidth))))
    : 44;
  const lineGap = Math.max(6, Math.round(bandFontSize * 0.08));
  const twoLineBlockH = (bandFontSize * 2) + lineGap;
  const bannerTextY = Math.max(0, Math.round(bannerY + (bannerH - bandFontSize) / 2));
  const bannerTextTopY = Math.max(0, Math.round(bannerY + (bannerH - twoLineBlockH) / 2));
  const bannerTextBottomY = bannerTextTopY + bandFontSize + lineGap;
  const noBandTextY = Math.max(18, Math.round(outH * 0.06)); // üst-orta profesyonel yerleşim
  const noBandSidePad = 100;
  const noBandFontSize = 44;
  const noBandLineGap = Math.max(6, Math.round(noBandFontSize * 0.10));
  const noBandTwoLineBlockH = (noBandFontSize * 2) + noBandLineGap;
  const noBandTextTopY = Math.max(18, Math.round(outH * 0.055));
  const noBandTextBottomY = noBandTextTopY + noBandFontSize + noBandLineGap;

  const fontFile = useLabFrame ? pickFontForReelsHookDrawtext() : pickExistingFontForDrawtext();
  const fontPart = fontFile
    ? `:fontfile='${escapeDrawtextText(fontFile.replace(/\\/g, '/'))}'`
    : '';

  const hookEnable = "between(t,0,1e9)";
  const coverFillOpacity = cover ? 1.0 : 0;
  const bandLine1Color = '#FFFFFF';
  const bandLine2Color = (brand === 'kaos') ? '#FFB38A' : ((brand === 'umut') ? '#9BFF57' : '#FFD400');
  const bandShadow = 'black@0.45';

  // hflip kapalı: yakılmış (burned-in) yazı pikseldir; altyazı akışı yoksa tespit edilemez, flip metni ters çevirir.
  const rawManual = parseManualBlurRectsInput(o.manual_blur_rects ?? o.manualBlurRects ?? []);
  const ubRects = scaleManualBlurRectsToOutputPx(rawManual, o.manualBlurRefW, o.manualBlurRefH, outW, outH);
  const ubChain = buildManualBlurDelogoChain('v0base', ubRects, outW, outH, 'v0postblur');

  let vChain = `[0:v]setpts=PTS-STARTPTS,fps=${targetFps}`;
  vChain += `,scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH}[v0base]`;
  if (ubChain.chain) {
    vChain += `;${ubChain.chain}`;
  } else {
    vChain += `;[v0base]crop=${outW}:${outH}:0:0[v0postblur]`;
  }
  vChain +=
    `;[v0postblur]crop=${cropW}:${cropH}:(iw-ow)/2:(ih-oh)/2` +
    `,scale=iw*${zoom.toFixed(4)}:ih*${zoom.toFixed(4)},crop=${outW}:${outH}` +
    `,eq=contrast=${contrast.toFixed(4)}:saturation=${saturation.toFixed(4)}:brightness=${brightness.toFixed(4)}` +
    // Zoom kaynaklı yumuşamayı hafif toparla (çok agresif değil)
    `,unsharp=5:5:0.70:3:3:0.35` +
    `,setsar=1,setpts=PTS/${effectiveSpeed.toFixed(6)},trim=0:${outDur.toFixed(3)},setpts=PTS-STARTPTS[v0]`;

  let baseLabel = cover ? 'vcover' : 'v0u';

  const capChars = Math.max(18, Math.round(34 * (outW / 1080)));
  const reelsEscapedLines = useLabFrame
    ? splitHookIntoLines55(hookTextBandStyled).map((ln) => escapeDrawtextText(String(ln || '').trim()))
    : [];

  const noiseOpEff = useReelsInstagramCanvas ? 0.002 : noiseOpacity;
  const grainOpEff = useReelsInstagramCanvas ? 0.006 : grainOpacity;

  const wmInputIdx = frameExists ? 2 : 1;
  const tailWmAndGrain = [
    `[${wmInputIdx}:v]scale=${wmSize}:${wmSize}:force_original_aspect_ratio=decrease,format=rgba,` +
      `pad=${wmSize}:${wmSize}:(ow-iw)/2:(oh-ih)/2:color=black@0,` +
      `rotate='${tiltRotateExpr}':c=none:ow=iw:oh=ih[wm0]`,
    // Watermark’ı tam yuvarlak “top” gibi yap: dairesel alpha mask
    `[wm0]split=2[wmA][wmB]`,
    `[wmA]alphaextract,geq=lum='if(lte((X-W/2)*(X-W/2)+(Y-H/2)*(Y-H/2),(min(W,H)/2)*(min(W,H)/2)),255,0)'[wmMask]`,
    `[wmB][wmMask]alphamerge,format=rgba,colorchannelmixer=aa=${wmAlphaFinal.toFixed(4)}[wm]`,
    `[v1][wm]overlay=x='${wmXExpr}':y='${wmYExpr}':format=auto[v1m]`,
    `[v1m]split=2[vA][vB]`,
    `[vB]noise=alls=10:allf=t+u,format=yuv420p[vN]`,
    `[vA][vN]blend=all_mode=overlay:all_opacity=${noiseOpEff},format=yuv420p[vblend]`,
    `[vblend]split=2[vC][vD]`,
    `[vD]noise=alls=3:allf=t+u,format=yuv420p[vGrain]`,
    `[vC][vGrain]blend=all_mode=overlay:all_opacity=${grainOpEff},format=yuv420p[vpre]`,
    useReelsInstagramCanvas
      ? `[vpre]format=yuv420p[v]`
      : `[vpre]vignette=PI/10:eval=frame,format=yuv420p[v]`
  ];

  const legacyVisualStack = [
    `color=c=#${uniqHex}@${uniqAlpha}:s=${outW}x${outH}:d=1[uniq]`,
    `[v0][uniq]overlay=0:0:enable='eq(n,0)'[v0u]`,
    ...(cover
      ? [`[v0u]drawbox=x=0:y=${cover.y}:w=${outW}:h=${cover.h}:color=black@${coverFillOpacity.toFixed(3)}:t=fill[vcover]`]
      : []),
    ...(hasBand
      ? [
          `[${baseLabel}]drawbox=x=0:y=${bannerY}:w=${outW}:h=${bannerH}:color=black@1.000:t=fill[vtop]`,
          ...(hasTwoBandLines
            ? [
                `[vtop]drawtext=text='${escapeDrawtextText(hookDisplay.line1)}'${fontPart}:` +
                  `fontcolor=${bandLine1Color}@1.000:fontsize=${bandFontSize}:borderw=2:bordercolor=black@0.70:` +
                  `shadowcolor=${bandShadow}:shadowx=2:shadowy=2:` +
                  `fix_bounds=1:text_shaping=1:` +
                  `x='max(${bandSidePad}\\,min((w-text_w)/2\\,w-text_w-${bandSidePad}))':y=${bannerTextTopY}:enable='${hookEnable}'[vline1]`,
                `[vline1]drawtext=text='${escapeDrawtextText(hookDisplay.line2)}'${fontPart}:` +
                  `fontcolor=${bandLine2Color}@1.000:fontsize=${bandFontSize}:borderw=2:bordercolor=black@0.70:` +
                  `shadowcolor=${bandShadow}:shadowx=2:shadowy=2:` +
                  `fix_bounds=1:text_shaping=1:` +
                  `x='max(${bandSidePad}\\,min((w-text_w)/2\\,w-text_w-${bandSidePad}))':y=${bannerTextBottomY}:enable='${hookEnable}'[v1]`
              ]
            : [
                `[vtop]drawtext=text='${escapeDrawtextText(hookTextBandStyled)}'${fontPart}:` +
                  `fontcolor=${bandLine1Color}@1.000:fontsize=${bandFontSize}:borderw=2:bordercolor=black@0.70:` +
                  `shadowcolor=${bandShadow}:shadowx=2:shadowy=2:` +
                  `fix_bounds=1:text_shaping=1:` +
                  `x='max(${bandSidePad}\\,min((w-text_w)/2\\,w-text_w-${bandSidePad}))':y=${bannerTextY}:enable='${hookEnable}'[v1]`
              ])
        ]
      : [
          ...(hookDisplay.line2
            ? [
                `[${baseLabel}]drawtext=text='${escapeDrawtextText(hookDisplay.line1)}'${fontPart}:` +
                  `fontcolor=white@1.000:fontsize=${noBandFontSize}:borderw=3:bordercolor=black@1.000:` +
                  `shadowcolor=black@0.6:shadowx=2:shadowy=2:` +
                  `fix_bounds=1:text_shaping=1:` +
                  `x='max(${noBandSidePad}\\,min((w-text_w)/2\\,w-text_w-${noBandSidePad}))':y=${noBandTextTopY}:` +
                  `enable='${hookEnable}'[vline1]`,
                `[vline1]drawtext=text='${escapeDrawtextText(hookDisplay.line2)}'${fontPart}:` +
                  `fontcolor=white@1.000:fontsize=${noBandFontSize}:borderw=3:bordercolor=black@1.000:` +
                  `shadowcolor=black@0.6:shadowx=2:shadowy=2:` +
                  `fix_bounds=1:text_shaping=1:` +
                  `x='max(${noBandSidePad}\\,min((w-text_w)/2\\,w-text_w-${noBandSidePad}))':y=${noBandTextBottomY}:` +
                  `enable='${hookEnable}'[v1]`
              ]
            : [
                // No-band, outline + shadow ile okunaklı yazı
                `[${baseLabel}]drawtext=text='${escapeDrawtextText(hookTextBandStyled)}'${fontPart}:` +
                  `fontcolor=white@1.000:fontsize=${noBandFontSize}:borderw=3:bordercolor=black@1.000:` +
                  `shadowcolor=black@0.6:shadowx=2:shadowy=2:` +
                  `fix_bounds=1:text_shaping=1:` +
                  `x='max(${noBandSidePad}\\,min((w-text_w)/2\\,w-text_w-${noBandSidePad}))':y=${noBandTextY}:` +
                  `enable='${hookEnable}'[v1]`
              ])
        ])
  ];

  const parts = [
    vChain,
    ...(useLabFrame
      ? buildReelsInstagramCanvasFilters({
          brandNorm,
          outW,
          outH,
          fontPart,
          hookEnable,
          escapedLines: reelsEscapedLines,
          frameFileExists: frameExists
        })
      : legacyVisualStack),
    ...tailWmAndGrain
  ];

  const semitone = -0.4;
  const pitchFactor = Math.pow(2, semitone / 12);

  let audioFilter = '';
  let mapAudioOut = hasAudio;

  if (hasAudio) {
    const bumpDur = 0.25;
    const bump = (t) => `between(t,${t.toFixed(3)},${(t + bumpDur).toFixed(3)})`;
    const volExpr = `if(${bump(3)}+${bump(8)}+${bump(10)},1.02,1)`;

    if (musicFile && fs.existsSync(musicFile)) {
      const musicDur = (await probeAudioDuration(ffmpegPath, ffprobePath, musicFile)) || 120;
      const maxStart = Math.max(0, musicDur - 0.25);
      const musicStart = Math.random() * maxStart;
      const bgVol = randRange(0.07, 0.1);

      const musicInputIdx = frameExists ? 3 : 2;
      if (useRubberband) {
        audioFilter =
          `[0:a]asetpts=PTS-STARTPTS,` +
          `rubberband=tempo=${effectiveSpeed.toFixed(6)}:pitch=${pitchFactor.toFixed(8)},` +
          `volume='${volExpr}',` +
          `aformat=sample_fmts=fltp:channel_layouts=stereo,` +
          `apad=pad_dur=${(outDur + 0.5).toFixed(3)},` +
          `atrim=0:${outDur.toFixed(3)},asetpts=PTS-STARTPTS[a0];` +
          `[${musicInputIdx}:a]atrim=start=${musicStart.toFixed(3)}:duration=${outDur.toFixed(3)},asetpts=PTS-STARTPTS,` +
          `aformat=sample_fmts=fltp:channel_layouts=stereo,` +
          `volume=${bgVol.toFixed(4)}[bg];` +
          `[a0][bg]amix=inputs=2:duration=first:normalize=0[a]`;
      } else {
        audioFilter =
          `[0:a]asetpts=PTS-STARTPTS,` +
          `atempo=${effectiveSpeed.toFixed(6)},` +
          `volume='${volExpr}',` +
          `aformat=sample_fmts=fltp:channel_layouts=stereo,` +
          `apad=pad_dur=${(outDur + 0.5).toFixed(3)},` +
          `atrim=0:${outDur.toFixed(3)},asetpts=PTS-STARTPTS[a0];` +
          `[${musicInputIdx}:a]atrim=start=${musicStart.toFixed(3)}:duration=${outDur.toFixed(3)},asetpts=PTS-STARTPTS,` +
          `aformat=sample_fmts=fltp:channel_layouts=stereo,` +
          `volume=${bgVol.toFixed(4)}[bg];` +
          `[a0][bg]amix=inputs=2:duration=first:normalize=0[a]`;
      }
      parts.push(audioFilter);
    } else {
      if (useRubberband) {
        parts.push(
          `[0:a]asetpts=PTS-STARTPTS,` +
            `rubberband=tempo=${effectiveSpeed.toFixed(6)}:pitch=${pitchFactor.toFixed(8)},` +
            `volume='${volExpr}',` +
            `apad=pad_dur=${(outDur + 0.5).toFixed(3)},` +
            `atrim=0:${outDur.toFixed(3)},asetpts=PTS-STARTPTS[a]`
        );
      } else {
        parts.push(
          `[0:a]asetpts=PTS-STARTPTS,` +
            `atempo=${effectiveSpeed.toFixed(6)},` +
            `volume='${volExpr}',` +
            `apad=pad_dur=${(outDur + 0.5).toFixed(3)},` +
            `atrim=0:${outDur.toFixed(3)},asetpts=PTS-STARTPTS[a]`
        );
      }
    }
  } else if (musicFile && fs.existsSync(musicFile)) {
    const musicDur = (await probeAudioDuration(ffmpegPath, ffprobePath, musicFile)) || 120;
    const maxStart = Math.max(0, musicDur - 0.25);
    const musicStart = Math.random() * maxStart;
    const bgVol = randRange(0.07, 0.1);
    const musicInputIdx = frameExists ? 3 : 2;
    parts.push(
      `[${musicInputIdx}:a]atrim=start=${musicStart.toFixed(3)}:duration=${outDur.toFixed(3)},asetpts=PTS-STARTPTS,` +
        `aformat=sample_fmts=fltp:channel_layouts=stereo,` +
        `volume=${bgVol.toFixed(4)}[a]`
    );
    mapAudioOut = true;
  }

  const filterComplex = parts.join(';');

  const inputs = ['-y', '-i', inFile];
  if (frameExists) inputs.push('-loop', '1', '-i', framePng);
  inputs.push('-loop', '1', '-i', wmFile);
  if (musicFile && fs.existsSync(musicFile)) {
    inputs.push('-stream_loop', '-1', '-i', musicFile);
  }

  const ffArgs = [
    ...inputs,
    '-filter_complex',
    filterComplex,
    '-map',
    '[v]',
    ...(mapAudioOut ? ['-map', '[a]'] : []),
    '-t',
    outDur.toFixed(3),
    '-fps_mode',
    'cfr',
    '-r',
    String(targetFps),
    '-c:v',
    'libx264',
    '-preset',
    'slower',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    // Bitrate’i sosyal medya standardının altına düşürme (yaklaşık 8–10 Mbps)
    '-b:v',
    '8M',
    '-minrate',
    '8M',
    '-maxrate',
    '10M',
    '-bufsize',
    '20M',
    '-movflags',
    '+faststart',
    ...buildMetadataArgs(),
    ...(mapAudioOut ? ['-c:a', 'aac', '-b:a', '128k'] : [])
  ];

  return {
    ffmpegArgsTail: ffArgs,
    debug: {
      speedRamp,
      effectiveSpeed: Number(effectiveSpeed.toFixed(6)),
      horizontalFlip: false,
      originalFps: origFps,
      targetFps,
      outDurSec: Number(outDur.toFixed(3)),
      edge,
      manualBlurCount: ubRects.length,
      musicFile: musicFile && fs.existsSync(musicFile) ? path.basename(musicFile) : null,
      hookFont: fontFile ? path.basename(fontFile) : null
    }
  };
}

async function selfCheckCrushOutput(ffmpegPath, ffprobePath, outFile) {
  const checks = [];
  let ok = true;
  if (!fs.existsSync(outFile)) {
    return { ok: false, checks: [{ name: 'dosya', ok: false, detail: 'yok' }] };
  }
  const st = fs.statSync(outFile);
  checks.push({ name: 'boyut>0', ok: st.size > 1000, detail: String(st.size) });
  if (!checks[checks.length - 1].ok) ok = false;

  const dur = await probeDurationViaFfprobe(ffprobePath, outFile).then((d) => d || probeDurationViaFfmpeg(ffmpegPath, outFile));
  checks.push({ name: 'süre', ok: !!(dur && dur > 0.2), detail: dur != null ? String(dur) : '?' });
  if (!checks[checks.length - 1].ok) ok = false;

  const hasV = await new Promise((resolve) => {
    const child = spawn(
      ffprobePath && fs.existsSync(ffprobePath) ? ffprobePath : ffmpegPath,
      ffprobePath && fs.existsSync(ffprobePath)
        ? ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', outFile]
        : ['-hide_banner', '-i', outFile],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let o = '';
    let e = '';
    child.stdout.on('data', (d) => {
      o += d.toString();
    });
    child.stderr.on('data', (d) => {
      e += d.toString();
    });
    child.on('close', () => {
      if (ffprobePath && fs.existsSync(ffprobePath)) {
        resolve(String(o).trim().length > 0);
      } else {
        resolve(/Video:\s/.test(e));
      }
    });
    child.on('error', () => resolve(false));
  });
  checks.push({ name: 'video-akışı', ok: hasV, detail: hasV ? 'var' : 'yok' });
  if (!hasV) ok = false;

  return { ok, checks };
}

module.exports = {
  getCrushMusicDir,
  listMusicFiles,
  pickRandomMusicFile,
  buildCrushRenderPlan,
  selfCheckCrushOutput,
  probeHasAudioStream,
  probeAudioDuration,
  probeContainerDurationSec: probeDurationViaFfmpeg,
  buildMetadataArgs,
  BASE_EDIT_SPEED,
  AUDIO_EXTS,
  parseManualBlurRectsInput,
  scaleManualBlurRectsToOutputPx,
  MANUAL_BLUR_REF_W,
  MANUAL_BLUR_REF_H
};
