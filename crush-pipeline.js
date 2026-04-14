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
    'Ending is unbelievable ⚠️',
    'Watch for the end! 🤣',
    'Did not expect that 😂',
    'End is crazy! 😱'
  ];
  const terapi = [
    'Ending is so sweet ✨',
    'Wait for the sweet end! 😍',
    'Watch till the end ❤️',
    'Too cute to be real 🥰'
  ];
  if (String(brand).toLowerCase() === 'kaos') return pickOne(kaos);
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
  return pickOne(existing.length ? existing : fonts);
}

function sanitizeHexColor(c, fallback) {
  const s = String(c || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s;
  return fallback;
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

  const wmSize = outW >= 1080 ? 110 : 96;
  // Watermark hareketi: yavaş/akıcı drift (başlangıçta kenar/köşe yakınında başlat)
  const driftT = randRange(14, 22); // per-video periyot (sn)
  const driftT2 = randRange(9, 15);
  const sx0 = Math.random() < 0.5 ? -1 : 1;
  const sy0 = Math.random() < 0.5 ? -1 : 1;
  // sin(±pi/2)=±1 → başlangıçta kenara yakın
  const phx = sx0 > 0 ? Math.PI / 2 : -Math.PI / 2;
  const phy = sy0 > 0 ? Math.PI / 2 : -Math.PI / 2;
  // ikinci bileşen fazı hafif değişsin
  const phx2 = phx + randRange(-0.65, 0.65);
  const phy2 = phy + randRange(-0.65, 0.65);
  const speedRamp = pickSpeedRampFactor();
  const effectiveSpeed = BASE_EDIT_SPEED * speedRamp;
  const inDur = clampDur(sourceDurSec, 1, 60);
  const outDur = Math.min(60, Math.max(1, inDur / effectiveSpeed));

  const origFps = (await probeOriginalFpsInt(ffmpegPath, ffprobePath, inFile)) || 30;
  const targetFps = computeTargetFpsInt(origFps);

  const edge = randInt(4, 6);
  const cropW = Math.max(16, outW - 2 * edge);
  const cropH = Math.max(16, outH - 2 * edge);

  const zoom = randRange(1.04, 1.08);
  const contrast = randRange(1.03, 1.09);
  const saturation = randRange(1.05, 1.15);
  const brightness = randRange(-0.02, 0.04);

  const uniqHex = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
  const uniqAlpha = 0.08;
  const noiseOpacity = 0.005;
  const grainOpacity = 0.018;
  // Watermark opaklığı: daha saydam (izleyiciyi rahatsız etmesin)
  const wmAlphaEdge = randRange(0.20, 0.30); // kenarda “imza gibi”
  const wmAlphaCenter = randRange(0.06, 0.12); // merkezde neredeyse görünmesin

  const hookText = pickHookText(brand);
  // Director yoksa: istenen aralık (70–95) içinde konumlandır.
  const hookY = Number.isFinite(hook?.y) ? Math.round(hook.y) : Math.round(randRange(70, 95));
  const hookTextFinal = (hook && typeof hook.text === 'string' && hook.text.trim()) ? hook.text.trim() : hookText;
  const hookColorPool = ['#FFFFFF', '#FFD400', '#9BFF57']; // Beyaz / Sarı / Açık yeşil
  const hookColor = sanitizeHexColor(hook?.color, pickOne(hookColorPool));
  const hookAlpha = randRange(0.88, 0.94);
  const barH = 110;
  const barY = Math.max(0, hookY - 36);
  const boxOpacity =
    typeof hook?.boxOpacity === 'number' && Number.isFinite(hook.boxOpacity)
      ? Math.max(0, Math.min(1, hook.boxOpacity))
      : 0.38;

  const cover = coverBox && Number.isFinite(coverBox.y) && Number.isFinite(coverBox.h)
    ? {
        y: Math.max(0, Math.min(outH - 2, Math.round(coverBox.y))),
        h: Math.max(2, Math.min(outH, Math.round(coverBox.h))),
        opacity: typeof coverBox.opacity === 'number' && Number.isFinite(coverBox.opacity)
          ? Math.max(0, Math.min(1, coverBox.opacity))
          : 1
      }
    : null;

  const fontFile = pickExistingFontForDrawtext();
  const fontPart = fontFile
    ? `:fontfile='${escapeDrawtextText(fontFile.replace(/\\/g, '/'))}'`
    : '';

  // Eski başlık varsa maske + hook uzun sürsün (video boyunca); yoksa 3 sn
  const hookEnable = cover ? "between(t,0,1e9)" : "between(t,0,3)";

  // hflip kapalı: yakılmış (burned-in) yazı pikseldir; altyazı akışı yoksa tespit edilemez, flip metni ters çevirir.
  let vChain = `[0:v]setpts=PTS-STARTPTS,fps=${targetFps}`;
  vChain +=
    `,scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH}` +
    `,crop=${cropW}:${cropH}:(iw-ow)/2:(ih-oh)/2` +
    `,scale=iw*${zoom.toFixed(4)}:ih*${zoom.toFixed(4)},crop=${outW}:${outH}` +
    `,eq=contrast=${contrast.toFixed(4)}:saturation=${saturation.toFixed(4)}:brightness=${brightness.toFixed(4)}` +
    // Zoom kaynaklı yumuşamayı hafif toparla (çok agresif değil)
    `,unsharp=5:5:0.70:3:3:0.35` +
    `,setsar=1,setpts=PTS/${effectiveSpeed.toFixed(6)},trim=0:${outDur.toFixed(3)},setpts=PTS-STARTPTS[v0]`;

  const parts = [
    vChain,
    `color=c=#${uniqHex}@${uniqAlpha}:s=${outW}x${outH}:d=1[uniq]`,
    `[v0][uniq]overlay=0:0:enable='eq(n,0)'[v0u]`,
    ...(cover
      ? [
          `[v0u]drawbox=x=0:y=${cover.y}:w=iw:h=${cover.h}:color=black@${cover.opacity.toFixed(3)}:t=fill[vcover]`,
          `[vcover]drawbox=x=0:y=${barY}:w=iw:h=${barH}:color=black@${boxOpacity.toFixed(3)}:t=fill:enable='${hookEnable}'[vbox]`
        ]
      : [
          `[v0u]drawbox=x=0:y=${barY}:w=iw:h=${barH}:color=black@${boxOpacity.toFixed(3)}:t=fill:enable='${hookEnable}'[vbox]`
        ]),
    `[vbox]drawtext=text='${escapeDrawtextText(hookTextFinal)}'${fontPart}:` +
      `fontcolor=${hookColor}@${hookAlpha.toFixed(3)}:fontsize=48:x=(w-text_w)/2:y=${hookY}:` +
      `enable='${hookEnable}'[v1]`,
    `[1:v]scale=${wmSize}:${wmSize}:force_original_aspect_ratio=decrease,format=rgba,` +
      `pad=${wmSize}:${wmSize}:(ow-iw)/2:(oh-ih)/2:color=black@0,` +
      `rotate='0.15*sin(2*PI*t/1.2)':c=none:ow=iw:oh=ih[wm0]`,
    `[wm0]split=2[wmA][wmB]`,
    `[wmA]alphaextract,geq=lum='if(lte((X-W/2)*(X-W/2)+(Y-H/2)*(Y-H/2),(min(W,H)/2)*(min(W,H)/2)),255,0)'[mask]`,
    // Gölge KALDIRILDI. Yeni mantık: merkezde daha saydam, kenara yaklaştıkça daha görünür.
    // İki sabit-alpha watermark üret → sinüs “merkez/kenar” ölçüsüne göre arada blend et.
    `[wmB][mask]alphamerge,split=2[wmLoSrc][wmHiSrc]`,
    `[wmLoSrc]colorchannelmixer=aa=${wmAlphaCenter.toFixed(4)}[wmLo]`,
    `[wmHiSrc]colorchannelmixer=aa=${wmAlphaEdge.toFixed(4)}[wmHi]`,
    // k: 0=merkez, 1=kenar (aynı drift sinüslerinden türetilir)
    // blend filtresinde ayrı bir k parametresi yok; k'yı all_expr içinde hesaplıyoruz.
    `[wmLo][wmHi]blend=all_expr='` +
      `A*(1-min(1,max(0,` +
        `sqrt(` +
          `pow(0.55*sin(2*PI*T/${driftT.toFixed(3)}+${phx.toFixed(4)})+0.45*sin(2*PI*T/${driftT2.toFixed(3)}+${phx2.toFixed(4)}),2)` +
          `+pow(0.55*sin(2*PI*T/${driftT.toFixed(3)}+${phy.toFixed(4)})+0.45*sin(2*PI*T/${driftT2.toFixed(3)}+${phy2.toFixed(4)}),2)` +
        `)/1.12` +
      `)))` +
      `)+` +
      `B*min(1,max(0,` +
        `sqrt(` +
          `pow(0.55*sin(2*PI*T/${driftT.toFixed(3)}+${phx.toFixed(4)})+0.45*sin(2*PI*T/${driftT2.toFixed(3)}+${phx2.toFixed(4)}),2)` +
          `+pow(0.55*sin(2*PI*T/${driftT.toFixed(3)}+${phy.toFixed(4)})+0.45*sin(2*PI*T/${driftT2.toFixed(3)}+${phy2.toFixed(4)}),2)` +
        `)/1.12` +
      `))'` +
    `[wm]`,
    // Akıcı drift (köşe→merkez→diğer kenar): aynı sinüs bileşenleri ile
    `[v1][wm]overlay=` +
      `x='(W-w)/2 + (W-w)/2*(0.55*sin(2*PI*t/${driftT.toFixed(3)}+${phx.toFixed(4)}) + 0.45*sin(2*PI*t/${driftT2.toFixed(3)}+${phx2.toFixed(4)}))':` +
      `y='(H-h)/2 + (H-h)/2*(0.55*sin(2*PI*t/${driftT.toFixed(3)}+${phy.toFixed(4)}) + 0.45*sin(2*PI*t/${driftT2.toFixed(3)}+${phy2.toFixed(4)}))':format=auto[v1m]`,
    `[v1m]split=2[vA][vB]`,
    `[vB]noise=alls=10:allf=t+u,format=yuv420p[vN]`,
    `[vA][vN]blend=all_mode=overlay:all_opacity=${noiseOpacity},format=yuv420p[vblend]`,
    `[vblend]split=2[vC][vD]`,
    `[vD]noise=alls=3:allf=t+u,format=yuv420p[vGrain]`,
    `[vC][vGrain]blend=all_mode=overlay:all_opacity=${grainOpacity},format=yuv420p[vpre]`,
    `[vpre]vignette=PI/10:eval=frame,format=yuv420p[v]`
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

      if (useRubberband) {
        audioFilter =
          `[0:a]asetpts=PTS-STARTPTS,` +
          `rubberband=tempo=${effectiveSpeed.toFixed(6)}:pitch=${pitchFactor.toFixed(8)},` +
          `volume='${volExpr}',` +
          `aformat=sample_fmts=fltp:channel_layouts=stereo,` +
          `apad=pad_dur=${(outDur + 0.5).toFixed(3)},` +
          `atrim=0:${outDur.toFixed(3)},asetpts=PTS-STARTPTS[a0];` +
          `[2:a]atrim=start=${musicStart.toFixed(3)}:duration=${outDur.toFixed(3)},asetpts=PTS-STARTPTS,` +
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
          `[2:a]atrim=start=${musicStart.toFixed(3)}:duration=${outDur.toFixed(3)},asetpts=PTS-STARTPTS,` +
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
    parts.push(
      `[2:a]atrim=start=${musicStart.toFixed(3)}:duration=${outDur.toFixed(3)},asetpts=PTS-STARTPTS,` +
        `aformat=sample_fmts=fltp:channel_layouts=stereo,` +
        `volume=${bgVol.toFixed(4)}[a]`
    );
    mapAudioOut = true;
  }

  const filterComplex = parts.join(';');

  const inputs = ['-y', '-i', inFile, '-loop', '1', '-i', wmFile];
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
  AUDIO_EXTS
};
