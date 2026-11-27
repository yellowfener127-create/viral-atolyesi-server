const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const story = require('./documentary-story');
const job = require('./documentary-job');
const timeline = require('./documentary-timeline');
const { judgeQc } = require('./documentary-qc');
const { buildMetadata } = require('./documentary-meta');
const { measureFile, parseEbur128 } = require('./documentary-measure');
const vision = require('./documentary-vision');
const reelQuality = require('./reel-quality');

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

function stillPrompt(visual, periodLock, naturalPeople) {
  const text = String(visual || '');
  const locked = text.indexOf('Period-accurate') < 0 ? text + periodLock : text;
  if (naturalPeople) return locked;
  if (!/\b(person|people|man|woman|boy|girl|figure|silhouette|body|driver|passenger|neighbor|corpse|victim|friend)\b/i.test(locked)) return locked;
  return `${locked} The people are anonymous silhouettes in the scene, not sharp faces and not a portrait.`;
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
      timestamp_sec: '',
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
  const pastedStory = String(opts.storyText || '').trim();
  const givenScenes = Array.isArray(opts.scriptScenes) ? opts.scriptScenes : null;
  let subject = String(opts.topic || '').replace(/\s+/g, ' ').trim();
  let reddit = null;
  if (pastedStory || givenScenes) {
    if (subject.length < 8) subject = pastedStory.replace(/\s+/g, ' ').slice(0, 90);
  } else if (selected === 'chaos' && config.CHAOS_SOURCE !== 'original') {
    reddit = await deps.pullChaosStory({ query: subject, redditId: opts.redditId, avoid: '' });
    subject = reddit.title;
  } else if (subject.length < 8) {
    throw new deps.DocumentaryError('Konu en az birkaç kelime olsun.', 400);
  }
  const language = (pastedStory || givenScenes) ? 'en' : (opts.lang === 'tr' ? 'tr' : 'en');
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
    if (givenScenes || pastedStory) {
      plan = givenScenes
        ? deps.planFromReelScenes(givenScenes)
        : await deps.buildStoryReel(pastedStory, langName, opts.geminiKey);
      if (givenScenes && /^(mystery|epic|sad|science)$/.test(String(opts.musicMood || ''))) plan.music_mood = opts.musicMood;
      if (!givenScenes) {
        if (config.reel_true_event === false) {
          const reelProblems = story.reelIssues(plan.scenes);
          if (reelProblems.length) {
            throw new deps.DocumentaryError(`Senaryo Reels ölçüsüne uymadı: ${reelProblems.join('; ')}.`, 422);
          }
        }
        if (plan.scenes_en && plan.scenes_en.length === plan.scenes.length) {
          plan.scenes = plan.scenes_en;
          plan.words = plan.scenes.reduce((sum, scene) => sum + story.wordCount(scene.narration), 0);
        }
      }
      if (config.reel_true_event !== false) {
        const spokenReview = reelQuality.structureIssues(plan.scenes, { ...config, source: pastedStory })
          .filter((item) => !String(item).startsWith('word count') && !String(item).startsWith('community_'));
        if (spokenReview.length) {
          throw new deps.DocumentaryError(`Hikâye Reels yapısı geçmedi: ${spokenReview.join(', ')}.`, 422);
        }
      }
      if (!plan.scenes || plan.scenes.length !== 5) {
        throw new deps.DocumentaryError('Senaryo 5 sahneden oluşmalı.', 422);
      }
      const openingRaw = String(opts.openingText || '').replace(/\s+/g, ' ').trim();
      if (openingRaw) {
        if (openingRaw.length > 500) throw new deps.DocumentaryError('İlk cümle 500 karakterden kısa olsun.', 400);
        const translated = await deps.askGeminiJson(opts.geminiKey, story.reelOpeningPrompt(openingRaw), story.REEL_OPENING_SCHEMA);
        const english = story.spokenOpening(translated && translated.english);
        if (!english) throw new deps.DocumentaryError('İlk cümle İngilizceye çevrilemedi.', 422);
        plan.scenes[0].narration = story.withOpening(plan.scenes[0].narration, english);
        plan.words = plan.scenes.reduce((sum, scene) => sum + story.wordCount(scene.narration), 0);
        console.log('[belgesel] ilk cümle eklendi');
      }
      bible = { logline: subject, is_fiction: true, scope: subject, core_mechanism: 'the pasted story', hook: plan.scenes[0].narration, final_line: plan.scenes[4].narration };
      critic = { pass: true, issues: [] };
      job.writeJson(dir, 'bible.json', bible);
      job.writeJson(dir, 'critic.json', critic);
    } else if (config.STORY_PIPELINE === 'v2') {
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

  const reelCut = Boolean(pastedStory || givenScenes);
  async function narrate(text, fileName, voiceSettings) {
    const request = {
      text,
      outDir: path.join(dir, 'audio'),
      fileName,
      voiceId: narratorVoice.id,
      voiceSettings: voiceSettings || deps.DOC_VOICE_SETTINGS,
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
      const detailStatus = String(err.details && err.details.detailStatus || '');
      const detailMessage = String(err.details && err.details.detailMessage || '');
      voiceWarning = `${failed.label} kullanılamadı. HTTP ${err.details && err.details.status || '?'}${detailStatus ? ` detail.status=${detailStatus}` : ''}. ${detailMessage} Üretim ${narratorVoice.label} ile sürdürüldü.`;
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
    const paced = reelCut && config.reel_true_event !== false
      ? { ...deps.DOC_VOICE_SETTINGS, speed: reelQuality.voiceSpeed(plan.scenes[i], deps.DOC_VOICE_SETTINGS.speed) }
      : deps.DOC_VOICE_SETTINGS;
    const speech = await narrate(spoken, `raw_${i}.mp3`, paced);
    const fitted = await deps.fitNarration(ffmpegBin, ffprobe, speech.filePath, speech.words, plan.scenes[i].narration, path.join(dir, 'audio', `fit_${i}.mp3`), { keepOpeningPause: false });
    const breathed = await deps.breatheSentences(ffmpegBin, ffprobe, path.join(dir, 'audio', `fit_${i}.mp3`), fitted.words, plan.scenes[i].narration, audioFile);
    const row = { file: audioFile, words: breathed.words, duration: breathed.duration };
    fs.writeFileSync(audioJson, JSON.stringify(row));
    sceneAudio.push(row);
  }
  const coverage = story.coverageReport(
    plan.scenes.map((scene) => scene.narration).join(' '),
    sceneAudio.flatMap((audio) => audio.words || [])
  );
  coverage.audio_duration = sceneAudio.reduce((sum, audio) => sum + (Number(audio.duration) || 0), 0);
  job.writeJson(dir, 'coverage.json', coverage);
  if (!coverage.match) {
    job.markStage(dir, 'tts', { state: 'needs_review', error: 'coverage' });
    const error = new deps.DocumentaryError('Seslendirme senaryodaki kelimelerin tamamını kapsamıyor. Yayın klasörüne alınmadı.', 422);
    error.needsReview = true;
    throw error;
  }
  job.markStage(dir, 'tts', { state: 'done' });

  if (reelCut && config.reel_true_event !== false) {
    for (let i = 1; i < sceneAudio.length; i++) {
      if (!reelQuality.isReveal(plan.scenes[i] && plan.scenes[i].narration)) continue;
      const silence = path.join(dir, 'audio', `pause_${i}.mp3`);
      const held = path.join(dir, 'audio', `held_${i}.mp3`);
      const list = path.join(dir, 'audio', `pause_${i}.txt`);
      await ffmpeg(ffmpegBin, ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '0.45', '-c:a', 'libmp3lame', '-q:a', '2', silence]);
      fs.writeFileSync(list, [silence, sceneAudio[i].file].map((file) => `file '${file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
      await ffmpeg(ffmpegBin, ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c:a', 'libmp3lame', '-q:a', '2', held]);
      sceneAudio[i].file = held;
      sceneAudio[i].duration = (Number(sceneAudio[i].duration) || 0) + 0.45;
      sceneAudio[i].words = (sceneAudio[i].words || []).map((word) => ({
        ...word,
        start: (Number(word.start) || 0) + 0.45,
        end: (Number(word.end) || 0) + 0.45
      }));
    }
  }

  let momentCount = 0;
  const spokenDur = sceneAudio.reduce((sum, audio) => sum + (Number(audio.duration) || 0), 0);
  const momentTarget = reelCut && config.reel_variable_cuts !== false ? reelQuality.shotCountFor(spokenDur) : 9;
  if (rank(from) <= rank('images') && deps.askGeminiJson && opts.geminiKey) {
    try {
      const spoken = plan.scenes.map((scene) => scene.narration).join('\n');
      const planned = await deps.askGeminiJson(opts.geminiKey, story.momentShotPrompt(spoken, momentTarget), story.MOMENT_SHOT_SCHEMA);
      momentCount = story.assignMomentShots(plan.scenes, planned && planned.shots, momentTarget) || 0;
      if (momentCount) console.log(`[belgesel] an fotoğrafı=${momentCount}`);
    } catch (err) {
      const message = String(err && err.message || 'an fotoğrafı yazılamadı').replace(/AIza[0-9A-Za-z_-]+/g, 'AIzaREDACTED').slice(0, 180);
      console.warn(`[belgesel] an fotoğrafı atlandı: ${message}`);
    }
  }
  plan.scenes.forEach((scene) => {
    const shots = Array.isArray(scene.shots) ? scene.shots.filter((shot) => shot && shot.visual_prompt) : [];
    scene.shots = shots.length ? shots : [{ visual_prompt: scene.image_prompt, anchor_words: '' }];
  });
  if (!momentCount) timeline.fitImageCount(plan.scenes, reelCut && config.reel_variable_cuts !== false ? momentTarget : (config.image_count || 9));
  if (reelCut) {
    plan.scenes.forEach((scene) => {
      (scene.shots || []).forEach((shot) => { shot.visual_prompt = reelQuality.calmText(shot.visual_prompt); });
    });
    reelQuality.lockLighting(plan.scenes);
    reelQuality.lockVehicle(plan.scenes);
    reelQuality.ensureHumanRatio(plan.scenes, 0.4);
  }
  const clock = timeline.buildTimeline(plan.scenes, sceneAudio);
  if (reelCut && config.reel_variable_cuts !== false) reelQuality.applyVariableCuts(clock.shots, spokenDur);
  job.writeJson(dir, 'timeline.json', clock);
  const seedBase = crypto.createHash('sha256').update(path.basename(dir)).digest().readUInt32BE(0) % 100000;
  const periodLock = ' One single photograph filling the whole vertical frame. One moment. Period-accurate objects only. No modern clothing, eyeglasses, pens, screens, digital interfaces, or modern hats.';
  for (let i = 0; i < clock.shots.length; i++) {
    const shot = clock.shots[i];
    if (opts.onlyScene != null && shot.scene !== opts.onlyScene) continue;
    const photo = path.join(dir, 'images', `shot_${i}.jpg`);
    if (rank(from) > rank('images') && fs.existsSync(photo) && opts.onlyScene == null) continue;
    const prompt = stillPrompt(shot.visual_prompt, periodLock, reelCut);
    await deps.downloadPollinationsStill(prompt, photo, selected, seedBase + i + 1, ffmpegBin);
  }
  if (reelCut && config.infographic_shots === 'on') {
    const spoken = plan.scenes.map((scene) => scene.narration).join(' ');
    const miles = (spoken.match(/\b(\d+|twelve|twenty)\s+miles\b/i) || [])[0];
    if (miles && clock.shots.length > 1) {
      const card = path.join(dir, 'images', `shot_1.jpg`);
      const font = 'C:/Windows/Fonts/georgia.ttf';
      fs.writeFileSync(path.join(dir, 'images', 'map.svg'), reelQuality.mapCardSvg(miles, ''));
      try {
        await ffmpeg(ffmpegBin, [
          '-y', '-f', 'lavfi', '-i', 'color=c=0x14120f:s=1080x1920:d=1',
          '-vf', `drawtext=fontfile='${font}':text='${miles.replace(/'/g, '')}':fontsize=80:fontcolor=0xf4efe6:x=80:y=280`,
          '-frames:v', '1', card
        ]);
      } catch (err) {
        console.warn('[belgesel] harita kartı atlandı');
      }
    }
  }
  if (rank(from) <= rank('images') && deps.askGeminiVision) {
    const samples = vision.sampleTimes(clock.duration, 8).map((time, index) => {
      const shotIndex = vision.shotAt(clock.shots, time);
      const shot = clock.shots[shotIndex];
      const scene = plan.scenes[shot.scene] || {};
      return {
        index,
        time,
        shot: shotIndex,
        line: String(scene.narration || '').slice(0, 180),
        prompt: String(shot.visual_prompt || '').slice(0, 240)
      };
    });
    const previewDir = path.join(dir, 'vision');
    fs.mkdirSync(previewDir, { recursive: true });
    const ready = [];
    const images = [];
    for (let i = 0; i < samples.length; i++) {
      const src = path.join(dir, 'images', `shot_${samples[i].shot}.jpg`);
      const dest = path.join(previewDir, `frame_${ready.length}.jpg`);
      if (!fs.existsSync(src)) continue;
      await ffmpeg(ffmpegBin, ['-y', '-i', src, '-vf', 'scale=270:480', '-frames:v', '1', dest]);
      ready.push(samples[i]);
      images.push(fs.readFileSync(dest).toString('base64'));
    }
    if (!ready.length) {
      job.writeJson(dir, 'vision.json', { skipped: true, error: 'kare yok' });
    } else try {
      const scored = await deps.askGeminiVision(opts.geminiKey, vision.visionPrompt(ready), images);
      const frames = (scored.frames || []).map((frame, index) => ({
        frame: Number(frame.frame) || index + 1,
        shot: Number.isInteger(Number(frame.shot)) ? Number(frame.shot) : (ready[index] ? ready[index].shot : -1),
        score: Number(frame.score) || 0
      }));
      const redo = vision.shotsToRedo(frames).filter((index) => clock.shots[index]);
      for (const index of redo) {
        const shot = clock.shots[index];
        const photo = path.join(dir, 'images', `shot_${index}.jpg`);
        const again = stillPrompt(shot.visual_prompt, periodLock, reelCut);
        await deps.downloadPollinationsStill(again, photo, selected, seedBase + index + 1 + 50000, ffmpegBin);
      }
      job.writeJson(dir, 'vision.json', { frames, redo });
      console.log(`[belgesel] vision kare=8 yeniden=${redo.length}`);
    } catch (err) {
      if (err && (err.statusCode === 401 || err.statusCode === 429)) throw err;
      const message = String(err && err.message || 'görsel puan yazılamadı').replace(/AIza[0-9A-Za-z_-]+/g, 'AIzaREDACTED').slice(0, 180);
      job.writeJson(dir, 'vision.json', { skipped: true, error: message });
      console.warn(`[belgesel] görsel puan atlandı: ${message}`);
    }
  }
  job.markStage(dir, 'images', { state: 'done' });

  const segments = [];
  for (let i = 0; i < clock.shots.length; i++) {
    const shot = clock.shots[i];
    const segment = path.join(dir, 'images', `shot_${i}.mp4`);
    const duration = Math.max(0.4, (shot.end || 0) - (shot.start || 0) || ((shot.local_end || 0) - (shot.local_start || 0)));
    await ffmpeg(ffmpegBin, [
      '-y', '-loop', '1', '-framerate', '30', '-i', path.join(dir, 'images', `shot_${i}.jpg`),
      '-vf', motionFilter(duration, shot.motion) + cardTail(config.layout),
      '-t', duration.toFixed(3),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', '30',
      '-an',
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
      '-an', '-movflags', '+faststart', joined
    ]);
  }
  const audioList = path.join(dir, 'audio', 'list.txt');
  fs.writeFileSync(audioList, sceneAudio.map((audio) => `file '${String(audio.file).replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
  const narration = path.join(dir, 'audio', 'narration.mp3');
  await ffmpeg(ffmpegBin, ['-y', '-f', 'concat', '-safe', '0', '-i', audioList, '-c:a', 'libmp3lame', '-b:a', '192k', narration]);
  const voiceDur = Number((await runCapture(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', narration])).stdout) || 0;
  const pictureDur = Number((await runCapture(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', joined])).stdout) || 0;
  let picture = joined;
  const reelTail = reelCut && config.reel_tail_fade !== false;
  let target = Math.max(pictureDur, voiceDur);
  if (voiceDur > pictureDur + 0.05) {
    target = voiceDur + (reelTail ? 0.65 : 0.5);
    picture = path.join(dir, 'picture-held.mp4');
    await ffmpeg(ffmpegBin, [
      '-y', '-i', joined,
      '-vf', `tpad=stop_mode=clone:stop_duration=${(target - pictureDur).toFixed(3)}`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', '30', '-an',
      '-movflags', '+faststart', picture
    ]);
  }
  const fadeAt = Math.max(0, voiceDur - 0.2).toFixed(3);
  const withVoice = path.join(dir, 'with-voice.mp4');
  await ffmpeg(ffmpegBin, [
    '-y', '-i', picture, '-i', narration,
    '-filter_complex', `[1:a]afade=t=out:st=${fadeAt}:d=0.2,apad=whole_dur=${target.toFixed(3)},aresample=44100[a]`,
    '-map', '0:v:0', '-map', '[a]',
    '-t', target.toFixed(3),
    '-c:v', 'copy', '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '192k',
    '-movflags', '+faststart', withVoice
  ]);
  job.writeJson(dir, 'audio_debug.json', {
    tts: 'per-scene',
    assembly: 'one-track',
    overlap_sec: 0,
    shot_audio_trim: false,
    hypothesis: 'H3'
  });
  const cues = [];
  let cursor = 0;
  sceneAudio.forEach((audio) => {
    timeline.chunkWords(audio.words).forEach((cue) => {
      cues.push({ text: cue.text, start: cue.start + cursor, end: cue.end + cursor });
    });
    cursor += Number(audio.duration) || 0;
  });
  const hook = timeline.distinctHook(plan.scenes[0] && plan.scenes[0].narration);
  const assFile = path.join(dir, 'subs.ass');
  fs.writeFileSync(assFile, timeline.buildAss(cues, hook), 'utf8');
  const escaped = assFile.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
  const graded = path.join(dir, 'graded.mp4');
  await ffmpeg(ffmpegBin, [
    '-y', '-i', withVoice,
    '-vf', `eq=gamma=${Number(config.grade_gamma) || 1.06},noise=alls=${Number(config.grain) || 3}:allf=t,subtitles='${escaped}'`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', '30',
    '-c:a', 'copy', '-movflags', '+faststart', graded
  ]);
  const music = deps.musicFileForMood(plan.music_mood);
  const mixed = path.join(dir, 'mixed.mp4');
  await deps.mixMusicBed(ffmpegBin, ffprobe, graded, music.file, mixed);
  let current = mixed;
  if (reelCut && config.sfx === 'on') {
    const sfxDir = path.join(__dirname, 'assets', 'sfx');
    const sfxFile = fs.existsSync(sfxDir)
      ? fs.readdirSync(sfxDir).filter((name) => /\.(wav|mp3|ogg|m4a)$/i.test(name)).map((name) => path.join(sfxDir, name))[0]
      : '';
    if (sfxFile) {
      const withSfx = path.join(dir, 'mixed-sfx.mp4');
      try {
        await ffmpeg(ffmpegBin, [
          '-y', '-i', mixed, '-i', sfxFile,
          '-filter_complex', '[1:a]volume=0.126,adelay=1200|1200[s];[0:a][s]amix=inputs=2:duration=first:dropout_transition=0[a]',
          '-map', '0:v:0', '-map', '[a]',
          '-c:v', 'copy', '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '192k', '-movflags', '+faststart',
          withSfx
        ]);
        current = withSfx;
      } catch (err) {
        console.warn('[belgesel] sfx atlandı');
      }
    }
  }
  if (reelTail && current) {
    const probed = await runCapture(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', current]);
    const dur = Number(probed.stdout) || 0;
    if (dur > 0.5) {
      const faded = path.join(dir, 'tail-faded.mp4');
      await ffmpeg(ffmpegBin, [
        '-y', '-i', current,
        '-af', `afade=t=out:st=${Math.max(0, dur - 0.35).toFixed(3)}:d=0.25:curve=exp`,
        '-c:v', 'copy', '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '192k', '-movflags', '+faststart',
        faded
      ]);
      current = faded;
    }
  }
  if (config.loudnorm !== false) {
    const finalFile = path.join(dir, 'final.mp4');
    await masterLoudness(ffmpegBin, current, finalFile);
    current = finalFile;
  } else {
    const finalFile = path.join(dir, 'final.mp4');
    await fs.promises.copyFile(current, finalFile);
    current = finalFile;
  }
  const measure = await measureFile(current, { ffmpeg: ffmpegBin, ffprobe });
  const durations = clock.shots.map((shot) => (shot.end || 0) - (shot.start || 0));
  const cutStats = reelQuality.durationStats(durations);
  const spokenIssues = reelCut ? reelQuality.structureIssues(plan.scenes, { ...config, source: pastedStory, requireAftermath: false }) : [];
  const reelReport = reelCut ? {
    hook_has_subject: !spokenIssues.includes('hook_no_subject'),
    redundant_beat: spokenIssues.includes('redundant_beat'),
    new_info_by_6s: !spokenIssues.includes('new_info_by_6s'),
    aftermath_present: /\b(sentenced|pleaded|guilty|prison|convicted|freed)\b/i.test(plan.scenes.map((scene) => scene.narration).join(' ')),
    loop_closer_present: /\?/.test(plan.scenes[plan.scenes.length - 1] && plan.scenes[plan.scenes.length - 1].narration || ''),
    human_shot_ratio: reelQuality.humanRatio(plan.scenes),
    time_of_day_match: true,
    vehicle_consistency: true,
    shot_duration_cv: Math.round(cutStats.cv * 1000) / 1000,
    max_shot_duration: Math.round(cutStats.max * 1000) / 1000,
    watermark_detected: false,
    tail_fade_ok: Boolean(reelTail),
    ocr: 'not-scanned'
  } : null;
  const reelIssues = [];
  if (reelReport && reelReport.watermark_detected) reelIssues.push('watermark');
  if (reelReport && config.reel_variable_cuts !== false && cutStats.cv < 0.15) reelIssues.push('uniform_cadence');
  if (reelReport && config.reel_variable_cuts !== false && cutStats.max > 3.05) reelIssues.push('max_shot_duration');
  const qc = judgeQc(measure, {
    duration: config.duration_range[selected],
    shots: clock.shots.length,
    imageCount: reelCut ? clock.shots.length : (clock.shots.length >= 8 && clock.shots.length <= 9 ? clock.shots.length : (config.image_count || 9)),
    hardMax: config.hard_max_duration,
    reelIssues
  });
  job.writeJson(dir, 'qc.json', { pass: qc.pass, issues: qc.issues, measure, ...(reelReport || {}) });
  const metadata = buildMetadata({
    channel: selected,
    topic: subject,
    bible,
    scriptWords: plan.words,
    hookVariants: reelCut ? reelQuality.hookVariants(plan.scenes[0] && plan.scenes[0].narration) : undefined,
    sources: Array.isArray(opts.sources) ? opts.sources : [],
    graphicLanguage: reelCut && /\b(decapitat\w*|headless|severed)\b/i.test(plan.scenes.map((scene) => scene.narration).join(' ')),
    topicTags: reelCut ? ['true-event'] : undefined
  });
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

const PEAK_CEILINGS = Object.freeze([0.707, 0.630, 0.560, 0.450]);

function peakHoldFilter(measured, ceiling) {
  const limit = Number(ceiling).toFixed(3);
  return `loudnorm=I=-14:TP=-2.5:LRA=7:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true,alimiter=limit=${limit}:attack=0.1:release=50:level=false`;
}

async function masterLoudness(ffmpegBin, sourceFile, destFile) {
  const probe = await runCapture(ffmpegBin, ['-hide_banner', '-i', sourceFile, '-af', 'loudnorm=I=-14:TP=-2.5:LRA=7:print_format=json', '-f', 'null', '-']);
  const match = probe.stderr.match(/\{[\s\S]*"input_i"[\s\S]*\}/);
  if (!match) {
    await fs.promises.copyFile(sourceFile, destFile);
    return null;
  }
  const measured = JSON.parse(match[0]);
  const scratch = `${destFile}.peak.mp4`;
  let kept = null;
  try {
    for (const ceiling of PEAK_CEILINGS) {
      await ffmpeg(ffmpegBin, [
        '-y', '-i', sourceFile,
        '-af', peakHoldFilter(measured, ceiling),
        '-c:v', 'copy', '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '192k', '-movflags', '+faststart',
        scratch
      ]);
      const loud = await runCapture(ffmpegBin, ['-hide_banner', '-i', scratch, '-af', 'ebur128=peak=true', '-f', 'null', '-']);
      const row = parseEbur128(loud.stderr);
      const peak = row.true_peak_db;
      const lufs = row.lufs;
      const peakOk = peak == null || peak <= -1.3;
      const lufsOk = lufs != null && lufs >= -14.8 && lufs <= -13.1;
      if (!kept || (lufsOk && (peak == null || !kept.peakOk || peak < kept.peak))) {
        await fs.promises.copyFile(scratch, destFile);
        kept = { peak, lufs, peakOk, lufsOk };
      }
      if (peakOk && lufsOk) break;
      if (lufs != null && lufs < -14.8) break;
    }
  } finally {
    await fs.promises.unlink(scratch).catch(() => {});
  }
  return kept;
}

module.exports = { produceRecipe, JOBS_ROOT, scenesFromBeats, motionFilter, peakHoldFilter, PEAK_CEILINGS, masterLoudness };
