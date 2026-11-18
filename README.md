# viral-atolyesi-server

Belgesel hattı `node local-downloader.js` ile `127.0.0.1:8787` üzerinde durur. Arayüz `node server.js` ile açılır.

## Belgesel

- Varsayılan yol: senaryo v2, iş klasörü `jobs/`, altyazı birleşmeden sonra, ses −14 LUFS.
- Eski yol: `STORY_PIPELINE=v1` ve `OUTPUT_LAYOUT=legacy`.
- Ölçüm: `node documentary-measure.js video.mp4`
- Senaryo provası, ağ yok: `node documentary-dry-run.js --fixture tests/fixtures/scene-plan.json`
- Test: `npm test`
- Günlük kuyruk iskeleti: `node documentary-batch.js`
- Karşılaştırma dosyası: `compare_v1_v2.md`

İş dosyaları `jobs/` altındadır ve git dışındadır. ElevenLabs belgesel anahtarı `keys/documentary.json` içindedir. İstek gövdesinde taşınmaz. Loga yazılmaz.
