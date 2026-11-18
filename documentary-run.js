const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const story = require('./documentary-story');
const job = require('./documentary-job');
const timeline = require('./documentary-timeline');
const { judgeQc } = require('./documentary-qc');
const { buildMetadata } = require('./documentary-meta');
const { measureFile } = require('./documentary-measure');

const JOBS_ROOT = path.join(__dirname, 'jobs');
const HISTORY_FILE = path.join(JOBS_ROOT, 'topic_history.jsonl');
const RUN_LOG = path.join(JOBS_ROOT, 'run_log.jsonl');

function runCapture(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 200000) stderr = stderr.slice(-200000);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function ffmpeg(bin, args) {
  const result = await runCapture(bin, args);
  if (result.code !== 0) {
    const line = result.stderr.split(/\r?\n/).map((item) => item.trim()).filter((item) => /error|invalid|no such/i.test(item)).slice(-2).join(' ');
    throw new Error(line || `ffmpeg exit ${result.code}`);
  }
}

function motionFilter(duration, motion) {
  const frames = Math.max(8, Math.round(Math.max(0.4, Number(duration) || 1) * 30));
  const head = 'scale=1426:2534:flags=lanczos,zoompan=fps=30:d=1:s=1080x1920';
  if (motion === 'zoom-in') {
    return `${head}:z='1+0.32*min(1\\,on/${frames})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)',format=yuv420p`;
  }
  if (motion === 'zoom-out') {
    return `${head}:z='1.32-0.32*min(1\\,on/${frames})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)',format=yuv420p`;
  }
  if (motion === 'pan-left') {
    return `${head}:z='1.32':x='(iw-iw/zoom)*(1-min(1\\,on/${frames}))':y='(ih-ih/zoom)/2',format=yuv420p`;
  }
  return `${head}:z='1.32':x='(iw-iw/zoom)*min(1\\,on/${frames})':y='(ih-ih/zoom)/2',format=yuv420p`;
}

function cardTail(layout) {
  if (layout !== 'card') return '';
  return ',split[bg][fg];[bg]scale=1080:1920,boxblur=20:5[back];[fg]scale=860:1530:force_original_aspect_ratio=decrease[front];[back][front]overlay=(W-w)/2:(H-h)/2';
}

function scenesFromBeats(beats, deps) {
  return (beats || []).map((beat) => {
    const narration = deps.spokenHookText(beat && beat.narration);
    const shots = (beat && beat.shots || []).map((shot) => ({
      visual_prompt: deps.cleanImagePrompt(shot.visual_prompt),
      anchor_words: String(shot.anchor_words || '').trim(),
      character_ids: Array.isArray(shot.character_ids) ? shot.character_ids : []
    })).filter((shot) => shot.visual_prompt);
    return {
      narration,
      image_prompt: shots[0] ? shots[0].visual_prompt : '',
      voice_tone: beat.voice_direction || beat.voice_tone || 'deep documentary',
      timestamp_sec: '0-2',
      shots
    };
  }).filter((scene) => scene.narration && scene.image_prompt);
}

async function buildV2(deps, subject, language, apiKey, channel, config) {
  let bible = null;
  let bibleNote = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    bible = await deps.askGeminiJson(apiKey, story.biblePrompt(`${subject}\n${bibleNote}`, channel, language), story.BIBLE_SCHEMA);
    const issues = story.validateBible(bible);
    if (!issues.length) break;
    bibleNote = issues.join('; ');
    bible = null;
  }
  if (!bible) {
    const error = new deps.DocumentaryError('Hikâye iskeleti fiziksel bir mekanizma kuramadı.');
    error.needsReview = true;
    throw error;
  }
  let script = null;
  let critic = { pass: false, issues: [] };
  let note = '';
  for (let turn = 0; turn < 3; turn++) {
    script = await deps.askGeminiJson(
      apiKey,
      story.scriptPrompt(bible, language, config.shots_per_scene, note),
      story.SCRIPT_SCHEMA
    );
    const issues = story.validateScript(script, bible, config);
    if (issues.length) {
      note = issues.join('; ');
      continue;
    }
    critic = await deps.askGeminiJson(apiKey, story.criticPrompt(bible, script), story.CRITIC_SCHEMA);
    if (!story.criticFails(critic)) break;
    const fixes = (critic.issues || []).map((issue) => issue.fix || issue.type).filter(Boolean).join('; ');
    note = fixes || 'The hook must be paid off and the mechanism must be a concrete action.';
    if (turn === 2) break;
  }
  return { bible, script, critic };
}

function logRun(row) {
  fs.mkdirSync(JOBS_ROOT, { recursive: true });
  fs.appendFileSync(RUN_LOG, JSON.stringify(row) + '\n');
}

async function produceRecipe(opts, config, deps) {
  const selected = deps.resolveDocChannel(opts.channel);
  let subject = String(opts.topic || '').replace(/\s+/g, ' ').trim();
  let reddit = null;
  if (selected === 'chaos' && config.CHAOS_SOURCE !== 'original') {
    reddit = await deps.pullChaosStory({ query: subject, redditId: opts.redditId, avoid: '' });
    subject = reddit.title;
  } else if (subject.length < 8) {
    throw new deps.DocumentaryError('Konu en az birkaç kelime olsun.', 400);
  }
  const language = opts.lang === 'tr' ? 'tr' : 'en';
  const langName = language === 'tr' ? 'Turkish' : 'English';
  const dir = opts.jobDir || job.jobDirFor(JOBS_ROOT, selected, subject);
  fs.mkdirSync(path.join(dir, 'audio'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
  const from = opts.fromStage || 'topic';
  const rank = (name) => job.STAGES.indexOf(name);
  job.markStage(dir, 'topic', { state: 'running', inputHash: job.hashValue(subject) });
  job.writeJson(dir, 'topic.json', { topic: subject, channel: selected, lang: language, reddit: reddit ? { id: reddit.id, subreddit: reddit.subreddit } : null });
  story.rememberTopic(HISTORY_FILE, subject);
  job.markStage(dir, 'topic', { state: 'done', inputHash: job.hashValue(subject), file: 'topic.json' });

  let bible = null;
  let plan = null;
  let critic = null;
  if (rank(from) <= rank('script') || !job.readJson(dir, 'script.json')) {
    if (config.STORY_PIPELINE === 'v2') {
      const built = await buildV2(deps, subject, langName, opts.geminiKey, selected, config);
      bible = built.bible;
      critic = built.critic;
      job.writeJson(dir, 'bible.json', bible);
      job.writeJson(dir, 'critic.json', critic);
      if (story.criticFails(critic)) {
        job.markStage(dir, 'critic', { state: 'needs_review', error: 'critic' });
        const error = new deps.DocumentaryError('Senaryo eleştiriden geçmedi. Yayın klasörüne alınmadı.', 422);
        error.needsReview = true;
        throw error;
      }
      const scenes = scenesFromBeats(story.beatsOf(built.script), deps);
      if (scenes.length < 5) throw new deps.DocumentaryError('Senaryo 5 sahneden kısa kaldı.');
      plan = { scenes, words: scenes.reduce((sum, scene) => sum + story.wordCount(scene.narration), 0), music_mood: built.script.music_mood || 'mystery' };
    } else {
      plan = await deps.buildPlan(subject, language, opts.geminiKey, reddit, selected);
      plan.scenes.forEach((scene) => {
        scene.shots = [{ visual_prompt: scene.image_prompt, anchor_words: '' }];
      });
    }
    job.writeJson(dir, 'script.json', plan);
    job.markStage(dir, 'script', { state: 'done', file: 'script.json' });
  } else {
    plan = job.readJson(dir, 'script.json');
    bible = job.readJson(dir, 'bible.json');
  }

  const ffmpegBin = opts.ffmpegPath || 'ffmpeg';
  const ffprobe = opts.ffprobePath || 'ffprobe';
  let narratorVoice = deps.resolveDocVoice(opts.narrator);
  let voiceWarning = '';
  const documentaryKey = String(opts.elevenKey || '').trim();
  const chars = plan.scenes.reduce((sum, scene) => sum + String(scene.narration || '').length, 0);
  if (rank(from) <= rank('tts')) {
    await deps.checkElevenCredits(documentaryKey, chars);
  }

  async function narrate(text, fileName) {
    const request = {
      text,
      outDir: path.join(dir, 'audio'),
      fileName,
      voiceId: narratorVoice.id,
      voiceSettings: deps.DOC_VOICE_SETTINGS,
      apiKey: documentaryKey,
      cache: true,
      modelId: config.TTS_MODEL
    };
    try {
      return await deps.synthesizeSpeechAligned(request);
    } catch (err) {
      if (!deps.isVoiceFallbackError(err) || narratorVoice.id === deps.DOC_VOICES.adam) throw err;
      const failed = narratorVoice;
      narratorVoice = deps.resolveDocVoice(deps.DOC_VOICES.adam);
      voiceWarning = `${failed.label} bu hesapta API ile kullanılamadı. Üretim ${narratorVoice.label} ile sürdürüldü.`;
      request.voiceId = narratorVoice.id;
      return deps.synthesizeSpeechAligned(request);
    }
  }

  const sceneAudio = [];
  for (let i = 0; i < plan.scenes.length; i++) {
    const audioJson = path.join(dir, 'audio', `scene_${i}.json`);
    const audioFile = path.join(dir, 'audio', `scene_${i}.mp3`);
    if (rank(from) > rank('tts') && fs.existsSync(audioJson) && fs.existsSync(audioFile) && opts.onlyScene !== i) {
      sceneAudio.push(JSON.parse(fs.readFileSync(audioJson, 'utf8')));
      continue;
    }
    const spoken = deps.shapeNarration(plan.scenes[i].narration, i === 0 ? 'urgent hard' : plan.scenes[i].voice_tone);
    const speech = await narrate(spoken, `raw_${i}.mp3`);
    const fitted = await deps.fitNarration(ffmpegBin, ffprobe, speech.filePath, speech.words, plan.scenes[i].narration, path.join(dir, 'audio', `fit_${i}.mp3`), { keepOpeningPause: false });
    const breathed = await deps.breatheSentences(ffmpegBin, ffprobe, path.join(dir, 'audio', `fit_${i}.mp3`), fitted.words, plan.scenes[i].narration, audioFile);
    const row = { file: audioFile, words: breathed.words, duration: breathed.duration };
    fs.writeFileSync(audioJson, JSON.stringify(row));
    sceneAudio.push(row);
  }
  job.markStage(dir, 'tts', { state: 'done' });

  plan.scenes.forEach((scene) => {
    const shots = Array.isArray(scene.shots) ? scene.shots.filter((shot) => shot && shot.visual_prompt) : [];
    scene.shots = shots.length ? shots : [{ visual_prompt: scene.image_prompt, anchor_words: '' }];
    while (scene.shots.length < config.shots_per_scene) {
      scene.shots.push({ visual_prompt: scene.image_prompt, anchor_words: '' });
    }
  });
  const clock = timeline.buildTimeline(plan.scenes, sceneAudio);
  job.writeJson(dir, 'timeline.json', clock);
  const seedBase = crypto.createHash('sha256').update(path.basename(dir)).digest().readUInt32BE(0) % 100000;
  for (let i = 0; i < clock.shots.length; i++) {
    const shot = clock.shots[i];
    if (opts.onlyScene != null && shot.scene !== opts.onlyScene) continue;
    const photo = path.join(dir, 'images', `shot_${i}.jpg`);
    if (rank(from) > rank('images') && fs.existsSync(photo) && opts.onlyScene == null) continue;
    await deps.downloadPollinationsStill(shot.visual_prompt, photo, selected, seedBase + i + 1, ffmpegBin);
  }
  job.markStage(dir, 'images', { state: 'done' });

  const segments = [];
  for (let i = 0; i < clock.shots.length; i++) {
    const shot = clock.shots[i];
    const audio = sceneAudio[shot.scene];
    const segment = path.join(dir, 'images', `shot_${i}.mp4`);
    const duration = Math.max(0.4, (shot.end || 0) - (shot.start || 0) || ((shot.local_end || 0) - (shot.local_start || 0)));
    const start = Math.max(0, shot.local_start || 0);
    const end = Math.max(start + 0.2, shot.local_end || (start + duration));
    await ffmpeg(ffmpegBin, [
      '-y', '-loop', '1', '-framerate', '30', '-i', path.join(dir, 'images', `shot_${i}.jpg`),
      '-i', audio.file,
      '-vf', motionFilter(duration, shot.motion) + cardTail(config.layout),
      '-af', `atrim=start=${start.toFixed(3)}:end=${end.toFixed(3)},asetpts=PTS-STARTPTS,apad=whole_dur=${duration.toFixed(3)},aresample=44100`,
      '-map', '0:v:0', '-map', '1:a:0', '-t', duration.toFixed(3),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', '30',
      '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '192k',
      '-movflags', '+faststart', segment
    ]);
    segments.push(segment);
  }
  const listPath = path.join(dir, 'list.txt');
  fs.writeFileSync(listPath, segments.map((file) => `file '${file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
  const joined = path.join(dir, 'joined.mp4');
  const copied = await runCapture(ffmpegBin, ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-movflags', '+faststart', joined]);
  if (copied.code !== 0) {
    await ffmpeg(ffmpegBin, [
      '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', '30',
      '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '192k', '-movflags', '+faststart', joined
    ]);
  }
  const cues = [];
  let cursor = 0;
  sceneAudio.forEach((audio) => {
    timeline.chunkWords(audio.words).forEach((cue) => {
      cues.push({ text: cue.text, start: cue.start + cursor, end: cue.end + cursor });
    });
    cursor += Number(audio.duration) || 0;
  });
  const hook = String(plan.scenes[0] && plan.scenes[0].narration || '').split(/[.!?]/)[0];
  const assFile = path.join(dir, 'subs.ass');
  fs.writeFileSync(assFile, timeline.buildAss(cues, hook), 'utf8');
  const escaped = assFile.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
  const graded = path.join(dir, 'graded.mp4');
  await ffmpeg(ffmpegBin, [
    '-y', '-i', joined,
    '-vf', `eq=gamma=${Number(config.grade_gamma) || 1.06},noise=alls=${Number(config.grain) || 3}:allf=t,subtitles='${escaped}'`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', '30',
    '-c:a', 'copy', '-movflags', '+faststart', graded
  ]);
  const music = deps.musicFileForMood(plan.music_mood);
  const mixed = path.join(dir, 'mixed.mp4');
  await deps.mixMusicBed(ffmpegBin, ffprobe, graded, music.file, mixed);
  let current = mixed;
  if (config.loudnorm !== false) {
    const probe = await runCapture(ffmpegBin, ['-hide_banner', '-i', mixed, '-af', 'loudnorm=I=-14:TP=-1.5:LRA=7:print_format=json', '-f', 'null', '-']);
    const match = probe.stderr.match(/\{[\s\S]*"input_i"[\s\S]*\}/);
    const finalFile = path.join(dir, 'final.mp4');
    if (match) {
      const measured = JSON.parse(match[0]);
      await ffmpeg(ffmpegBin, [
        '-y', '-i', mixed,
        '-af', `loudnorm=I=-14:TP=-1.5:LRA=7:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true`,
        '-c:v', 'copy', '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '192k', '-movflags', '+faststart',
        finalFile
      ]);
      current = finalFile;
    } else {
      await fs.promises.copyFile(mixed, finalFile);
      current = finalFile;
    }
  } else {
    const finalFile = path.join(dir, 'final.mp4');
    await fs.promises.copyFile(mixed, finalFile);
    current = finalFile;
  }
  const measure = await measureFile(current, { ffmpeg: ffmpegBin, ffprobe });
  const qc = judgeQc(measure, {
    duration: config.duration_range[selected],
    shots: clock.shots.length
  });
  job.writeJson(dir, 'qc.json', { pass: qc.pass, issues: qc.issues, measure });
  const metadata = buildMetadata({ channel: selected, topic: subject, bible, scriptWords: plan.words });
  job.writeJson(dir, 'metadata.json', metadata);
  if (!qc.pass) {
    job.markStage(dir, 'qc', { state: 'needs_review', error: qc.issues.join(',') });
    logRun({ at: new Date().toISOString(), job: path.basename(dir), state: 'needs_review', issues: qc.issues });
    const error = new deps.DocumentaryError(`Kalite kapısı geçilmedi (${qc.issues.join(', ')}). Dosya iş klasöründe kaldı: ${dir}`, 422);
    error.needsReview = true;
    throw error;
  }
  await fs.promises.mkdir(path.dirname(opts.outFile), { recursive: true });
  await fs.promises.copyFile(current, opts.outFile);
  job.markStage(dir, 'metadata', { state: 'done', file: 'metadata.json' });
  logRun({ at: new Date().toISOString(), job: path.basename(dir), state: 'done' });
  return {
    scenes: plan.scenes.map((scene) => ({
      narration: scene.narration,
      image_prompt: scene.image_prompt,
      voice_tone: scene.voice_tone,
      timestamp_sec: scene.timestamp_sec
    })),
    narrator: narratorVoice,
    music_mood: music.mood,
    music_file: music.title,
    warning: voiceWarning,
    words: plan.words,
    duration: measure.duration_sec,
    lang: language,
    channel: selected,
    job: path.basename(dir),
    lufs: measure.lufs,
    reddit: reddit ? { id: reddit.id, subreddit: reddit.subreddit, title: reddit.title, score: reddit.score } : null
  };
}

module.exports = { produceRecipe, JOBS_ROOT, scenesFromBeats, motionFilter };
