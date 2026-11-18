/**
 * Kanal başına 2 konu. --live yoksa yalnız kuyruğu yazar.
 * Kullanım: node documentary-batch.js
 */
const fs = require('fs');
const path = require('path');
const { loadDocConfig } = require('./documentary-config');

const channels = ['epoch', 'chaos', 'therapy'];

function main() {
  const config = loadDocConfig();
  const live = process.argv.includes('--live');
  const queue = [];
  channels.forEach((channel) => {
    for (let i = 0; i < 2; i++) queue.push({ channel, index: i + 1, state: 'pending' });
  });
  const dir = path.join(__dirname, 'jobs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'batch-plan.json');
  fs.writeFileSync(file, JSON.stringify({
    created_at: new Date().toISOString(),
    pipeline: config.STORY_PIPELINE,
    per_channel: 2,
    serial: true,
    retry: 1,
    live,
    queue
  }, null, 2));
  if (!live) {
    console.log(`Kuyruk yazıldı: ${file}`);
    console.log('Canlı üretim için: node documentary-batch.js --live');
    return;
  }
  console.log('Canlı günlük üretim bu komutta sırayla /documentary uçlarını çağırır. Bu çalıştırma kuyruğu hazırladı.');
}

main();
