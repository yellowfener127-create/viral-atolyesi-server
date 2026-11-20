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

test('a pasted story is read before the reel prompt', () => {
  const read = story.reelReadPrompt('She left the house. The door was locked from inside.');
  assert.match(read, /Do not write a script/);
  assert.match(read, /locked from inside/);
  const prompt = story.reelPrompt({
    shock: 'The door was locked from inside.',
    ending: 'The key was still in her pocket.',
    events: ['She left the house.', 'The door was locked from inside.']
  }, 'Turkish', '');
  assert.match(prompt, /already read the story/);
  assert.match(prompt, /80 to 85/);
  assert.match(prompt, /locked from inside/);
  assert.match(prompt, /Do not invent a name/);
  assert.match(prompt, /returns to the tension of the first sentence/);
  assert.match(read, /person name/);
  assert.doesNotMatch(story.biblePrompt('Mary Celeste', 'chaos', 'English'), /Do not invent a name/);
  assert.equal(story.reelSourceLanguage('The door was locked from inside after she left the house.'), 'en');
  assert.equal(story.reelSourceLanguage('Kapı içeriden kilitliydi ve anahtar hâlâ cebindeydi.'), 'tr');
  assert.match(story.reelTranslatePrompt([{ narration: 'The door was locked.' }], 'Turkish'), /Translate each narration into Turkish/);
  assert.match(story.reelRepairNote(['word count 60'], 60), /Add 20 to 25 words/);
  assert.match(story.reelLengthPrompt([{ narration: 'The door was locked.' }], 60, 'English'), /between 80 and 85/);
});

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

test('a critic with no named issue does not block the film', () => {
  assert.equal(story.criticFails({ pass: false, issues: [] }), false);
  assert.equal(story.criticFails({ pass: true, issues: [] }), false);
  assert.equal(story.criticFails({ pass: false, issues: [{ type: 'dream', fix: 'remove the dream' }] }), true);
  assert.equal(story.criticFails(null), true);
});

test('the measured roman-legion narration fails and pauses stay at punctuation', () => {
  const factory = require('../documentary-factory');
  const timeline = require('../documentary-timeline');
  const sample = 'What happened to six thousand Roman soldiers who simply vanished? A Roman legion marched east after captivity, settling at Liqian in ancient China. They left behind unique metallurgical traits and peculiar fish scale military formation. DNA testing reveals partial European ancestry matching ancient texts about foreign captive soldiers. History is not just written in books, it is etched into the very DNA of those who refuse to stay lost.';
  const issues = story.narrationClaimIssues(sample);
  ['unsupported_number', 'ambiguous_causality', 'garbled_claim', 'category_error', 'contradicted_by_consensus', 'vacuous_closer'].forEach((kind) => {
    assert.ok(issues.includes(kind), kind);
  });
  assert.equal(factory.pauseForSpan('They vanished.'), 0.48);
  assert.equal(factory.pauseForSpan('Who vanished?'), 0.52);
  assert.equal(factory.pauseForSpan('soldiers who'), 0);
  const mismatched = factory.sentenceSpans(
    [{ word: 'only', start: 0, end: 0.4 }],
    'only one word here.'
  );
  assert.equal(mismatched.length, 1);
  assert.equal(mismatched[0].pause, 0);
  assert.equal(timeline.distinctHook(sample), '');
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
  assert.equal(clock.shots[0].start, 0);
  assert.equal(clock.shots.length, 2);
  assert.ok(Math.abs((clock.shots[0].end - clock.shots[0].start) - 2) < 0.001);
  assert.ok(Math.abs((clock.shots[1].end - clock.shots[1].start) - 2) < 0.001);
  assert.equal(clock.shots[1].end, 4);
  const covered = clock.shots.reduce((sum, shot) => sum + (shot.end - shot.start), 0);
  assert.ok(Math.abs(covered - 4) < 0.001);
  const ass = timeline.buildAss(timeline.chunkWords(audio[0].words), 'The knife stayed');
  assert.match(ass, /Style: Hook/);
  assert.doesNotMatch(ass, /@/);
});

test('a short picture cannot drop the last sentence', () => {
  const { hasSeam, isStacked } = require('../documentary-image');
  const scenes = [{
    narration: 'Physical evidence bridges the gap between empires. The echoes of Rome still whisper through the brick walls of Liqian.',
    image_prompt: 'wall',
    shots: [
      { visual_prompt: 'gap', anchor_words: 'gap' },
      { visual_prompt: 'empires', anchor_words: 'empires' },
      { visual_prompt: 'Liqian', anchor_words: 'Liqian' }
    ]
  }];
  const words = scenes[0].narration.split(/\s+/).map((word, index) => ({ word, start: index * 0.4, end: index * 0.4 + 0.3 }));
  const clock = timeline.buildTimeline(scenes, [{ duration: 8, words }]);
  assert.equal(clock.shots[0].start, 0);
  assert.equal(clock.shots.length, 3);
  clock.shots.forEach((shot) => {
    assert.ok(Math.abs((shot.end - shot.start) - (8 / 3)) < 0.001);
  });
  assert.ok(Math.abs(clock.shots[2].end - 8) < 0.001);
  const issues = story.narrationClaimIssues('Did a lost Roman legion really vanish into ancient China? One theory holds that prisoners marched east. Modern scientific investigation changed everything when DNA testing revealed isolated Mediterranean genetic markers. They built a fish-scale fort. Physical evidence bridges the gap between empires.');
  ['certainty_escalation', 'missing_consensus', 'unanswered_hook', 'unsupported_detail', 'vague_claim', 'misleading_evidence'].forEach((kind) => {
    assert.ok(issues.includes(kind), kind);
  });
  const flat = Buffer.alloc(64 * 32, 40);
  const seam = Buffer.alloc(64 * 32, 30);
  seam.fill(180, 15 * 64, 16 * 64);
  seam.fill(210, 16 * 64);
  assert.equal(hasSeam(flat, 64, 32), false);
  assert.equal(hasSeam(seam, 64, 32), true);
  const plain = Buffer.alloc(40 * 60, 90);
  const stacked = Buffer.alloc(40 * 60, 90);
  for (let y = 20; y < 22; y++) stacked.fill(250, y * 40, (y + 1) * 40);
  for (let y = 40; y < 42; y++) stacked.fill(250, y * 40, (y + 1) * 40);
  assert.equal(isStacked(plain, 40, 60), false);
  assert.equal(isStacked(stacked, 40, 60), true);
  assert.equal(story.coverageReport('The echoes of Rome', [{ word: 'The' }, { word: 'echoes' }, { word: 'of' }, { word: 'Rome' }]).match, true);
  assert.equal(story.coverageReport('unique double-shield turtle', [{ word: 'unique' }, { word: 'double-shield' }, { word: 'turtle' }]).match, true);
  assert.equal(story.coverageReport('The echoes of Rome still whisper', [{ word: 'The' }, { word: 'echoes' }]).match, false);
});

test('qc accepts a measured reel and rejects a quiet one', () => {
  const good = judgeQc({
    width: 1080, height: 1920, fps: 30, duration_sec: 42, has_audio: true,
    lufs: -14, true_peak_db: -1.6, leading_silence_sec: 0.1, black_events: 0, freeze_events: 0
  }, { duration: [24, 70], shots: 15 });
  assert.equal(good.pass, true);
  const held = judgeQc({
    width: 1080, height: 1920, fps: 30, duration_sec: 47, has_audio: true,
    lufs: -14.1, true_peak_db: -1.1, black_events: 0, freeze_events: 0
  }, { duration: [24, 70], shots: 15, hardMax: 70 });
  assert.equal(held.pass, true);
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

test('eight frames mark only shots under 3 for one redo', () => {
  const vision = require('../documentary-vision');
  const times = vision.sampleTimes(40, 8);
  assert.equal(times.length, 8);
  assert.ok(times[0] > 0 && times[7] < 40);
  const shots = [
    { start: 0, end: 10 },
    { start: 10, end: 20 },
    { start: 20, end: 40 }
  ];
  assert.equal(vision.shotAt(shots, times[0]), 0);
  assert.deepEqual(vision.shotsToRedo([
    { shot: 0, score: 5 },
    { shot: 1, score: 2 },
    { shot: 1, score: 4 },
    { shot: 2, score: 3 }
  ]), [1]);
});

test('keys are masked and a finished stage can be skipped', () => {
  assert.equal(maskKey('sk_live_1234567890abcd'), '****abcd');
  const { usableElevenKey } = require('../documentary-keys');
  assert.equal(usableElevenKey('sk_live_1234567890abcd'), true);
  assert.equal(usableElevenKey('a1b2c3d4e5f6789012345678abcdef12'), false);
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
