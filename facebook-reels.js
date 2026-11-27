/**
 * Facebook Sayfa Reels.
 * Her marka klasöründen günde bir mp4, kendi saatinde.
 * Açıklama dosya adıdır. Başarıda dosya paylasildi klasörüne taşınır.
 * Instagram ve X bu modülden çağrılmaz. Anahtarlar yalnız ortam değişkeninden okunur.
 */
const fs = require('fs');
const path = require('path');

const PUBLISHED = 'paylasildi';
const MIN_GAP = 30;
const FRESH_MS = 2 * 60 * 1000;
const DEFAULT_SLOTS = ['22:00', '22:30', '23:00'];
const DEFAULT_FOLDERS = ['Epoch Lab', 'Chaos Lab', 'Therapy Lab'];

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

function defaultDownloadDir() {
  return process.env.VA_DOWNLOAD_DIR
    || path.join(process.env.USERPROFILE || process.cwd(), 'Videos', 'Viral Atölyesi İndirilenler');
}

function statePath(options) {
  return (options && options.stateFile)
    || process.env.FACEBOOK_REELS_STATE
    || path.join(__dirname, 'output', 'publish', 'facebook-reels.json');
}

function logPath() {
  return process.env.PUBLISH_LOG_PATH
    || path.join(__dirname, 'output', 'publish', 'log.jsonl');
}

function scrub(text) {
  return String(text || '')
    .replace(/access_token=[^&\s"']+/gi, 'access_token=***')
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/=]+/gi, 'Bearer ***')
    .slice(0, 500);
}

function writeLog(entry) {
  const row = Object.assign({ at: new Date().toISOString(), platform: 'facebook' }, entry);
  if (row.message) row.message = scrub(row.message);
  try {
    fs.mkdirSync(path.dirname(logPath()), { recursive: true });
    fs.appendFileSync(logPath(), `${JSON.stringify(row)}\n`);
  } catch {}
  const label = [row.event, row.message].filter(Boolean).join(' ');
  if (label) console.log('[facebook]', label);
}

function enabled() {
  if (String(process.env.FACEBOOK_REELS == null ? '1' : process.env.FACEBOOK_REELS) === '0') return false;
  if (String(process.env.PUBLISH_QUEUE == null ? '1' : process.env.PUBLISH_QUEUE) === '0') return false;
  return true;
}

function parseClock(value) {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return {
    hour,
    minute,
    label: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    abs: hour * 60 + minute
  };
}

function parseSlots(raw) {
  const warnings = [];
  const pieces = String(raw || DEFAULT_SLOTS.join(',')).split(/[,;]+/).map((part) => part.trim()).filter(Boolean);
  const clocks = [];
  pieces.forEach((piece) => {
    const slot = parseClock(piece);
    if (!slot) warnings.push(`Saat okunamadı: ${piece}`);
    else clocks.push(slot);
  });
  clocks.sort((a, b) => a.abs - b.abs);
  const slots = [];
  clocks.forEach((slot) => {
    const prev = slots[slots.length - 1];
    if (prev && slot.abs - prev.abs < MIN_GAP) {
      warnings.push(`${slot.label} atlandı. ${prev.label} ile arası 30 dakikadan kısa.`);
      return;
    }
    slots.push(slot);
  });
  return { slots, warnings };
}

function folderKey(folder) {
  const base = path.basename(folder);
  if (/epoch/i.test(base)) return 'EPOCH';
  if (/chaos/i.test(base)) return 'CHAOS';
  if (/therapy|terapi/i.test(base)) return 'THERAPY';
  const key = base.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
  return key.slice(0, 24) || 'PAGE';
}

function sourceFolders() {
  const raw = String(process.env.FACEBOOK_SOURCE_DIRS || '').trim();
  if (!raw) return DEFAULT_FOLDERS.slice();
  return raw.split(/[|;]/).map((part) => part.trim()).filter(Boolean);
}

function readCredential(name) {
  return String(process.env[name] || '').trim();
}

function credentialsFor(key) {
  const ownId = readCredential(`FACEBOOK_${key}_PAGE_ID`);
  const ownToken = readCredential(`FACEBOOK_${key}_PAGE_TOKEN`);
  if (ownId && ownToken) return { pageId: ownId, token: ownToken, via: 'brand' };
  if (ownId || ownToken) return { pageId: '', token: '', via: 'incomplete' };
  const pageId = readCredential('FACEBOOK_PAGE_ID');
  const token = readCredential('FACEBOOK_PAGE_TOKEN');
  if (pageId && token) return { pageId, token, via: 'fallback' };
  return { pageId: '', token: '', via: 'missing' };
}

function pages(downloadDir) {
  const root = downloadDir || defaultDownloadDir();
  const parsed = parseSlots(process.env.FACEBOOK_POST_SLOTS);
  const warnings = parsed.warnings.slice();
  const list = [];
  sourceFolders().forEach((folder, index) => {
    const slot = parsed.slots[index];
    if (!slot) {
      warnings.push(`${folder} için saat kalmadı.`);
      return;
    }
    const dir = path.isAbsolute(folder) ? folder : path.join(root, folder);
    const key = folderKey(dir);
    const creds = credentialsFor(key);
    list.push({
      key,
      folder: path.basename(dir),
      dir,
      slot,
      pageId: creds.pageId,
      token: creds.token,
      via: creds.via,
      ready: Boolean(creds.pageId && creds.token)
    });
  });
  return { pages: list, warnings };
}

function captionFromFile(file) {
  return path.basename(file, path.extname(file)).replace(/\s+/g, ' ').trim();
}

function nextMp4(dir, nowMs) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return null; }
  const freshBefore = Number(nowMs || Date.now()) - FRESH_MS;
  const files = names
    .filter((name) => name.toLowerCase().endsWith('.mp4') && !name.startsWith('.'))
    .filter((name) => !/\.hook-mix\.mp4$/i.test(name))
    .map((name) => path.join(dir, name))
    .filter((file) => {
      try {
        const stat = fs.statSync(file);
        return stat.isFile() && stat.size > 0 && stat.mtimeMs <= freshBefore;
      } catch {
        return false;
      }
    })
    .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs || a.localeCompare(b));
  return files[0] || null;
}

function moveToPublished(file) {
  const destDir = path.join(path.dirname(file), PUBLISHED);
  fs.mkdirSync(destDir, { recursive: true });
  const ext = path.extname(file);
  const stem = path.basename(file, ext);
  let dest = path.join(destDir, path.basename(file));
  if (fs.existsSync(dest)) dest = path.join(destDir, `${stem}_${Date.now()}${ext}`);
  fs.renameSync(file, dest);
  return dest;
}

function loadState(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      posted: data.posted || {},
      fired: data.fired || {},
      sent: data.sent || {}
    };
  } catch {
    return { posted: {}, fired: {}, sent: {} };
  }
}

function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
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
    const parts = options.parts || trtParts(now);
    const built = pages(options.downloadDir);
    if (!warned || options.repeatWarnings) {
      built.warnings.forEach((message) => emit({ event: 'config', message }));
      warned = true;
    }
    const file = statePath(options);
    const state = loadState(file);
    for (const page of built.pages) {
      if (parts.hour !== page.slot.hour || parts.minute !== page.slot.minute) continue;
      const fireKey = `${page.key}|${parts.date}|${page.slot.label}`;
      if (state.fired[fireKey]) continue;
      state.fired[fireKey] = new Date().toISOString();
      saveState(file, state);
      if (!page.ready) {
        emit({
          event: 'skipped',
          message: page.via === 'incomplete'
            ? `${page.folder} ${page.slot.label} atlandı. FACEBOOK_${page.key}_PAGE_ID ve FACEBOOK_${page.key}_PAGE_TOKEN birlikte dolu olmalı.`
            : `${page.folder} ${page.slot.label} atlandı. FACEBOOK_${page.key}_PAGE_ID / FACEBOOK_${page.key}_PAGE_TOKEN boş. Ortak FACEBOOK_PAGE_ID / FACEBOOK_PAGE_TOKEN de boş.`
        });
        continue;
      }
      if (state.posted[page.pageId] === parts.date) {
        emit({ event: 'day-limit', message: `${page.folder} sayfası bugün zaten paylaştı.` });
        continue;
      }
      const video = nextMp4(page.dir, now.getTime());
      if (!video) {
        emit({ event: 'empty', message: `${page.folder} klasöründe hazır mp4 yok.` });
        continue;
      }
      if (state.sent[video]) {
        try {
          emit({ event: 'moved', message: moveToPublished(video) });
        } catch (err) {
          emit({ event: 'move-failed', message: err && err.message ? err.message : String(err) });
        }
        continue;
      }
      const caption = captionFromFile(video);
      try {
        const result = await options.post({
          videoPath: video,
          caption,
          pageId: page.pageId,
          token: page.token
        });
        state.sent[video] = { id: result && result.id ? String(result.id) : '', at: new Date().toISOString() };
        state.posted[page.pageId] = parts.date;
        saveState(file, state);
        try {
          const dest = moveToPublished(video);
          emit({ event: 'posted', message: `${page.folder} ${path.basename(dest)} ${page.via === 'brand' ? 'kendi sayfası' : 'ortak sayfa'}` });
        } catch (err) {
          emit({ event: 'move-failed', message: `${path.basename(video)} paylaşıldı ama taşınamadı. ${err && err.message ? err.message : err}` });
        }
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        emit({ event: err && err.skip ? 'skipped' : 'failed', message: `${path.basename(video)} ${message}` });
      }
    }
    return { ok: true, logs };
  } finally {
    ticking = false;
  }
}

function snapshot(options = {}) {
  const built = pages(options.downloadDir);
  return {
    enabled: enabled(),
    warnings: built.warnings,
    pages: built.pages.map((page) => ({
      folder: page.folder,
      slot: page.slot.label,
      ready: page.ready
    }))
  };
}

module.exports = {
  tick,
  snapshot,
  captionFromFile,
  nextMp4,
  moveToPublished,
  parseSlots,
  pages,
  trtParts,
  folderKey
};
