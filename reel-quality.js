const story = require('./documentary-story');

const STOP = new Set(['the', 'and', 'that', 'with', 'from', 'this', 'his', 'her', 'was', 'were', 'for', 'into', 'after', 'before', 'while', 'then', 'them', 'they', 'have', 'had', 'has']);
const SENSITIVE = /\b(decapitat\w*|headless|severed|dismember\w*)\b/i;
const AFTERMATH = /\b(sentenced|pleaded|guilty|prison|convicted|years|freed)\b/i;
const VAGUE_PLACE = /\bto atlanta\b/i;
const TONE = /\b(lol|haha|hilarious|stupid|idiot|dumb)\b/i;
const FRAGMENT = /^(accidentally|suddenly|unknowingly|after|before|while|driving|killed)\b/i;
const HUMAN = /\b(person|people|silhouette|hand|hands|driver|passenger|interior)\b/i;
const GRAPHIC = /\b(blood|corpse|gore|wound|decapitat\w*|headless|severed|dismember\w*)\b/gi;

function contentWords(text) {
  return story.spokenTokens(text).filter((word) => word.length > 3 && !STOP.has(word));
}

function contentJaccard(a, b) {
  const left = new Set(contentWords(a));
  const right = new Set(contentWords(b));
  if (!left.size || !right.size) return 0;
  let shared = 0;
  left.forEach((word) => { if (right.has(word)) shared += 1; });
  return shared / (left.size + right.size - shared);
}

function sentencesOf(scenes) {
  return (scenes || []).flatMap((scene) => String(scene && scene.narration || '')
    .split(/(?<=[.!?])\s+/)
    .map((line) => line.trim())
    .filter(Boolean));
}

function hasSubject(sentence) {
  const line = String(sentence || '').trim();
  if (!line || FRAGMENT.test(line)) return false;
  return /^(he|she|they|it|[A-Z][a-z]+)\b/.test(line);
}

function hookVariants(hook) {
  const line = String(hook || '').replace(/\s+/g, ' ').trim();
  if (!line) return [];
  const soft = line.replace(SENSITIVE, 'killed instantly');
  return [soft, `What if ${soft.charAt(0).toLowerCase()}${soft.slice(1)}`, `How does this start: ${soft}`].slice(0, 3);
}

function voiceSpeed(scene, base) {
  const speed = Number(base) || 1.1;
  const text = `${scene && scene.narration || ''} ${scene && scene.voice_tone || ''}`;
  const reveal = isReveal(text);
  const climb = /\b(urgent|faster|drive|drove|racing)\b/i.test(text);
  const factor = reveal ? 0.92 : (climb ? 1.08 : 1);
  return Math.round(speed * factor * 1000) / 1000;
}

function isReveal(text) {
  return /\b(discover\w*|found|finds|neighbor|died instantly|dies instantly|impact)\b/i.test(String(text || ''));
}

function nameLine(policy) {
  if (policy === 'full') return 'A victim name from the reading may be used in full. A defendant name may stay only when the reading already uses it.';
  if (policy === 'none') return 'If the reading names the victim, leave that name out. A defendant name may stay only when the reading already uses it.';
  return 'If the reading names the victim, use only the first name. Do not use the victim surname. A defendant name may stay only when the reading already uses it.';
}

function trueEventPrompt(reading, language, note, options) {
  const opts = options || {};
  return [
    'You already read the story. The reading below is the only material you may use.',
    'Write one spoken script for a vertical reel.',
    'Do not add a person, place, number, date, court result, or cause that the reading does not contain.',
    `Narration language: ${language}.`,
    'Five scenes. The five narrations together stay between 80 and 110 spoken words.',
    'Scene 1 is one sentence of at most 16 words. It has a subject and a stake. It is not a fragment. It does not use the words decapitated or headless. Use "killed instantly" instead.',
    'The next sentences, in order, add who, when, and where, then why, then the impact, then what he did next, then the discovery.',
    'If the reading contains a court result or a family response, one later sentence must say that result. Do not invent one.',
    'Do not repeat the same claim in two sentences in a row. The second sentence must add a new fact.',
    'Do not say "to Atlanta" unless the reading says the destination was Atlanta.',
    'The last sentence is a question. It echoes a concrete phrase from the first sentence and asks the viewer to respond.',
    nameLine(opts.name_policy),
    'image_prompt shows the moment as an anonymous silhouette, a hand, or the inside of the vehicle. No blood, no corpse, no wound, no severed body.',
    'anchor_words are 2 to 4 words copied from that scene narration.',
    'voice_tone is a short English direction such as "quiet, tense" or "slow, low".',
    'music_mood is exactly one of mystery, epic, sad, science.',
    'No square brackets and no stage directions.',
    note ? `Fix: ${note}` : '',
    `Reading:\n${JSON.stringify(reading)}`
  ].filter(Boolean).join('\n');
}

function sameClaim(a, b) {
  if (contentJaccard(a, b) > 0.5) return true;
  const travel = /\b(drove|drive|driven|driving|traveled|travelled|traveling|travelling|home)\b/i;
  const carried = /\b(body|passenger|friend|headless|lifeless)\b/i;
  return travel.test(a) && travel.test(b) && carried.test(a) && carried.test(b);
}

function addsFact(prev, next) {
  const before = new Set(contentWords(prev));
  return contentWords(next).some((word) => !before.has(word));
}

function structureIssues(scenes, options) {
  const opts = options || {};
  const maxWords = Number(opts.hook_max_words) || 16;
  const maxSec = Number(opts.hook_max_sec) || 4.5;
  const lines = sentencesOf(scenes);
  const issues = [];
  const list = Array.isArray(scenes) ? scenes : [];
  if (list.length !== 5) issues.push('five scenes');
  const words = list.reduce((sum, scene) => sum + story.wordCount(scene && scene.narration), 0);
  if (words < 70 || words > 120) issues.push(`word count ${words}`);
  const hook = lines[0] || '';
  const hookWords = story.wordCount(hook);
  if (hook.split(/[.!?]+/).filter(Boolean).length !== 1 || hookWords < 6 || hookWords > maxWords) issues.push('hook_length');
  if (hookWords / 3.2 > maxSec) issues.push('hook_too_long');
  if (!hasSubject(hook)) issues.push('hook_no_subject');
  if ((opts.sensitive_hook || 'soft') === 'soft' && SENSITIVE.test(hook)) issues.push('sensitive_hook');
  lines.slice(0, -1).forEach((line, index) => {
    const next = lines[index + 1];
    if (sameClaim(line, next)) issues.push('redundant_beat');
    else if (!addsFact(line, next)) issues.push('no_new_info');
  });
  if (lines.length < 2 || sameClaim(hook, lines[1] || '') || hookWords > Math.floor(6 * 3.2)) issues.push('new_info_by_6s');
  const spoken = lines.join(' ');
  const source = String(opts.source || '');
  const requireAftermath = opts.requireAftermath || AFTERMATH.test(source);
  if (requireAftermath && !AFTERMATH.test(spoken)) issues.push('missing_aftermath');
  const last = lines[lines.length - 1] || '';
  if (!/\?/.test(last) || contentJaccard(hook, last) < 0.12) issues.push('missing_loop_closer');
  if (VAGUE_PLACE.test(spoken)) issues.push('vague_location');
  if (TONE.test(spoken)) issues.push('tone_check');
  const namePolicy = opts.name_policy || 'first_name';
  if (namePolicy === 'none' && /\bfriend\s+[A-Z][a-z]+\b/.test(spoken)) issues.push('victim_named');
  if (namePolicy === 'first_name' && /\bfriend\s+[A-Z][a-z]+\s+[A-Z][a-z]+\b/.test(spoken)) issues.push('victim_full_name');
  if (opts.fact_check === 'on' && (!Array.isArray(opts.sources) || !opts.sources.length)) issues.push('missing_sources');
  list.forEach((scene, index) => {
    if (!String(scene && scene.narration || '').trim()) issues.push(`empty scene ${index + 1}`);
  });
  return issues;
}

function visualIssues(visuals) {
  const row = visuals || {};
  const issues = [];
  if (row.human_shot_ratio != null && row.human_shot_ratio < 0.4) issues.push('no_human_shots');
  if (row.time_of_day_match === false) issues.push('time_of_day_mismatch');
  if (row.vehicle_consistent === false) issues.push('vehicle_inconsistency');
  const durations = Array.isArray(row.shot_durations) ? row.shot_durations : [];
  if (durations.length) {
    const stats = durationStats(durations);
    if (stats.cv < 0.15) issues.push('uniform_cadence');
    if (stats.max > 3) issues.push('max_shot_duration');
  }
  return issues;
}

function reviewTrueEvent(scenes, options) {
  const issues = structureIssues(scenes, options).concat(visualIssues(options && options.visuals));
  const lines = sentencesOf(scenes);
  return {
    pass: issues.length === 0,
    issues,
    hook_has_subject: hasSubject(lines[0]),
    redundant_beat: issues.includes('redundant_beat'),
    new_info_by_6s: !issues.includes('new_info_by_6s'),
    aftermath_present: AFTERMATH.test(lines.join(' ')),
    loop_closer_present: !issues.includes('missing_loop_closer')
  };
}

function durationStats(durations) {
  const values = (durations || []).map(Number).filter((value) => Number.isFinite(value));
  if (!values.length) return { cv: 0, max: 0, mean: 0 };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;
  return { cv: mean ? Math.sqrt(variance) / mean : 0, max: Math.max(...values), mean };
}

function applyVariableCuts(shots, spoken) {
  const list = shots || [];
  const total = Number(spoken) || list.reduce((sum, shot) => sum + ((shot.end || 0) - (shot.start || 0)), 0);
  if (!list.length || !(total > 0)) return list;
  const weights = list.map((_, index) => (index % 2 === 0 ? 0.84 : 1.16));
  const weightSum = weights.reduce((sum, value) => sum + value, 0);
  let durations = weights.map((weight) => (total * weight) / weightSum);
  durations = durations.map((value) => Math.min(3, Math.max(1.5, value)));
  const scale = total / durations.reduce((sum, value) => sum + value, 0);
  durations = durations.map((value) => Math.min(3, value * scale));
  const drift = total - durations.reduce((sum, value) => sum + value, 0);
  durations[durations.length - 1] = Math.max(0.4, durations[durations.length - 1] + drift);
  let cursor = 0;
  list.forEach((shot, index) => {
    shot.start = cursor;
    shot.end = index === list.length - 1 ? total : cursor + durations[index];
    shot.local_start = 0;
    shot.local_end = shot.end - shot.start;
    cursor = shot.end;
  });
  return list;
}

function shotCountFor(spoken) {
  const duration = Number(spoken) || 0;
  if (!(duration > 0)) return 9;
  return Math.max(8, Math.min(24, Math.ceil(duration / 2.5)));
}

function calmText(text) {
  return String(text || '').replace(GRAPHIC, 'the empty seat').replace(/\s+/g, ' ').trim();
}

function allShots(scenes) {
  return (scenes || []).flatMap((scene) => (Array.isArray(scene.shots) ? scene.shots : []));
}

function ensureHumanRatio(scenes, ratio) {
  const need = Number(ratio) || 0.4;
  const shots = allShots(scenes);
  if (!shots.length) return 0;
  const phrase = ' Seen from inside the vehicle, an anonymous silhouette keeps both hands on the wheel. No injury is shown.';
  let human = shots.filter((shot) => HUMAN.test(shot.visual_prompt)).length;
  shots.forEach((shot) => {
    if (human / shots.length >= need) return;
    if (HUMAN.test(shot.visual_prompt)) return;
    shot.visual_prompt = `${shot.visual_prompt}${phrase}`;
    human += 1;
  });
  return human / shots.length;
}

function lockLighting(scenes) {
  const spoken = (scenes || []).map((scene) => scene.narration).join(' ');
  const night = /\b(evening|night|dark)\b/i.test(spoken);
  const morning = /\b(morning|dawn)\b/i.test(spoken);
  (scenes || []).forEach((scene, index) => {
    const late = index >= Math.ceil((scenes.length - 1) * 0.7);
    const light = morning && late
      ? 'early morning light'
      : (night ? 'night, headlights, no noon sun' : 'the light of the hour being spoken');
    (scene.shots || []).forEach((shot) => {
      let prompt = String(shot.visual_prompt || '');
      if (light.indexOf('night') === 0 || light.indexOf('early morning') === 0) {
        prompt = prompt.replace(/\b(sunny|sunlit|daylight|noon|midday|bright afternoon)\b/gi, '').replace(/\s+/g, ' ').trim();
      }
      if (!prompt.includes(light)) prompt = `${prompt} ${light}.`;
      shot.visual_prompt = prompt;
    });
  });
}

function lockVehicle(scenes) {
  const spoken = (scenes || []).map((scene) => scene.narration).join(' ');
  const phrase = /\bpickup|truck\b/i.test(spoken) ? 'the same dark pickup truck' : (/\bcar\b/i.test(spoken) ? 'the same dark car' : '');
  if (!phrase) return '';
  (scenes || []).forEach((scene) => {
    const aboutRoad = /\b(drove|drive|road|truck|car|pickup|park)\b/i.test(scene.narration || '');
    if (!aboutRoad) return;
    (scene.shots || []).forEach((shot) => {
      if (!shot.visual_prompt.includes(phrase)) shot.visual_prompt = `${shot.visual_prompt} ${phrase}.`;
    });
  });
  return phrase;
}

function humanRatio(scenes) {
  const shots = allShots(scenes);
  if (!shots.length) return 0;
  return shots.filter((shot) => HUMAN.test(shot.visual_prompt)).length / shots.length;
}

function mapCardSvg(miles, label) {
  const distance = String(miles || '12');
  const caption = String(label || '').replace(/[<>&]/g, ' ');
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920">',
    '<rect width="1080" height="1920" fill="#14120f"/>',
    '<g stroke="#3a342c" stroke-width="1">',
    Array.from({ length: 12 }, (_, i) => `<line x1="${i * 90}" y1="0" x2="${i * 90}" y2="1920"/>`).join(''),
    Array.from({ length: 20 }, (_, i) => `<line x1="0" y1="${i * 96}" x2="1080" y2="${i * 96}"/>`).join(''),
    '</g>',
    '<path d="M180 1500 C 360 1200, 520 980, 860 420" fill="none" stroke="#d7c4a3" stroke-width="8"/>',
    `<text x="120" y="280" fill="#f4efe6" font-size="92" font-family="Georgia">${distance} miles</text>`,
    `<text x="120" y="380" fill="#c8bba6" font-size="42" font-family="Georgia">${caption}</text>`,
    '</svg>'
  ].join('');
}

function tailPlan(voiceDur) {
  const voice = Number(voiceDur) || 0;
  return { tail: 0.65, fade: 0.25, end: voice + 0.65 };
}

module.exports = {
  contentJaccard,
  hasSubject,
  hookVariants,
  voiceSpeed,
  isReveal,
  trueEventPrompt,
  structureIssues,
  reviewTrueEvent,
  durationStats,
  applyVariableCuts,
  shotCountFor,
  calmText,
  ensureHumanRatio,
  lockLighting,
  lockVehicle,
  humanRatio,
  mapCardSvg,
  tailPlan,
  visualIssues
};
