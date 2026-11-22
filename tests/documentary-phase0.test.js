const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDocConfig, DOC_CONFIG } = require('../documentary-config');
const { parseEbur128, parseProbe, countEvents, countFreezes } = require('../documentary-measure');
const { dryRunPlan } = require('../documentary-dry-run');
const fixture = require('./fixtures/scene-plan.json');

test('config defaults keep the current pipeline', () => {
  const config = loadDocConfig({});
  assert.equal(config.STORY_PIPELINE, 'v2');
  assert.equal(config.OUTPUT_LAYOUT, 'jobs');
  assert.equal(config.CHAOS_SOURCE, 'reddit_premise');
  assert.equal(config.shots_per_scene, 2);
  assert.equal(config.image_count, 10);
  assert.equal(config.subtitles, 'ass');
  assert.equal(config.loudnorm, true);
  assert.equal(config.music_volume, 0.05);
  assert.deepEqual(config.duration_range.epoch, [24, 70]);
  assert.deepEqual(config.duration_aim, [40, 50]);
  assert.equal(DOC_CONFIG.TTS_MODEL, 'eleven_multilingual_v2');
});

test('legacy flags still select the previous pipeline', () => {
  const config = loadDocConfig({ STORY_PIPELINE: 'v1', OUTPUT_LAYOUT: 'legacy', DOC_LOUDNORM: '0' });
  assert.equal(config.STORY_PIPELINE, 'v1');
  assert.equal(config.OUTPUT_LAYOUT, 'legacy');
  assert.equal(config.loudnorm, false);
});

test('ebur128 and probe parsers read a sample report', () => {
  const loud = parseEbur128('I: -70.0 LUFS\nSummary:\n    I:         -26.4 LUFS\n    LRA:         8.2 LU\n    Peak:        -3.1 dBFS\n');
  assert.equal(loud.lufs, -26.4);
  assert.equal(loud.true_peak_db, -3.1);
  assert.equal(countFreezes('lavfi.freezedetect.freeze_start: 38.133333', 38.8), 0);
  assert.equal(countFreezes('lavfi.freezedetect.freeze_start: 10.0', 38.8), 1);
  const probe = parseProbe(JSON.stringify({
    format: { duration: '42.5' },
    streams: [
      { codec_type: 'video', width: 1080, height: 1920, avg_frame_rate: '30/1' },
      { codec_type: 'audio' }
    ]
  }));
  assert.equal(probe.width, 1080);
  assert.equal(probe.fps, 30);
  assert.equal(probe.has_audio, true);
  assert.equal(countEvents('black_start:0 black_start:2', 'black_start'), 2);
});

test('dry-run counts a fixture and does not call a network', () => {
  const report = dryRunPlan(fixture, loadDocConfig({}));
  assert.equal(report.live_calls, false);
  assert.deepEqual(report.stages, ['topic', 'script']);
  assert.equal(report.scene_count, 5);
  assert.equal(report.within_accept, true);
});
