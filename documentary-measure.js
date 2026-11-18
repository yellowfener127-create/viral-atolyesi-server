/**
 * Bir mp4 için çözünürlük, fps, süre, LUFS ve siyah/donuk kare ölçümü.
 * Kullanım: node documentary-measure.js <video.mp4> [cikti.json]
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function parseProbe(stdout) {
  const data = JSON.parse(stdout || '{}');
  const video = (data.streams || []).find((stream) => stream.codec_type === 'video') || {};
  const audio = (data.streams || []).find((stream) => stream.codec_type === 'audio') || null;
  const rate = String(video.avg_frame_rate || video.r_frame_rate || '0/1');
  const parts = rate.split('/');
  const fps = Number(parts[1]) ? Number(parts[0]) / Number(parts[1]) : Number(parts[0]) || 0;
  return {
    width: Number(video.width) || 0,
    height: Number(video.height) || 0,
    fps: Math.round(fps * 1000) / 1000,
    duration_sec: Number(data.format && data.format.duration) || 0,
    has_audio: Boolean(audio)
  };
}

function parseEbur128(stderr) {
  const text = String(stderr || '');
  const summaryAt = text.lastIndexOf('Summary:');
  const body = summaryAt >= 0 ? text.slice(summaryAt) : text;
  const integrated = body.match(/I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/);
  const lra = body.match(/LRA:\s*(-?\d+(?:\.\d+)?)\s*LU/);
  const peak = body.match(/Peak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/);
  return {
    lufs: integrated ? Number(integrated[1]) : null,
    lra: lra ? Number(lra[1]) : null,
    true_peak_db: peak ? Number(peak[1]) : null
  };
}

function countEvents(stderr, marker) {
  return (String(stderr || '').match(new RegExp(marker, 'g')) || []).length;
}

async function measureFile(filePath, bins) {
  const ffmpeg = (bins && bins.ffmpeg) || 'ffmpeg';
  const ffprobe = (bins && bins.ffprobe) || 'ffprobe';
  const file = path.resolve(filePath);
  const probe = await run(ffprobe, [
    '-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height,avg_frame_rate,r_frame_rate',
    '-of', 'json', file
  ]);
  if (probe.code !== 0) throw new Error(probe.stderr.trim() || 'ffprobe başarısız');
  const loud = await run(ffmpeg, ['-hide_banner', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-']);
  const black = await run(ffmpeg, ['-hide_banner', '-i', file, '-vf', 'blackdetect=d=0.1:pix_th=0.10', '-an', '-f', 'null', '-']);
  const freeze = await run(ffmpeg, ['-hide_banner', '-i', file, '-vf', 'freezedetect=n=-60dB:d=0.5', '-an', '-f', 'null', '-']);
  return {
    file,
    ...parseProbe(probe.stdout),
    ...parseEbur128(loud.stderr),
    black_events: countEvents(black.stderr, 'black_start'),
    freeze_events: countEvents(freeze.stderr, 'freeze_start')
  };
}

async function main() {
  const file = process.argv[2];
  const out = process.argv[3];
  if (!file) {
    console.error('Kullanım: node documentary-measure.js <video.mp4> [cikti.json]');
    process.exit(1);
  }
  const report = await measureFile(file);
  const body = JSON.stringify(report, null, 2);
  if (out) fs.writeFileSync(out, body);
  console.log(body);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { measureFile, parseProbe, parseEbur128, countEvents };
