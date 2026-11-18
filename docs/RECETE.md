
Belgesel Fabrikası: Stabilite ve Bağlam
 
Reçetesi (Cursor Prompt)
Cursor için hazır prompt · 18 Kasım 2026
Aşağıdaki 'Prompt' bölümünün tamamını Cursor'a tek mesaj olarak yapıştır. Not: Bu reçete
yalnızca sitenin ön yüzünü görerek yazıldı; sunucu kodunu, Gemini prompt'larını ve ffmpeg
komutlarını görmedim. Bu yüzden Cursor'dan önce bir denetim (audit) yapması isteniyor.
Prompt
Rolün: kıdemli bir video-otomasyon mühendisi. Projemde 'Belgesel Fabrikası' adlı bir hat
var: konu → Gemini senaryo → Pollinations görsel → ElevenLabs ses → ffmpeg ile 9:16
video. Günde 6 video üretiyorum (3 kanal: Epoch Lab, Chaos Lab, Therapy Lab; kanal
başına 2). Amaç: bu hattı kararlı (hata verse de kendini toparlayan), bağlamı tutarlı, ses-
görüntü-altyazı senkron ve Reels / Shorts / X için uygun hale getirmek.
0. Çalışma kuralları
1. 
Önce KOD YAZMA. Repoyu oku; belgesel hattını bul (Gemini prompt'ları, Pollinations
çağrıları, ElevenLabs çağrıları, ffmpeg komutları, altyazı üretimi, dosya adlandırma).
AUDIT.md
 yaz: dosya haritası, mevcut akış, bu belgedeki her maddeye karşı 'var / yok /
kısmen' tablosu, riskler. Sonra uygula.
2. 
Küçük adımlarla ilerle; her adım sonunda sistem çalışır durumda olsun ve ayrı commit
olsun. Mevcut çıktıyı bozma; yeni davranışları config bayrağıyla aç/kapat.
3. 
'Mix & Derleme', 'Voice Enjektör', 'Telif Ezici' ve 'Araçlar' sekmelerine DOKUNMA.
Belgesel hattı bunlardan bağımsız kalsın. Belgesel render'ında mikro kırpma, hız
oynatma, metadata silme, delogo gibi içerik kimliği atlatmaya yönelik işlemleri
KULLANMA.
4. 
API anahtarları yalnızca sunucuda 
.env
 içinde durur (bkz. Bölüm 12).
5. 
Her aşama idempotent, önbellekli ve yeniden başlatılabilir olsun.
1. İş klasörü ve durum makinesi
Her video için 
jobs/<YYYYMMDD>_<kanal>_<slug>/
 klasörü aç. Aşama çıktıları:
topic.json
, 
bible.json
, 
script.json
, 
critic.json
, 
audio/
 (ses +
alignment.json
), 
images/
, 
timeline.json
, 
final.mp4
, 
qc.json
, 
metadata.json
,
status.json
.
abrikrompt)
Page 
1
 of 
16

===== PAGE =====


status.json
: stage, state (pending|running|done|failed|needs_review), attempts, error,
timestamps. Aşama zaten bitmişse ve girdi hash'i değişmediyse atla. UI'dan 'şu aşamadan
yeniden başlat' ve 'sadece şu sahneyi yeniden üret' yapılabilsin.
Aşama sırası: topic → bible → script → critic → tts → images → timeline → render → qc →
metadata.
2. Konu
Kullanıcı konu yazdıysa aynen kullan. 'Rastgele viral konu' için Gemini çıktısını
structured output ile al (responseMimeType application/json + responseSchema).
topic_history.jsonl
 içinde son 200 konuyu tut; yeni konu anahtar
kelime/embedding benzerliği olarak çok yakınsa reddet ve yeniden üret.
Gerçek kişi/olay iddiası için Bölüm 10'daki doğruluk kuralları geçerli.
3. Story Bible (bağlamın omurgası)
Senaryodan ÖNCE ayrı bir Gemini çağrısı (temperature ~0.7) şu şemayı üretir (YAML
gösterim; gerçekte JSON schema):
logline: tek cümle
is_fiction: true | false
scope: tek ana varlık (örn. the king); başlık, anlatım ve görsel hep bu
 
kapsamı kullanır
setting: {place, era, mood}
characters: [{id, role, visual_descriptor}]   # sabit görsel tarif: old king,
 
grey beard, crimson robe
core_mechanism: olayın FİZİKSEL işleyişi (zehirse: kim koydu, nasıl, ne
 
zaman, kurban nasıl temas etti)
hook: ilk 2 sn'deki vaat; video sonunda mutlaka karşılığı olmalı
planted_clue: erken verilen ve twist'te karşılığı çıkan ipucu
twist: tek ve net
final_line: kapanış; mümkünse ilk cümleye bağlanan döngü
forbidden: [başlıkta spoiler, kapsam değişimi, yeni karakter ekleme, cevapsız
 
soru]
Kural: 
core_mechanism
 boş ya da 'unknown' ise bible reddedilir ve yeniden üretilir.
4. Senaryo
Bible'dan türetilir; bible dışında yeni olgu eklemez. Çıktı structured JSON:
abrikrompt)
Page 
2
 of 
16

===== PAGE =====


beats:
  
- id: hook | setup | escalation | twist | close
    
narration: 1-2 cümle, doğrudan seslendirilecek metin (köşeli parantez
 
YOK)
    
voice_direction: ayrı alan (örn. hushed, tense)
    
shots:            # her beat için 2-3 shot, her shot 2-3 sn
      
- visual_prompt: ...
        
anchor_words: shot'ın başlayacağı narration kelimeleri
        
location_id: ...
        
character_ids: [...]
Kurallar:
Süre bütçesi kanal config'inde (varsayılan 24-38 sn). Hedef kelime sayısı = hedef sn ×
2.5 (±%10). Gemini'nin yazdığı zaman aralıkları (0-2, 2-12 gibi) güvenilir değildir;
KULLANMA. Süreler sesten ölçülecek.
Yapı: hook (ilk 2.5 sn, merak uyandırır, spoiler vermez) → setup → escalation → twist
(planted_clue'nun karşılığı) → close.
Her shot'ın görseli, o anda söylenen ana isim/eylemi göstersin. Kritik anlarda (hook,
twist, final) ilgili nesne ekranda olsun: 'ink' deniyorsa mürekkep yakın plan, 'page
burned' deniyorsa yanan sayfa.
Her visual_prompt = shot içeriği + karakter descriptor'ları + kanal STYLE_SUFFIX.
Görselde yazı/logo/altyazı olmasın.
'Panic', 'fear' gibi soyut duygular için boş mekân yerine insan silüeti ya da tepki kullan.
5. Eleştirmen (critic) geçişi
Ayrı bir Gemini çağrısı (temperature ~0.2), bible + script alır ve 
{pass, issues:[{type,
beat, fix}]}
 döner. Kontrol listesi: kapsam tutarlılığı; hook'un karşılığı; mekanizma
açıklanmış mı; zaman/mekân çelişkisi; cevapsız soru; başlıkta spoiler; kelime bütçesi;
gerçek kişiye suçlayıcı iddia. 
pass=false
 ise düzeltmeleri uygulayarak yeniden yaz (en
fazla 2 tur). Olmazsa job 
needs_review
 olur ve otomatik yayın klasörüne düşmez.
Bunun yanında KOD tabanlı doğrulayıcılar yaz (LLM'e güvenme): narration'da köşeli
parantez yok; kelime/süre bütçesi tutuyor; her shot'ın anchor_words'ü narration'da
geçiyor; karakter id'leri bible'da var; hook ≤ 7 kelime.
6. Ses (ElevenLabs)
Mümkünse zaman damgalı endpoint (with-timestamps) kullan, karakter/kelime
hizalamasını 
audio/alignment.json
 olarak kaydet.
abrikrompt)
Page 
3
 of 
16

===== PAGE =====


voice_direction
'ı yalnızca modelin desteklediği biçimde uygula (örn. v3 audio
tag'leri). Desteklemeyen modelde ASLA metne ekleme; 
voice_settings
'e (stability,
style, speed) çevir. Model 
TTS_MODEL
 config'inde.
Önbellek: hash(metin + ses + model + ayarlar). Hata durumunda üstel geri çekilmeyle
3 deneme; 401 / 429 / kota ayrımı; üretimden önce kalan karakter kontrolü; yedek ses
tanımı.
Çıktı −14 LUFS'a normalize edilir (Bölüm 8).
7. Görseller (Pollinations)
Video başına sabit seed tabanı; shot seed'i = taban + shot indeksi. Hatada farklı seed
ile yeniden dene.
Pollinations logosunu/watermark'ını üretim parametresiyle ya da kimlik doğrulamalı
API ile kaynakta kapat (güncel Pollinations dokümanını kontrol et). Üretilmiş görselin
üstünden delogo/blur ile logo silme YAPMA. Kaynakta çözülemezse başka bir görsel
sağlayıcı seçeneği ekle (UI'dan seçilebilir).
Timeout 60 sn, 3 deneme, sağlayıcı/model fallback; aynı anda en fazla 2-3 istek.
Doğrulama: boyut 1080×1920 (değilse ölçekle/kırp); boş ya da tek renk değil (std
sapma eşiği); bir öncekine çok benzemiyor (perceptual hash); opsiyonel olarak Gemini
vision ile içinde yazı yok.
Video başına yeterli görsel: 24 sn için en az 8-10 shot.
Önbellek: hash(prompt + seed + model).
8. Zaman çizelgesi ve render (ffmpeg)
timeline.json
: her shot'ın başlangıcı = anchor_words'ün alignment'taki başlangıcı;
bitişi = sonraki shot'ın başlangıcı. Son shot, ses bitiminden 0.4 sn sonra biter. Süre
Gemini'den DEĞİL sesten gelir.
Hareket: shot'lara sırayla zoom-in, zoom-out, pan sol, pan sağ ver (zoompan ya da
scale+crop ifadeleri).
Geçiş: sert kesme ya da ≤ 0.15 sn çapraz geçiş.
ALTYAZI EN SON basılsın. Önce görüntü + geçişler birleştirilsin, sonra tek geçişte ASS
ile kelime kelime altyazı yakılsın; böylece geçişlerde altyazı sönmez. Stil: kalın beyaz,
siyah kontur + gölge, 1-3 kelimelik parçalar, aktif kelime vurgulu.
Güvenli alanlar (config'te, yaklaşık değerler; uygulama içi önizlemeyle doğrula): üst
250 px, alt 450 px, sağ 120 px boş bırak. Altyazı dikey konumu yaklaşık %58-66 (y ≈
1100-1270). Hook yazısı yalnızca ilk 3 sn görünür ve üst güvenli alanın altında durur.
Videoya @hesap adı GÖMME.
abrikrompt)
Page 
4
 of 
16

===== PAGE =====


Yerleşim: 
layout: fullbleed | card
. Varsayılan fullbleed (kartlı/bulanık arka plan
efektif çözünürlüğü düşürüyor).
Ses: opsiyonel fon müziği (kendi ürettiğin ya da lisanslı); konuşma altında −20 ile −24
dB seviyesine indirip ducking uygula. Son karışıma 
loudnorm
 iki geçişli: I=−14,
TP=−1.5, LRA=7. Konuşma ilk kareden başlasın (baştaki boşluk ≤ 0.2 sn). Twist anında
opsiyonel kısa vurgu/sessizlik.
Kodlama: 1080×1920, 30 fps sabit (cfr), libx264 yuv420p, CRF 18-20, +faststart, AAC
192k. Koyu sahnelerde sıkıştırma bantlanmasını azaltmak için hafif gölge açma (eq
gamma ≈ 1.05-1.1) ve düşük yoğunluklu grain; test edip değerleri config'e yaz.
9. QC kapısı (qc.json)
Render sonrası otomatik çalışır; geçmeyen job 
needs_review
 olur ve yayın klasörüne
düşmez:
ffprobe: 1080×1920, 30 fps, süre kanal aralığında, ses akışı var.
Ses: LUFS −15 ile −13 arasında, true peak ≤ −1 dBTP, başta sessizlik ≤ 0.3 sn.
blackdetect
 ve 
freezedetect
 ile siyah/donuk kare yok; shot sayısı ≥ süre/3.
Eşit aralıklı 8 kare + senaryo → Gemini vision: her karenin ilgili cümleyi görsel olarak
karşılama puanı (1-5). 3 altı shot'lar otomatik olarak bir kez yeniden üretilir.
Altyazı bölgesinde kontrast/okunabilirlik kontrolü.
10. Metadata, doğruluk ve platform
metadata.json
 üret (hashtag'leri dosya adına KOYMA): kanal için başlık (spoiler
YOK), açıklama, 3-5 ilgili hashtag, platform varyantları (Reels / Shorts / X), AI/sentetik
içerik bayrağı. Hashtag listesi kanala özeldir (Epoch: dark history, mystery; Chaos:
creepy, horror, reddit; Therapy: psychology, dark psychology). Kanallar arası etiket
karıştırma. Dosya adı: 
YYYYMMDD_kanal_slug.mp4
.
Doğruluk: 
is_fiction=false
 ancak Gemini Google Search grounding ile
doğrulanabilir kaynakla olabilir; yoksa hikâyeyi kurgu olarak yeniden yaz. Gerçek kişi,
aile ya da dava hakkında suçlayıcı kesin ifade üretme (örn. 'koca öldürdü ve serbest
kaldı'); anonimleştir, 'dramatize edilmiş / ilham alınmış' çerçevesi kullan, anlatımda 'bu
gerçekten oldu' deme. Therapy kanalında 'herkesi doğruyu söylemeye zorlayan
numara' gibi kesin iddialar yerine 'araştırmalar bazı durumlarda...' dili kullan; uydurma
çalışma ya da isim yok.
Çeşitlilik (toplu/şablon içerik politikalarına karşı): en az 6 farklı hikâye şablonu; aynı
kanalda aynı gün aynı şablon veya aynı ses tekrarlanmasın; görsel palet rotasyonu.
abrikrompt)
Page 
5
 of 
16

===== PAGE =====


11. Günlük toplu çalışma
daily_batch
 config: kanal başına 2 konu. Kuyruk sıralı çalışır (aynı anda 1 job; görsel
istekleri sınırlı paralel). Başarısız job bir kez otomatik yeniden denenir. 
run_log.jsonl
tutulur. UI'da job listesi, aşama durumu ve 'sadece bu sahneyi yeniden üret' olsun. Mevcut
Gemini anahtar listesi korunur: 429'da otomatik sonraki anahtara geç ve aynı aşamayı
tekrar dene.
12. Gizli anahtarlar
Anahtarlar yalnızca sunucuda 
.env
 içinde durur. UI 'Kaydet' ile sunucuya POST eder;
anahtar UI'a geri DÖNMEZ (yalnızca maskeli son 4 hane). localStorage, repo ve log'lara
yazma. 
.env
 
.gitignore
'da olsun. CORS yalnızca localhost'a açık. Log'larda anahtarlar
maskeli. Geçmişte commit, log ya da ekran görüntüsüne düşmüş anahtarları yenile.
13. Gemini prompt şablonları (İngilizce, sistem talimatı olarak)
Bible:
You are a story architect for 25-35 second vertical videos. Channel:
 
{channel}. Topic: {topic}.
Return JSON matching the schema. Rules: one scope entity only; explain the
 
physical mechanism of the key event; define exactly one hook, one planted
 
clue, one twist, one final line; the hook must not reveal the twist; if the
 
topic involves real people or real crimes, set is_fiction=false only when
 
verifiable, otherwise write a clearly fictional version with invented names.
Script:
Using ONLY the story bible, write beats (hook, setup, escalation, twist,
 
close). Narration is plain spoken text with no brackets or stage directions.
 
Target {words} words. Every shot must visually show the main noun or action
 
of the sentence it starts on. Reuse character visual_descriptors verbatim. No
 
text, logos or captions inside images. Never introduce facts, characters or
 
places that are not in the bible.
Critic:
You are a strict script editor. Compare the script to the bible. Return JSON
 
{pass, issues:[{type, beat, fix}]}. Fail the script if: scope changes between
 
title, narration and visuals; the hook is never paid off; the key mechanism
 
is unexplained; places or times contradict; a question is left unanswered;
 
the title spoils the twist; a real person is accused of a crime as fact.
abrikrompt)
Page 
6
 of 
16

===== PAGE =====


14. Testler ve kabul kriterleri
Birim testleri: doğrulayıcılar (köşeli parantez, kelime bütçesi, anchor_words, bible
alanları).
--dry-run
: yalnızca topic → critic aşamalarını çalıştırıp JSON çıktısı verir (görsel/ses
maliyeti yok).
Golden test: sabit fixture ile 
timeline.json
 üretimi.
Kabul: art arda 10 job'dan en az 9'u QC'yi ilk denemede geçer; hiçbir job elle müdahale
gerektirmez; tek bir Pollinations/ElevenLabs hatasında job kendini toparlar; altyazı
geçişlerde sönmez; ses −14 ±1 LUFS; kapsam ve hook-payoff critic'ten geçer.
15. Teslim
Sıra: 
AUDIT.md
 → uygulama commit'leri (durum makinesi + önbellek, bible + script + critic,
TTS hizalama, görsel doğrulama, timeline + render, QC, metadata, toplu çalışma, gizli
anahtar düzeni) → 
CHANGELOG.md
 ve README'ye çalıştırma talimatı. Her adımın sonunda
ne değiştiğini 5 satırda özetle.
Denetim sonrası: kararlar ve fazlar
AUDIT.md'ye göre reçetenin yaklaşık yarısı kısmen zaten var (zaman damgalı TTS, sesten
süre, köşeli parantez temizliği, kodlama ayarları). Asıl eksikler: story bible, critic,
jobs/durum, QC kapısı, loudnorm, altyazının en sonda basılması, Pollinations logosunu
kaynakta kapatma, kuyruk ve testler. Önce ana prompt'u repoya 
docs/RECETE.md
 olarak
kaydet. Aşağıdaki her faz prompt'u Cursor'a ayrı ayrı verilir ve 
docs/RECETE.md
 dosyasını
okuyarak başlar. Bir faz bitip sonuç doğrulanmadan sonrakine geçme.
Risklere kararlar
1. 
Süre: 24-38 sn zorunlu değil. Kanal başına 
duration_range
 config'i olsun; varsayılan
bugünkü davranış (40-50 sn) kalsın. Kelime bütçesi sabit 2.5 kelime/sn çarpanıyla
değil, seçili sesin ölçülmüş hızından (alignment verisinden kelime/sn) hesaplansın.
Mevcut hat 80-90 kelimeyi 40-50 sn'de okuyor (yaklaşık 1.9 kelime/sn), yani reçetedeki
2.5 çarpanı bu hatta yanlış olurdu. Kısa/uzun karşılaştırmasını kendi analitiğinle dene.
2. 
Shot sayısı: 
shots_per_scene
 config'i (varsayılan 1 = bugünkü davranış). Faz 3'te 2-3'e
çıkarılır; Pollinations isteği 2-3 kat artar.
3. 
Ekstra Gemini çağrıları (bible + critic) kabul. 
STORY_PIPELINE=v1|v2
 bayrağıyla; v1'de
eski akış aynen çalışır. Critic için daha hafif bir model seçilebilsin.
4. 
Ses: −14 LUFS yalnızca son karışıma uygulanır; müzik/konuşma oranı (0.07) değişmez.
Ducking sonra, ayrı bir karar.
abrikrompt)
Page 
7
 of 
16

===== PAGE =====


5. 
jobs/
 eklemelidir: 
OUTPUT_LAYOUT=legacy|jobs
; son mp4 her durumda
getMixDir()
 altına da kopyalanır.
6. 
Chaos: critic'e nedensellik kuralı eklenir (rüya, tesadüf ve açıklamasız olay tek başına
çözüm olamaz).
Reddit notu (Chaos kaynağı)
Chaos kanalı Reddit'ten hikâye çekiyor. Bir gönderinin telif hakkı yazarına aittir ve
Reddit'in API şartları ticari kullanımı kısıtlayabilir (güncel şartları kendin kontrol et; bu
hukuki tavsiye değil). Daha güvenli yön: yalnızca fikir/premise al, hikâyeyi yeni karakterler
ve yeni olay sırasıyla yeniden kur, birebir cümle kullanma, kullanıcı adı ya da kimlik bilgisi
verme. Cursor'dan 
CHAOS_SOURCE=reddit_premise|original
 bayrağı ve Gemini
prompt'una şu kuralı ekletmesini iste: premise only, new characters, new order of events,
no copied sentences.
abrikrompt)
Page 
8
 of 
16

===== PAGE =====


Faz 1 prompt: Temel (videonun görünümü değişmez)
docs/RECETE.md ve AUDIT.md dosyalarını oku. Bu fazda yalnızca temel
 
dayanıklılığı ekle; içerik üretim mantığı ve videonun görünümü değişmesin.
 
Her madde ayrı commit, her yeni davranış config bayrağıyla.
1. Tek bir config modülü: STORY_PIPELINE, OUTPUT_LAYOUT, CHAOS_SOURCE,
 
duration_range, shots_per_scene, TTS_MODEL, STYLE_SUFFIX (kanal başına).
 
Varsayılanlar bugünkü davranışı korur.
2. jobs/<tarih>_<kanal>_<slug>/ klasörü ve status.json (reçete Bölüm 1). Ara
 
dosyalar iş bitince silinmez, yalnızca jobs/ içinde tutulur (eski geçici
 
klasör davranışı OUTPUT_LAYOUT=legacy ile sürer). Aşama atlama (girdi hash'i
 
aynıysa) ve 'şu aşamadan devam et' API'si.
3. Önbellek: ElevenLabs (metin+ses+model+ayar hash'i) ve Pollinations
 
(prompt+seed+model hash'i).
4. ElevenLabs üretimde: 3 denemeli üstel geri çekilme, 401/429/kota ayrımı,
 
üretimden önce kalan karakter kontrolü.
5. Pollinations: video başına sabit seed tabanı, hatada farklı seed ile
 
yeniden deneme, logo/watermark'ı kaynakta kapatma (güncel Pollinations
 
dokümanını oku; delogo/blur ile silme YOK), görsel doğrulama (1080x1920,
 
boş/tek renk değil, bir öncekine perceptual hash ile çok benzemiyor).
6. Son karışıma loudnorm iki geçişli: I=-14, TP=-1.5, LRA=7. Müzik/konuşma
 
oranı değişmesin.
7. Altyazı: sahneleri geçişlerle birleştirdikten SONRA tek geçişte ASS ile
 
kelime kelime bas (mevcut drawtext görünümüne yakın tut).
8. metadata.json (başlık, açıklama, kanala özel hashtag'ler, platform
 
varyantları, AI bayrağı) ve temiz dosya adı YYYYMMDD_kanal_slug.mp4.
9. --dry-run bayrağının iskeleti (şimdilik yalnızca konu ve senaryo
 
aşamalarını çalıştırıp JSON yazsın).
Kabul: aynı konu iki kez çalıştırılınca ikinci seferde önbellekten gelir;
 
Pollinations/ElevenLabs tek hatasında iş kendini toparlar; altyazı geçişlerde
 
sönmez; çıktı -14 ±1 LUFS; eski çıktı yolu hâlâ çalışır. Bitince 5 satırlık
 
değişiklik özeti ver ve DUR.
abrikrompt)
Page 
9
 of 
16

===== PAGE =====


Faz 2 prompt: Bağlam (story pipeline v2)
docs/RECETE.md Bölüm 2, 3, 4, 5, 10, 13 ve AUDIT.md oku. STORY_PIPELINE=v2
 
bayrağıyla yeni akışı ekle; v1 kapalıyken aynen çalışsın.
1. topic_history.jsonl (son 200 konu) ve benzerlik reddi.
2. Story bible: ayrı Gemini çağrısı, structured JSON (kapsam, mekanizma,
 
planted_clue, twist, final_line, is_fiction). core_mechanism boşsa reddet ve
 
yeniden üret.
3. Senaryo bible'dan türetilsin. Kelime bütçesi sabit çarpan değil: seçili
 
sesin geçmiş çıktılarından ölçülmüş kelime/sn değeriyle hesaplanır (alignment
 
verisi yoksa mevcut 80-90 kelime hedefi sürer).
4. Critic: ayrı Gemini çağrısı (düşük temperature, hafif model seçilebilir),
 
JSON {pass, issues}. En fazla 2 düzeltme turu; olmazsa needs_review ve yayın
 
klasörüne düşmez. Chaos için nedensellik kuralı: rüya, tesadüf, açıklamasız
 
olay tek başına çözüm olamaz.
5. Kod doğrulayıcıları: narration'da köşeli parantez yok; kelime/süre
 
bütçesi; hook <= 7 kelime; bible karakter id'leri geçerli.
6. Doğruluk: is_fiction=false ancak doğrulanabilir kaynakla olur (Google
 
Search grounding); yoksa kurguya çevir. Gerçek kişiye suçlayıcı kesin ifade
 
yok. Therapy: kesin psikoloji iddiası yok.
 
CHAOS_SOURCE=reddit_premise|original uygulansın.
7. Birim testleri ve --dry-run (konu -> critic, ses/görsel maliyeti yok).
8. 10 konu için v1 ve v2 senaryolarını karşılaştıran compare_v1_v2.md üret
 
(kapsam tutarlılığı, hook karşılığı, mekanizma açıklanmış mı).
Kabul: critic'ten geçen senaryolarda kapsam tek, hook'un karşılığı var,
 
mekanizma açıklanmış. Bitince özet ver ve DUR.
Faz 3 prompt: Tempo ve görsel uyum
docs/RECETE.md Bölüm 4, 7, 8, 9 ve AUDIT.md oku. shots_per_scene config'i ve
 
yeni zaman çizelgesi.
1. Beat başına shots_per_scene kadar shot; her shot'ın anchor_words'ü
 
narration'da geçmeli (doğrulayıcı).
2. Shot başlangıcı alignment'taki anchor kelimenin başlangıcına kilitlensin;
 
süre sesten gelsin.
3. Hareket: shot'lara sırayla zoom-in, zoom-out, pan sol, pan sağ; geçiş sert
 
kesme veya <= 0.15 sn.
4. Güvenli alanlar (config'te) ve hook yazısı (yalnızca ilk 3 sn, üst güvenli
 
alanın altında). Hesap adı videoya gömülmez. layout=fullbleed|card
 
(varsayılan şimdilik card, ben karar verene kadar).
5. Kritik anlarda (hook, twist, final) görsel, söylenen ana nesneyi
 
göstersin; Gemini vision ile 8 örnek kare puanlanır, 3 altı shot'lar bir kez
 
yeniden üretilir.
Kabul: 40 sn videoda en az 12 shot; her shot kendi cümlesini görsel olarak
 
karşılıyor; altyazı güvenli alanda. Bitince özet ver ve DUR.
abrikrompt)
Page 
10
 of 
16

===== PAGE =====


Faz 4 prompt: Kuyruk, QC ve anahtarlar
docs/RECETE.md Bölüm 9, 11, 12, 14 ve AUDIT.md oku.
1. qc.json otomatik kapısı (ffprobe, LUFS -15..-13, blackdetect/freezedetect,
 
başta sessizlik, altyazı kontrastı). Geçmeyen iş needs_review olur, yayın
 
klasörüne düşmez.
2. daily_batch config: kanal başına 2 konu, sıralı kuyruk, başarısız işi bir
 
kez otomatik yeniden dene, run_log.jsonl. Gemini anahtar rotasyonu 429'da
 
devreye girsin.
3. UI: iş listesi, aşama durumu, 'şu aşamadan devam et', 'yalnızca şu sahneyi
 
yeniden üret'.
4. Anahtarlar: UI anahtarı sunucuya yalnızca kaydetmek için gönderir; sunucu
 
.env benzeri bir gizli dosyada saklar; sonraki isteklerde anahtar gövdede
 
taşınmaz, localStorage'da tutulmaz, geri dönmez (yalnızca maskeli son 4
 
hane). CORS yalnızca localhost.
5. Birim ve golden testler, README'ye çalıştırma talimatı, CHANGELOG.md.
Kabul: art arda 10 işten en az 9'u QC'yi ilk denemede geçer; hiçbir iş elle
 
müdahale gerektirmez. Bitince özet ver.
FİNAL: Cursor'a tek parça verilecek komple prompt
Aşağıdaki kutunun tamamını kopyala ve Cursor'a (Agent modu) tek mesaj olarak yapıştır.
Bu kutu, yukarıdaki ana prompt'un ve faz prompt'larının yerine geçer; başka bir şey
vermen gerekmez.
ROL
Kıdemli bir video-otomasyon mühendisisin. Projem 'Viral Atölyesi' içindeki
 
'Belgesel Fabrikası' hattını kararlı, bağlamı tutarlı, ses-görüntü-altyazı
 
senkron ve Reels / Shorts / X'e uygun hale getireceksin. Bu mesaj tüm işi
 
anlatır. Faz faz ilerle.
BAĞLAM
Hat: konu → Gemini senaryo → ElevenLabs ses → Pollinations görsel → FFmpeg
 
ile 9:16 video. Günde 6 video: 3 kanal (Epoch Lab: karanlık/alternatif tarih;
 
Chaos Lab: Reddit korku/gizem; Therapy Lab: karanlık psikoloji), kanal başına
 
2.
Önceki denetimden mevcut dosyalar: documentary-factory.js,
 
pollinations_image.py, clean_narration.py, elevenlabs-hook.js, local-
downloader.js (POST /documentary, /documentary-topic, /documentary-voice-
preview), public/index.html ve index.html. İki index kopyasını senkron tut ya
 
da hangisinin yayına gittiğini belirleyip tek kaynağa indir.
Bugünkü davranış: tek Gemini planı 5-6 sahne; sahne başına 1 görsel; süre
 
sesten; 80-90 kelime, yaklaşık 40-50 sn; altyazı drawtext ile sahne sahne
 
yanıyor; müzik 0.07; aynı anda tek iş (__docInProgress).
abrikrompt)
Page 
11
 of 
16

===== PAGE =====


BİLİNEN SORUNLAR (örnek bir çıktının analizinden)
- Başlık, anlatım ve görsel kapsamı tutarsız (krallık / soy / kral). Olayın
 
mekanizması anlatılmıyor. Hook karşılıksız kalıyor. Final cümlesi belirsiz.
- Görseller söylenen cümleye bağlı değil: kritik anlarda (reveal, final)
 
ilgili nesne ekranda yok; 6 sn'lik statik plan; 24 sn'de yalnızca 5 görsel.
- Altyazı geçiş sırasında sönüyor (twist ve final cümlesinde).
- Ses yaklaşık -26 LUFS (çok sessiz).
- Karelerde gezinen küçük bir logo var. Pollinations filigranı olduğunu
 
doğrula.
- Çıktıda video, bulanık arka plan üstünde küçük bir kartta duruyor; üstte
 
hesap adı ve sabit bir hook yazısı var. Bunların belgesel hattından mı yoksa
 
başka bir sekmeden (ör. Telif Ezici sonrası) mı geldiğini doğrula. Başka
 
sekmeden geliyorsa o sekmeye dokunma; belgesel çıktısı o işlemden geçmeden de
 
yayına uygun olsun.
- Başlık spoiler veriyor. Etiketler kanallar arası karışık.
- Gerçek gibi sunulan uydurma suç/psikoloji iddiası riski. Chaos kaynağı
 
Reddit.
KESİN KURALLAR
1. Mix & Derleme, Voice Enjektör, Telif Ezici ve Araçlar sekmelerine /
 
kodlarına DOKUNMA. Belgesel hattına mikro kırpma, hız oynatma, metadata
 
silme, delogo ya da içerik kimliği atlatmaya yönelik hiçbir işlem EKLEME.
 
Pollinations logosunu kaynakta çöz (parametre, kimlik doğrulamalı API ya da
 
başka sağlayıcı seçeneği). Üretilmiş görselin üstünden silme/blur YAPMA.
2. Küçük adımlar. Her madde ayrı commit. Her yeni davranış config bayrağı
 
arkasında; varsayılanlar bugünkü davranışı korur. Eski çıktı yolu
 
(getMixDir()) çalışmaya devam eder.
3. API anahtarları loga, commit'e ya da API yanıtına yazılmaz.
4. Testlerde gerçek API çağrısı yok (mock). Canlı duman testi yalnızca --live
 
bayrağıyla. Maliyetli çağrıları gereksiz çoğaltma.
5. Emin olmadığın dış API ayrıntılarını (Pollinations parametreleri,
 
ElevenLabs endpoint/model özellikleri) tahmin etme; güncel resmi dokümanı
 
oku. Okuyamazsan koda not düş ve güvenli varsayılanı seç.
6. Her fazın sonunda eski akışla (v1) yeni akışı yan yana çalıştırıp
 
karşılaştır; eski akışı bozma.
ÇALIŞMA PROTOKOLÜ
Faz 0'dan başla. Her faz sonunda: testleri çalıştır, kabul kriterlerini tek
 
tek işaretle, CHANGELOG.md'ye 5 satır yaz, commit/tag at, sonra sonraki faza
 
geç. Şu durumlarda DUR ve bana sor: (a) bir karar çıktının görünümünü ya da
 
maliyetini belirgin değiştiriyor ve aşağıda cevabı yok; (b) bir kabul kriteri
 
sağlanamıyor; (c) Faz 2 bittiğinde, compare_v1_v2.md hazır olunca (içerik
 
kalitesini ben değerlendireceğim).
FAZ 0: ÖLÇÜM VE ALTYAPI
- Tek bir config modülü: STORY_PIPELINE=v1|v2 (varsayılan v1),
 
abrikrompt)
Page 
12
 of 
16

===== PAGE =====


OUTPUT_LAYOUT=legacy|jobs (legacy), CHAOS_SOURCE=reddit_premise|original
 
(reddit_premise), duration_range (kanal başına; varsayılan bugünkü),
 
shots_per_scene (1), layout=card|fullbleed (card), TTS_MODEL, STYLE_SUFFIX
 
(kanal başına), safe_area (üst 250, alt 450, sağ 120 px; yaklaşık değerler,
 
uygulama önizlemesiyle doğrulanacak).
- Ölçüm komutu: bir mp4 için ffprobe + ebur128 (LUFS, true peak) +
 
blackdetect/freezedetect + süre/fps/çözünürlük çıktısı veren JSON üretir (qc
 
measure). Elimdeki bir çıktıyla baseline.json üret.
- Birim test altyapısı ve --dry-run iskeleti.
FAZ 1: DAYANIKLILIK (videonun görünümü değişmez)
1. jobs/<YYYYMMDD>_<kanal>_<slug>/ klasörü ve status.json (stage, state:
 
pending|running|done|failed|needs_review, attempts, error, zaman damgaları).
 
Ara dosyalar iş bitince silinmez; jobs/ içinde kalır (eski geçici klasör
 
davranışı OUTPUT_LAYOUT=legacy ile sürer). Son mp4 her durumda getMixDir()
 
altına da kopyalanır.
2. Aşama sırası: topic → bible → script → critic → tts → images → timeline →
 
render → qc → metadata. Girdi hash'i aynıysa aşama atlanır; 'şu aşamadan
 
devam et' ve 'yalnızca şu sahneyi yeniden üret' API'leri (local-
downloader.js).
3. Önbellek: ElevenLabs (hash: metin + ses + model + ayarlar) ve Pollinations
 
(hash: prompt + seed + model).
4. ElevenLabs üretimde: 3 denemeli üstel geri çekilme, 401 / 429 / kota
 
ayrımı, üretimden önce kalan karakter kontrolü, yedek ses tanımı.
 
voice_direction köşeli parantez olarak metne girmesin; model destekliyorsa
 
uygun biçimde, desteklemiyorsa voice_settings'e (stability, style, speed)
 
çevrilsin.
5. Pollinations: video başına sabit seed tabanı (shot seed = taban + indeks),
 
hatada farklı seed ile yeniden deneme, timeout 60 sn, aynı anda en fazla 2-3
 
istek, model/sağlayıcı fallback. Logo/watermark kaynakta kapatılır. Görsel
 
doğrulama: 1080x1920, boş/tek renk değil, bir öncekine perceptual hash ile
 
çok benzemiyor.
6. Son karışıma loudnorm iki geçişli: I=-14, TP=-1.5, LRA=7. Müzik/konuşma
 
oranı (0.07) DEĞİŞMEZ. Konuşma ilk kareden başlasın (baştaki boşluk <= 0.2
 
sn).
7. Altyazı: sahneleri geçişlerle birleştirdikten SONRA tek geçişte ASS ile
 
kelime kelime bas (mevcut görünüme yakın: kalın beyaz, siyah kontur + gölge,
 
1-3 kelimelik parçalar). Geçişlerde sönmemeli.
8. metadata.json: kanal için başlık (spoiler YOK), açıklama, 3-5 kanala özel
 
hashtag (Epoch: dark history, mystery; Chaos: creepy, horror; Therapy:
 
psychology, dark psychology; kanallar arası karışma), platform varyantları
 
(Reels / Shorts / X), AI/sentetik içerik bayrağı. Dosya adı
 
YYYYMMDD_kanal_slug.mp4; hashtag dosya adına girmez.
9. Kodlama: 1080x1920, 30 fps sabit, libx264 yuv420p, CRF 18-20, +faststart,
 
AAC 192k. Koyu sahnelerde bantlanmayı azaltmak için hafif gölge açma (eq
 
gamma yaklaşık 1.05-1.1) ve düşük grain dene; değerleri config'e yaz.
abrikrompt)
Page 
13
 of 
16

===== PAGE =====


Kabul: aynı konu iki kez çalıştırılınca ikinci seferde önbellekten gelir; tek
 
Pollinations/ElevenLabs hatasında iş kendini toparlar; altyazı geçişlerde
 
sönmez; ölçüm -14 ±1 LUFS verir; eski çıktı yolu çalışır.
FAZ 2: BAĞLAM (STORY_PIPELINE=v2, v1 aynen kalır)
1. Konu: kullanıcı konusu aynen kullanılır. Rastgele konu Gemini structured
 
output (JSON schema) ile gelir. topic_history.jsonl son 200 konuyu tutar;
 
benzerlik yüksekse reddet ve yeniden üret.
2. Story bible (ayrı Gemini çağrısı, temperature ~0.7, structured JSON).
 
Alanlar:
   
logline; is_fiction (true|false); scope (tek ana varlık,
 
başlık/anlatım/görsel hep bunu kullanır); setting {place, era, mood};
 
characters [{id, role, visual_descriptor}] (sabit görsel tarif);
 
core_mechanism (olayın fiziksel işleyişi: kim, nasıl, ne zaman, kurban nasıl
 
etkilendi); hook; planted_clue; twist; final_line (mümkünse ilk cümleye
 
bağlanan döngü); forbidden [başlıkta spoiler, kapsam değişimi, yeni karakter
 
ekleme, cevapsız soru].
   
core_mechanism boş ya da unknown ise bible reddedilir ve yeniden üretilir.
3. Senaryo bible'dan türetilir; bible dışında yeni olgu eklemez. Beat yapısı:
 
hook (ilk 2.5 sn, merak uyandırır, spoiler vermez; <= 7 kelime) → setup →
 
escalation → twist (planted_clue'nun karşılığı) → close. Her beat: narration
 
(1-2 cümle, köşeli parantez YOK), voice_direction (ayrı alan), shots
 
[{visual_prompt, anchor_words, location_id, character_ids}].
4. Kelime bütçesi sabit çarpanla değil, seçili sesin geçmiş çıktılardan
 
ölçülmüş kelime/sn değeriyle hesaplanır (alignment yoksa bugünkü 80-90 kelime
 
hedefi sürer). Gemini'nin yazdığı zaman aralıkları KULLANILMAZ; süre sesten
 
gelir.
5. Görsel kuralları: visual_prompt = shot içeriği + karakter descriptor'ları
 
(aynen tekrar) + kanal STYLE_SUFFIX. Görselde yazı/logo/altyazı olmasın.
 
Söylenen ana nesne/eylem görselde olsun (ink deniyorsa mürekkep yakın plan,
 
page burned deniyorsa yanan sayfa). Soyut duygu (panic, fear) için boş mekan
 
yerine insan silueti veya tepki kullan.
6. Critic (ayrı Gemini çağrısı, düşük temperature, hafif model seçilebilir):
 
bible + senaryo alır, JSON {pass, issues:[{type, beat, fix}]} döner. Kontrol:
 
kapsam tutarlılığı; hook karşılığı; mekanizma açıklanmış mı; zaman/mekan
 
çelişkisi; cevapsız soru; başlıkta spoiler; kelime bütçesi; gerçek kişiye
 
suçlayıcı iddia; Chaos için nedensellik (rüya, tesadüf, açıklamasız olay tek
 
başına çözüm olamaz). pass=false ise düzeltmeyle yeniden yaz (en fazla 2
 
tur). Olmazsa iş needs_review olur ve yayın klasörüne düşmez.
7. Kod doğrulayıcıları (LLM'e güvenme): narration'da köşeli parantez yok;
 
kelime/süre bütçesi; her anchor_words narration'da geçiyor; karakter id'leri
 
bible'da var; hook <= 7 kelime.
8. Doğruluk: is_fiction=false ancak doğrulanabilir kaynakla olabilir (Google
 
Search grounding); yoksa hikayeyi kurgu olarak yeniden yaz. Gerçek
 
kişi/aile/dava hakkında suçlayıcı kesin ifade yok; anonimleştir, 'dramatize
 
edilmiş / ilham alınmış' çerçevesi kullan, anlatımda bu gerçekten oldu deme.
 
abrikrompt)
Page 
14
 of 
16

===== PAGE =====


Therapy: kesin psikoloji iddiası yerine araştırmalar bazı durumlarda dili;
 
uydurma çalışma/isim yok.
9. CHAOS_SOURCE=reddit_premise: Reddit gönderisinden yalnızca fikir al; yeni
 
karakterler, yeni olay sırası, birebir cümle yok, kullanıcı adı/kimlik
 
bilgisi yok. CHAOS_SOURCE=original: Reddit kullanmadan özgün kurgu. Reddit'in
 
güncel API şartlarını ve ticari kullanım koşullarını koda not olarak ekle
 
(hukuki tavsiye değildir).
10. Çeşitlilik: en az 6 hikaye şablonu; aynı kanalda aynı gün aynı şablon
 
veya ses tekrarlanmasın; görsel palet rotasyonu.
11. Gemini prompt şablonları (İngilizce):
   
Bible: You are a story architect for vertical short videos. Channel:
 
{channel}. Topic: {topic}. Return JSON matching the schema. One scope entity
 
only; explain the physical mechanism of the key event; exactly one hook, one
 
planted clue, one twist, one final line; the hook must not reveal the twist;
 
if real people or real crimes are involved set is_fiction=false only when
 
verifiable, otherwise write a clearly fictional version with invented names.
   
Script: Using ONLY the story bible, write beats (hook, setup, escalation,
 
twist, close). Narration is plain spoken text with no brackets or stage
 
directions. Target {words} words. Every shot must visually show the main noun
 
or action of the sentence it starts on. Reuse character visual_descriptors
 
verbatim. No text, logos or captions in images. Never introduce facts,
 
characters or places that are not in the bible.
   
Critic: You are a strict script editor. Compare the script to the bible
 
and return JSON {pass, issues:[{type, beat, fix}]}. Fail if: scope changes
 
between title, narration and visuals; the hook is never paid off; the key
 
mechanism is unexplained; places or times contradict; a question is left
 
unanswered; the title spoils the twist; a real person is accused of a crime
 
as fact; the resolution relies on a dream, coincidence or unexplained event
 
alone.
12. Birim testleri ve --dry-run (konu → critic; ses/görsel maliyeti yok). 10
 
konu için v1 ve v2 senaryolarını karşılaştıran compare_v1_v2.md üret (kapsam
 
tutarlılığı, hook karşılığı, mekanizma açıklanmış mı).
Kabul: critic'ten geçen senaryolarda kapsam tek, hook'un karşılığı var,
 
mekanizma açıklanmış. Bu fazın sonunda DUR ve compare_v1_v2.md'yi bana
 
göster.
FAZ 3: TEMPO VE GÖRSEL UYUM
1. shots_per_scene config'i: beat başına 2-3 shot. Her shot'ın anchor_words'ü
 
narration'da geçmeli (doğrulayıcı). Pollinations istek sayısı artacağı için
 
süre ve maliyeti raporla.
2. timeline.json: shot başlangıcı = anchor kelimenin alignment'taki
 
başlangıcı; bitişi = sonraki shot'ın başlangıcı. Son shot ses bitiminden 0.4
 
sn sonra biter. Süre Gemini'den değil sesten gelir.
3. Hareket: shot'lara sırayla zoom-in, zoom-out, pan sol, pan sağ. Geçiş:
 
sert kesme ya da <= 0.15 sn çapraz geçiş.
4. Güvenli alanlar (safe_area config'inden): altyazı dikey konumu yaklaşık
 
abrikrompt)
Page 
15
 of 
16

===== PAGE =====


%58-66 (y 1100-1270). Varsa hook yazısı yalnızca ilk 3 sn görünür ve üst
 
güvenli alanın altında durur. Hesap adı videoya gömülmez.
 
layout=fullbleed|card: iki örneği yan yana üretip bana sun (varsayılan
 
şimdilik card).
5. Kritik anlarda (hook, twist, final) görsel söylenen ana nesneyi
 
göstermeli. Gemini vision ile eşit aralıklı 8 kare + senaryo → her karenin
 
cümleyi karşılama puanı (1-5); 3 altı shot'lar bir kez yeniden üretilir.
Kabul: 40 sn videoda en az 12 shot; her shot kendi cümlesini görsel olarak
 
karşılıyor; altyazı güvenli alanda; geçişlerde sönmüyor.
FAZ 4: KUYRUK, QC VE ANAHTARLAR
1. qc.json otomatik kapısı: ffprobe (1080x1920, 30 fps, süre kanal
 
aralığında, ses var); LUFS -15..-13, true peak <= -1; başta sessizlik <= 0.3
 
sn; blackdetect/freezedetect temiz; shot sayısı >= süre/3; altyazı bölgesi
 
kontrastı. Geçmeyen iş needs_review olur ve yayın klasörüne düşmez.
2. daily_batch config: kanal başına 2 konu, sıralı kuyruk (aynı anda 1 iş;
 
görsel istekleri sınırlı paralel), başarısız işi bir kez otomatik yeniden
 
dene, run_log.jsonl. Gemini anahtar rotasyonu 429'da otomatik sonraki
 
anahtara geçip aynı aşamayı tekrar denesin.
3. UI: iş listesi, aşama durumu, 'şu aşamadan devam et', 'yalnızca şu sahneyi
 
yeniden üret'. Aynı UI iki index kopyasında da çalışsın.
4. Anahtarlar: UI anahtarı yalnızca kaydetmek için sunucuya gönderir; sunucu
 
gizli bir dosyada saklar (.env benzeri, gitignore'da); sonraki isteklerde
 
anahtar gövdede taşınmaz, localStorage'da tutulmaz, UI'a geri dönmez
 
(yalnızca maskeli son 4 hane). CORS yalnızca localhost. Loglarda anahtarlar
 
maskeli.
5. Birim ve golden testler (sabit fixture ile timeline üretimi), README'ye
 
çalıştırma talimatı.
Kabul: art arda 10 işten en az 9'u QC'yi ilk denemede geçer; hiçbir iş elle
 
müdahale gerektirmez; tek bir dış servis hatasında iş kendini toparlar.
GLOBAL KABUL VE TESLİM
- Ölçüm: -14 ±1 LUFS; 1080x1920 / 30 fps; altyazı geçişlerde sönmüyor;
 
hook'un karşılığı var; kapsam tek; mekanizma açıklanmış.
- Teslim: her faz için commit/tag, CHANGELOG.md (faz başına 5 satır), README
 
çalıştırma talimatı, baseline.json ile son ölçümün karşılaştırması.
- Her faz sonunda ne değiştiğini 5 satırda özetle.
abrikrompt)
Page 
16
 of 
16