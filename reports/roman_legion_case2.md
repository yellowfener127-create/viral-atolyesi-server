# Roma lejyonu, ikinci ölçüm

Dosya: `20261119_epoch_the-lost-roman-legion-that-vanished-into-ancient-china_1795085207752.mp4` (33.9 sn). Bu iş yeni kod yolundan çıktı: `jobs/.../audio_debug.json` ve `with-voice.mp4` var.

## Son cümle neden kesildi

| Hipotez | Sonuç |
| --- | --- |
| H1, TTS metni kırpıldı | Değil. Son sahnenin 19 kelimesi de alignment'ta var. Altyazı dosyası `of Liqian.` ile 37.36 sn'ye kadar yazılı. |
| H2, son kelimeler alignment'ta yok | Değil. |
| H3, ffmpeg videoya göre kesti | Doğru. Görüntü 33.87 sn, ses 37.84 sn. Shot'lar zaman sırasında değildi ve bazı sahnelerin başını kapsamıyordu. `-shortest` sesi görüntüye göre kesti. |
| H4, son TTS yutuldu | Değil. `scene_4.json` tam. |
| H5, atempo | Belgesel hattında yok. Hız adımı eklenmedi. |

## Düzeltme

Görüntü sesi kesmez. Ses daha uzunsa son kare uzatılır. Shot'lar kronolojik dizilir ve sahne 0. sn'den başlar. Cümle sonundaki ek duraklama, modelin kendi boşluğunun üstüne binmez. Kelime sayıları uyuşmazsa iş yayınlanmaz.

Filigran isteği zaten `nologo=true` ile gidiyor. Bu karede yine de göründü. Kırpma veya delogo eklenmedi. İstek metnine yazı, logo ve kolaj yasağı eklendi. Yatay dikiş için piksel kontrolü eklendi.

`hard_max_duration` varsayılanı 45 sn. Bunu aşan iş kesilmez, yayın klasörüne alınmaz.
