# Hutcherson reels

Örnek `video_1.mp4` bu makinede yoktu. Önce sütunu, verilen ölçüm ve koddaki gerçek yoldur. Canlı API çağrılmadı; sonra sütunu yeni bir render değil, critic fixture'ı ve kod yoludur.

## Önce / sonra

| Konu | Önce | Sonra |
| --- | --- | --- |
| Hook | Özne yok, parça cümle, 13 kelime, yaklaşık 4.4 sn | Tek cümle, özne ve bahis. Üst sınır 16 kelime ve 4.5 sn |
| Tekrar | 1. ve 2. cümle aynı iddia: eve cesetle sürmek | Ardışık yolculuk + taşınan kişi aynı iddia sayılır |
| Yeni olgu | 12. saniyeye kadar yeni bilgi yok | İkinci cümle yeni olgu değilse `new_info_by_6s` düşer |
| Yer | "to Atlanta" | Cobb County / Marietta dışında "to Atlanta" `vague_location` |
| Akıbet | "Komşu buldu" ile bitiyor | Kaynakta mahkeme sonucu varsa akıbet cümlesi zorunlu |
| Kapanış | Soru yok | Son cümle hook'taki sözü yankılar ve soru sorar |
| İnsan | Hiçbir karede insan, el, silüet veya araç içi yok | Shot'ların en az %40'ı silüet, el veya araç içi. Ceset, kan ve yara yok |
| Araç | Başta siyah yeni pikap, sonda beyaz eski pikap | Yolda görünen her kareye aynı "dark pickup truck" tarifi eklenir. Yıl uydurulmaz |
| Işık | 15–23 sn gündüz ormanı; kaza gece | Gece anlatımında "night, headlights". Gündüz kelimeleri silinir |
| Kesim | 10 görsel, yaklaşık 3.87 sn, eşit | Süreye göre 8–24 shot. Süreler 0.84 / 1.16 ağırlıklı. 3 sn üstü ve CV 0.15 altı kapıyı düşürür |
| Filigran | `pollinations.ai` köşede, üçüncü rapor | `nologo` gönderilmez. Klasik sağlayıcı yayınlanmaz |
| Ses ucu | Son kelimeden sonra yaklaşık 1 sn, −24 dB, fade yok, 39.29 sn'de kesik | Konuşmadan sonra 0.65 sn kuyruk. Son 0.25 sn exponential fade; son 100 ms sessiz |
| Kritik an | Hız ve ton düz | Çarpma ve keşifte hız −%8, tırmanışta +%8. Hemen önce 0.45 sn sessizlik |

## Doğrulanan kaynaklar

- [Los Angeles Times / AP, 26 May 2005](https://www.latimes.com/archives/la-xpm-2005-may-26-na-decapitate26-story.html): John Kemper Hutcherson araçla adam öldürmeden suçunu kabul etti ve beş yıl hapis aldı. Olay Marietta. Arkadaş pencereden eğildi. Sürücü fark etmeden ailesinin evine "10 milden fazla" sürdü.
- [AccessWDUN / AP, 25 May 2005](https://accesswdun.com/article/2005/5/145288): Ölüm 29 Ağustos. Kurban 23 yaşında Frankie Brohm. Cobb County. Ailenin avukatı hafifletme istedi. Komşu kızıyla yürürken buldu.
- [WIS / AP, 30 Ağustos 2004](https://www.wistv.com/story/2234401/ga-man-charged-with-vehicular-homicide-dui-after-passenger-decapitated-by-wire/): İlk duruşma. Mesafe burada "12 miles". Varış Atlanta diye yazılmıyor.

"12 mil" ile "10 milden fazla" iki ayrı haberde duruyor. Şablon ikisini de uydurmaz; okunan metindeki sayıyı kullanır. "to Atlanta" kaynaklarda yok. 1992 model iddiası bu üç haberde yok, bu yüzden araç kilidi yıl yazmaz.

Kurban adı varsayılan `NAME_POLICY=none` ile anlatıma girmez. Sanık adı ancak bu kamu kaydı `sources[]` içindeyken kullanılabilir.

## Hipotezler

Ses ucu doğrulandı. `documentary-run.js` sesi yalnızca kendi steminde 0.2 sn kısar, görüntüyü konuşmadan 0.5 sn uzun tutar, sonra müziği `MUSIC_VOLUME` 0.05 ile tüm süreye karıştırır. 0.05 doğrusal kazanç yaklaşık −26 dB. Ölçülen −24 dB bu yatağa uyar. Dosya fade'siz kesiliyordu. Düzeltme loudnorm'dan sonra, tüm karışımın son 0.25 sn'sini exponential kısar ve kuyruğu 0.65 sn'de tutar. Bayrak: `REEL_TAIL_FADE=0` eski ucu geri verir.

Filigran doğrulandı. Pollinations classic dokümanı her JPEG'in köşesinde logo olduğunu yazar. `nologo`, `enhance` ve `negative_prompt` 10 Haziran 2026 dokümanında kaldırıldı; sunucu bunları yok sayar. Eski `nologo=true` bu yüzden işe yaramadı. Kırpma, blur ve delogo eklenmedi. Logosuz yol `IMAGE_PROVIDER=enter` ve `POLLINATIONS_API_KEY` ile `https://gen.pollinations.ai/image/` isteğidir. Anahtar URL'ye ve loga yazılmaz. Anahtar yokken varsayılan `classic` kalır; aksi halde istek 401 olur. Bu durumda reels işi `watermark` ile `needs_review` olur ve yayın klasörüne kopyalanmaz. Tesseract bu makinede yok. 10 fps OCR taraması uydurulmadı; `qc.json` içinde `ocr` alanı `provider-policy` yazar.

Eşit 3.87 sn kesim, `buildTimeline`'ın konuşmayı shot sayısına bölmesinden gelir. Belgesel ve `REEL_VARIABLE_CUTS=0` bu eşit dilimi korur. Değişken kesim yalnızca hikâye reels yolunda, timeline'dan sonra uygulanır.

## Yapılanlar

- `reel-quality.js`: şablon, Jaccard ve aynı iddia, hook varyantları, ışık ve araç kilidi, insan oranı, harita SVG, kuyruk planı.
- `documentary-factory.js`: `REEL_TRUE_EVENT` açıkken yeni prompt ve critic. Kapalıyken eski 70–85 kelime kapısı durur.
- `documentary-run.js`: hız ±%8, 0.45 sn reveal sessizliği, değişken kesim, kuyruk fade, metadata ve qc alanları. `SFX=on` ve `INFOGRAPHIC_SHOTS=on` kapalıyken bu yollar çalışmaz.
- `pollinations_image.py`: classic istekten ölü `nologo` çıktı. Enter yalnızca anahtar varsa.
- Test: ölçülen altı cümle reddedilir. Kaynakla uyumlu gövde geçer. 20 test geçti. Ağ yok.

## Açık kalanlar

- `assets/sfx` yok. `SFX` varsayılan `off`. Dosya konunca ve bayrak açılınca ilk dosya yaklaşık −18 dB ile alta karışır.
- Harita kartı yalnızca `INFOGRAPHIC_SHOTS=on` iken çizilir. Dış harita karosu yok.
- Gemini'den üç hook varyantı canlı çağrı istemez. Anahtarsız üretimde üç varyant yerelde yazılır. `--variants` ile ayrıca render yok.
- Yeni bir Hutcherson videosu üretilmedi. Karşılaştırma bu fixture ve kod yoludur.
