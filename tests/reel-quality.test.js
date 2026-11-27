const test = require('node:test');
const assert = require('node:assert/strict');
const quality = require('../reel-quality');

const FAILING = [
  'Accidentally killed his friend and unknowingly traveled 12 miles with the lifeless body.',
  'John Hutcherson drove home with his headless passenger and went straight to bed.',
  'Earlier that evening in Cobb County, Georgia, the twenty-three year old hung out the window.',
  'An intoxicated Hutcherson drove off the road and sideswiped a telephone pole support wire.',
  'The horrific impact decapitated him instantly while Hutcherson continued the final twelve miles to Atlanta.',
  'The next morning, a shocked neighbor finally discovered the headless body inside the truck.'
];

const PASSING = [
  "He drove twelve miles home with his friend's body beside him, and never noticed.",
  'August 2004, Georgia.',
  'John Hutcherson and his friend leave a bar after drinking.',
  'His friend feels sick and leans out the window.',
  "Hutcherson drifts off the road and clips a telephone pole's support wire.",
  'His friend dies instantly.',
  'Hutcherson keeps driving, parks at home, and goes to bed.',
  'Around eight the next morning, a neighbor on a walk finds the truck.',
  'Hutcherson pleaded guilty and was sentenced to five years.',
  "The victim's family had asked for him to be freed.",
  'How do you drive twelve miles and not know?'
];

function pack(lines) {
  const scenes = lines.slice(0, 4).map((narration) => ({ narration }));
  scenes.push({ narration: lines.slice(4).join(' ') });
  return scenes;
}

test('the measured hutcherson narration fails the reel structure', () => {
  const review = quality.reviewTrueEvent(pack(FAILING), {
    requireAftermath: true,
    visuals: {
      human_shot_ratio: 0,
      time_of_day_match: false,
      vehicle_consistent: false,
      shot_durations: [3.87, 3.86, 3.87, 3.87, 3.86, 3.87, 3.86, 3.87, 3.87, 3.87]
    }
  });
  assert.equal(review.pass, false);
  ['hook_no_subject', 'redundant_beat', 'missing_aftermath', 'missing_loop_closer', 'vague_location', 'no_human_shots', 'time_of_day_mismatch', 'vehicle_inconsistency', 'uniform_cadence'].forEach((issue) => {
    assert.ok(review.issues.includes(issue), issue);
  });
});

test('a sourced aftermath script with a question passes', () => {
  const cuts = Array.from({ length: 16 }, () => ({ start: 0, end: 0 }));
  quality.applyVariableCuts(cuts, 38);
  const review = quality.reviewTrueEvent(pack(PASSING), {
    requireAftermath: true,
    name_policy: 'none',
    visuals: {
      human_shot_ratio: 0.5,
      time_of_day_match: true,
      vehicle_consistent: true,
      shot_durations: cuts.map((shot) => shot.end - shot.start)
    }
  });
  assert.deepEqual(review.issues, []);
  assert.equal(review.pass, true);
  assert.equal(review.hook_has_subject, true);
  assert.equal(review.aftermath_present, true);
  assert.equal(review.loop_closer_present, true);
});

test('an article or a name counts as a hook subject', () => {
  assert.equal(quality.hasSubject('A driver kept going twelve miles and never noticed.'), true);
  assert.equal(quality.hasSubject('The neighbor found the truck the next morning.'), true);
  assert.equal(quality.hasSubject('John drove home and never noticed his friend.'), true);
  assert.equal(quality.hasSubject('After the bar, John drove home and never noticed.'), true);
  assert.equal(quality.hasSubject('Accidentally killed his friend and unknowingly traveled 12 miles with the lifeless body.'), false);
  assert.equal(quality.hasSubject('Killed his friend on the drive home that night.'), false);
  assert.match(quality.issueNote(['hook_no_subject']), /He, She, They/);
  assert.match(quality.issueNote(['word count 60']), /60 words/);
  assert.match(quality.issueNote(['word count 60']), /ordinary moment/);
  assert.match(quality.trueEventPrompt({ shock: 'a', ending: 'b', events: ['c'] }, 'English', ''), /helicopter lost altitude/);
  assert.match(quality.trueEventPrompt({ shock: 'a', ending: 'b', events: ['c'] }, 'English', ''), /do not use imagine/i);
});

test('the default name policy keeps a victim surname out', () => {
  const withSurname = pack(PASSING.map((line) => line.replace('His friend feels', 'His friend Frankie Brohm feels')));
  const withFirst = pack(PASSING.map((line) => line.replace('His friend feels', 'His friend Frankie feels')));
  assert.ok(quality.structureIssues(withSurname).includes('victim_full_name'));
  assert.equal(quality.structureIssues(withFirst).includes('victim_full_name'), false);
  assert.ok(quality.structureIssues(withFirst, { name_policy: 'none' }).includes('victim_named'));
  assert.match(quality.trueEventPrompt({ shock: 'a', ending: 'b', events: ['c'] }, 'English', '', { name_policy: 'first_name' }), /only the first name/);
});

test('variable cuts stay under three seconds and are uneven', () => {
  const shots = Array.from({ length: 16 }, () => ({ start: 0, end: 0 }));
  quality.applyVariableCuts(shots, 38.3);
  const durations = shots.map((shot) => shot.end - shot.start);
  const stats = quality.durationStats(durations);
  assert.ok(stats.cv >= 0.15);
  assert.ok(stats.max <= 3.05);
  assert.ok(Math.abs(shots[shots.length - 1].end - 38.3) < 0.05);
  assert.equal(quality.shotCountFor(38.3) >= 16, true);
});

test('human ratio, vehicle lock and graphic wording stay nonviolent', () => {
  const scenes = [1, 2, 3, 4, 5].map(() => ({
    narration: 'He drove the truck down the dark road.',
    shots: [{ visual_prompt: 'A sunny forest and an empty road with no one there at all.' }]
  }));
  const ratio = quality.ensureHumanRatio(scenes, 0.4);
  assert.equal(ratio, 0);
  assert.doesNotMatch(scenes[0].shots[0].visual_prompt, /silhouette/);
  assert.equal(quality.lockVehicle(scenes), 'the same dark pickup truck');
  assert.match(quality.calmText('a headless corpse in blood'), /empty seat/);
  assert.doesNotMatch(quality.calmText('a headless corpse in blood'), /headless|corpse|blood/);
  assert.match(quality.mapCardSvg(12, 'August 2004 · Georgia'), /12 miles/);
  assert.equal(quality.tailPlan(38.3).tail, 0.65);
  assert.equal(quality.hookVariants('He drove home.').length, 3);
});
