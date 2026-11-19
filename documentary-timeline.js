const MOTIONS = Object.freeze(['zoom-in', 'zoom-out', 'pan-left', 'pan-right']);

function motionFor(index) {
  return MOTIONS[Math.abs(index) % MOTIONS.length];
}

function findAnchor(words, anchor) {
  const wanted = String(anchor || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!wanted.length || !words.length) return null;
  for (let i = 0; i < words.length; i++) {
    const slice = words.slice(i, i + wanted.length).map((item) => String(item.word || '').toLowerCase().replace(/[^a-z0-9']/g, ''));
    if (slice.join(' ') === wanted.join(' ')) return words[i];
    if (slice[0] && slice[0].indexOf(wanted[0]) === 0) return words[i];
  }
  return null;
}

function buildTimeline(scenes, sceneAudio) {
  const shots = [];
  let cursor = 0;
  scenes.forEach((scene, sceneIndex) => {
    const audio = sceneAudio[sceneIndex] || { words: [], duration: 0 };
    const words = audio.words || [];
    const duration = Number(audio.duration) || 0;
    const listed = Array.isArray(scene.shots) && scene.shots.length ? scene.shots : [{
      visual_prompt: scene.image_prompt,
      anchor_words: words[0] ? words[0].word : ''
    }];
    const anchors = listed.map((shot, shotIndex) => {
      const hit = findAnchor(words, shot.anchor_words);
      const fallback = words[Math.min(words.length - 1, Math.floor((words.length * shotIndex) / listed.length))] || null;
      return hit || fallback;
    });
    const sceneShots = [];
    listed.forEach((shot, shotIndex) => {
      const localStart = anchors[shotIndex] ? Number(anchors[shotIndex].start) || 0 : (duration * shotIndex) / listed.length;
      sceneShots.push({
        scene: sceneIndex,
        index: 0,
        visual_prompt: shot.visual_prompt || scene.image_prompt,
        anchor_words: shot.anchor_words || '',
        motion: motionFor(shots.length + sceneShots.length),
        local_start: localStart,
        global_hint: cursor + localStart
      });
    });
    sceneShots.sort((a, b) => a.local_start - b.local_start);
    if (sceneShots.length) sceneShots[0].local_start = 0;
    sceneShots.forEach((shot, order) => {
      const next = sceneShots[order + 1];
      shot.local_end = next ? next.local_start : duration;
      if (shot.local_end <= shot.local_start) shot.local_end = Math.min(duration, shot.local_start + 0.4);
    });
    shots.push(...sceneShots);
    cursor += duration;
  });
  if (shots.length) {
    const last = shots[shots.length - 1];
    last.local_end = Number(last.local_end) + 0;
  }
  let global = 0;
  const sceneDuration = {};
  sceneAudio.forEach((audio, index) => { sceneDuration[index] = Number(audio && audio.duration) || 0; });
  const offsets = [];
  scenes.forEach((_, index) => {
    offsets[index] = global;
    global += sceneDuration[index] || 0;
  });
  shots.forEach((shot) => {
    shot.start = (offsets[shot.scene] || 0) + shot.local_start;
    shot.end = (offsets[shot.scene] || 0) + shot.local_end;
  });
  if (shots.length) {
    shots[shots.length - 1].end += 0.5;
    global = shots[shots.length - 1].end;
  }
  shots.sort((a, b) => a.start - b.start);
  shots.forEach((shot, index) => { shot.index = index; });
  return { shots, duration: global };
}

function chunkWords(words) {
  const cues = [];
  const list = words || [];
  for (let i = 0; i < list.length;) {
    let take = 1;
    while (take < 3 && i + take < list.length && !/[.!?…]$/.test(String(list[i + take - 1].word || ''))) take += 1;
    const slice = list.slice(i, i + take);
    cues.push({
      text: slice.map((item) => item.word).join(' '),
      start: Number(slice[0].start) || 0,
      end: Number(slice[slice.length - 1].end) || 0
    });
    i += take;
  }
  return cues;
}

function assTime(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = value % 60;
  return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

function assEscape(text) {
  return String(text || '').replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\r?\n/g, ' ').replace(/'/g, '\u2019');
}

function distinctHook(narration) {
  const text = String(narration || '').replace(/\s+/g, ' ').trim();
  const line = text.split(/[.!?]/)[0].trim();
  if (!line) return '';
  if (text.toLowerCase().indexOf(line.toLowerCase()) === 0) return '';
  return line;
}

function buildAss(cues, hook) {
  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1080',
    'PlayResY: 1920',
    'WrapStyle: 1',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,Arial,58,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,2,2,120,120,700,1',
    'Style: Hook,Arial,52,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,2,8,80,80,320,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ];
  (cues || []).forEach((cue) => {
    if (!cue.text) return;
    lines.push(`Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},Default,,0,0,0,,${assEscape(cue.text)}`);
  });
  if (hook) {
    lines.push(`Dialogue: 1,${assTime(0)},${assTime(3)},Hook,,0,0,0,,${assEscape(hook)}`);
  }
  return lines.join('\n');
}

module.exports = { MOTIONS, motionFor, findAnchor, buildTimeline, chunkWords, buildAss, assTime, distinctHook };
