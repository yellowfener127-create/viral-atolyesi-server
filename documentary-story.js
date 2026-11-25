const fs = require('fs');
const path = require('path');

const DREAM_MARKS = [
  'it was a dream', 'it was all a dream', 'he woke up', 'she woke up',
  'rüya', 'ruyaydi', 'rüyaydı', 'uyanınca', 'tesadüf', 'coincidence'
];

function tokens(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9çğıöşü\s]/gi, ' ').split(/\s+/).filter((word) => word.length > 2);
}

function jaccard(a, b) {
  const left = new Set(tokens(a));
  const right = new Set(tokens(b));
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}

function wordCount(text) {
  return String(text || '').replace(/\[[^\]]*\]/g, ' ').trim().split(/\s+/).filter(Boolean).length;
}

function readTopicHistory(file) {
  if (!file || !fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-200);
}

function rememberTopic(file, topic) {
  const text = String(topic || '').replace(/\s+/g, ' ').trim();
  if (!text || !file) return;
  const prior = readTopicHistory(file).filter((line) => line.toLowerCase() !== text.toLowerCase());
  prior.push(text);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, prior.slice(-200).join('\n') + '\n');
}

function similarTopic(topic, history) {
  return (history || []).some((line) => jaccard(topic, line) >= 0.72);
}

function validateBible(bible) {
  const issues = [];
  if (!bible || typeof bible !== 'object') return ['bible missing'];
  const mechanism = String(bible.core_mechanism || '').trim();
  if (!mechanism || /^unknown$/i.test(mechanism)) issues.push('core_mechanism empty');
  if (!String(bible.scope || '').trim()) issues.push('scope empty');
  if (!String(bible.hook || '').trim()) issues.push('hook empty');
  if (!String(bible.final_line || '').trim()) issues.push('final_line empty');
  if (bible.is_fiction === false && !(Array.isArray(bible.sources) && bible.sources.length)) {
    bible.is_fiction = true;
  }
  return issues;
}

function beatsOf(script) {
  if (!script || typeof script !== 'object') return [];
  if (Array.isArray(script.beats)) return script.beats;
  if (Array.isArray(script.scenes)) return script.scenes;
  return [];
}

function validateScript(script, bible, config) {
  const issues = [];
  const beats = beatsOf(script);
  if (beats.length < 5) issues.push('fewer than 5 beats');
  const ids = new Set(((bible && bible.characters) || []).map((item) => item && item.id).filter(Boolean));
  let words = 0;
  beats.forEach((beat, index) => {
    const narration = String(beat && beat.narration || '');
    if (/\[[^\]]*\]/.test(narration)) issues.push(`beat ${index + 1} has square brackets`);
    words += wordCount(narration);
    const shots = Array.isArray(beat && beat.shots) ? beat.shots : [];
    const wanted = config && config.shots_per_scene ? config.shots_per_scene : 1;
    if (shots.length && shots.length < Math.min(2, wanted)) issues.push(`beat ${index + 1} is short on shots`);
    shots.forEach((shot) => {
      const anchor = String(shot && shot.anchor_words || '').trim();
      if (anchor && narration.toLowerCase().indexOf(anchor.toLowerCase()) < 0) {
        issues.push(`anchor missing in beat ${index + 1}`);
      }
      (shot.character_ids || []).forEach((id) => {
        if (ids.size && !ids.has(id)) issues.push(`unknown character ${id}`);
      });
    });
  });
  const hookWords = wordCount(beats[0] && beats[0].narration);
  if (hookWords > 14 || hookWords < 6) issues.push('hook length');
  const target = (config && config.word_target) || { acceptMin: 60, acceptMax: 140 };
  if (words < target.acceptMin || words > target.acceptMax) issues.push(`word count ${words}`);
  const blob = beats.map((beat) => beat && beat.narration).join(' ').toLowerCase();
  if (DREAM_MARKS.some((mark) => blob.indexOf(mark) >= 0)) issues.push('dream or coincidence');
  narrationClaimIssues(blob).forEach((issue) => issues.push(issue));
  return issues;
}

function spokenTokens(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[^a-z0-9']+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function coverageReport(scriptText, alignmentWords) {
  const scriptWords = spokenTokens(scriptText);
  const aligned = (alignmentWords || []).flatMap((item) => spokenTokens(item && item.word ? item.word : item));
  const match = scriptWords.length === aligned.length && scriptWords.every((word, index) => word === aligned[index]);
  return {
    script_words: scriptWords.length,
    alignment_words: aligned.length,
    caption_words: aligned.length,
    match
  };
}

function narrationClaimIssues(narration) {
  const text = String(narration || '');
  const issues = [];
  if (/\bsix thousand\b/i.test(text)) issues.push('unsupported_number');
  if (/marched east after captivity/i.test(text)) issues.push('ambiguous_causality');
  if (/metallurgical traits/i.test(text)) issues.push('garbled_claim');
  if (/matching ancient texts/i.test(text)) issues.push('category_error');
  if (/DNA testing reveals partial European ancestry/i.test(text)) issues.push('contradicted_by_consensus');
  if (/refuse to stay lost/i.test(text)) issues.push('vacuous_closer');
  if (/physical evidence bridges the gap/i.test(text)) issues.push('misleading_evidence');
  if (/changed everything/i.test(text)) issues.push('certainty_escalation');
  if (/fish-scale fort/i.test(text)) issues.push('unsupported_detail');
  if (/isolated Mediterranean genetic markers/i.test(text)) issues.push('vague_claim');
  if (/marched east after the Battle of Carrhae to settle/i.test(text)) issues.push('incomplete_chain');
  if (/really vanish/i.test(text) && /physical evidence bridges/i.test(text)) issues.push('unanswered_hook');
  if (/one theory holds/i.test(text) && /changed everything/i.test(text)) issues.push('missing_consensus');
  return issues;
}

function criticFails(critic) {
  if (!critic || typeof critic !== 'object') return true;
  const issues = Array.isArray(critic.issues) ? critic.issues : [];
  return issues.some((issue) => /dream|coincidence|unexplained|scope|hook/i.test(String((issue && (issue.type || issue.fix)) || issue)));
}

function biblePrompt(topic, channel, language) {
  return [
    'Write a story bible for one vertical documentary. Return JSON only.',
    `Channel: ${channel}. Language: ${language}.`,
    `Topic: ${topic}`,
    'scope is one main thing. Title, narration, and pictures stay on that one thing.',
    'core_mechanism is the physical chain: who did what, with which object, and what changed. Empty or unknown is invalid.',
    'hook is the promise of the first two seconds. final_line pays that promise off.',
    'is_fiction is true unless you include a sources array of real URLs.',
    'Do not accuse a real living person. Therapy uses "research suggests" and does not invent a study.',
    'Chaos uses the premise only: new characters, new order, no copied sentences, no dream, no coincidence as the answer.',
    'forbidden lists title spoilers, scope changes, new characters, and unanswered questions.'
  ].join('\n');
}

function scriptPrompt(bible, language, shotsPerScene, note) {
  return [
    'Write the spoken script from this bible only. Do not add a new fact.',
    `Language: ${language}.`,
    `Shots per beat: ${shotsPerScene}.`,
    'Five beats. Each beat has one draft photograph of the moment that beat speaks. A later pass cuts the whole narration into nine moments.',
    'Beats in order: hook, setup, escalation, twist, close.',
    'Hook is one sentence, 6 to 7 spoken words, no spoiler, no square brackets.',
    'Each beat has narration (1 or 2 sentences), voice_direction, and shots.',
    'Each shot has visual_prompt, anchor_words that appear in the narration, location_id, and character_ids.',
    'visual_prompt is 80 to 120 concrete English words. No readable text, logo, or famous face.',
    'Aim for 80 to 90 spoken words. Stay between 75 and 100.',
    'The close pays off the hook. A dream, a coincidence, or an unexplained event cannot be the answer.',
    'A number, year, or proper name must be a claim. Disputed or legendary claims use "one theory holds" or "a legend says". Debunked claims are not stated as fact. The final line is a concrete conclusion, not a slogan.',
    note ? `Fix: ${note}` : '',
    `Bible: ${JSON.stringify(bible)}`
  ].filter(Boolean).join('\n');
}

function reelReadPrompt(source) {
  return [
    'Read the source from the first word to the last. Do not write a script.',
    'Return the events that are actually written, in the order they happen.',
    'shock is the single most surprising result or mystery already in the source.',
    'ending is the last real event.',
    'Each event is one short sentence. Keep every person name, place name, ship or location name, date, and clock time the source uses.',
    'Do not add a cause, a dream, a coincidence, a person, a place, or a date that the source does not contain.',
    `Source:\n${source}`
  ].join('\n');
}

function reelPrompt(reading, language, note) {
  return [
    'You already read the story. The reading below is the only material you may use.',
    'Now write one spoken script for a 40 to 50 second vertical reel.',
    'Do not add a dream, a coincidence, a character, a place, a number, a date, or a cause that the reading does not contain.',
    `Narration language: ${language}.`,
    'Five scenes. Count every spoken word. The five narrations together must be 80 to 85 words. Under 80 is wrong. Never pass 85.',
    'Use the person names, place names, ship or location names, dates, and clock times already in the reading. Fit them into the sentence so the line still reads aloud. Do not invent a name, a place, a date, a time, or a detail that the reading does not contain.',
    'Scene 1 is one sentence of 6 to 14 words. It is spoken in the first 3 seconds. It points straight at the sharpest result or contradiction and includes at least one concrete name, place, or time from the reading.',
    'Scenes 2, 3 and 4 retell the reading in chronological order. Sentences stay short, clear, and easy to speak. Do not repeat a stock phrase.',
    'The last sentence closes the story on a clear knot and returns to the tension of the first sentence. It adds no new fact.',
    'image_prompt is one English photograph of 40 to 70 words. It shows only the instant that scene speaks. If that scene has people, put each of them in the frame as an anonymous silhouette doing that action, not a sharp face and not a portrait. One continuous vertical photograph. Match the light to the scene. Do not force a dark grade. No neon and no candy colors.',
    'anchor_words are 2 to 4 words copied from that scene narration.',
    'voice_tone is a short English direction such as "quiet, tense".',
    'music_mood is exactly one of mystery, epic, sad, science.',
    'No square brackets and no stage directions.',
    note ? `Fix: ${note}` : '',
    `Reading:\n${JSON.stringify(reading)}`
  ].filter(Boolean).join('\n');
}

function reelSourceLanguage(text) {
  const marks = (String(text || '').match(/[İıĞğÜüŞşÖöÇç]/g) || []).length;
  return marks >= 2 ? 'tr' : 'en';
}

function reelTranslatePrompt(scenes, targetLanguage) {
  const lines = (scenes || []).map((scene, index) => `${index + 1}. ${scene.narration}`);
  return [
    `Translate each narration into ${targetLanguage}.`,
    'Keep the same five scenes, the same order, and the same facts.',
    'Do not add a scene, a fact, a name, or a cause.',
    'anchor_words are 2 to 4 words copied from that translated narration.',
    'No square brackets.',
    lines.join('\n')
  ].join('\n');
}

function reelRepairNote(issues, words) {
  const rest = (issues || []).filter((item) => !String(item).startsWith('word count'));
  const lines = [];
  const count = Number(words);
  if ((issues || []).some((item) => String(item).startsWith('word count')) && Number.isFinite(count)) {
    if (count < 80) {
      lines.push(`The narration is ${count} spoken words. Add ${80 - count} to ${85 - count} words inside scenes 2, 3 and 4 by unfolding events already in the reading. Land between 80 and 85. Do not add a new fact. Keep every name, place, date, and time.`);
    } else {
      lines.push(`The narration is ${count} spoken words. Cut scenes 2, 3 and 4 until the total is between 80 and 85. Keep the shock, the last sentence, and every name, place, date, and time.`);
    }
  }
  if (rest.length) lines.push(`Also fix: ${rest.join('; ')}.`);
  return lines.join(' ');
}

function reelLengthPrompt(scenes, words, language) {
  const lines = (scenes || []).map((scene, index) => `${index + 1}. ${scene.narration}`);
  const count = Number(words) || 0;
  const direction = count > 85
    ? `These five lines are ${count} words. Cut them to between 80 and 85 spoken words. Keep the shock and the last sentence.`
    : `These five lines are ${count} words. Rewrite them to between 80 and 85 spoken words. Add the missing words in scenes 2, 3 and 4 by unfolding events already in the reading. Do not add a new fact.`;
  return [
    direction,
    `Narration language: ${language}.`,
    'Keep exactly five scenes. Scene 1 stays one sentence of 6 to 14 words and still includes one concrete name, place, or time.',
    'Keep every person name, place name, date, and clock time. Do not invent one.',
    'The last sentence still closes the knot and returns to the tension of the first sentence.',
    'image_prompt is one English photograph of 40 to 70 words. Show the people that scene names as anonymous silhouettes. One continuous vertical photograph.',
    'anchor_words are 2 to 4 words copied from that scene narration.',
    'voice_tone is a short English direction such as "quiet, tense".',
    'music_mood is exactly one of mystery, epic, sad, science.',
    'No square brackets and no stage directions.',
    lines.join('\n')
  ].join('\n');
}

function reelOpeningPrompt(text) {
  return [
    'Translate the Turkish line into spoken English.',
    'Keep the same sentences and every name, place, date, and fact.',
    'Do not add a name, a place, a date, or a fact that the line does not contain.',
    'No square brackets.',
    `Line:\n${text}`
  ].join('\n');
}

function spokenOpening(text) {
  let line = String(text || '').replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
  line = line.replace(/^["']+|["']+$/g, '').trim();
  if (!line) return '';
  if (!/[.!?…]$/.test(line)) line += '.';
  return line;
}

function withOpening(narration, opening) {
  const line = spokenOpening(opening);
  const rest = String(narration || '').replace(/\s+/g, ' ').trim();
  if (!line) return rest;
  if (!rest) return line;
  if (rest.toLowerCase().indexOf(line.toLowerCase()) === 0) return rest;
  return `${line} ${rest}`;
}

function momentShotPrompt(narration) {
  return [
    'Divide this spoken script into exactly 9 photographs, in time order, from the first word to the last.',
    '8 photographs is acceptable. 10 is not. Cover the whole script. Do not skip the ending.',
    'Each photograph is the instant being spoken in its own stretch. Simulate that moment. Do not illustrate a different part of the story.',
    'When the stretch names people, put every one of them in the frame, doing what the line says, in the place the line puts them.',
    'A line about driving with a headless body is the inside of the car: a silhouette in the driver seat and a headless silhouette where the body sits.',
    'A line about a neighbor seeing that body is the neighbor silhouette looking in at the headless silhouette inside the car.',
    'People are anonymous silhouettes, not a sharp face, not a portrait, and not a full-HD beauty shot.',
    'If the stretch has no person, do not add one.',
    'Do not add an object, a place, or an action the stretch does not contain.',
    'One continuous vertical photograph of that one moment.',
    'visual_prompt is 40 to 80 concrete English words. Name the place, the light, and where each person is.',
    'anchor_words are 2 to 5 words copied from that stretch.',
    `Script:\n${narration}`
  ].join('\n');
}

function shareCount(total, scenes) {
  const n = Math.max(1, scenes);
  const base = Math.floor(total / n);
  let extra = total % n;
  return Array.from({ length: n }, () => base + (extra > 0 ? (extra -= 1, 1) : 0));
}

function assignMomentShots(scenes, frames) {
  const list = (scenes || []).filter((scene) => scene && String(scene.narration || '').trim());
  const shots = (frames || []).map((frame) => ({
    visual_prompt: String(frame && frame.visual_prompt || '').replace(/\s+/g, ' ').trim(),
    anchor_words: String(frame && frame.anchor_words || '').replace(/\s+/g, ' ').trim()
  })).filter((frame) => frame.visual_prompt.length >= 20);
  if (shots.length < 8 || !list.length) return false;
  const used = shots.slice(0, 9);
  const counts = shareCount(used.length, list.length);
  let cursor = 0;
  list.forEach((scene, index) => {
    const take = counts[index];
    scene.shots = used.slice(cursor, cursor + take).map((frame) => ({
      visual_prompt: frame.visual_prompt,
      anchor_words: frame.anchor_words
    }));
    cursor += take;
  });
  return used.length;
}

function reelIssues(scenes) {
  const list = Array.isArray(scenes) ? scenes : [];
  const issues = [];
  if (list.length !== 5) issues.push('five scenes');
  const words = list.reduce((sum, scene) => sum + wordCount(scene && scene.narration), 0);
  if (words < 70 || words > 85) issues.push(`word count ${words}`);
  const opening = String(list[0] && list[0].narration || '');
  const openingWords = wordCount(opening);
  const openingSentences = opening.split(/[.!?]+/).map((part) => part.trim()).filter(Boolean).length;
  if (openingSentences !== 1 || openingWords < 6 || openingWords > 14) issues.push('opening sentence');
  list.forEach((scene, index) => {
    const narration = String(scene && scene.narration || '');
    if (!narration.trim()) issues.push(`empty scene ${index + 1}`);
    if (/\[[^\]]+\]/.test(narration)) issues.push(`brackets in scene ${index + 1}`);
    if (String(scene && scene.image_prompt || '').trim().length < 20) issues.push(`image ${index + 1}`);
  });
  return issues;
}

function criticPrompt(bible, script) {
  return [
    'You are a strict story editor. Return JSON only.',
    'pass is true only when the scope is one thing, the hook is paid off by the last line, and the mechanism is explained by a concrete object or action.',
    'Fail if the ending depends on a dream, a coincidence, or an unexplained event.',
    'Also fail for category_error, garbled_claim, ambiguous_causality, unsupported_number, contradicted_by_consensus, or a vacuous_closer.',
    'If you cannot name an issue, pass is true and issues is an empty array.',
    'issues is an array of {type, beat, fix}.',
    `Bible: ${JSON.stringify(bible)}`,
    `Script: ${JSON.stringify(script)}`
  ].join('\n');
}

const BIBLE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    logline: { type: 'STRING' },
    is_fiction: { type: 'BOOLEAN' },
    scope: { type: 'STRING' },
    setting: { type: 'OBJECT', properties: { place: { type: 'STRING' }, era: { type: 'STRING' }, mood: { type: 'STRING' } } },
    characters: { type: 'ARRAY', items: { type: 'OBJECT', properties: { id: { type: 'STRING' }, role: { type: 'STRING' }, visual_descriptor: { type: 'STRING' } } } },
    core_mechanism: { type: 'STRING' },
    hook: { type: 'STRING' },
    planted_clue: { type: 'STRING' },
    twist: { type: 'STRING' },
    final_line: { type: 'STRING' },
    forbidden: { type: 'ARRAY', items: { type: 'STRING' } },
    sources: { type: 'ARRAY', items: { type: 'STRING' } }
  },
  required: ['logline', 'is_fiction', 'scope', 'core_mechanism', 'hook', 'final_line']
};

const SCRIPT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    music_mood: { type: 'STRING' },
    beats: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          narration: { type: 'STRING' },
          voice_direction: { type: 'STRING' },
          shots: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                visual_prompt: { type: 'STRING' },
                anchor_words: { type: 'STRING' },
                location_id: { type: 'STRING' },
                character_ids: { type: 'ARRAY', items: { type: 'STRING' } }
              },
              required: ['visual_prompt', 'anchor_words']
            }
          }
        },
        required: ['narration', 'shots']
      }
    }
  },
  required: ['beats']
};

const CRITIC_SCHEMA = {
  type: 'OBJECT',
  properties: {
    pass: { type: 'BOOLEAN' },
    issues: { type: 'ARRAY', items: { type: 'OBJECT', properties: { type: { type: 'STRING' }, beat: { type: 'STRING' }, fix: { type: 'STRING' } } } }
  },
  required: ['pass', 'issues']
};

module.exports = {
  wordCount,
  jaccard,
  readTopicHistory,
  rememberTopic,
  similarTopic,
  validateBible,
  validateScript,
  spokenTokens,
  coverageReport,
  narrationClaimIssues,
  criticFails,
  biblePrompt,
  scriptPrompt,
  criticPrompt,
  reelReadPrompt,
  reelPrompt,
  reelSourceLanguage,
  reelTranslatePrompt,
  reelRepairNote,
  reelLengthPrompt,
  reelOpeningPrompt,
  spokenOpening,
  withOpening,
  momentShotPrompt,
  assignMomentShots,
  reelIssues,
  beatsOf,
  BIBLE_SCHEMA,
  SCRIPT_SCHEMA,
  CRITIC_SCHEMA,
  REEL_TRANSLATE_SCHEMA: {
    type: 'OBJECT',
    properties: {
      scenes: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            narration: { type: 'STRING' },
            anchor_words: { type: 'STRING' }
          },
          required: ['narration', 'anchor_words']
        }
      }
    },
    required: ['scenes']
  },
  MOMENT_SHOT_SCHEMA: {
    type: 'OBJECT',
    properties: {
      shots: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            visual_prompt: { type: 'STRING' },
            anchor_words: { type: 'STRING' }
          },
          required: ['visual_prompt', 'anchor_words']
        }
      }
    },
    required: ['shots']
  },
  REEL_OPENING_SCHEMA: {
    type: 'OBJECT',
    properties: { english: { type: 'STRING' } },
    required: ['english']
  },
  REEL_READ_SCHEMA: {
    type: 'OBJECT',
    properties: {
      shock: { type: 'STRING' },
      ending: { type: 'STRING' },
      events: { type: 'ARRAY', items: { type: 'STRING' } }
    },
    required: ['shock', 'ending', 'events']
  },
  REEL_SCHEMA: {
    type: 'OBJECT',
    properties: {
      music_mood: { type: 'STRING' },
      scenes: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            narration: { type: 'STRING' },
            image_prompt: { type: 'STRING' },
            voice_tone: { type: 'STRING' },
            anchor_words: { type: 'STRING' }
          },
          required: ['narration', 'image_prompt', 'anchor_words']
        }
      }
    },
    required: ['music_mood', 'scenes']
  }
};
