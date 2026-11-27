const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STAGES = Object.freeze(['topic', 'bible', 'script', 'critic', 'tts', 'images', 'timeline', 'render', 'qc', 'metadata']);

function stampDay(date) {
  const value = date || new Date();
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, '0');
  const d = String(value.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function slugify(text) {
  const slug = String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (slug || 'film').slice(0, 60);
}

function hashValue(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20);
}

function jobDirFor(root, channel, title, date) {
  return path.join(root, `${stampDay(date)}_${channel}_${slugify(title)}`);
}

function blankStatus() {
  return { stage: 'topic', state: 'pending', attempts: 0, error: '', stages: {}, updated_at: new Date().toISOString() };
}

function readStatus(dir) {
  const file = path.join(dir, 'status.json');
  if (!fs.existsSync(file)) return blankStatus();
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.stages = data.stages || {};
    return data;
  } catch {
    return blankStatus();
  }
}

function writeStatus(dir, status) {
  fs.mkdirSync(dir, { recursive: true });
  status.updated_at = new Date().toISOString();
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(status, null, 2));
}

function writeJson(dir, name, value) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(value, null, 2));
}

function readJson(dir, name) {
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function stageOutputReady(dir, stage, inputHash) {
  const status = readStatus(dir);
  const row = status.stages[stage];
  if (!row || row.state !== 'done' || row.inputHash !== inputHash) return false;
  return !row.file || fs.existsSync(path.join(dir, row.file));
}

function markStage(dir, stage, patch) {
  const status = readStatus(dir);
  status.stage = stage;
  status.state = patch.state || status.state;
  status.error = patch.error || '';
  if (patch.state === 'failed') status.attempts = (status.attempts || 0) + 1;
  status.stages[stage] = Object.assign({}, status.stages[stage], patch, { at: new Date().toISOString() });
  writeStatus(dir, status);
  try {
    fs.writeFileSync(path.join(path.dirname(dir), 'active.json'), JSON.stringify({
      job: path.basename(dir),
      stage: status.stage,
      state: status.state,
      updated_at: status.updated_at
    }));
  } catch {}
  return status;
}

function listJobs(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const status = readStatus(path.join(root, entry.name));
      return { id: entry.name, stage: status.stage, state: status.state, error: status.error || '' };
    })
    .slice(-40)
    .reverse();
}

module.exports = {
  STAGES,
  stampDay,
  slugify,
  hashValue,
  jobDirFor,
  readStatus,
  writeStatus,
  writeJson,
  readJson,
  stageOutputReady,
  markStage,
  listJobs
};
