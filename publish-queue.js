/**
 * Kancalı videoyu kuyruğa alır.
 * Otomatik paylaşım marka klasöründeki sıradaki mp4 içindir:
 * Facebook Sayfa Reels, Instagram Reels ve YouTube Shorts.
 * X kodu durur, zamanlayıcı onu çağırmaz.
 *
 *   const q = require('./publish-queue');
 *   await q.finishHookedPublish({ videoPath, hookText, caption });
 *   q.startScheduler();
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { synthesizeHook, spokenHookText } = require('./elevenlabs-hook');
const { composeHookVideo } = require('./hook-compose');

const PLATFORMS = ['instagram', 'facebook', 'x'];
const SLOT_HOUR = 21;
const SLOT_MINUTE = 30;
const DEFAULT_GAP_MS = 3 * 60 * 1000;
const GRAPH_VERSION = () => String(process.env.META_GRAPH_VERSION || 'v21.0').trim();

class PublishError extends Error {
  constructor(message, extra) {
    super(message);
    this.name = 'PublishError';
    if (extra) Object.assign(this, extra);
  }
}

function stateFile() {
  return process.env.PUBLISH_STATE_PATH
    || path.join(__dirname, 'output', 'publish', 'queue.json');
}

function logFile() {
  return process.env.PUBLISH_LOG_PATH
    || path.join(__dirname, 'output', 'publish', 'log.jsonl');
}

function emptyState() {
  return { items: [], slotDate: '', missedDate: '', postedDays: {}, hooked: {} };
}

function loadState() {
  try {
    const data = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    return Object.assign(emptyState(), data);
  } catch {
    return emptyState();
  }
}

function saveState(state) {
  const file = stateFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

function scrub(text) {
  return String(text || '')
    .replace(/access_token=[^&\s"']+/gi, 'access_token=***')
    .replace(/refresh_token=[^&\s"']+/gi, 'refresh_token=***')
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/=]+/gi, 'Bearer ***')
    .slice(0, 500);
}

function logEvent(entry) {
  const row = Object.assign({ at: new Date().toISOString() }, entry);
  if (row.message) row.message = scrub(row.message);
  try {
    fs.mkdirSync(path.dirname(logFile()), { recursive: true });
    fs.appendFileSync(logFile(), `${JSON.stringify(row)}\n`);
  } catch {}
  const label = [row.platform, row.event, row.message].filter(Boolean).join(' ');
  if (label) console.log('[publish]', label);
}

function trtParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });
  const bag = {};
  for (const part of fmt.formatToParts(date)) bag[part.type] = part.value;
  let hour = Number(bag.hour);
  if (hour === 24) hour = 0;
  return {
    date: `${bag.year}-${bag.month}-${bag.day}`,
    hour,
    minute: Number(bag.minute)
  };
}

function shouldStartSlot(parts, state) {
  if (!parts || parts.hour !== SLOT_HOUR || parts.minute !== SLOT_MINUTE) return false;
  if (state && state.slotDate === parts.date) return false;
  return true;
}

function gapMs() {
  const raw = Number(process.env.PUBLISH_PLATFORM_GAP_MS);
  if (Number.isFinite(raw) && raw >= 1000) return raw;
  return DEFAULT_GAP_MS;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(err) {
  if (!err || err.skip || err.uncertain) return false;
  if (err.status === 429 || (err.status >= 500 && err.status <= 599)) return true;
  if (!err.status && /timeout|network|fetch|ECONN|ENOTFOUND|EAI_AGAIN/i.test(err.message || '')) return true;
  return false;
}

async function attempt(fn, { retryDelays, sleepFn }) {
  const delays = retryDelays || [20000, 40000];
  const wait = sleepFn || sleep;
  let last;
  for (let i = 0; i <= delays.length; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (!isRetryable(err) || i === delays.length) throw err;
      logEvent({ event: 'retry', message: scrub(err.message), waitMs: delays[i] });
      await wait(delays[i]);
    }
  }
  throw last;
}

function brandPairReady(prefix, idName, tokenNames, fallbackId, fallbackTokens) {
  const brands = ['EPOCH', 'CHAOS', 'THERAPY'];
  const own = brands.some((key) => {
    const id = String(process.env[`${prefix}_${key}_${idName}`] || '').trim();
    const token = tokenNames.map((name) => String(process.env[`${prefix}_${key}_${name}`] || '').trim()).find(Boolean);
    return Boolean(id && token);
  });
  if (own) return true;
  const id = String(process.env[fallbackId] || '').trim();
  const token = fallbackTokens.map((name) => String(process.env[name] || '').trim()).find(Boolean);
  return Boolean(id && token);
}

function configured(name) {
  if (name === 'instagram') {
    return brandPairReady(
      'INSTAGRAM',
      'ACCOUNT_ID',
      ['ACCESS_TOKEN'],
      'INSTAGRAM_ACCOUNT_ID',
      ['INSTAGRAM_ACCESS_TOKEN', 'META_ACCESS_TOKEN']
    );
  }
  if (name === 'youtube') {
    const client = String(process.env.YOUTUBE_CLIENT_ID || '').trim() && String(process.env.YOUTUBE_CLIENT_SECRET || '').trim();
    const own = ['EPOCH', 'CHAOS', 'THERAPY'].some((key) => String(process.env[`YOUTUBE_${key}_REFRESH_TOKEN`] || '').trim());
    const shared = String(process.env.YOUTUBE_REFRESH_TOKEN || '').trim();
    return Boolean(client && (own || shared));
  }
  if (name === 'facebook') {
    const brands = ['EPOCH', 'CHAOS', 'THERAPY'];
    const own = brands.some((key) => {
      const id = process.env[`FACEBOOK_${key}_PAGE_ID`];
      const token = process.env[`FACEBOOK_${key}_PAGE_TOKEN`] || process.env[`FACEBOOK_${key}_ACCESS_TOKEN`];
      return id && token;
    });
    return own || !!(process.env.FACEBOOK_PAGE_ID && (process.env.FACEBOOK_PAGE_TOKEN || process.env.META_ACCESS_TOKEN));
  }
  if (name === 'x') {
    return !!(
      process.env.X_API_KEY &&
      process.env.X_API_SECRET &&
      process.env.X_ACCESS_TOKEN &&
      process.env.X_ACCESS_SECRET
    );
  }
  return false;
}

async function readResponse(res) {
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text: scrub(text) };
}

function httpError(prefix, res) {
  const msg = (res.json && res.json.error && (res.json.error.message || res.json.error)) || res.text || `HTTP ${res.status}`;
  const err = new PublishError(`${prefix}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`, { status: res.status });
  return err;
}

async function postInstagram(item) {
  const token = String((item && item.token) || process.env.INSTAGRAM_ACCESS_TOKEN || process.env.META_ACCESS_TOKEN || '').trim();
  const igId = String((item && item.accountId) || process.env.INSTAGRAM_ACCOUNT_ID || '').trim();
  if (!igId || !token) {
    throw new PublishError('Instagram hesabı ayarlı değil (INSTAGRAM_ACCOUNT_ID, INSTAGRAM_ACCESS_TOKEN).', { skip: true });
  }
  const version = GRAPH_VERSION();
  const video = await fs.promises.readFile(item.videoPath);
  const open = await fetch(`https://graph.facebook.com/${version}/${encodeURIComponent(igId)}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      media_type: 'REELS',
      upload_type: 'resumable',
      caption: String(item.caption || '').slice(0, 2200),
      share_to_feed: true
    }),
    signal: AbortSignal.timeout(30000)
  });
  const opened = await readResponse(open);
  if (!open.ok || !opened.json || !opened.json.id || !opened.json.uri) throw httpError('Instagram yükleme açılmadı', opened);
  const upload = await fetch(opened.json.uri, {
    method: 'POST',
    headers: {
      Authorization: `OAuth ${token}`,
      offset: '0',
      file_size: String(video.length),
      'Content-Type': 'application/octet-stream'
    },
    body: video,
    signal: AbortSignal.timeout(180000)
  });
  const uploaded = await readResponse(upload);
  if (!upload.ok) throw httpError('Instagram video yüklenemedi', uploaded);

  const containerId = opened.json.id;
  let finished = false;
  for (let i = 0; i < 40; i++) {
    await sleep(3000);
    const statusRes = await fetch(
      `https://graph.facebook.com/${version}/${encodeURIComponent(containerId)}?fields=status_code,status`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) }
    );
    const status = await readResponse(statusRes);
    const code = status.json && status.json.status_code;
    if (code === 'FINISHED') { finished = true; break; }
    if (code === 'ERROR' || code === 'EXPIRED') throw httpError('Instagram kanca videosunu işlemedi', status);
  }
  if (!finished) throw new PublishError('Instagram video işleme süresi doldu.', { status: 504 });

  const published = await fetch(`https://graph.facebook.com/${version}/${encodeURIComponent(igId)}/media_publish`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ creation_id: containerId }),
    signal: AbortSignal.timeout(30000)
  });
  const result = await readResponse(published);
  if (!published.ok || !result.json || !result.json.id) {
    throw new PublishError(`Instagram yayınlanamadı: ${result.text || published.status}`, { status: published.status, uncertain: published.status === 0 });
  }
  return { id: result.json.id };
}

async function postFacebook(item) {
  const token = String((item && item.token) || process.env.FACEBOOK_PAGE_TOKEN || process.env.META_ACCESS_TOKEN || '').trim();
  const pageId = String((item && item.pageId) || process.env.FACEBOOK_PAGE_ID || '').trim();
  if (!pageId || !token) {
    throw new PublishError('Facebook sayfası ayarlı değil (FACEBOOK_PAGE_ID, FACEBOOK_PAGE_TOKEN).', { skip: true });
  }
  const version = GRAPH_VERSION();
  const video = await fs.promises.readFile(item.videoPath);
  const start = await fetch(`https://graph.facebook.com/${version}/${encodeURIComponent(pageId)}/video_reels`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ upload_phase: 'start' }),
    signal: AbortSignal.timeout(30000)
  });
  const started = await readResponse(start);
  if (!start.ok || !started.json || !started.json.video_id || !started.json.upload_url) {
    throw httpError('Facebook yükleme açılmadı', started);
  }
  const upload = await fetch(started.json.upload_url, {
    method: 'POST',
    headers: {
      Authorization: `OAuth ${token}`,
      offset: '0',
      file_size: String(video.length),
      'Content-Type': 'application/octet-stream'
    },
    body: video,
    signal: AbortSignal.timeout(180000)
  });
  const uploaded = await readResponse(upload);
  if (!upload.ok) throw httpError('Facebook video yüklenemedi', uploaded);
  const finish = await fetch(`https://graph.facebook.com/${version}/${encodeURIComponent(pageId)}/video_reels`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      upload_phase: 'finish',
      video_id: started.json.video_id,
      video_state: 'PUBLISHED',
      description: String(item.caption || '').slice(0, 5000)
    }),
    signal: AbortSignal.timeout(30000)
  });
  const finished = await readResponse(finish);
  if (!finish.ok) {
    throw new PublishError(`Facebook yayınlanamadı: ${finished.text || finish.status}`, { status: finish.status, uncertain: true });
  }
  return { id: started.json.video_id };
}

function youtubePrivacy() {
  const raw = String(process.env.YOUTUBE_PRIVACY_STATUS || 'public').trim().toLowerCase();
  if (raw === 'public' || raw === 'unlisted' || raw === 'private') return raw;
  return 'public';
}

function youtubeCopy(caption) {
  const text = String(caption || '').replace(/\s+/g, ' ').trim();
  const title = text.slice(0, 100) || 'Short';
  let description = text.slice(0, 4800);
  if (!/#shorts\b/i.test(description)) description = `${description} #Shorts`.trim();
  return { title, description, privacyStatus: youtubePrivacy() };
}

async function youtubeAccessToken(item) {
  const clientId = String((item && item.clientId) || process.env.YOUTUBE_CLIENT_ID || '').trim();
  const clientSecret = String((item && item.clientSecret) || process.env.YOUTUBE_CLIENT_SECRET || '').trim();
  const refreshToken = String((item && item.refreshToken) || process.env.YOUTUBE_REFRESH_TOKEN || '').trim();
  if (!refreshToken) {
    throw new PublishError('YouTube refresh token boş. Bu marka atlandı.', { skip: true });
  }
  if (!clientId || !clientSecret) {
    throw new PublishError('YouTube uygulama bilgisi boş (YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET).', { skip: true });
  }
  const { OAuth2Client } = require('google-auth-library');
  const client = new OAuth2Client(clientId, clientSecret);
  client.setCredentials({ refresh_token: refreshToken });
  let access;
  try {
    access = await client.getAccessToken();
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    throw new PublishError(`YouTube erişim anahtarı alınamadı: ${message}`);
  }
  const token = typeof access === 'string' ? access : (access && access.token);
  if (!token) throw new PublishError('YouTube erişim anahtarı alınamadı.');
  return token;
}

async function postYouTube(item) {
  const copy = youtubeCopy(item && item.caption);
  const token = await youtubeAccessToken(item);
  const video = await fs.promises.readFile(item.videoPath);
  const start = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': 'video/mp4',
      'X-Upload-Content-Length': String(video.length)
    },
    body: JSON.stringify({
      snippet: { title: copy.title, description: copy.description, categoryId: '22' },
      status: { privacyStatus: copy.privacyStatus, selfDeclaredMadeForKids: false }
    }),
    signal: AbortSignal.timeout(30000)
  });
  const started = await readResponse(start);
  if (!start.ok) throw httpError('YouTube yükleme açılmadı', started);
  const location = start.headers.get('location');
  if (!location) throw new PublishError('YouTube yükleme adresi dönmedi.');
  const upload = await fetch(location, {
    method: 'PUT',
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': String(video.length)
    },
    body: video,
    signal: AbortSignal.timeout(180000)
  });
  const uploaded = await readResponse(upload);
  if (!upload.ok || !uploaded.json || !uploaded.json.id) throw httpError('YouTube video yüklenemedi', uploaded);
  return { id: uploaded.json.id };
}

function rfc3986(value) {
  return encodeURIComponent(String(value))
    .replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

function oauthHeader({ method, url, params, consumerKey, consumerSecret, token, tokenSecret }) {
  const oauth = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: token,
    oauth_version: '1.0'
  };
  const all = Object.assign({}, params || {}, oauth);
  const paramStr = Object.keys(all).sort().map((key) => `${rfc3986(key)}=${rfc3986(all[key])}`).join('&');
  const base = `${method.toUpperCase()}&${rfc3986(url)}&${rfc3986(paramStr)}`;
  const key = `${rfc3986(consumerSecret)}&${rfc3986(tokenSecret)}`;
  oauth.oauth_signature = crypto.createHmac('sha1', key).update(base).digest('base64');
  return `OAuth ${Object.keys(oauth).sort().map((k) => `${rfc3986(k)}="${rfc3986(oauth[k])}"`).join(', ')}`;
}

function xKeys() {
  return {
    consumerKey: process.env.X_API_KEY,
    consumerSecret: process.env.X_API_SECRET,
    token: process.env.X_ACCESS_TOKEN,
    tokenSecret: process.env.X_ACCESS_SECRET
  };
}

async function xForm(url, params) {
  const keys = xKeys();
  const body = new URLSearchParams(params);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: oauthHeader({ method: 'POST', url, params, ...keys }),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body,
    signal: AbortSignal.timeout(30000)
  });
  const parsed = await readResponse(res);
  if (!res.ok) throw httpError('X', parsed);
  return parsed.json || {};
}

async function postX(item) {
  if (!configured('x')) {
    throw new PublishError('X hesabı ayarlı değil (X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET).', { skip: true });
  }
  const uploadUrl = 'https://upload.twitter.com/1.1/media/upload.json';
  const video = await fs.promises.readFile(item.videoPath);
  const init = await xForm(uploadUrl, {
    command: 'INIT',
    media_type: 'video/mp4',
    total_bytes: String(video.length),
    media_category: 'tweet_video'
  });
  const mediaId = String(init.media_id_string || init.media_id || '');
  if (!mediaId) throw new PublishError('X video kimliği dönmedi.');
  const chunkSize = 4 * 1024 * 1024;
  const keys = xKeys();
  for (let index = 0, offset = 0; offset < video.length; index++, offset += chunkSize) {
    const chunk = video.subarray(offset, offset + chunkSize);
    const form = new FormData();
    form.append('command', 'APPEND');
    form.append('media_id', mediaId);
    form.append('segment_index', String(index));
    form.append('media', new Blob([chunk], { type: 'application/octet-stream' }), 'chunk.mp4');
    const res = await fetch(uploadUrl, {
      method: 'POST',
      headers: { Authorization: oauthHeader({ method: 'POST', url: uploadUrl, params: {}, ...keys }) },
      body: form,
      signal: AbortSignal.timeout(180000)
    });
    const parsed = await readResponse(res);
    if (!res.ok) throw httpError('X parça yüklenemedi', parsed);
  }
  await xForm(uploadUrl, { command: 'FINALIZE', media_id: mediaId });
  for (let i = 0; i < 20; i++) {
    const statusUrl = uploadUrl;
    const params = { command: 'STATUS', media_id: mediaId };
    const query = `?command=STATUS&media_id=${encodeURIComponent(mediaId)}`;
    const res = await fetch(statusUrl + query, {
      headers: { Authorization: oauthHeader({ method: 'GET', url: statusUrl, params, ...keys }) },
      signal: AbortSignal.timeout(30000)
    });
    const parsed = await readResponse(res);
    if (!res.ok) throw httpError('X işleme bakılamadı', parsed);
    const info = parsed.json && parsed.json.processing_info;
    if (!info || info.state === 'succeeded') break;
    if (info.state === 'failed') {
      throw new PublishError(`X videoyu işlemedi: ${scrub(JSON.stringify(info.error || info))}`);
    }
    await sleep(Math.min(15000, Math.max(1000, Number(info.check_after_secs || 2) * 1000)));
  }
  const chars = Array.from(String(item.caption || ''));
  const text = chars.slice(0, 250).join('').trim();
  const tweetUrl = 'https://api.twitter.com/2/tweets';
  const tweetRes = await fetch(tweetUrl, {
    method: 'POST',
    headers: {
      Authorization: oauthHeader({ method: 'POST', url: tweetUrl, params: {}, ...keys }),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ text, media: { media_ids: [mediaId] } }),
    signal: AbortSignal.timeout(30000)
  });
  const tweet = await readResponse(tweetRes);
  if (!tweetRes.ok || !tweet.json || !tweet.json.data || !tweet.json.data.id) {
    throw new PublishError(`X gönderilemedi: ${tweet.text || tweetRes.status}`, { status: tweetRes.status, uncertain: true });
  }
  return { id: tweet.json.data.id };
}

const ADAPTERS = {
  instagram: postInstagram,
  facebook: postFacebook,
  x: postX
};

function nextItem(state) {
  return (state.items || []).find((item) => item && (item.status === 'queued' || item.status === 'partial'));
}

function rollup(item) {
  const statuses = PLATFORMS.map((name) => item.platforms[name] && item.platforms[name].status);
  if (statuses.every((status) => status === 'posted')) item.status = 'posted';
  else if (statuses.some((status) => status === 'posted')) item.status = 'partial';
  else item.status = 'queued';
}

async function runPublishSlot(options = {}) {
  const state = options.state || loadState();
  const today = (options.today || trtParts().date);
  const item = nextItem(state);
  if (!item) return { ok: true, empty: true };
  if (!fs.existsSync(item.videoPath)) {
    item.status = 'failed';
    item.error = 'Video dosyası yerinde değil.';
    saveState(state);
    logEvent({ event: 'missing-file', itemId: item.id, message: item.error });
    return { ok: false, error: item.error };
  }
  const adapters = options.adapters || ADAPTERS;
  const wait = options.sleepFn || sleep;
  const pause = Number.isFinite(options.gapMs) ? options.gapMs : gapMs();
  let needGap = false;
  state.postedDays = state.postedDays || {};
  for (const name of PLATFORMS) {
    const entry = item.platforms[name] || { status: 'pending' };
    item.platforms[name] = entry;
    if (name !== 'facebook') {
      logEvent({ event: 'skipped', platform: name, itemId: item.id, message: 'Şimdilik yalnızca Facebook Sayfa Reels açık.' });
      continue;
    }
    if (entry.status === 'posted') continue;
    if (state.postedDays[name] === today) {
      logEvent({ event: 'day-limit', platform: name, itemId: item.id, message: 'Bu hesap bugün zaten paylaştı.' });
      continue;
    }
    if (needGap && pause > 0) await wait(pause);
    try {
      const result = await attempt(() => adapters[name](item), {
        retryDelays: options.retryDelays,
        sleepFn: wait
      });
      entry.status = 'posted';
      entry.id = result && result.id ? result.id : '';
      entry.postedAt = new Date().toISOString();
      entry.lastError = '';
      state.postedDays[name] = today;
      needGap = true;
      logEvent({ event: 'posted', platform: name, itemId: item.id, message: entry.id || 'ok' });
    } catch (err) {
      if (err && err.skip) {
        entry.status = 'pending';
        entry.lastError = err.message;
        logEvent({ event: 'skipped', platform: name, itemId: item.id, message: err.message });
      } else {
        entry.status = 'failed';
        entry.lastError = scrub(err && err.message ? err.message : String(err));
        needGap = true;
        logEvent({ event: 'failed', platform: name, itemId: item.id, message: entry.lastError });
      }
    }
    rollup(item);
    saveState(state);
  }
  rollup(item);
  saveState(state);
  return { ok: item.status === 'posted', itemId: item.id, status: item.status };
}

function enqueue(item) {
  const state = loadState();
  const videoPath = path.resolve(item.videoPath);
  const existing = (state.items || []).find((row) => row.videoPath === videoPath && row.status !== 'posted');
  if (existing) return existing;
  const row = {
    id: crypto.randomBytes(6).toString('hex'),
    videoPath,
    caption: String(item.caption || '').replace(/\s+/g, ' ').trim(),
    hookText: String(item.hookText || '').replace(/\s+/g, ' ').trim(),
    createdAt: new Date().toISOString(),
    status: 'queued',
    platforms: {
      instagram: { status: 'pending' },
      facebook: { status: 'pending' },
      x: { status: 'pending' }
    }
  };
  state.items.push(row);
  saveState(state);
  logEvent({ event: 'queued', itemId: row.id, message: path.basename(videoPath) });
  return row;
}

async function replaceWithHooked(videoPath, tmpOut) {
  const backup = `${videoPath}.bak`;
  await fs.promises.rename(videoPath, backup);
  try {
    await fs.promises.rename(tmpOut, videoPath);
  } catch (err) {
    await fs.promises.rename(backup, videoPath).catch(() => {});
    throw err;
  }
  await fs.promises.unlink(backup).catch(() => {});
}

/**
 * Crush çıktısının üstüne kanca sesini koyar ve 21:30 kuyruğuna yazar.
 * ElevenLabs anahtarı yoksa crush dosyasına dokunmaz.
 */
async function finishHookedPublish({ videoPath, hookText, caption }) {
  if (String(process.env.PUBLISH_QUEUE || '1') === '0') {
    return { ok: false, skipped: true, reason: 'Yayın kuyruğu kapalı.' };
  }
  const spoken = spokenHookText(hookText);
  if (!spoken) return { ok: false, skipped: true, reason: 'Kanca metni yok.' };
  const abs = path.resolve(videoPath);
  if (!fs.existsSync(abs)) throw new PublishError('Kuyruğa alınacak video yok.');
  const prior = loadState();
  prior.hooked = prior.hooked || {};
  if (prior.hooked[abs]) {
    const row = enqueue({ videoPath: abs, hookText: spoken, caption });
    return { ok: true, alreadyHooked: true, queued: row.id, videoPath: abs };
  }
  if (!String(process.env.ELEVENLABS_API_KEY || process.env.XI_API_KEY || '').trim()) {
    return { ok: false, skipped: true, reason: 'ELEVENLABS_API_KEY yok. Video kuyruğa alınmadı.' };
  }
  const tmpOut = `${abs}.hook-mix.mp4`;
  try {
    const hookMp3Path = await synthesizeHook({ text: spoken });
    await composeHookVideo({
      videoPath: abs,
      hookMp3Path,
      outputPath: tmpOut,
      hookText: spoken,
      captionText: caption
    });
    await replaceWithHooked(abs, tmpOut);
  } catch (err) {
    await fs.promises.unlink(tmpOut).catch(() => {});
    throw err;
  }
  const fresh = loadState();
  fresh.hooked = fresh.hooked || {};
  fresh.hooked[abs] = new Date().toISOString();
  saveState(fresh);
  const row = enqueue({ videoPath: abs, hookText: spoken, caption });
  return { ok: true, queued: row.id, videoPath: abs };
}

let timer = null;

function startScheduler(options = {}) {
  if (timer) return;
  const brandPublish = require('./brand-publish');
  const downloadDir = options.downloadDir;
  const run = () => {
    brandPublish.tick({
      downloadDir,
      gapMs: gapMs(),
      postFacebook: (item) => postFacebook(item),
      postInstagram: (item) => postInstagram(item),
      postYouTube: (item) => postYouTube(item)
    }).catch((err) => logEvent({ event: 'tick-error', platform: 'publish', message: err && err.message ? err.message : String(err) }));
  };
  timer = setInterval(run, 15000);
  if (timer.unref) timer.unref();
  run();
  logEvent({ event: 'scheduler', platform: 'publish', message: 'Facebook, Instagram ve YouTube. Saatler 22:00, 22:30, 23:00.' });
}

function snapshot() {
  const state = loadState();
  const parts = trtParts();
  let facebook = null;
  let brands = null;
  try { facebook = require('./facebook-reels').snapshot({ downloadDir: process.env.VA_DOWNLOAD_DIR }); } catch {}
  try { brands = require('./brand-publish').snapshot({ downloadDir: process.env.VA_DOWNLOAD_DIR }); } catch {}
  return {
    timezone: 'Europe/Istanbul',
    slot: '22:00, 22:30, 23:00',
    today: parts.date,
    clock: `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`,
    slotUsedToday: state.slotDate === parts.date,
    gapMs: gapMs(),
    accounts: {
      instagram: configured('instagram'),
      facebook: configured('facebook'),
      youtube: configured('youtube'),
      x: false
    },
    facebook,
    brands,
    items: (state.items || []).map((item) => ({
      id: item.id,
      file: path.basename(item.videoPath || ''),
      status: item.status,
      createdAt: item.createdAt,
      platforms: item.platforms
    }))
  };
}

module.exports = {
  finishHookedPublish,
  enqueue,
  startScheduler,
  runPublishSlot,
  snapshot,
  trtParts,
  shouldStartSlot,
  configured,
  PublishError,
  postFacebook,
  postInstagram,
  postYouTube,
  youtubeCopy
};
