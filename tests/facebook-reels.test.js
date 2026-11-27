const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const reels = require('../facebook-reels');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fb-reels-'));
}

function writeMp4(dir, name, ageMs) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, 'video');
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(file, when, when);
  return file;
}

function slotParts(label, date) {
  const [hour, minute] = label.split(':').map(Number);
  return { date, hour, minute };
}

test('caption is the file name without the extension', () => {
  const name = 'A tragic date ended in Ireland 😱 #dogs #news #ireland #crime #story.mp4';
  assert.equal(reels.captionFromFile(name), 'A tragic date ended in Ireland 😱 #dogs #news #ireland #crime #story');
});

test('the next mp4 is the oldest file outside paylasildi', () => {
  const dir = tempDir();
  writeMp4(dir, 'newer.mp4', 5 * 60 * 1000);
  const older = writeMp4(dir, 'older story.mp4', 10 * 60 * 1000);
  writeMp4(path.join(dir, 'paylasildi'), 'already.mp4', 30 * 60 * 1000);
  writeMp4(dir, 'still-writing.mp4', 10 * 1000);
  assert.equal(reels.nextMp4(dir, Date.now()), older);
});

test('a posted file moves into paylasildi and a name clash gets a suffix', () => {
  const dir = tempDir();
  const file = writeMp4(dir, 'same.mp4', 5 * 60 * 1000);
  fs.mkdirSync(path.join(dir, 'paylasildi'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'paylasildi', 'same.mp4'), 'old');
  const dest = reels.moveToPublished(file);
  assert.equal(fs.existsSync(file), false);
  assert.match(path.basename(dest), /^same_\d+\.mp4$/);
  assert.equal(path.basename(path.dirname(dest)), 'paylasildi');
});

test('slots closer than 30 minutes are dropped', () => {
  const parsed = reels.parseSlots('22:00, 22:10, 23:00');
  assert.deepEqual(parsed.slots.map((slot) => slot.label), ['22:00', '23:00']);
  assert.match(parsed.warnings.join(' '), /22:10/);
});

test('a missing token skips the slot and leaves the file', async () => {
  const root = tempDir();
  const epoch = path.join(root, 'Epoch Lab');
  const file = writeMp4(epoch, 'hello world.mp4', 5 * 60 * 1000);
  const previous = {
    dirs: process.env.FACEBOOK_SOURCE_DIRS,
    slots: process.env.FACEBOOK_POST_SLOTS,
    id: process.env.FACEBOOK_PAGE_ID,
    token: process.env.FACEBOOK_PAGE_TOKEN
  };
  process.env.FACEBOOK_SOURCE_DIRS = epoch;
  process.env.FACEBOOK_POST_SLOTS = '22:00';
  process.env.FACEBOOK_PAGE_ID = '';
  process.env.FACEBOOK_PAGE_TOKEN = '';
  let posted = 0;
  const result = await reels.tick({
    force: true,
    silent: true,
    downloadDir: root,
    stateFile: path.join(root, 'state.json'),
    parts: slotParts('22:00', '2026-11-27'),
    now: new Date('2026-11-27T19:00:00Z'),
    post: async () => { posted += 1; return { id: 'x' }; }
  });
  Object.assign(process.env, {
    FACEBOOK_SOURCE_DIRS: previous.dirs,
    FACEBOOK_POST_SLOTS: previous.slots,
    FACEBOOK_PAGE_ID: previous.id,
    FACEBOOK_PAGE_TOKEN: previous.token
  });
  assert.equal(posted, 0);
  assert.equal(fs.existsSync(file), true);
  assert.equal(result.logs.some((row) => row.event === 'skipped'), true);
});

test('a failed post stays in place and the next page still runs', async () => {
  const root = tempDir();
  const epoch = path.join(root, 'Epoch Lab');
  const chaos = path.join(root, 'Chaos Lab');
  const failed = writeMp4(epoch, 'fail story.mp4', 5 * 60 * 1000);
  const ok = writeMp4(chaos, 'ok story.mp4', 5 * 60 * 1000);
  process.env.FACEBOOK_SOURCE_DIRS = `${epoch}|${chaos}`;
  process.env.FACEBOOK_POST_SLOTS = '22:00,22:30';
  process.env.FACEBOOK_EPOCH_PAGE_ID = '111';
  process.env.FACEBOOK_EPOCH_PAGE_TOKEN = 'epoch-token';
  process.env.FACEBOOK_CHAOS_PAGE_ID = '222';
  process.env.FACEBOOK_CHAOS_PAGE_TOKEN = 'chaos-token';
  const seen = [];
  await reels.tick({
    force: true,
    silent: true,
    downloadDir: root,
    stateFile: path.join(root, 'state.json'),
    parts: slotParts('22:00', '2026-11-27'),
    now: new Date('2026-11-27T19:00:00Z'),
    post: async (item) => {
      seen.push(item.caption);
      if (item.pageId === '111') throw new Error('graph down');
      return { id: 'nope' };
    }
  });
  await reels.tick({
    force: true,
    silent: true,
    downloadDir: root,
    stateFile: path.join(root, 'state.json'),
    parts: slotParts('22:30', '2026-11-27'),
    now: new Date('2026-11-27T19:30:00Z'),
    post: async (item) => {
      seen.push(item.caption);
      return { id: 'ok-1' };
    }
  });
  assert.equal(fs.existsSync(failed), true);
  assert.equal(fs.existsSync(path.join(chaos, 'paylasildi', 'ok story.mp4')), true);
  assert.deepEqual(seen, ['fail story', 'ok story']);
  delete process.env.FACEBOOK_EPOCH_PAGE_ID;
  delete process.env.FACEBOOK_EPOCH_PAGE_TOKEN;
  delete process.env.FACEBOOK_CHAOS_PAGE_ID;
  delete process.env.FACEBOOK_CHAOS_PAGE_TOKEN;
  delete process.env.FACEBOOK_SOURCE_DIRS;
  delete process.env.FACEBOOK_POST_SLOTS;
});

test('a brand access token is used when the page token name is empty', () => {
  const root = tempDir();
  process.env.FACEBOOK_SOURCE_DIRS = 'Epoch Lab';
  process.env.FACEBOOK_POST_SLOTS = '22:00';
  delete process.env.FACEBOOK_EPOCH_PAGE_TOKEN;
  delete process.env.FACEBOOK_PAGE_ID;
  delete process.env.FACEBOOK_PAGE_TOKEN;
  process.env.FACEBOOK_EPOCH_PAGE_ID = 'epoch-id';
  process.env.FACEBOOK_EPOCH_ACCESS_TOKEN = 'epoch-access';
  const built = reels.pages(root);
  assert.equal(built.pages[0].ready, true);
  assert.equal(built.pages[0].pageId, 'epoch-id');
  assert.equal(built.pages[0].via, 'brand');
  delete process.env.FACEBOOK_EPOCH_PAGE_ID;
  delete process.env.FACEBOOK_EPOCH_ACCESS_TOKEN;
  delete process.env.FACEBOOK_SOURCE_DIRS;
  delete process.env.FACEBOOK_POST_SLOTS;
});

test('each brand uses its own page and a half-filled brand is skipped', async () => {
  const root = tempDir();
  const epoch = path.join(root, 'Epoch Lab');
  const chaos = path.join(root, 'Chaos Lab');
  const therapy = path.join(root, 'Therapy Lab');
  writeMp4(epoch, 'epoch story.mp4', 5 * 60 * 1000);
  const chaosFile = writeMp4(chaos, 'chaos story.mp4', 5 * 60 * 1000);
  writeMp4(therapy, 'therapy story.mp4', 5 * 60 * 1000);
  process.env.FACEBOOK_SOURCE_DIRS = `${epoch}|${chaos}|${therapy}`;
  process.env.FACEBOOK_POST_SLOTS = '22:00,22:30,23:00';
  process.env.FACEBOOK_PAGE_ID = 'shared';
  process.env.FACEBOOK_PAGE_TOKEN = 'shared-token';
  process.env.FACEBOOK_EPOCH_PAGE_ID = 'epoch-id';
  process.env.FACEBOOK_EPOCH_PAGE_TOKEN = 'epoch-token';
  process.env.FACEBOOK_CHAOS_PAGE_ID = 'chaos-id';
  delete process.env.FACEBOOK_CHAOS_PAGE_TOKEN;
  process.env.FACEBOOK_THERAPY_PAGE_ID = 'therapy-id';
  process.env.FACEBOOK_THERAPY_PAGE_TOKEN = 'therapy-token';
  const seen = [];
  const stateFile = path.join(root, 'state.json');
  const base = { force: true, silent: true, downloadDir: root, stateFile, now: new Date('2026-11-27T19:00:00Z') };
  await reels.tick({ ...base, parts: slotParts('22:00', '2026-11-27'), post: async (item) => { seen.push(item.pageId); return { id: 'e' }; } });
  const skipped = await reels.tick({ ...base, parts: slotParts('22:30', '2026-11-27'), post: async (item) => { seen.push(item.pageId); return { id: 'c' }; } });
  await reels.tick({ ...base, parts: slotParts('23:00', '2026-11-27'), post: async (item) => { seen.push(item.pageId); return { id: 't' }; } });
  assert.deepEqual(seen, ['epoch-id', 'therapy-id']);
  assert.equal(fs.existsSync(chaosFile), true);
  assert.equal(fs.existsSync(path.join(epoch, 'paylasildi', 'epoch story.mp4')), true);
  assert.equal(fs.existsSync(path.join(therapy, 'paylasildi', 'therapy story.mp4')), true);
  assert.equal(skipped.logs.some((row) => row.event === 'skipped'), true);
  ['FACEBOOK_PAGE_ID', 'FACEBOOK_PAGE_TOKEN', 'FACEBOOK_SOURCE_DIRS', 'FACEBOOK_POST_SLOTS', 'FACEBOOK_EPOCH_PAGE_ID', 'FACEBOOK_EPOCH_PAGE_TOKEN', 'FACEBOOK_CHAOS_PAGE_ID', 'FACEBOOK_THERAPY_PAGE_ID', 'FACEBOOK_THERAPY_PAGE_TOKEN'].forEach((name) => delete process.env[name]);
});

test('one page id posts only one video in a day', async () => {
  const root = tempDir();
  const epoch = path.join(root, 'Epoch Lab');
  const chaos = path.join(root, 'Chaos Lab');
  writeMp4(epoch, 'first.mp4', 5 * 60 * 1000);
  const second = writeMp4(chaos, 'second.mp4', 5 * 60 * 1000);
  process.env.FACEBOOK_SOURCE_DIRS = `${epoch}|${chaos}`;
  process.env.FACEBOOK_POST_SLOTS = '22:00,22:30';
  process.env.FACEBOOK_PAGE_ID = 'same';
  process.env.FACEBOOK_PAGE_TOKEN = 'same-token';
  let calls = 0;
  const stateFile = path.join(root, 'state.json');
  await reels.tick({
    force: true,
    silent: true,
    downloadDir: root,
    stateFile,
    parts: slotParts('22:00', '2026-11-27'),
    now: new Date('2026-11-27T19:00:00Z'),
    post: async () => { calls += 1; return { id: '1' }; }
  });
  const later = await reels.tick({
    force: true,
    silent: true,
    downloadDir: root,
    stateFile,
    parts: slotParts('22:30', '2026-11-27'),
    now: new Date('2026-11-27T19:30:00Z'),
    post: async () => { calls += 1; return { id: '2' }; }
  });
  assert.equal(calls, 1);
  assert.equal(fs.existsSync(second), true);
  assert.equal(later.logs.some((row) => row.event === 'day-limit'), true);
  delete process.env.FACEBOOK_PAGE_ID;
  delete process.env.FACEBOOK_PAGE_TOKEN;
  delete process.env.FACEBOOK_SOURCE_DIRS;
  delete process.env.FACEBOOK_POST_SLOTS;
});
