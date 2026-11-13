/**
 * Kanca sesi videodan önce, tek başına çalar.
 * İlk kare o süre boyunca donar; belgesel görüntüsü ve sesi Adam bitince başlar.
 * Kanca sesine altyazı basılmaz. Üstteki hook yazısı ezilmiş karede durur.
 * 60 fps ve üzeri 59'a iner. Yatay çevirme ve settb yok.
 *
 *   const { composeHookVideo } = require('./hook-compose');
 *   const outputPath = await composeHookVideo({ videoPath, hookMp3Path, outputPath, hookText });
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const HOOK_BED_VOLUME = 0.22;
const HOOK_RELEASE_SEC = 0.12;
const MAX_FPS = 59;

class HookComposeError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'HookComposeError';
    this.details = details || null;
  }
}

function resolveBin(envName, fallback) {
  const fromEnv = String(process.env[envName] || '').trim();
  if (fromEnv) return fromEnv;
  return fallback;
}

function assertFile(filePath, label) {
  const abs = path.resolve(String(filePath || ''));
  if (!filePath || !fs.existsSync(abs)) {
    throw new HookComposeError(`${label} bulunamadı: ${filePath || '(boş)'}`);
  }
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch (err) {
    throw new HookComposeError(`${label} okunamadı: ${err.message}`);
  }
  if (!stat.isFile() || stat.size < 32) {
    throw new HookComposeError(`${label} boş veya dosya değil: ${abs}`);
  }
  return abs;
}

function parseRate(raw) {
  const text = String(raw || '').trim();
  const frac = text.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (frac) {
    const den = Number(frac[2]);
    if (!den) return null;
    const value = Number(frac[1]) / den;
    return value > 0 ? value : null;
  }
  const value = Number(text);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function runProbe(ffprobePath, filePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffprobePath, [
      '-v', 'error',
      '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,duration',
      '-of', 'json',
      filePath
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => {
      if (e && e.code === 'ENOENT') {
        reject(new HookComposeError('ffprobe bulunamadı. FFMPEG ile aynı klasörde olmalı veya FFPROBE_PATH verilmeli.'));
        return;
      }
      reject(new HookComposeError(e.message || 'ffprobe başlatılamadı.'));
    });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new HookComposeError(`ffprobe okuyamadı: ${err.trim().slice(0, 400) || filePath}`));
        return;
      }
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new HookComposeError('ffprobe çıktısı okunamadı.'));
      }
    });
  });
}

function mediaFacts(probe) {
  const streams = Array.isArray(probe && probe.streams) ? probe.streams : [];
  const video = streams.find((s) => s && s.codec_type === 'video') || null;
  const audio = streams.find((s) => s && s.codec_type === 'audio') || null;
  const formatDur = Number(probe && probe.format && probe.format.duration);
  const streamDur = Math.max(
    Number(video && video.duration) || 0,
    Number(audio && audio.duration) || 0
  );
  const duration = Math.max(Number.isFinite(formatDur) ? formatDur : 0, streamDur);
  const fps = video
    ? (parseRate(video.r_frame_rate) || parseRate(video.avg_frame_rate))
    : null;
  return {
    video,
    hasAudio: !!audio,
    duration: duration > 0 ? duration : 0,
    width: video ? Number(video.width) || 0 : 0,
    height: video ? Number(video.height) || 0 : 0,
    fps,
    codec: video ? String(video.codec_name || '') : ''
  };
}

function escapeDrawtext(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%')
    .replace(/,/g, '\\,');
}

function visibleHookText(raw) {
  return String(raw || '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Caption dosya adı olur. Hashtag kalır. Ayrı metin dosyası üretilmez. */
function prepareHookCaption(raw) {
  const displayText = String(raw || '').replace(/\s+/g, ' ').trim();
  const fileStem = displayText
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
  return { displayText, fileStem };
}

function pickDrawtextFont() {
  const candidates = process.platform === 'win32'
    ? ['C:\\Windows\\Fonts\\arialbd.ttf', 'C:\\Windows\\Fonts\\arial.ttf']
    : [
      '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
      '/usr/share/fonts/truetype/freefont/FreeSansBold.ttf'
    ];
  return candidates.find((p) => {
    try { return fs.existsSync(p); } catch { return false; }
  }) || '';
}

function bedVolumeExpr(hookDur) {
  const end = hookDur.toFixed(3);
  const back = (hookDur + HOOK_RELEASE_SEC).toFixed(3);
  const low = HOOK_BED_VOLUME.toFixed(2);
  const rise = (1 - HOOK_BED_VOLUME).toFixed(2);
  const release = HOOK_RELEASE_SEC.toFixed(2);
  return `if(lt(t,${end}),${low},if(lt(t,${back}),${low}+${rise}*(t-${end})/${release},1))`;
}

/**
 * Kanca süresince gösterilecek tek satır. Renkli emoji bu adımda yok;
 * Arial emojiyi seslendirmez, ekrana da basılmaz.
 */
function buildHookCaptionFilter(hookText, hookDur, height, fontFile) {
  const text = visibleHookText(hookText);
  if (!text) return '';
  const size = Math.max(18, Math.min(84, Math.round((Number(height) || 1920) / 22)));
  const font = fontFile
    ? `:fontfile='${escapeDrawtext(String(fontFile).replace(/\\/g, '/'))}'`
    : ':font=Arial';
  const end = Math.max(0.05, Number(hookDur) || 0).toFixed(3);
  return (
    `[0:v]drawtext=${font}:text='${escapeDrawtext(text)}':fontsize=${size}` +
    `:fontcolor=white:borderw=4:bordercolor=black@0.7` +
    `:x=(w-text_w)/2:y=h*0.72:enable='between(t,0,${end})'[vout]`
  );
}

function buildVideoChain({ hookText, hookDur, height, fontFile, limitFps, copyable }) {
  const caption = buildHookCaptionFilter(hookText, hookDur, height, fontFile);
  if (!limitFps && !caption && copyable) return '';
  if (!limitFps && !caption) return '[0:v]null[vout]';
  if (limitFps && caption) {
    return caption.replace('[0:v]drawtext=', `[0:v]fps=${MAX_FPS},drawtext=`);
  }
  if (limitFps) return `[0:v]fps=${MAX_FPS}[vout]`;
  return caption;
}

function buildHookFilterGraph({ hasVideoAudio, hookDur, videoDur, limitFps }) {
  const hook = Math.max(0.05, Number(hookDur) || 0).toFixed(3);
  const video = Math.max(0.05, Number(videoDur) || 0).toFixed(3);
  const fps = limitFps ? `,fps=${MAX_FPS}` : '';
  const videoChain =
    `[0:v]setpts=PTS-STARTPTS${fps},tpad=start_duration=${hook}:start_mode=clone,format=yuv420p,setsar=1[vout]`;
  const hookAudio =
    `[1:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
    `asetpts=PTS-STARTPTS,atrim=duration=${hook},apad=whole_dur=${hook}[hk]`;
  const bed = hasVideoAudio
    ? `[0:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,apad=whole_dur=${video},atrim=duration=${video}[bg]`
    : `anullsrc=channel_layout=stereo:sample_rate=44100,atrim=duration=${video},asetpts=PTS-STARTPTS[bg]`;
  const graph = [videoChain, hookAudio, bed, '[hk][bg]concat=n=2:v=0:a=1[aout]'].join(';');
  if (/\bhflip\b|\bsettb=|\bdrawtext\b/.test(graph)) {
    throw new HookComposeError('Kanca sekansında altyazı, çevirme veya settb yok.');
  }
  return graph;
}

function resolveOutputPath(outputPath, captionText) {
  const caption = prepareHookCaption(captionText);
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const salt = crypto.randomBytes(2).toString('hex');
  const fallbackName = (caption.fileStem || `hooked_${stamp}_${salt}`) + '.mp4';
  const raw = String(outputPath || '').trim();
  if (!raw) return path.join(__dirname, 'output', fallbackName);
  const abs = path.resolve(raw);
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
    return path.join(abs, fallbackName);
  }
  if (!path.extname(abs)) return path.join(abs, fallbackName);
  if (!abs.toLowerCase().endsWith('.mp4')) {
    return abs.slice(0, -path.extname(abs).length) + '.mp4';
  }
  return abs;
}

function ffmpegFailureText(stderr, code) {
  const lines = String(stderr || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) =>
      line &&
      !/^ffmpeg version/i.test(line) &&
      !/^built with/i.test(line) &&
      !/^configuration:/i.test(line) &&
      !/^libav/i.test(line) &&
      !/^Input #/.test(line) &&
      !/^Duration:/.test(line) &&
      !/^Stream #/.test(line) &&
      !/^Press \[q\]/.test(line)
    );
  const tail = lines.slice(-6).join(' ');
  return tail || `ffmpeg çıkış kodu ${code}`;
}

function runFfmpeg(ffmpegPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
    }, 8 * 60 * 1000);
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 160000) stderr = stderr.slice(-160000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      if (err && err.code === 'ENOENT') {
        reject(new HookComposeError('ffmpeg bulunamadı. PATH üzerinde olmalı veya FFMPEG_PATH verilmeli.'));
        return;
      }
      reject(new HookComposeError(err.message || 'ffmpeg başlatılamadı.'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      reject(new HookComposeError(`Kurgu başarısız: ${ffmpegFailureText(stderr, code)}`, { code }));
    });
  });
}

/**
 * @param {{ videoPath: string, hookMp3Path: string, outputPath?: string, hookText?: string, captionText?: string }} input
 * @returns {Promise<string>} yazılan mp4'ün mutlak yolu
 */
async function composeHookVideo(input) {
  const opts = input || {};
  const videoPath = assertFile(opts.videoPath, 'Video');
  const hookMp3Path = assertFile(opts.hookMp3Path, 'Kanca sesi');
  const outputPath = resolveOutputPath(opts.outputPath, opts.captionText);
  const ffmpegPath = resolveBin('FFMPEG_PATH', 'ffmpeg');
  const ffprobePath = resolveBin('FFPROBE_PATH', 'ffprobe');
  let scriptPath = '';

  try {
    const videoFacts = mediaFacts(await runProbe(ffprobePath, videoPath));
    const hookFacts = mediaFacts(await runProbe(ffprobePath, hookMp3Path));
    if (!videoFacts.video || !videoFacts.width || !videoFacts.height) {
      throw new HookComposeError('Videoda görüntü akışı yok.');
    }
    if (!(videoFacts.duration > 0.05)) {
      throw new HookComposeError('Video süresi okunamadı.');
    }
    if (!hookFacts.hasAudio) {
      throw new HookComposeError('Kanca dosyasında ses yok.');
    }
    if (!(hookFacts.duration > 0.05)) {
      throw new HookComposeError('Kanca sesinin süresi okunamadı.');
    }

    const hookDur = Math.min(hookFacts.duration, 8);
    const limitFps = !!(videoFacts.fps && videoFacts.fps >= 60);
    const graph = buildHookFilterGraph({
      hasVideoAudio: videoFacts.hasAudio,
      hookDur,
      videoDur: videoFacts.duration,
      limitFps
    });
    const copyVideo = false;
    scriptPath = path.join(os.tmpdir(), `va_hook_fc_${Date.now()}_${crypto.randomBytes(3).toString('hex')}.txt`);
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.promises.writeFile(scriptPath, graph, 'utf8');

    const args = [
      '-y', '-hide_banner',
      '-i', videoPath,
      '-i', hookMp3Path,
      '-/filter_complex', scriptPath,
      '-map', copyVideo ? '0:v:0' : '[vout]',
      '-map', '[aout]'
    ];
    if (copyVideo) {
      args.push('-c:v', 'copy');
    } else {
      args.push(
        '-c:v', 'libx264',
        '-preset', 'medium',
        '-crf', '18',
        '-pix_fmt', 'yuv420p'
      );
      if (limitFps) args.push('-r', String(MAX_FPS), '-fps_mode', 'cfr');
    }
    args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', '2', '-movflags', '+faststart', outputPath);

    try {
      await runFfmpeg(ffmpegPath, args);
    } catch (err) {
      await fs.promises.unlink(outputPath).catch(() => {});
      throw err;
    }

    const outFacts = mediaFacts(await runProbe(ffprobePath, outputPath));
    const size = fs.statSync(outputPath).size;
    if (size < 1000 || !outFacts.video || !outFacts.hasAudio) {
      await fs.promises.unlink(outputPath).catch(() => {});
      throw new HookComposeError('Çıkış videosu yazılamadı.');
    }
    if (outFacts.width !== videoFacts.width || outFacts.height !== videoFacts.height) {
      await fs.promises.unlink(outputPath).catch(() => {});
      throw new HookComposeError('Çıkış en-boy oranı ham video ile aynı değil.');
    }
    const expected = videoFacts.duration + hookDur;
    if (Math.abs(outFacts.duration - expected) > 0.45) {
      await fs.promises.unlink(outputPath).catch(() => {});
      throw new HookComposeError('Kanca sesi videoyla üst üste bindi. Video, ses bitince başlamalı.');
    }
    if (outFacts.fps && outFacts.fps >= 60) {
      await fs.promises.unlink(outputPath).catch(() => {});
      throw new HookComposeError('Çıkış kare hızı 60 veya üzerinde.');
    }
    return outputPath;
  } catch (err) {
    if (err instanceof HookComposeError) throw err;
    throw new HookComposeError(err && err.message ? err.message : 'Kanca kurgusu tamamlanamadı.');
  } finally {
    if (scriptPath) await fs.promises.unlink(scriptPath).catch(() => {});
  }
}

module.exports = {
  composeHookVideo,
  prepareHookCaption,
  buildHookFilterGraph,
  buildHookCaptionFilter,
  HookComposeError,
  HOOK_BED_VOLUME
};

if (require.main === module) {
  const videoPath = process.argv[2];
  const hookMp3Path = process.argv[3];
  const outputPath = process.argv[4];
  const hookText = process.argv.slice(5).join(' ').trim();
  composeHookVideo({ videoPath, hookMp3Path, outputPath, hookText })
    .then((filePath) => { process.stdout.write(`${filePath}\n`); })
    .catch((err) => {
      process.stderr.write(`${err.message}\n`);
      process.exitCode = 1;
    });
}
