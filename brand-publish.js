/**
 * Marka klasöründeki sıradaki mp4.
 * Saatler Facebook ile aynıdır: 22:00 Epoch, 22:30 Chaos, 23:00 Therapy.
 * Dolu kimliği olan platform paylaşır. Boş platform atlanır.
 * Hazır platformların hepsi başarılıysa dosya paylasildi klasörüne taşınır.
 * X bu modülden çağrılmaz.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const facebook = require('./facebook-reels');

const BRANDS = ['facebook', 'instagram', 'youtube'];

function statePath(options) {
  return (options && options.stateFile)
    || process.env.BRAND_PUBLISH_STATE
    || path.join(__dirname, 'output', 'publish', 'state.json');
}

function logPath() {
  return process.env.PUBLISH_LOG_PATH
    || path.join(__dirname, 'output', 'publish', 'log.jsonl');
}

function scrub(text) {
  return String(text || '')
    .replace(/access_token=[^&\s"']+/gi, 'access_token=***')
    .replace(/refresh_token=[^&\s"']+/gi, 'refresh_token=***')
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/=]+/gi, 'Bearer ***')
    .replace(/ya29\.[A-Za-z0-9\-._]+/g, 'ya29.***')
    .slice(0, 500);
}

function writeLog(entry) {
  const row = Object.assign({ at: new Date().toISOString() }, entry);
  if (row.message) row.message = scrub(row.message);
  try {
    fs.mkdirSync(path.dirname(logPath()), { recursive: true });
    fs.appendFileSync(logPath(), `${JSON.stringify(row)}\n`);
  } catch {}
  const label = [row.platform, row.event, row.message].filter(Boolean).join(' ');
  if (label) console.log('[publish]', label);
}

function readCredential(name) {
  return String(process.env[name] || '').trim();
}

function firstCredential(names) {
  for (const name of names) {
    const value = readCredential(name);
    if (value) return value;
  }
  return '';
}

function enabled() {
  if (String(process.env.PUBLISH_QUEUE == null ? '1' : process.env.PUBLISH_QUEUE) === '0') return false;
  return true;
}

function platformOn(name) {
  if (!enabled()) return false;
  if (name === 'facebook') return String(process.env.FACEBOOK_REELS == null ? '1' : process.env.FACEBOOK_REELS) !== '0';
  if (name === 'instagram') return String(process.env.INSTAGRAM_REELS == null ? '1' : process.env.INSTAGRAM_REELS) !== '0';
  if (name === 'youtube') return String(process.env.YOUTUBE_SHORTS == null ? '1' : process.env.YOUTUBE_SHORTS) !== '0';
  return false;
}

function pairFor(prefix, key, idName, tokenNames, fallbackId, fallbackTokens) {
  const ownId = readCredential(`${prefix}_${key}_${idName}`);
  const ownToken = firstCredential(tokenNames.map((name) => `${prefix}_${key}_${name}`));
  if (ownId && ownToken) return { id: ownId, token: ownToken, via: 'brand' };
  if (ownId || ownToken) return { id: '', token: '', via: 'incomplete' };
  const id = readCredential(fallbackId);
  const token = firstCredential(fallbackTokens);
  if (id && token) return { id, token, via: 'fallback' };
  return { id: '', token: '', via: 'missing' };
}

function targetLabel(name, key, via) {
  if (name === 'facebook') {
    return via === 'incomplete'
      ? `FACEBOOK_${key}_PAGE_ID ve FACEBOOK_${key}_PAGE_TOKEN birlikte dolu olmalı.`
      : `FACEBOOK_${key}_PAGE_ID / FACEBOOK_${key}_PAGE_TOKEN boş. Ortak FACEBOOK_PAGE_ID / FACEBOOK_PAGE_TOKEN de boş.`;
  }
  if (name === 'instagram') {
    return via === 'incomplete'
      ? `INSTAGRAM_${key}_ACCOUNT_ID ve INSTAGRAM_${key}_ACCESS_TOKEN birlikte dolu olmalı.`
      : `INSTAGRAM_${key}_ACCOUNT_ID / INSTAGRAM_${key}_ACCESS_TOKEN boş. Ortak INSTAGRAM_ACCOUNT_ID ve INSTAGRAM_ACCESS_TOKEN veya META_ACCESS_TOKEN de boş.`;
  }
  return `YOUTUBE_${key}_REFRESH_TOKEN boş. YouTube atlandı.`;
}

function tokenKey(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function youtubeFor(key) {
  const own = readCredential(`YOUTUBE_${key}_REFRESH_TOKEN`);
  const shared = readCredential('YOUTUBE_REFRESH_TOKEN');
  const refreshToken = own || shared;
  if (!refreshToken) return { ready: false, via: 'missing', refreshToken: '', id: '', clientId: '', clientSecret: '' };
  return {
    ready: platformOn('youtube'),
    via: own ? 'brand' : 'fallback',
    refreshToken,
    id: tokenKey(refreshToken),
    clientId: readCredential('YOUTUBE_CLIENT_ID'),
    clientSecret: readCredential('YOUTUBE_CLIENT_SECRET')
  };
}

function decorate(page) {
  const facebookCreds = {
    id: page.pageId,
    token: page.token,
    via: page.via,
    ready: Boolean(page.ready) && platformOn('facebook')
  };
  const instagram = pairFor(
    'INSTAGRAM',
    page.key,
    'ACCOUNT_ID',
    ['ACCESS_TOKEN'],
    'INSTAGRAM_ACCOUNT_ID',
    ['INSTAGRAM_ACCESS_TOKEN', 'META_ACCESS_TOKEN']
  );
  const youtube = youtubeFor(page.key);
  instagram.ready = (instagram.via === 'brand' || instagram.via === 'fallback') && platformOn('instagram');
  if (!platformOn('facebook')) facebookCreds.ready = false;
  return {
    key: page.key,
    folder: page.folder,
    dir: page.dir,
    slot: page.slot,
    facebook: facebookCreds,
    instagram,
    youtube
  };
}

function brandPages(downloadDir) {
  const built = facebook.pages(downloadDir);
  return {
    warnings: built.warnings,
    pages: built.pages.map(decorate)
  };
}

function loadState(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      posted: data.posted || {},
      fired: data.fired || {},
      chosen: data.chosen || {}
    };
  } catch {
    return { posted: {}, fired: {}, chosen: {} };
  }
}

function sidePath(file) {
  return `${file}.state.json`;
}

function loadSide(file) {
  try {
    const data = JSON.parse(fs.readFileSync(sidePath(file), 'utf8'));
    if (!data || typeof data !== 'object') throw new Error('bad');
    data.platforms = data.platforms || {};
    return data;
  } catch {
    return { file: path.basename(file), platforms: {} };
  }
}

function saveSide(file, data) {
  const dest = sidePath(file);
  const tmp = `${dest}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, dest);
}

function isDone(data, name) {
  return Boolean(data.platforms[name] && data.platforms[name].status === 'done');
}

function markPlatform(file, name, entry) {
  const data = loadSide(file);
  data.file = path.basename(file);
  data.platforms[name] = entry;
  saveSide(file, data);
  return data;
}

function moveWithState(file) {
  const side = sidePath(file);
  const dest = facebook.moveToPublished(file);
  if (fs.existsSync(side)) fs.renameSync(side, `${dest}.state.json`);
  return dest;
}

function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let ticking = false;
let warned = false;

async function tick(options = {}) {
  if (ticking) return { ok: true, busy: true };
  if (!options.force && !enabled()) return { ok: true, disabled: true };
  ticking = true;
  const logs = [];
  const emit = (entry) => {
    logs.push(entry);
    if (options.log) options.log(entry);
    else if (!options.silent) writeLog(entry);
  };
  try {
    const now = options.now || new Date();
    const parts = options.parts || facebook.trtParts(now);
    const built = brandPages(options.downloadDir);
    if (!warned || options.repeatWarnings) {
      built.warnings.forEach((message) => emit({ event: 'config', platform: 'publish', message }));
      warned = true;
    }
    const file = statePath(options);
    const state = loadState(file);
    const wait = options.sleepFn || sleep;
    const pause = Number.isFinite(options.gapMs) ? options.gapMs : 0;
    for (const page of built.pages) {
      if (parts.hour !== page.slot.hour || parts.minute !== page.slot.minute) continue;
      const fireKey = `${page.key}|${parts.date}|${page.slot.label}`;
      const targets = BRANDS.map((name) => Object.assign({ name }, page[name]));
      const ready = targets.filter((target) => target.ready);
      let video = state.chosen[fireKey] && fs.existsSync(state.chosen[fireKey]) ? state.chosen[fireKey] : '';
      if (!video) {
        if (state.fired[fireKey]) continue;
        targets.forEach((target) => {
          if (target.ready || !platformOn(target.name)) return;
          emit({
            event: 'skipped',
            platform: target.name,
            message: `${page.folder} ${page.slot.label} atlandı. ${targetLabel(target.name, page.key, target.via)}`
          });
        });
        if (!ready.length) {
          state.fired[fireKey] = new Date().toISOString();
          saveState(file, state);
          continue;
        }
        video = facebook.nextMp4(page.dir, now.getTime());
        state.fired[fireKey] = new Date().toISOString();
        if (video) state.chosen[fireKey] = video;
        saveState(file, state);
        if (!video) {
          emit({ event: 'empty', platform: 'publish', message: `${page.folder} klasöründe hazır mp4 yok.` });
          continue;
        }
      }
      const caption = facebook.captionFromFile(video);
      const side = loadSide(video);
      let failed = false;
      let blocked = false;
      let postedNow = 0;
      for (const target of ready) {
        if (isDone(side, target.name)) continue;
        const dayKey = `${target.name}:${target.id}`;
        if (state.posted[dayKey] === parts.date) {
          blocked = true;
          emit({ event: 'day-limit', platform: target.name, message: `${page.folder} bugün bu hesapta zaten paylaştı.` });
          continue;
        }
        if (postedNow > 0 && pause > 0) await wait(pause);
        try {
          const poster = target.name === 'facebook'
            ? options.postFacebook
            : target.name === 'instagram'
              ? options.postInstagram
              : options.postYouTube;
          if (typeof poster !== 'function') throw new Error(`${target.name} yayın işlevi yok.`);
          const result = await poster({
            videoPath: video,
            caption,
            pageId: target.name === 'facebook' ? target.id : '',
            accountId: target.name === 'instagram' ? target.id : '',
            token: target.token || '',
            refreshToken: target.refreshToken || '',
            clientId: target.clientId || '',
            clientSecret: target.clientSecret || ''
          });
          const marked = markPlatform(video, target.name, {
            status: 'done',
            id: result && result.id ? String(result.id) : '',
            at: new Date().toISOString()
          });
          side.platforms = marked.platforms;
          state.posted[dayKey] = parts.date;
          saveState(file, state);
          postedNow += 1;
          emit({
            event: 'posted',
            platform: target.name,
            message: `${page.folder} ${path.basename(video)} ${target.via === 'brand' ? 'kendi hesabı' : 'ortak hesap'}`
          });
        } catch (err) {
          failed = true;
          const message = scrub(err && err.message ? err.message : String(err));
          markPlatform(video, target.name, { status: 'failed', at: new Date().toISOString(), error: message });
          emit({
            event: err && err.skip ? 'skipped' : 'failed',
            platform: target.name,
            message: `${path.basename(video)} ${message}`
          });
        }
      }
      const current = loadSide(video);
      const done = ready.every((target) => isDone(current, target.name));
      if (!failed && !blocked && done) {
        try {
          const dest = moveWithState(video);
          emit({ event: 'moved', platform: 'publish', message: dest });
        } catch (err) {
          emit({ event: 'move-failed', platform: 'publish', message: `${path.basename(video)} paylaşıldı ama taşınamadı. ${err && err.message ? err.message : err}` });
        }
      }
    }
    return { ok: true, logs };
  } finally {
    ticking = false;
  }
}

function snapshot(options = {}) {
  const built = brandPages(options.downloadDir);
  return {
    enabled: enabled(),
    warnings: built.warnings,
    pages: built.pages.map((page) => ({
      folder: page.folder,
      slot: page.slot.label,
      facebook: page.facebook.ready,
      instagram: page.instagram.ready,
      youtube: page.youtube.ready
    }))
  };
}

module.exports = {
  tick,
  snapshot,
  brandPages,
  pairFor
};
