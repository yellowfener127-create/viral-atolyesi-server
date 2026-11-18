# Değişiklikler

## Faz 0

- Belgesel bayrakları `documentary-config.js` içinde toplandı. Varsayılanlar bugünkü üretimi değiştirmez.
- `documentary-measure.js` bir mp4 için çözünürlük, fps, süre, LUFS ve siyah/donuk kare sayısını JSON yazar.
- `documentary-dry-run.js` bir senaryo dosyasını sayar. Gemini, ElevenLabs ve Pollinations çağırmaz.
- `node --test tests/documentary-phase0.test.js` bu iskeleti doğrular.
- Mevcut belgesel mp4 ölçümü `baseline.json` dosyasına yazıldı.
