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

function usableElevenKey(value) {
  return /^sk_[A-Za-z0-9_-]{16,240}$/.test(String(value || '').trim());
}

function saveElevenKey(value) {
  const text = String(value || '').trim();
  if (text && !usableElevenKey(text)) {
    const error = new Error('ElevenLabs anahtarı sk_ ile başlamalı. Anahtar kimliğini değil, oluştururken gösterilen anahtarı yapıştır.');
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
  const saved = String(readStore().elevenlabs || '').trim();
  return { elevenlabs: usableElevenKey(saved) ? maskKey(saved) : '' };
}

function resolveElevenKey(bodyKey) {
  const body = String(bodyKey || '').trim();
  if (usableElevenKey(body)) return body;
  if (body) {
    const error = new Error('ElevenLabs anahtarı sk_ ile başlamalı. Anahtar kimliğini değil, oluştururken gösterilen anahtarı yapıştır.');
    error.statusCode = 400;
    throw error;
  }
  const saved = String(readStore().elevenlabs || '').trim();
  if (usableElevenKey(saved)) return saved;
  if (saved) {
    const next = readStore();
    delete next.elevenlabs;
    writeStore(next);
    console.warn('Belgesel ElevenLabs kaydı sk_ anahtarı değil. .env anahtarı kullanılacak.');
  }
  return '';
}

module.exports = { maskKey, usableElevenKey, saveElevenKey, publicKeys, resolveElevenKey };
