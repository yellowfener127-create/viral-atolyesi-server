# Belgesel Fabrikası denetimi

Reçete önce denetim istiyor. Bu dosya mevcut hattı anlatır. 16 sayfalık sürüm işi Faz 0–4 diye böler. Faz 0 yalnızca ölçüm ve bayrak iskeletidir. Üretim akışı bu tablodaki gibi durur.

## Dosya haritası

Belgesel hattı bu dosyalarda durur. Diğer sekmeler ayrıdır.

- `documentary-factory.js` — konu, senaryo, ses, görsel, sahne, birleştirme
- `pollinations_image.py` — görsel indirme
- `clean_narration.py` — ElevenLabs öncesi köşeli parantez temizliği
- `elevenlabs-hook.js` — TTS ve kelime zamanları
- `local-downloader.js` — `POST /documentary`, `POST /documentary-topic`, `POST /documentary-voice-preview`
- `public/index.html` ve `index.html` — Belgesel Fabrikası arayüzü

Dokunulmayan sekmeler: Mix & Birleştirme, Voice Enjektör, Telif Ezici, Araçlar.

## Mevcut akış

1. Kanal `epoch`, `chaos` veya `therapy`. Aynı anda tek iş (`__docInProgress`).
2. Konu kullanıcıdan gelir. Boşsa Gemini tek başlık üretir. Chaos bir Reddit hikâyesi çeker.
3. Tek Gemini çağrısı 5–6 sahnelik plan yazar: `narration`, `image_prompt`, `voice_tone`, `music_mood`.
4. Her sahne ElevenLabs ile seslenir. Kelime zamanları altyazıya gider.
5. Her sahne için bir Pollinations görseli iner.
6. FFmpeg sahneyi 1080×1920, 30 fps basar. Sahneler birleşir. Müzik `0.07` seviyesinde biner.
7. Çıktı `getMixDir()` altına tek mp4 olarak yazılır. Ara dosyalar geçici klasörde kalır ve iş bitince silinir.

## Madde tablosu

| Madde | Durum | Not |
| --- | --- | --- |
| 0. Önce denetim, sonra uygulama | var | Bu dosya o adımdır. |
| 0. Küçük adım, config bayrağı, commit | yok | Bayraklı yeni davranış yok. |
| 0. Diğer sekmelere dokunmama | var | Belgesel ayrı duruyor. |
| 0. Telif atlatma eklememe | var | Belgesel render'ında mikro kırpma, hız oynatma, metadata silme, delogo yok. |
| 0. Anahtarlar sunucuda | kısmen | `.env` var ve gitignore'da. Arayüz anahtarı istek gövdesinde gidiyor, loga yazılmıyor. localStorage'da da duruyor. |
| 1. `jobs/` klasörü ve durum dosyası | yok | Tek geçici klasör, bitince siliniyor. Yeniden başlatma ve tek sahne yenileme yok. |
| 2. Konu | kısmen | Kullanıcı konusu aynen kullanılır. Rastgele konu var. Son 200 konu geçmişi ve benzerlik reddi yok. |
| 3. Story bible | yok | Ayrı şema, `core_mechanism`, `planted_clue` yok. |
| 4. Senaryo | kısmen | Tek plan çağrısı var. Süre Gemini zamanından değil sesten geliyor. Shot başına 2–3 görsel yok; sahne başına 1 görsel var. |
| 4. Kelime bütçesi | kısmen | Hedef 80–90. 75–100 kabul. 60–140 arası en yakın metinle devam. 24–38 sn hedefi yok; mevcut hedef 40–50 sn. |
| 4. Görsel, söylenen şeye bağlı | kısmen | Ayrıntılı `image_prompt` var. `anchor_words` yok. |
| 5. Critic | yok | Ayrı düşük-temperature eleştirmen ve `needs_review` yok. |
| 5. Kod doğrulayıcıları | kısmen | Köşeli parantez temizleniyor. Kelime sayısı ve ilk cümle bakılıyor. Anchor ve bible kontrolü yok. |
| 6. ElevenLabs | kısmen | Zaman damgalı TTS var. Önbellek yalnız 5 sn örnekte. Üretimde 3 denemeli üstel geri çekilme ve kota ön kontrolü yok. Köşeli etiket metne eklenmiyor. |
| 7. Görseller | kısmen | Klasik Pollinations URL, yeniden deneme, tarayıcı kimliği var. Sabit seed, logo'yu kaynakta kapatma, phash, vision kontrolü ve shot başına çok görsel yok. |
| 8. Timeline sesten | kısmen | Cümle sonu nefesleri var. Shot başlangıcı anchor kelimeye kilitli değil. |
| 8. Hareket ve geçiş | kısmen | Yavaş kaydırma var. Sıralı zoom/pan ve 0.15 sn geçiş yok. |
| 8. Altyazı | kısmen | Kelime kelime `drawtext` var. Geçişten sonra tek seferde basılmıyor; sahne sahne yanıyor. Üst/alt güvenli alan ve hook yazısı yok. |
| 8. Ses seviyesi | yok | Müzik 0.07. Konuşma −14 LUFS ve iki geçişli loudnorm yok. |
| 8. Kodlama | kısmen | 1080×1920, 30 fps, CRF 18, yuv420p, faststart, AAC var. |
| 9. QC kapısı | yok | `qc.json`, siyah kare, LUFS aralığı ve vision puanı yok. |
| 10. Metadata | kısmen | Kanal dosya adı var. Ayrı başlık, açıklama, hashtag dosyası yok. |
| 10. Doğruluk | kısmen | Therapy uydurma deney istemiyor. Arama ile doğrulama ve `is_fiction` yok. |
| 11. Günlük 6 video kuyruğu | yok | Tek iş kilidi var. Kanal başına 2 konu ve aşama listesi yok. |
| 12. Gizli anahtarlar | kısmen | Sunucu `.env` okur. Arayüz anahtarı tarayıcıda durur ve istekte gider. |
| 13. Bible / script / critic şablonları | yok | Yerinde tek yönetmen prompt'u var: kanca, neden-sonuç, 80–90 kelime, ayrıntılı görsel. |
| 14. Test ve dry-run | yok | Belgesel için birim test ve `--dry-run` yok. |
| 15. Teslim notu | yok | Bu denetimden sonra yazılacak. |

## Riskler

- Reçetedeki 24–38 saniye ve shot başına 2–3 görsel, bugünkü 40–50 saniyelik tek görselli sahne yapısını değiştirir.
- Story bible ve critic iki ekstra Gemini çağrısı ekler.
- −14 LUFS, mevcut 0.07 müzik seviyesini değiştirir. Bu seviye ayrıca istenmedi.
- `jobs/` klasörü ve durum makinesi mevcut tek mp4 çıktısının yanına yeni bir düzen ekler. Eski çıktı yolu config ile durmalı.
- Görselde logo silmek reçetede yasak. Mevcut kod da delogo yapmıyor.
- Chaos kaynağı bazen nedensiz. Prompt rüya ve tesadüfü attırıyor; bunu eleyen bir critic yok.
