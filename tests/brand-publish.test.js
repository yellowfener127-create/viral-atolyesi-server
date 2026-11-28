const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const publish = require('../brand-publish');

const TOUCHED = [
  'FACEBOOK_SOURCE_DIRS',
  'FACEBOOK_POST_SLOTS',
  'FACEBOOK_PAGE_ID',
  'FACEBOOK_PAGE_TOKEN',
  'FACEBOOK_EPOCH_PAGE_ID',
  'FACEBOOK_EPOCH_PAGE_TOKEN',
  'FACEBOOK_EPOCH_ACCESS_TOKEN',
  'FACEBOOK_CHAOS_PAGE_ID',
  'FACEBOOK_CHAOS_PAGE_TOKEN',
  'FACEBOOK_CHAOS_ACCESS_TOKEN',
  'FACEBOOK_THERAPY_PAGE_ID',
  'FACEBOOK_THERAPY_PAGE_TOKEN',
  'INSTAGRAM_ACCOUNT_ID',
  'INSTAGRAM_ACCESS_TOKEN',
  'META_ACCESS_TOKEN',
  'INSTAGRAM_EPOCH_ACCOUNT_ID',
  'INSTAGRAM_EPOCH_ACCESS_TOKEN',
  'INSTAGRAM_CHAOS_ACCOUNT_ID',
  'INSTAGRAM_CHAOS_ACCESS_TOKEN',
  'YOUTUBE_CLIENT_ID',
  'YOUTUBE_CLIENT_SECRET',
  'YOUTUBE_REFRESH_TOKEN',
  'YOUTUBE_EPOCH_REFRESH_TOKEN',
  'YOUTUBE_CHAOS_REFRESH_TOKEN',
  'YOUTUBE_THERAPY_REFRESH_TOKEN',
  'YOUTUBE_PRIVACY_STATUS'
];

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brand-publish-'));
}

function writeMp4(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, 'video');
  const when = new Date(Date.now() - 5 * 60 * 1000);
  fs.utimesSync(file, when, when);
  return file;
}

function slotParts(label) {
  const [hour, minute] = label.split(':').map(Number);
  return { date: '2026-11-27', hour, minute };
}

function clearEnv() {
  TOUCHED.forEach((name) => delete process.env[name]);
}

function posters(seen) {
  return {
    postFacebook: async (item) => { seen.push(['facebook', item.pageId, item.caption]); return { id: 'fb' }; },
    postInstagram: async (item) => { seen.push(['instagram', item.accountId, item.caption]); return { id: 'ig' }; },
    postYouTube: async (item) => { seen.push(['youtube', item.refreshToken, item.caption]); return { id: 'yt' }; }
  };
}

test('facebook still posts and moves when instagram and youtube are empty', async () => {
  clearEnv();
  const root = tempDir();
  const epoch = path.join(root, 'Epoch Lab');
  const file = writeMp4(epoch, 'epoch story.mp4');
  process.env.FACEBOOK_SOURCE_DIRS = epoch;
  process.env.FACEBOOK_POST_SLOTS = '22:00';
  process.env.FACEBOOK_EPOCH_PAGE_ID = 'epoch-page';
  process.env.FACEBOOK_EPOCH_ACCESS_TOKEN = 'epoch-token';
  const seen = [];
  const result = await publish.tick({
    force: true,
    silent: true,
    downloadDir: root,
    stateFile: path.join(root, 'state.json'),
    parts: slotParts('22:00'),
    now: new Date(),
    gapMs: 0,
    ...posters(seen)
  });
  assert.deepEqual(seen, [['facebook', 'epoch-page', 'epoch story']]);
  assert.equal(fs.existsSync(path.join(epoch, 'paylasildi', 'epoch story.mp4')), true);
  assert.equal(fs.existsSync(path.join(epoch, 'paylasildi', 'epoch story.mp4.state.json')), true);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(file + '.state.json'), false);
  assert.equal(result.logs.some((row) => row.platform === 'instagram' && row.event === 'skipped'), true);
  assert.equal(result.logs.some((row) => row.platform === 'youtube' && row.event === 'skipped'), true);
  clearEnv();
});

test('a failed instagram leaves the file and the youtube post is still attempted', async () => {
  clearEnv();
  const root = tempDir();
  const epoch = path.join(root, 'Epoch Lab');
  const file = writeMp4(epoch, 'stay story.mp4');
  process.env.FACEBOOK_SOURCE_DIRS = epoch;
  process.env.FACEBOOK_POST_SLOTS = '22:00';
  process.env.FACEBOOK_EPOCH_PAGE_ID = 'epoch-page';
  process.env.FACEBOOK_EPOCH_PAGE_TOKEN = 'epoch-token';
  process.env.INSTAGRAM_EPOCH_ACCOUNT_ID = 'epoch-ig';
  process.env.INSTAGRAM_EPOCH_ACCESS_TOKEN = 'epoch-ig-token';
  process.env.YOUTUBE_EPOCH_REFRESH_TOKEN = 'epoch-yt-token';
  const seen = [];
  const options = {
    force: true,
    silent: true,
    downloadDir: root,
    stateFile: path.join(root, 'state.json'),
    parts: slotParts('22:00'),
    now: new Date(),
    gapMs: 0,
    postFacebook: async (item) => { seen.push(['facebook', item.pageId]); return { id: 'fb' }; },
    postInstagram: async () => { seen.push(['instagram']); throw new Error('ig down'); },
    postYouTube: async (item) => { seen.push(['youtube', item.refreshToken]); return { id: 'yt' }; }
  };
  const result = await publish.tick(options);
  assert.deepEqual(seen, [['facebook', 'epoch-page'], ['instagram'], ['youtube', 'epoch-yt-token']]);
  assert.equal(fs.existsSync(file), true);
  const side = JSON.parse(fs.readFileSync(file + '.state.json', 'utf8'));
  assert.equal(side.platforms.facebook.status, 'done');
  assert.equal(side.platforms.youtube.status, 'done');
  assert.equal(side.platforms.instagram.status, 'failed');
  assert.equal(result.logs.some((row) => row.platform === 'instagram' && row.event === 'failed'), true);
  seen.length = 0;
  await publish.tick(options);
  assert.deepEqual(seen, [['instagram']]);
  assert.equal(fs.existsSync(file), true);
  clearEnv();
});

test('a half-filled brand does not borrow the shared token', () => {
  clearEnv();
  const root = tempDir();
  process.env.FACEBOOK_SOURCE_DIRS = path.join(root, 'Epoch Lab');
  process.env.FACEBOOK_POST_SLOTS = '22:00';
  process.env.INSTAGRAM_ACCOUNT_ID = 'shared-ig';
  process.env.INSTAGRAM_ACCESS_TOKEN = 'shared-ig-token';
  process.env.INSTAGRAM_EPOCH_ACCOUNT_ID = 'epoch-ig';
  process.env.YOUTUBE_REFRESH_TOKEN = 'shared-refresh';
  process.env.YOUTUBE_EPOCH_REFRESH_TOKEN = 'epoch-refresh';
  const built = publish.brandPages(root);
  assert.equal(built.pages[0].instagram.ready, false);
  assert.equal(built.pages[0].instagram.via, 'incomplete');
  assert.equal(built.pages[0].youtube.ready, true);
  assert.equal(built.pages[0].youtube.via, 'brand');
  assert.equal(built.pages[0].youtube.refreshToken, 'epoch-refresh');
  delete process.env.YOUTUBE_EPOCH_REFRESH_TOKEN;
  const shared = publish.brandPages(root);
  assert.equal(shared.pages[0].youtube.via, 'fallback');
  assert.equal(shared.pages[0].youtube.refreshToken, 'shared-refresh');
  clearEnv();
});

test('ready platforms share one caption and the file moves once', async () => {
  clearEnv();
  const root = tempDir();
  const chaos = path.join(root, 'Chaos Lab');
  const file = writeMp4(chaos, 'chaos story #shorts.mp4');
  process.env.FACEBOOK_SOURCE_DIRS = chaos;
  process.env.FACEBOOK_POST_SLOTS = '22:30';
  process.env.FACEBOOK_CHAOS_PAGE_ID = 'chaos-page';
  process.env.FACEBOOK_CHAOS_PAGE_TOKEN = 'chaos-token';
  process.env.INSTAGRAM_CHAOS_ACCOUNT_ID = 'chaos-ig';
  process.env.INSTAGRAM_CHAOS_ACCESS_TOKEN = 'chaos-ig-token';
  process.env.YOUTUBE_CHAOS_REFRESH_TOKEN = 'chaos-yt-token';
  const seen = [];
  await publish.tick({
    force: true,
    silent: true,
    downloadDir: root,
    stateFile: path.join(root, 'state.json'),
    parts: slotParts('22:30'),
    now: new Date(),
    gapMs: 0,
    ...posters(seen)
  });
  assert.deepEqual(seen, [
    ['facebook', 'chaos-page', 'chaos story #shorts'],
    ['instagram', 'chaos-ig', 'chaos story #shorts'],
    ['youtube', 'chaos-yt-token', 'chaos story #shorts']
  ]);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(path.join(chaos, 'paylasildi', 'chaos story #shorts.mp4')), true);
  clearEnv();
});

test('one shared account posts only one video that day', async () => {
  clearEnv();
  const root = tempDir();
  const epoch = path.join(root, 'Epoch Lab');
  const chaos = path.join(root, 'Chaos Lab');
  writeMp4(epoch, 'first.mp4');
  const second = writeMp4(chaos, 'second.mp4');
  process.env.FACEBOOK_SOURCE_DIRS = `${epoch}|${chaos}`;
  process.env.FACEBOOK_POST_SLOTS = '22:00,22:30';
  process.env.YOUTUBE_REFRESH_TOKEN = 'same-token';
  const stateFile = path.join(root, 'state.json');
  const seen = [];
  const base = {
    force: true,
    silent: true,
    downloadDir: root,
    stateFile,
    now: new Date(),
    gapMs: 0,
    postFacebook: async () => { throw new Error('facebook should be skipped'); },
    postInstagram: async () => { throw new Error('instagram should be skipped'); },
    postYouTube: async (item) => { seen.push(item.refreshToken); return { id: 'yt' }; }
  };
  await publish.tick({ ...base, parts: slotParts('22:00') });
  const later = await publish.tick({ ...base, parts: slotParts('22:30') });
  assert.deepEqual(seen, ['same-token']);
  assert.equal(fs.existsSync(second), true);
  assert.equal(later.logs.some((row) => row.platform === 'youtube' && row.event === 'day-limit'), true);
  clearEnv();
});

test('youtube short text comes from the file name', () => {
  const queue = require('../publish-queue');
  delete process.env.YOUTUBE_PRIVACY_STATUS;
  const plain = queue.youtubeCopy('A quiet street in Canada');
  assert.equal(plain.title, 'A quiet street in Canada');
  assert.equal(plain.description, 'A quiet street in Canada #Shorts');
  assert.equal(plain.privacyStatus, 'public');
  const tagged = queue.youtubeCopy('Street story #Shorts');
  assert.equal(tagged.description, 'Street story #Shorts');
  process.env.YOUTUBE_PRIVACY_STATUS = 'unlisted';
  assert.equal(queue.youtubeCopy('Street story').privacyStatus, 'unlisted');
  delete process.env.YOUTUBE_PRIVACY_STATUS;
});

test('an empty old youtube token does not override the brand refresh token', () => {
  clearEnv();
  const root = tempDir();
  process.env.FACEBOOK_SOURCE_DIRS = path.join(root, 'Epoch Lab');
  process.env.FACEBOOK_POST_SLOTS = '22:00';
  process.env.YOUTUBE_EPOCH_ACCOUNT_ID = '';
  process.env.YOUTUBE_EPOCH_ACCESS_TOKEN = '';
  process.env.YOUTUBE_CLIENT_ID = 'client';
  process.env.YOUTUBE_CLIENT_SECRET = 'secret';
  process.env.YOUTUBE_EPOCH_REFRESH_TOKEN = 'epoch-refresh';
  process.env.YOUTUBE_REFRESH_TOKEN = '';
  const built = publish.brandPages(root);
  assert.equal(built.pages[0].youtube.ready, true);
  assert.equal(built.pages[0].youtube.via, 'brand');
  assert.equal(built.pages[0].youtube.refreshToken, 'epoch-refresh');
  assert.equal(built.pages[0].youtube.clientId, 'client');
  assert.equal(built.pages[0].youtube.clientSecret, 'secret');
  clearEnv();
  delete process.env.YOUTUBE_EPOCH_ACCOUNT_ID;
  delete process.env.YOUTUBE_EPOCH_ACCESS_TOKEN;
});

test('a later run retries only the unfinished platform and does not move the file', async () => {
  clearEnv();
  const root = tempDir();
  const epoch = path.join(root, 'Epoch Lab');
  const file = writeMp4(epoch, 'half story.mp4');
  process.env.FACEBOOK_SOURCE_DIRS = epoch;
  process.env.FACEBOOK_POST_SLOTS = '22:00';
  process.env.FACEBOOK_EPOCH_PAGE_ID = 'epoch-page';
  process.env.FACEBOOK_EPOCH_PAGE_TOKEN = 'epoch-token';
  process.env.YOUTUBE_EPOCH_REFRESH_TOKEN = 'epoch-refresh';
  const stateFile = path.join(root, 'state.json');
  const seen = [];
  let youtubeFails = true;
  const options = {
    force: true,
    silent: true,
    downloadDir: root,
    stateFile,
    gapMs: 0,
    retryMs: 0,
    now: new Date(),
    postFacebook: async () => { seen.push('facebook'); return { id: 'fb' }; },
    postInstagram: async () => { throw new Error('instagram should stay inactive'); },
    postYouTube: async () => {
      seen.push('youtube');
      if (youtubeFails) throw new Error('yt down');
      return { id: 'yt' };
    }
  };
  await publish.tick({ ...options, parts: slotParts('22:00') });
  assert.deepEqual(seen, ['facebook', 'youtube']);
  assert.equal(fs.existsSync(file), true);
  assert.equal(fs.existsSync(path.join(epoch, 'paylasildi', 'half story.mp4')), false);
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(saved.videos[file].platforms.facebook, 'done');
  assert.equal(saved.videos[file].platforms.youtube, 'failed');
  seen.length = 0;
  await publish.tick({ ...options, parts: { date: '2026-11-27', hour: 22, minute: 15 } });
  assert.deepEqual(seen, ['youtube']);
  assert.equal(fs.existsSync(file), true);
  youtubeFails = false;
  seen.length = 0;
  await publish.tick({ ...options, parts: { date: '2026-11-27', hour: 22, minute: 20 } });
  assert.deepEqual(seen, ['youtube']);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(path.join(epoch, 'paylasildi', 'half story.mp4')), true);
  clearEnv();
});
