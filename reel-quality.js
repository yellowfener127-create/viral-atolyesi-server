const story = require('./documentary-story');

const STOP = new Set(['the', 'and', 'that', 'with', 'from', 'this', 'his', 'her', 'was', 'were', 'for', 'into', 'after', 'before', 'while', 'then', 'them', 'they', 'have', 'had', 'has']);
const SENSITIVE = /\b(decapitat\w*|headless|severed|dismember\w*)\b/i;
const AFTERMATH = /\b(sentenced|pleaded|guilty|prison|convicted|years|freed)\b/i;
const VAGUE_PLACE = /\bto atlanta\b/i;
const TONE = /\b(lol|haha|hilarious|stupid|idiot|dumb)\b/i;
const HUMAN = /\b(person|people|man|woman|boy|girl|silhouette|hand|hands|driver|passenger|neighbor)\b/i;
const GRAPHIC = /\b(blood|corpse|gore|wound|decapitat\w*|headless|severed|dismember\w*)\b/gi;
const COMMUNITY_GRAPHIC = /\b(blood|bloody|corpse|gore|guts|entrails|wound|decapitat\w*|headless|severed|dismember\w*|mutilat\w*|beheading)\b/i;
const COMMUNITY_SEXUAL = /\b(nude|naked|porn|pornograph\w*|intercourse|genitals?|sex tape|orgasm)\b/i;
const COMMUNITY_CHILD = /\b(child|children|minor|underage|kid|toddler|infant|baby|boy|girl)\b/i;
const COMMUNITY_HATE = /\b(nigger|nigga|faggot|kike|spic|chink|tranny)\b/i;
const COMMUNITY_HARM = /\bhow to (kill yourself|commit suicide|cut (your|their) wrists?|make (a |an )?(bomb|explosive|gun|firearm|weapon)|build (a |an )?(bomb|explosive|gun|firearm|weapon))\b|\b(suicide method|best way to die)\b/i;

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
  const line = String(sentence || '').trim().replace(/^["'“”]+/, '');
  if (!line) return false;
  if (/^(accidentally|suddenly|unknowingly|driving|killed)\b/i.test(line)) return false;
  if (/^(after|before|while)\b/i.test(line)) {
    const rest = line.replace(/^(after|before|while)\b[, ]*/i, '');
    return /\b(he|she|they|we|i)\b/i.test(rest) || /\b[A-Z][\p{L}'’-]{1,}/u.test(rest);
  }
  if (/^(a|an|the|he|she|they|it|his|her|their|one|this|that)\b/i.test(line)) return true;
  if (/^[A-Z][\p{L}'’-]*/u.test(line)) return true;
  return /\b(he|she|they|we|i)\b/i.test(line);
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
    'You already read the story. The reading below is the event you must tell.',
    'Write one spoken script for a vertical reel.',
    'If the reading is short, open the same event with the ordinary moment around it until the script reaches 70 to 110 spoken words. Say where the person was, what they were doing, and how the thing reached them.',
    'A line like "a helicopter hit his head" can become "he was walking down the road when a helicopter lost altitude and fell onto him."',
    'Keep the same people, the same outcome, and the same cause. Do not invent a new person, a new ending, a court result, a date, or a different cause.',
    `Narration language: ${language}.`,
    'Five scenes. The five narrations together stay between 70 and 110 spoken words.',
    'Scene 1 is one sentence of 6 to 16 words. Start with He, She, They, A, The, or a name from the reading, then the stake. Do not start with Accidentally, Suddenly, or a bare verb. Do not use the words decapitated or headless. Use "killed instantly" instead.',
    'The next sentences, in order, add who, when, and where, then why, then the impact, then what he did next, then the discovery.',
    'If the reading contains a court result or a family response, one later sentence must say that result. Do not invent one.',
    'Do not repeat the same claim in two sentences in a row. The second sentence must add a new fact.',
    'Do not say "to Atlanta" unless the reading says the destination was Atlanta.',
    'Read the event again before each sentence. Use the fact that is already in the reading. Do not reach for a stock phrase. Do not end on imagine, could you imagine, can you imagine, or ever imagine.',
    'The finished video must be allowed on Instagram Reels, X, and YouTube. No graphic injury, no sexual content, no nudity, no slur, and no instructions for self-harm or weapons. Say that someone was killed instantly. If the moment is the injury, the picture shows the people still whole, just before impact.',
    nameLine(opts.name_policy),
    'image_prompt shows exactly the people that scene names, as ordinary people doing the action the narration gives them. Not silhouettes. A scene with no person does not gain one. No blood, no corpse, no wound, no severed body.',
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

function issueNote(issues) {
  const notes = {
    hook_no_subject: 'Scene 1 must start with He, She, They, A, The, or a name, and say what is at stake.',
    'word count': 'The reading is thin. Open the same event with the ordinary moment around it until the five narrations are between 70 and 110 words. Say where the person was, what they were doing, and how the event reached them.',
    hook_length: 'Scene 1 must be one sentence of 6 to 16 words.',
    hook_too_long: 'Scene 1 must stay under 4.5 seconds, so keep it to 16 words or fewer.',
    redundant_beat: 'Do not repeat the same claim in two sentences in a row.',
    no_new_info: 'Each sentence must add a new fact.',
    new_info_by_6s: 'Sentence 2 must add a new fact. Do not repeat the opening claim.',
    missing_aftermath: 'Add the court result or family response that is already in the reading.',
    missing_loop_closer: 'The last sentence must stay with this event. Do not use imagine.',
    community_graphic: 'Remove graphic injury from the words and the picture. Say the person was killed instantly. Do not show blood, a corpse, a wound, or a severed body. Instagram Reels, X, and YouTube reject that.',
    community_sexual: 'Remove sexual content and nudity. This video must be allowed on Instagram Reels, X, and YouTube.',
    community_minor: 'Remove any sexual content involving a child. Do not produce the video.',
    community_hate: 'Remove slurs and attacks on a group. This video must be allowed on Instagram Reels, X, and YouTube.',
    community_harm: 'Do not give instructions for self-harm, suicide, or making a weapon. You may say that the event happened, without explaining how to do it.',
    vague_location: 'Do not say "to Atlanta" unless the reading says that was the destination.',
    victim_full_name: 'Use only the victim\'s first name.',
    victim_named: 'Leave the victim\'s name out.',
    sensitive_hook: 'Do not use decapitated or headless in scene 1.'
  };
  return (issues || []).map((item) => {
    const count = String(item).match(/^word count (\d+)/);
    if (count) {
      const words = Number(count[1]);
      const direction = words < 70
        ? `The narration is ${words} words. Add the ordinary moment around the same event until it is between 70 and 110 words.`
        : `The narration is ${words} words. Shorten it to between 70 and 110 words without changing the event.`;
      return `${direction} ${notes['word count']}`;
    }
    return notes[item] || item;
  }).join(' ');
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
  if (words < 70 || words > 110) issues.push(`word count ${words}`);
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
  if (VAGUE_PLACE.test(spoken)) issues.push('vague_location');
  if (TONE.test(spoken)) issues.push('tone_check');
  const namePolicy = opts.name_policy || 'first_name';
  if (namePolicy === 'none' && /\bfriend\s+[A-Z][a-z]+\b/.test(spoken)) issues.push('victim_named');
  if (namePolicy === 'first_name' && /\bfriend\s+[A-Z][a-z]+\s+[A-Z][a-z]+\b/.test(spoken)) issues.push('victim_full_name');
  if (opts.fact_check === 'on' && (!Array.isArray(opts.sources) || !opts.sources.length)) issues.push('missing_sources');
  list.forEach((scene, index) => {
    if (!String(scene && scene.narration || '').trim()) issues.push(`empty scene ${index + 1}`);
  });
  communityIssues(list).forEach((code) => issues.push(code));
  return issues;
}

function sceneText(scenes) {
  return (scenes || []).flatMap((scene) => [
    scene && scene.narration,
    scene && scene.image_prompt,
    ...(Array.isArray(scene && scene.shots) ? scene.shots.map((shot) => shot && shot.visual_prompt) : [])
  ]).filter(Boolean).join(' ');
}

function softenGraphic(text) {
  return String(text || '')
    .replace(/\b(decapitat\w*|headless|severed|dismember\w*|mutilat\w*|beheading)\b/gi, 'killed instantly')
    .replace(/\b(corpse|guts|entrails)\b/gi, 'the empty seat')
    .replace(/\b(blood|bloody|gore)\b/gi, '')
    .replace(/\bwounds?\b/gi, 'impact')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?])/g, '$1')
    .trim();
}

function softenScenes(scenes) {
  (scenes || []).forEach((scene) => {
    if (!scene) return;
    if (scene.narration) scene.narration = softenGraphic(scene.narration);
    if (scene.image_prompt) scene.image_prompt = softenGraphic(scene.image_prompt);
    (scene.shots || []).forEach((shot) => {
      if (shot && shot.visual_prompt) shot.visual_prompt = softenGraphic(shot.visual_prompt);
    });
  });
  return scenes;
}

function communityIssues(scenes) {
  const text = sceneText(scenes);
  const issues = [];
  if (COMMUNITY_GRAPHIC.test(text)) issues.push('community_graphic');
  if (COMMUNITY_SEXUAL.test(text) && COMMUNITY_CHILD.test(text)) issues.push('community_minor');
  else if (COMMUNITY_SEXUAL.test(text)) issues.push('community_sexual');
  if (COMMUNITY_HATE.test(text)) issues.push('community_hate');
  if (COMMUNITY_HARM.test(text)) issues.push('community_harm');
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

function ensureHumanRatio(scenes) {
  return humanRatio(scenes);
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
  issueNote,
  hookVariants,
  voiceSpeed,
  isReveal,
  trueEventPrompt,
  structureIssues,
  communityIssues,
  softenScenes,
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
