const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'keys', 'documentary.json');

function maskKey(value) {
  const text = String(value || '').trim();
  if (text.length < 8) return '';
  return `****${text.slice(-4)}`;
}

function readStore() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function writeStore(data) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const body = JSON.stringify({ elevenlabs: String(data.elevenlabs || '') });
  fs.writeFileSync(FILE, body, { mode: 0o600 });
}

function saveElevenKey(value) {
  const text = String(value || '').trim();
  if (text && !/^[A-Za-z0-9_-]{20,256}$/.test(text)) {
    const error = new Error('Anahtar biçimi geçersiz.');
    error.statusCode = 400;
    throw error;
  }
  const next = readStore();
  if (text) next.elevenlabs = text;
  else delete next.elevenlabs;
  writeStore(next);
  return { elevenlabs: maskKey(next.elevenlabs) };
}

function publicKeys() {
  return { elevenlabs: maskKey(readStore().elevenlabs) };
}

function resolveElevenKey(bodyKey) {
  const body = String(bodyKey || '').trim();
  if (body) return body;
  return String(readStore().elevenlabs || '').trim();
}

module.exports = { maskKey, saveElevenKey, publicKeys, resolveElevenKey };
