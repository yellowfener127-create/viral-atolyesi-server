# Değişiklikler

## Roma lejyonu vakası

- Konuşma artık shot sınırında kesilmez. Sahnelerin sesi tek iz olarak videoya bağlanır.
- Duraklama yalnızca cümle sonuna konur: nokta 0.48 sn, soru 0.52 sn, üç nokta 0.55 sn. Cümle ortasına 0.7 sn eklenmez.
- Kelime hizası anlatımla tutmazsa araya sessizlik konmaz.
- İlk cümleyle aynı hook yazısı ikinci kez basılmaz.
- Örnek Roma lejyonu anlatımı sayı, nedensellik, kanıt türü ve boş kapanış yüzünden reddedilir.

## Faz 0

- Belgesel bayrakları tek modülde toplandı.
- Bir mp4 için çözünürlük, fps, süre ve LUFS ölçümü eklendi.
- Ağ çağrısı yapmayan dry-run iskeleti eklendi.
- Ölçüm testleri eklendi.
- Mevcut bir çıktı `baseline.json` içine yazıldı: 1080×1920, 27.3 sn, −24.3 LUFS.

## Faz 1

- Her iş `jobs/YYYYMMDD_kanal_slug/` altında durur. Son mp4 yayın klasörüne de kopyalanır.
- ElevenLabs ve Pollinations sonuçları hash ile önbelleğe alınır. ElevenLabs üç kez dener.
- Pollinations `nologo=true` ve sabit seed kullanır. Logo sonradan silinmez.
- Altyazı sahneler birleştikten sonra tek ASS geçişinde basılır.
- Müzik seviyesi 0.07 kalır. Karışım iki geçişli loudnorm ile −14 LUFS hedefine çekilir.

## Faz 2

- Story bible, senaryo ve eleştirmen ayrı Gemini çağrılarıdır. `STORY_PIPELINE=v1` eski planı korur.
- Mekanizma boşsa, köşeli parantez varsa veya rüya çözümse senaryo geri çevrilir.
- Konu geçmişi son 200 başlığı tutar ve yakın tekrarı reddeder.
- Doğrulanmamış `is_fiction=false` kurguya çevrilir.
- Karşılaştırma `compare_v1_v2.md` dosyasındadır.

## Faz 3

- Beat başına üç görsel. Shot, söylenen kelimenin zamanına kilitlenir. Sekiz eşit kare 1–5 puanlanır. 3 altı shot bir kez yeniden üretilir.
- Hareket sırası zoom-in, zoom-out, pan sol, pan sağ.
- Altyazı güvenli alanda. Hesap adı gömülmez. İlk üç saniyede kısa hook satırı vardır.
- Varsayılan kadraj tam ekrandır. `DOC_LAYOUT=card` kart kadrajını açar.

## Faz 4

- `qc.json` çözünürlük, fps, süre, LUFS, tepe, siyah ve donuk kareyi kapı yapar. Geçmeyen iş yayın klasörüne kopyalanmaz.
- Günlük kuyruk iskeleti kanal başına iki konu yazar.
- Arayüz iş listesi, devam ve tek sahne yeniden üretimini gösterir.
- Belgesel ElevenLabs anahtarı sunucuda maskeli saklanır. Sonraki istek anahtarı taşımaz.
