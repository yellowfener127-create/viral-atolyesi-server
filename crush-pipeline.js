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
  frameFileExists,
  cropYNudgeRefPx = 0,
  windowShiftYRefPx = 0,
  hookXOffsetRefPx = 0,
  hookYOffsetRefPx = 0
}) {
  const sy = outH / 1920;
  const sx = outW / 1080;
  const s = Math.min(sx, sy);
  // Frame window geometry (1080×1920 referans).
  // Therapy (terapi): mevcut “düzgün” yerleşimi bozma — eski sabit pencere.
  // Chaos/Hope: video tam beyaz pencerenin içine otursun (taşma yok) — gerçek pencere bbox.
  const win =
    brandNorm === 'kaos'
      ? { x: 94, y: 353, w: 890, h: 1366 }
      : brandNorm === 'umut'
        ? { x: 60, y: 390, w: 959, h: 1331 }
        : { x: 113, y: 412, w: 853, h: 1229 };
  const wx = Math.round(win.x * sx);
  const wy = Math.round(win.y * sy);
  const ww = Math.round(win.w * sx);
  const wh = Math.round(win.h * sy);
  const fontSize = Math.max(20, Math.round(44 * s));
  const lineStep = Math.max(Math.round(fontSize * 1.30), fontSize + 4);
  const maxCapLines = 2;
  const lines = (escapedLines || []).slice(0, maxCapLines);
  const padX = Math.max(18, Math.round(52 * sx));
  const blockH = lines.length ? ((lines.length - 1) * lineStep + Math.round(fontSize * 1.08)) : Math.round(fontSize * 1.08);
  // Hook'u video penceresinin üstündeki boşlukta ortala (eski/kompakt alan)
  // Hook alanını çok az yukarı genişlet (kenarlara değil, sadece üstten).
  // (Therapy/Hope/Chaos hepsinde aynı davranış.)
  const hookAreaTop = Math.round(16 * sy);
  const hookAreaBottom = Math.max(hookAreaTop + 1, Math.round(wy - 18 * sy));
  const hxOff = Math.round(
    parseManualReelsHookOffsetPx(hookXOffsetRefPx) * (outW / MANUAL_BLUR_REF_W)
  );
  const hyOff = Math.round(
    parseManualReelsHookOffsetPx(hookYOffsetRefPx) * (outH / MANUAL_BLUR_REF_H)
  );
  const hookYTop =
    Math.max(hookAreaTop, Math.round(((hookAreaTop + hookAreaBottom) / 2) - (blockH / 2))) + hyOff;

  // Reels frame mode requires the 2nd video input [1:v] (frame).
  // If it's missing, fall back to a safe solid background.
  const bgHex = brandNorm === 'umut' ? '0xF5F5F5' : '0xF0F8FF';

  const nudge = Number.isFinite(Number(cropYNudgeRefPx)) ? Math.round(Number(cropYNudgeRefPx)) : 0;
  // 2. slider: pencere içindeki videonun kendisini (overlay) yukarı/aşağı kaydır.
  const winShift = parseManualReelsWindowShiftYPx(windowShiftYRefPx);
  const winShiftPx = Math.round(winShift * (outH / MANUAL_BLUR_REF_H));
  const nudgeRatio = nudge / MANUAL_BLUR_REF_H;
  const cropYExpr =
    `max(0\\,min(ih-oh\\,max(0\\,(ih-oh)*0.42)+ih*${nudgeRatio.toFixed(8)}))`;

  const parts = frameFileExists ? [
    `color=c=white:s=${outW}x${outH}:d=99999[base]`,
    `[1:v]scale=${outW}:${outH},format=rgba,setsar=1[frame]`,
    // Kaynaktaki üst hook/bantı gizlemek için crop'ı biraz aşağıdan al (üstten kırp).
    // FFmpeg filtergraph: max(0\,expr) içindeki virgül kaçırılmalı, yoksa yeni filtre sanır.
    // Manuel nudge (720×1280 px referansı): ih*(nudge/1280) ifadesi ölçeklenmiş kare üzerinde kaydırır.
    // Chaos/Hope: videoyu pencere içinde %5–%6 küçült (kenar payı kalsın)
    ...(() => {
      const shrinkBrand = (brandNorm === 'kaos' || brandNorm === 'umut') ? 0.94 : 1.0;
      const shrink = shrinkBrand;
      const vww = Math.max(2, Math.round(ww * shrink));
      const vwh = Math.max(2, Math.round(wh * shrink));
      const vx = Math.round(wx + (ww - vww) / 2);
      const vy = Math.round(wy + (wh - vwh) / 2) + winShiftPx;
      return [
        `[v0]scale=${vww}:${vwh}:force_original_aspect_ratio=increase,crop=${vww}:${vwh}:(iw-ow)/2:${cropYExpr},setsar=1[vid]`,
        `[base][vid]overlay=x=${vx}:y=${vy}:shortest=1[vb]`
      ];
    })(),
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
        `x='max(${padX}\\,min((w-text_w)/2+${hxOff}\\,w-text_w-${padX}))':y=${y}:enable='${hookEnable}'[${next}]`
    );
    cur = next;
  });
  parts.push(`[${cur}]format=yuv420p[v1]`);
  return parts;
}

/**
 * Lab markası reels çıktısı [v1] üzerine animasyonlu meter çubuğu + hedef yüzde yazısı (alt orta).
 * Çıkış etiketi: [v1meter] — watermark zinciri buradan beslenir.
 */
function buildLabMeterOverlayParts({ brandNorm, outDur, fontPart, labMeter, outW, outH }) {
  const enabled = labMeter && typeof labMeter.enabled === 'boolean' ? labMeter.enabled : true;
  if (!enabled) return { filters: [], debug: { enabled: false } };

  // SCORE mode (0–100): prefer target_value, fall back to target_percent.
  let T = (labMeter && Number.isFinite(Number(labMeter.target_value)))
    ? Math.round(Number(labMeter.target_value))
    : ((labMeter && Number.isFinite(Number(labMeter.target_percent))) ? Math.round(Number(labMeter.target_percent)) : randInt(70, 95));
  T = Math.max(0, Math.min(100, T));
  let S = 0;

  const d = Math.max(0.01, Number(outDur) || 4);
  const pd = Math.max(0.10, d - 5.0); // output timeline: hit target exactly 5s before end
  const pdLit = String(pd.toFixed(6)).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');

  // Palette (only used for glow accents + needle; template itself is fixed)
  let glowHex = '0xff8844';
  let accentHex = '0xffffff';
  if (brandNorm === 'terapi') {
    glowHex = '0x44ccdd';
  } else if (brandNorm === 'umut') {
    glowHex = '0xffee88';
    accentHex = '0xfffbf0';
  }

  const pos720 = labMeter && labMeter.pos_720 && Number.isFinite(labMeter.pos_720.x) && Number.isFinite(labMeter.pos_720.y)
    ? { x: Math.round(labMeter.pos_720.x), y: Math.round(labMeter.pos_720.y) }
    : null;
  // Default: liste alanı alt-orta, koyu kutu içi (public/design_refs/lab_meter_terapi_list_overlay_ref.png)
  const defaultPos720 = { x: 360, y: 988 };
  const posUse = pos720 || defaultPos720;
  const wOut = Math.max(2, Math.round(Number(outW) || 1080));
  const hOut = Math.max(2, Math.round(Number(outH) || 1920));
  const cx = Math.round((posUse.x / 720) * wOut);
  const cy = Math.round((posUse.y / 1280) * hOut);

  // Needle motion range (semi-circle)
  const a0 = -2.45; // rad (left)
  const a1 = 2.45;  // rad (right)
  // Progress fraction in [0..1] without using min(t/x,1) (some builds mis-parse commas/escapes).
  // IMPORTANT: for this Windows FFmpeg build, escaping commas inside geq expressions breaks parsing.
  // Use normal commas in the expression itself.
  const fracExpr = `if(lt(t,${pdLit}),t/${pdLit},1)`;
  // Linear progress: reach target at (outDur-5s).
  const scoreExpr = `if(lt(t,${pdLit}),(${T})*t/${pdLit},${T})`;
  const angleExpr = `(${a0})+(${a1 - a0})*(${scoreExpr}/100)`;

  const pulseTerms = [];
  for (let v = 10; v <= 100; v += 10) {
    if (v > T) break;
    const tk = pd * (v / Math.max(1, T));
    const t0 = (tk - 0.08).toFixed(3);
    const t1 = (tk + 0.08).toFixed(3);
    pulseTerms.push(`between(t\\,${t0}\\,${t1})`);
  }
  const pulseEnable = pulseTerms.length ? pulseTerms.join('+') : '0';
  const targetEnable = `between(t\\,${(pd - 0.12).toFixed(3)}\\,${(pd + 0.22).toFixed(3)})`;

  // FFmpeg filtergraphs use commas as separators between filters, so commas inside expressions must be escaped
  // when they appear inside any option value (enable=..., rotate angle=..., drawtext text=...).
  const escapeExprCommas = (s) => String(s || '').replace(/,/g, '\\,');
  const scoreExprEsc = escapeExprCommas(scoreExpr);
  const angleExprEsc = escapeExprCommas(angleExpr);

  const numText = `%{eif\\:${scoreExprEsc}\\:d}`;

  // New single template: `public/lab_meter_score_template.png` (green background removed).
  // If template input is missing, fall back to a solid panel so meter still renders.
  const hasTemplateInput = labMeter && Number.isFinite(Number(labMeter.template_input_idx));
  const tmplW = Math.max(520, Math.round(wOut * 0.62));
  const tmplH = Math.round(tmplW * (810 / 1024));
  const anchorX = Math.round(tmplW * 0.50);
  const anchorY = Math.round(tmplH * 0.62);
  const tmplOx = Math.round(cx - anchorX);
  const tmplOy = Math.round(cy - anchorY);
  const digitFromBottomPx = Math.max(44, Math.round(tmplW * 0.11));
  const digitFontPx = Math.max(80, Math.round(tmplW * 0.20));

  const needleSize = Math.max(420, Math.round(tmplW * 0.78));
  const nx0 = Math.round(cx - needleSize / 2);
  const ny0 = Math.round(cy - needleSize / 2);
  const needleLen = Math.max(120, Math.round(needleSize * 0.42));
  const needleW = Math.max(6, Math.round(needleSize * 0.018));
  const hubR = Math.max(10, Math.round(needleSize * 0.030));

  // Progress bar (arc) as cumulative segments.
  // We avoid geq/alphamerge/blend between mismatched sizes by generating each segment in a same-size
  // square (needleSize x needleSize) and overlaying it onto the already composited frame.
  const segCount = 72; // smoother arc fill
  const segRadius = Math.round(needleSize * 0.44);
  const segThick = Math.max(10, Math.round(needleSize * 0.065));
  const segLen = Math.max(12, Math.round(needleSize * 0.11));
  const segW = Math.max(10, Math.round(segThick * 0.92));
  const segX = Math.round(needleSize / 2 - segW / 2);
  const segY = Math.round(needleSize / 2 - segRadius - segLen + Math.round(segThick * 0.20));
  // Purple/blue like template; small glow pulse near milestones.
  const barHex = brandNorm === 'terapi' ? '0x6E5BFF' : brandNorm === 'umut' ? '0x8D79FF' : '0x6E5BFF';

  // Template cleanup: the PNG template contains a baked "0" in the score area.
  // We must remove it, otherwise we see two "0" (template + dynamic drawtext).
  // Do this by making that region fully transparent in the template's alpha channel.
  const scoreBoxW = Math.max(80, Math.round(tmplW * 0.40));
  const scoreBoxH = Math.max(60, Math.round(digitFontPx * 1.10));
  const scoreBoxX = Math.round(anchorX - scoreBoxW / 2);
  const scoreBoxY = Math.round(tmplH - digitFromBottomPx - scoreBoxH + Math.round(digitFontPx * 0.10));

  return {
    filters: [
      ...(hasTemplateInput
        ? [
            // Robust path: avoid any blend between template and full-size video.
            // Directly overlay the RGBA template at desired coordinates.
            `[${Math.round(Number(labMeter.template_input_idx))}:v]scale=${tmplW}:${tmplH}:flags=lanczos+accurate_rnd+full_chroma_inp,format=rgba,split=2[tmplRgba0][tmplRgba1]`,
            `[tmplRgba0]alphaextract,format=gray,` +
              `drawbox=x=${scoreBoxX}:y=${scoreBoxY}:w=${scoreBoxW}:h=${scoreBoxH}:color=black@1:t=fill[tmplA]`,
            `[tmplRgba1]format=rgb24[tmplRgb]`,
            `[tmplRgb][tmplA]alphamerge[tmplClean]`,
            `[v1][tmplClean]overlay=x=${tmplOx}:y=${tmplOy}:format=auto[lmT0]`,
            // Single dynamic number (template center is cleared).
            `[lmT0]drawtext=text='${numText}'${fontPart}:fontsize=${digitFontPx}:` +
              `fontcolor=${accentHex}@1:borderw=3:bordercolor=0x000000@1:` +
              `x=${cx}-text_w/2:y=${tmplOy + tmplH - digitFromBottomPx}[lm2]`
          ]
        : [
            `color=c=black@0.0:s=${outW}x${outH}:d=99999,format=rgba[noop0]`,
            `[v1][noop0]overlay=x=0:y=0:format=auto[lmT0]`,
            `[lmT0]drawbox=x=${tmplOx}:y=${tmplOy}:w=${tmplW}:h=${tmplH}:color=0x0C0E12@1:t=fill,` +
              `drawtext=text='${numText}'${fontPart}:fontsize=${digitFontPx}:` +
              `fontcolor=${accentHex}@1:borderw=3:bordercolor=0x000000@1:` +
              `x=${cx}-text_w/2:y=${tmplOy + tmplH - digitFromBottomPx}[lm2]`
          ]),
      // Build the cumulative progress bar as many small segments, enabled as the score increases.
      // Each segment becomes visible once scoreExpr reaches its threshold.
      ...(() => {
        const out = [];
        // First, pass through the current frame as the working label.
        // We'll overlay segments one-by-one onto [lm2].
        let cur = 'lm2';
        for (let i = 0; i < segCount; i++) {
          const frac = segCount <= 1 ? 1 : i / (segCount - 1);
          const thr = (frac * 100).toFixed(3);
          const ang = (a0 + (a1 - a0) * frac).toFixed(6);
          const segLabel = `lmSeg${i}`;
          const segRot = `lmSegR${i}`;
          const next = `lmBar${i}`;
          const enableExpr = `gte(${scoreExprEsc}\\,${thr})`;
          // Glow pulses around milestones/target using enable (alpha can't be an expression in drawbox color).
          const glowEnable = `${pulseEnable}+${targetEnable}`;
          out.push(
            `color=c=black@0.0:s=${needleSize}x${needleSize}:d=99999,format=rgba,` +
              `drawbox=x=${segX}:y=${segY}:w=${segW}:h=${segLen}:color=${barHex}@1:t=fill,` +
              `drawbox=x=${segX}:y=${Math.round(segY + segLen - Math.round(segThick * 0.25))}:w=${segW}:h=${Math.round(segThick * 0.25)}:` +
                `color=${glowHex}@1:t=fill:enable='${glowEnable}'[${segLabel}]`
          );
          out.push(`[${segLabel}]rotate=angle='${ang}':c=none:ow=iw:oh=ih[${segRot}]`);
          out.push(`[${cur}][${segRot}]overlay=x=${nx0}:y=${ny0}:format=auto:enable='${enableExpr}'[${next}]`);
          cur = next;
        }
        // Rename final to a stable label for downstream needle overlay.
        out.push(`[${cur}]null[lmBarDone]`);
        return out;
      })(),
      `color=c=black@0.0:s=${needleSize}x${needleSize}:d=99999,format=rgba,` +
        `drawbox=x=${Math.round(needleSize / 2 - needleW / 2)}:y=${Math.round(needleSize / 2 - needleLen)}:w=${needleW}:h=${needleLen}:color=${accentHex}@1:t=fill,` +
        `drawbox=x=${Math.round(needleSize / 2 - hubR)}:y=${Math.round(needleSize / 2 - hubR)}:w=${hubR * 2}:h=${hubR * 2}:color=black@1:t=fill,` +
        `drawbox=x=${Math.round(needleSize / 2 - Math.round(hubR * 0.55))}:y=${Math.round(needleSize / 2 - Math.round(hubR * 0.55))}:w=${Math.round(hubR * 1.1)}:h=${Math.round(hubR * 1.1)}:color=${accentHex}@1:t=fill,` +
        `rotate=angle='${angleExprEsc}':c=none:ow=iw:oh=ih[lmNeedle]`,
      `[lmBarDone][lmNeedle]overlay=x=${nx0}:y=${ny0}:format=auto[v1meter]`
    ],
    debug: {
      enabled: true,
      random_start_percent: S,
      target_value: T,
      brandNorm,
      pos_720: posUse,
      template: hasTemplateInput ? 'lab_meter_score_template.png' : null,
      tmplW,
      tmplH,
      anchorX,
      anchorY,
      tmpl_xy_out: `${tmplOx}x${tmplOy}`
    }
  };
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
const MANUAL_REELS_CROP_Y_NUDGE_MIN = -500;
const MANUAL_REELS_CROP_Y_NUDGE_MAX = 500;
const MANUAL_REELS_WINDOW_SHIFT_Y_MIN = -250;
const MANUAL_REELS_WINDOW_SHIFT_Y_MAX = 250;
const MANUAL_REELS_HOOK_OFF_MIN = -400;
const MANUAL_REELS_HOOK_OFF_MAX = 400;

/** İstek gövdesinden {x,y,w,h} (px, 720×1280 referansı) — manuel video kırpma kutusu. */
function parseManualCropRectInput(raw) {
  const r = raw && typeof raw === 'object' ? raw : null;
  const xIn = Math.round(Number(r && r.x));
  const yIn = Math.round(Number(r && r.y));
  const wIn = Math.round(Number(r && r.w));
  const hIn = Math.round(Number(r && r.h));
  if (![xIn, yIn, wIn, hIn].every((n) => Number.isFinite(n))) {
    return { x: 0, y: 0, w: MANUAL_BLUR_REF_W, h: MANUAL_BLUR_REF_H };
  }
  const x = Math.max(0, Math.min(MANUAL_BLUR_REF_W - 16, xIn));
  const y = Math.max(0, Math.min(MANUAL_BLUR_REF_H - 16, yIn));
  const w = Math.max(16, Math.min(MANUAL_BLUR_REF_W - x, wIn));
  const h = Math.max(16, Math.min(MANUAL_BLUR_REF_H - y, hIn));
  return { x, y, w, h };
}

/** Lab frame üst kırpımına manuel ince ayar (px, 720×1280 ile aynı dikey ölçek). Negatif = daha çok üst göster; pozitif = daha çok üstü gizle. */
function parseManualReelsCropYNudgePx(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.max(
    MANUAL_REELS_CROP_Y_NUDGE_MIN,
    Math.min(MANUAL_REELS_CROP_Y_NUDGE_MAX, Math.round(n))
  );
}

/** Pencere içi videoyu ayrıca yukarı/aşağı kaydır (px, 720×1280 referansı). */
function parseManualReelsWindowShiftYPx(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.max(
    MANUAL_REELS_WINDOW_SHIFT_Y_MIN,
    Math.min(MANUAL_REELS_WINDOW_SHIFT_Y_MAX, Math.round(n))
  );
}

/** drawtext konumu (720×1280 referans); sunucuda outW/outH ile ölçeklenir. */
function parseManualReelsHookOffsetPx(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.max(
    MANUAL_REELS_HOOK_OFF_MIN,
    Math.min(MANUAL_REELS_HOOK_OFF_MAX, Math.round(n))
  );
}

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
    const W = Math.max(1, Math.round(Number(outW) || 1080));
    const H = Math.max(1, Math.round(Number(outH) || 1920));

    let x = Math.round(r.x);
    let y = Math.round(r.y);
    let w = Math.round(r.w);
    let h = Math.round(r.h);

    // delogo is strict: rectangle must be fully inside the frame.
    // Keep a 1px inset from right/bottom borders (some FFmpeg builds are picky about edge touches).
    x = Math.max(0, Math.min(Math.max(0, W - 9), x));
    y = Math.max(0, Math.min(Math.max(0, H - 9), y));

    let wClamp = Math.max(8, Math.min(Math.max(0, W - x - 1), w));
    let hClamp = Math.max(8, Math.min(Math.max(0, H - y - 1), h));
    w = wClamp;
    h = hClamp;

    // If sizing still overflows (stale rects / rounding), shrink position inward.
    if (x + w >= W || y + h >= H) {
      x = Math.max(0, Math.min(Math.max(0, W - w - 1), x));
      y = Math.max(0, Math.min(Math.max(0, H - h - 1), y));
    }

    w -= w % 2;
    h -= h % 2;
    if (w < 8 || h < 8) return;
    if (x < 0 || y < 0) return;
    if (x + w >= W || y + h >= H) return;

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
    (brandNorm === 'terapi' || brandNorm === 'umut' || brandNorm === 'kaos') && o.useReelsInstagramCanvas !== false;
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

  // Lab meter uses a single score template PNG (green background removed).
  const meterTemplatePng = path.join(__dirname, 'public', 'lab_meter_score_template.png');
  const meterTemplateExists = fs.existsSync(meterTemplatePng);

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
  const inDur0 = clampDur(sourceDurSec, 1, 60);
  const manualStartSecRaw = Number(o.manual_start_sec ?? o.manualStartSec ?? 0);
  const startSec = Number.isFinite(manualStartSecRaw) ? Math.max(0, Math.min(inDur0 - 0.10, manualStartSecRaw)) : 0;
  const inDur = Math.max(0.10, inDur0 - startSec);
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
  const manualCropRectRef = parseManualCropRectInput(
    o.manual_crop_rect_720 ?? o.manualCropRect720 ?? o.manual_crop_rect ?? o.manualCropRect ?? null
  );
  const manualReelsCropYNudgePx = parseManualReelsCropYNudgePx(
    o.manual_reels_crop_y_nudge_px ?? o.manualReelsCropYNudgePx
  );
  const manualReelsWindowShiftYPx = parseManualReelsWindowShiftYPx(
    o.manual_reels_window_shift_y_px ?? o.manualReelsWindowShiftYPx
  );
  const manualReelsHookXOff = parseManualReelsHookOffsetPx(
    o.manual_reels_hook_x_offset_px ?? o.manualReelsHookXOffsetPx
  );
  const manualReelsHookYOff = parseManualReelsHookOffsetPx(
    o.manual_reels_hook_y_offset_px ?? o.manualReelsHookYOffsetPx
  );
  const labMeterOpt = (() => {
    const raw = o.lab_meter ?? o.labMeter ?? null;
    if (!raw || typeof raw !== 'object') return null;
    const enabled = raw.enabled == null ? true : !!raw.enabled;
    const tv = Number(raw.target_value);
    const tp = Number(raw.target_percent);
    const target_value = Number.isFinite(tv) ? Math.max(0, Math.min(1000, Math.round(tv))) : null;
    const target_percent = Number.isFinite(tp) ? Math.max(0, Math.min(100, Math.round(tp))) : null;
    const p = raw.pos_720;
    const pos_720 =
      p && typeof p === 'object' && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y))
        ? { x: Math.round(Number(p.x)), y: Math.round(Number(p.y)) }
        : null;
    return { enabled, target_value, target_percent, pos_720 };
  })();
  const ubRects = scaleManualBlurRectsToOutputPx(rawManual, o.manualBlurRefW, o.manualBlurRefH, outW, outH);
  const ubChain = buildManualBlurDelogoChain('v0base', ubRects, outW, outH, 'v0postblur');

  // Input index planning (0=inFile, 1=frame?, 2=meter template?, then wm, then music)
  let nextInputIdx = 1;
  if (frameExists) nextInputIdx += 1;
  const useLabMeterTemplate = useLabFrame && (labMeterOpt ? labMeterOpt.enabled !== false : true) && meterTemplateExists;
  const meterTemplateInputIdx = useLabMeterTemplate ? nextInputIdx++ : null;
  const wmInputIdxPlanned = nextInputIdx++;
  const musicInputIdxPlanned = nextInputIdx; // only valid if music input exists

  let vChain = `[0:v]trim=start=${startSec.toFixed(3)},setpts=PTS-STARTPTS,fps=${targetFps}`;
  vChain += `,scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH}[v0base0]`;
  // Manual crop rect: crop in outW×outH space, then scale back to outW×outH (fill).
  const cropRectOut = (() => {
    const sx = outW / MANUAL_BLUR_REF_W;
    const sy = outH / MANUAL_BLUR_REF_H;
    let x = Math.round(manualCropRectRef.x * sx);
    let y = Math.round(manualCropRectRef.y * sy);
    let w = Math.round(manualCropRectRef.w * sx);
    let h = Math.round(manualCropRectRef.h * sy);
    x = Math.max(0, Math.min(outW - 16, x));
    y = Math.max(0, Math.min(outH - 16, y));
    w = Math.max(16, Math.min(outW - x, w));
    h = Math.max(16, Math.min(outH - y, h));
    // Even dims for yuv420p / x264 friendliness.
    if (w % 2) w -= 1;
    if (h % 2) h -= 1;
    if (x % 2) x -= 1;
    if (y % 2) y -= 1;
    x = Math.max(0, x);
    y = Math.max(0, y);
    w = Math.max(16, Math.min(outW - x, w));
    h = Math.max(16, Math.min(outH - y, h));
    return { x, y, w, h };
  })();
  const isFullCrop =
    cropRectOut.x === 0 &&
    cropRectOut.y === 0 &&
    cropRectOut.w === outW &&
    cropRectOut.h === outH;
  if (!isFullCrop) {
    vChain += `;[v0base0]crop=${cropRectOut.w}:${cropRectOut.h}:${cropRectOut.x}:${cropRectOut.y},` +
      `scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH}[v0base]`;
  } else {
    vChain += `;[v0base0]crop=${outW}:${outH}:0:0[v0base]`;
  }
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

  let labMeterExtra = { filters: [], debug: null };
  if (useLabFrame) {
    const labMeterForBuild = useLabMeterTemplate
      ? { ...(labMeterOpt || {}), template_input_idx: meterTemplateInputIdx }
      : { ...(labMeterOpt || {}) };
    labMeterExtra = buildLabMeterOverlayParts({ brandNorm, outDur, fontPart, labMeter: labMeterForBuild, outW, outH });
  }
  const preWmLabel = labMeterExtra.filters.length ? 'v1meter' : 'v1';

  const wmInputIdx = wmInputIdxPlanned;
  const tailWmAndGrain = [
    `[${wmInputIdx}:v]scale=${wmSize}:${wmSize}:force_original_aspect_ratio=decrease,format=rgba,` +
      `pad=${wmSize}:${wmSize}:(ow-iw)/2:(oh-ih)/2:color=black@0,` +
      `rotate='${tiltRotateExpr}':c=none:ow=iw:oh=ih[wm0]`,
    `[wm0]split=2[wmA][wmB]`,
    `[wmA]alphaextract,geq=lum='if(lte((X-W/2)*(X-W/2)+(Y-H/2)*(Y-H/2),(min(W,H)/2)*(min(W,H)/2)),255,0)'[wmMask]`,
    `[wmB][wmMask]alphamerge,format=rgba,colorchannelmixer=aa=${wmAlphaFinal.toFixed(4)}[wm]`,
    `[${preWmLabel}][wm]overlay=x='${wmXExpr}':y='${wmYExpr}':format=auto[v1m]`,
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
          frameFileExists: frameExists,
          cropYNudgeRefPx: manualReelsCropYNudgePx,
          windowShiftYRefPx: manualReelsWindowShiftYPx,
          hookXOffsetRefPx: manualReelsHookXOff,
          hookYOffsetRefPx: manualReelsHookYOff
        })
      : legacyVisualStack),
    ...labMeterExtra.filters,
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

      const musicInputIdx = musicInputIdxPlanned;
      if (useRubberband) {
        audioFilter =
          `[0:a]atrim=start=${startSec.toFixed(3)},asetpts=PTS-STARTPTS,` +
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
          `[0:a]atrim=start=${startSec.toFixed(3)},asetpts=PTS-STARTPTS,` +
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
          `[0:a]atrim=start=${startSec.toFixed(3)},asetpts=PTS-STARTPTS,` +
            `rubberband=tempo=${effectiveSpeed.toFixed(6)}:pitch=${pitchFactor.toFixed(8)},` +
            `volume='${volExpr}',` +
            `apad=pad_dur=${(outDur + 0.5).toFixed(3)},` +
            `atrim=0:${outDur.toFixed(3)},asetpts=PTS-STARTPTS[a]`
        );
      } else {
        parts.push(
          `[0:a]atrim=start=${startSec.toFixed(3)},asetpts=PTS-STARTPTS,` +
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
    const musicInputIdx = musicInputIdxPlanned;
    parts.push(
      `[${musicInputIdx}:a]atrim=start=${musicStart.toFixed(3)}:duration=${outDur.toFixed(3)},asetpts=PTS-STARTPTS,` +
        `aformat=sample_fmts=fltp:channel_layouts=stereo,` +
        `volume=${bgVol.toFixed(4)}[a]`
    );
    mapAudioOut = true;
  }

  const filterComplex = parts.join(';');

  // Windows CreateProcess has a strict command-line length limit.
  // Our animated lab meter can generate a very long filtergraph, so write it to a script file
  // and use -filter_complex_script to avoid spawn ENAMETOOLONG.
  let filterComplexScriptPath = null;
  try {
    const tmpDir =
      (o && typeof o.tmpDir === 'string' && o.tmpDir)
        ? o.tmpDir
        : (inFile ? path.dirname(inFile) : os.tmpdir());
    filterComplexScriptPath = path.join(tmpDir, `va_filter_complex_${Date.now()}_${Math.random().toString(16).slice(2)}.txt`);
    fs.writeFileSync(filterComplexScriptPath, filterComplex, { encoding: 'utf8' });
  } catch (e) {
    // If we fail to write the script, we'll fall back to inline -filter_complex.
    filterComplexScriptPath = null;
  }

  const inputs = ['-y', '-i', inFile];
  if (frameExists) inputs.push('-loop', '1', '-i', framePng);
  if (useLabMeterTemplate) inputs.push('-loop', '1', '-i', meterTemplatePng);
  inputs.push('-loop', '1', '-i', wmFile);
  if (musicFile && fs.existsSync(musicFile)) {
    inputs.push('-stream_loop', '-1', '-i', musicFile);
  }

  const ffArgs = [
    ...inputs,
    ...(filterComplexScriptPath
      ? ['-/filter_complex', filterComplexScriptPath]
      : ['-filter_complex', filterComplex]),
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
      filterComplexScript: filterComplexScriptPath ? path.basename(filterComplexScriptPath) : null,
      speedRamp,
      effectiveSpeed: Number(effectiveSpeed.toFixed(6)),
      horizontalFlip: false,
      originalFps: origFps,
      targetFps,
      outDurSec: Number(outDur.toFixed(3)),
      edge,
      manualBlurCount: ubRects.length,
      manualCropRect720: manualCropRectRef,
      manualReelsCropYNudgePx,
      manualReelsWindowShiftYPx,
      manualReelsHookXOff,
      manualReelsHookYOff,
      musicFile: musicFile && fs.existsSync(musicFile) ? path.basename(musicFile) : null,
      hookFont: fontFile ? path.basename(fontFile) : null,
      labMeter: labMeterExtra.debug
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
  MANUAL_BLUR_REF_H,
  parseManualReelsCropYNudgePx,
  parseManualReelsWindowShiftYPx,
  parseManualReelsHookOffsetPx,
  parseManualCropRectInput
};
