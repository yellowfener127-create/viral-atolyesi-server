# Roma lejyonu vakası

Ölçülen dosya: `20261119_epoch_the-lost-roman-legion-that-vanished-into-ancient-china` (28.5 sn). Yeni video bu düzeltmeden sonra ayrıca üretilmedi; aşağıdaki tablo kodun davranışıdır.

## Hipotez

| Kod | Sonuç |
| --- | --- |
| H1, TTS shot başına | Değil. TTS sahne başına bir kez çalışıyor. |
| H2, duraklama slot sınırından | Kısmen. 1.0 sn ve 0.7 sn duraklama noktalama parçasına ekleniyordu. Sahne sesi sonra her shot için kesilip `apad` ile dolduruluyordu. Kesim, cümle ortasındaki bu boşluğa denk geliyordu. |
| H3, iki ses üst üste | Değil. Konuşma `amix` ile birleşmiyor; parçalar art arda ekleniyor. |

## Önce / sonra

| | Önce | Sonra |
| --- | --- | --- |
| Konuşma | Her shot kendi ses dilimini kesiyor | Sahneler tek izde duruyor, video kesimleri sesi bölmüyor |
| Cümle ortası boşluk | 0.7–1.0 sn | Eklenmez. Hiza tutmazsa duraklama da eklenmez |
| Cümle sonu | Nokta 1.0 sn, diğer 0.7 sn | Nokta 0.48 sn, soru 0.52 sn, üç nokta 0.55 sn |
| Hook | İlk cümle hem üstte hem altta | Aynı metin ikinci kez basılmaz |
| Anlatım | Sayı ve DNA iddiası olgu gibi geçebiliyordu | Örnek metin altı hata türüyle reddedilir |
| Görsel | Modern nesne yasağı yoktu | İstek metnine dönem nesnesi kilidi eklendi |

## Açık kararlar

- `MUSIC_BED` varsayılanı sorulacak. Şu an müzik 0.07 ile duruyor.
- `FACT_CHECK` varsayılanı sorulacak. Google Search grounding kapalı.
