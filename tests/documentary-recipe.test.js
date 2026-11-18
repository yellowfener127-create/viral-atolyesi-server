const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const story = require('../documentary-story');
const timeline = require('../documentary-timeline');
const { judgeQc } = require('../documentary-qc');
const { buildMetadata, fileNameFor } = require('../documentary-meta');
const { maskKey } = require('../documentary-keys');
const { hashValue, stageOutputReady, markStage } = require('../documentary-job');
const { hamming, isFlat, tooSimilar } = require('../documentary-image');

test('bible and script validators catch an empty mechanism and a dream ending', () => {
  assert.ok(story.validateBible({ scope: 'one knife', hook: 'The knife stayed', final_line: 'The knife named him', core_mechanism: '' }).includes('core_mechanism empty'));
  const bible = {
    scope: 'one knife',
    hook: 'The knife stayed',
    final_line: 'The knife named him',
    core_mechanism: 'He left the knife in the lock.',
    characters: [{ id: 'keeper' }],
    is_fiction: false
  };
  assert.equal(bible.is_fiction, false);
  assert.deepEqual(story.validateBible(bible), []);
  assert.equal(bible.is_fiction, true);
  const script = {
    beats: [1, 2, 3, 4, 5].map((n) => ({
      narration: n === 5 ? 'Then he woke and it was a dream after all tonight.' : 'The knife stayed in the lock and turned the story.',
      shots: [{ visual_prompt: 'a', anchor_words: 'knife stayed', character_ids: ['keeper'] }]
    }))
  };
  script.beats[0].narration = 'The knife stayed in the lock.';
  const issues = story.validateScript(script, bible, { shots_per_scene: 1, word_target: { acceptMin: 10, acceptMax: 200 } });
  assert.ok(issues.includes('dream or coincidence'));
});

test('timeline locks a shot to its anchor and the last shot holds', () => {
  const scenes = [{
    narration: 'The knife stayed in the lock.',
    image_prompt: 'knife',
    shots: [
      { visual_prompt: 'knife', anchor_words: 'knife' },
      { visual_prompt: 'lock', anchor_words: 'lock' }
    ]
  }];
  const audio = [{
    duration: 4,
    words: [
      { word: 'The', start: 0, end: 0.2 },
      { word: 'knife', start: 0.2, end: 0.6 },
      { word: 'stayed', start: 0.6, end: 1 },
      { word: 'in', start: 1, end: 1.2 },
      { word: 'the', start: 1.2, end: 1.4 },
      { word: 'lock', start: 1.4, end: 2 }
    ]
  }];
  const clock = timeline.buildTimeline(scenes, audio);
  assert.equal(clock.shots[0].start, 0.2);
  assert.equal(clock.shots[1].start, 1.4);
  assert.ok(clock.shots[1].end >= 4.4);
  const ass = timeline.buildAss(timeline.chunkWords(audio[0].words), 'The knife stayed');
  assert.match(ass, /Style: Hook/);
  assert.doesNotMatch(ass, /@/);
});

test('qc accepts a measured reel and rejects a quiet one', () => {
  const good = judgeQc({
    width: 1080, height: 1920, fps: 30, duration_sec: 42, has_audio: true,
    lufs: -14, true_peak_db: -1.6, leading_silence_sec: 0.1, black_events: 0, freeze_events: 0
  }, { duration: [24, 70], shots: 15 });
  assert.equal(good.pass, true);
  const quiet = judgeQc({
    width: 1080, height: 1920, fps: 30, duration_sec: 42, has_audio: true,
    lufs: -24.3, true_peak_db: -4.6, black_events: 0, freeze_events: 0
  }, { duration: [24, 70], shots: 15 });
  assert.equal(quiet.pass, false);
  assert.ok(quiet.issues.includes('lufs'));
});

test('metadata stays on one channel and the filename has no hashtag', () => {
  const meta = buildMetadata({ channel: 'therapy', topic: 'The shock test', bible: { logline: 'A lab measured obedience.' } });
  assert.ok(meta.hashtags.includes('#therapy'));
  assert.equal(meta.hashtags.includes('#chaos'), false);
  assert.equal(meta.ai_generated, true);
  const name = fileNameFor('20261118', 'epoch', 'The cursed diary #chaos');
  assert.equal(name.includes('#'), false);
  assert.match(name, /^20261118_epoch_/);
});

test('keys are masked and a finished stage can be skipped', () => {
  assert.equal(maskKey('sk_live_1234567890abcd'), '****abcd');
  assert.equal(maskKey('short'), '');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'va-job-'));
  const hash = hashValue({ topic: 'knife' });
  markStage(dir, 'script', { state: 'done', inputHash: hash, file: 'script.json' });
  fs.writeFileSync(path.join(dir, 'script.json'), '{}');
  assert.equal(stageOutputReady(dir, 'script', hash), true);
  assert.equal(stageOutputReady(dir, 'script', 'other'), false);
  const flat = Buffer.from(new Array(64).fill(20));
  const varied = Buffer.from(new Array(64).fill(0).map((_, i) => i * 3));
  assert.equal(isFlat(flat), true);
  assert.equal(tooSimilar(hamming(varied, varied) === 0 ? '1111' : '', ''), false);
});
