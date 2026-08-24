# Changelog

Bu proje [Keep a Changelog](https://keepachangelog.com/) biçimini izler.

## Yayınlanmamış: 2026-08-24

Bir denetim turunun ardından güvenlik sertleştirmeleri ve arayüz düzeltmeleri.
Kontratın bytecode'u değişmedi (yalnızca NatSpec); değişen SDK, backend, demo-kit
ve uygulama.

### Güvenlik

- **Co-signer artık kutunun sahibini doğruluyor.** Deployed bir kutuda zincir
  üstünde owner tutulmadığı için, yabancı biri herhangi bir kutunun adresini verip
  geçerli bir co-signature alabiliyordu: para kilitli target'a gider ama abonelik
  sahibinin rızası olmadan sürülebiliyordu. Yeni `AccountOwnerIndex` fabrikanın
  `AccountCreated` olayındaki `ownerHash`'i indeksliyor; imza fazı, iddia edilen
  owner'ı kutunun ownerHash'iyle karşılaştırıp tutmazsa imzayı vermiyor.
- **Firewall, veri kaynağı düşünce artık fail-closed.** Doğrulanmış-alıcı indeksi
  cevap vermeyince istemci sınırlı bir pencereye (200k blok, kabaca bir gün)
  düşüyor ama raporu yine "tam" sayıyordu, yani o pencereden eski bir alıcının
  benzeri "güvenli" geçebiliyordu. Sınırlı tarama artık eksik işaretleniyor,
  lookalike kuralı çalışamamış sayılıp bilinmeyen hedef bloklanıyor.
- **İmza tekrar koruması ECDSA malleability'ye kapatıldı.** Tek kullanımlık nonce
  ham imza byte'ından türetiliyordu; `s -> n-s` ikizi aynı imzacıyı aynı mesaj için
  recover ettiği halde farklı byte üretip kontrolü atlıyordu. Nonce artık recover
  edilen imzacı ve imzalanan mesaj üzerinden.
- **Sıfır değerli bait taraması sayfalanıyor.** Tek sayfa okunuyordu; saldırgan
  bait'i bir dizi sıradan transferle ilk sayfanın dışına itebiliyordu. Artık
  benzer geçmiş taraması gibi sayfa sayfa geziliyor.
- **`sweepExpired` artık yalnızca vault'un kendisi çağırabiliyor.**
  `SpendPolicyAccount` Arc'ta yeniden deploy edildi (factory
  `0x9B3b3057...2161`): eskiden vault'u commitment'tan çözen bir yabancı
  `sweepExpired(vault)` ile vault-kutu bağını zincire yazdırabiliyordu; artık
  `msg.sender == vault` şart. Deploy mevcut kutular için güvenli: `pay`/`pull`
  calldata'ları değişmedi, ve co-signer'ın owner-bind indeksi artık eski
  factory'yi de tarıyor, yani mevcut abonelikler tanınmaya devam ediyor (deploy
  öncesi uçtan uca doğrulandı). Co-signer imza deadline'ı ertelendi: calldata'yı
  değiştirdiği için eski kutuları bozardı, ayrı bir sürüm-tespiti katmanı gerekiyor.

### Düzeltildi

- **CCTP köprüsünde bakiye üstü tutar önden engelleniyor.** Bakiyeden fazla
  girildiğinde Bridge butonu açık kalıyor, hata ancak yakma imzalandıktan sonra
  görünüyordu. Gateway'deki gibi bir eksik uyarısı ve tek tıkla düzelten buton
  eklendi.
- **Activity satırında butonun içindeki buton kaldırıldı.** Kopyala butonu satır
  butonunun içindeydi, geçersiz HTML üretiyordu ve kopyalayınca satırın detayı da
  açılıyordu. Satır başlığı artık `role="button"` bir öğe, kopyala tıklaması satırı
  açmıyor, klavye ile yine açılıp kapanıyor.
- **Activity ekranı erişilebilirlik.** Sıralama chip'i sayfa zeminine karışıyordu,
  görünür bir kenar aldı; tarih girişi ve makbuz linki tap hedefi 24 pikselin
  altındaydı, büyütüldü; ışık temasında vurgu rengi link ile alt bilgi metni
  kontrast eşiğinin altındaydı, düzeltildi.
- **Private Pay açıklaması gerçeğe hizalandı.** Metin "zincirde kimliğinden iz
  taşımayan adres" diyordu ama besleme transferinin görünür kaldığını söylemiyordu;
  artık söylüyor. Akış aynen çalışıyor.
- **`/api/health` her istekte zinciri okumuyor.** Uç metrelenmediği için her
  yoklama taze bir zincir okumasıydı; artık bakiye birkaç saniye önbelleklenir.
- **NatSpec düzeltmeleri.** `CtrlArcZ.sol` hala "6 haneli kod" diyordu; claim
  secret 16 karakter, 80 bit. Blok hızı ve zaman aşımı yorumları ölçülen değerlere
  çekildi.

### Test

- 5 yeni regresyon testi (toplam 742'den 747'ye): sınırlı doğrulanmış-alıcı
  taramasının fail-closed bloklaması ve tam listenin aşırı-bloklamaması (SDK);
  `AccountOwnerIndex`'in kutuyu ownerHash'e eşlemesi ve bilinmeyen kutuya null
  dönmesi (SDK); imza tekrarında ECDSA-malleable ikizin reddi (api).

## Yayınlanmamış: 2026-08-22

Cüzdan hatası artık ekrana sayfa değil, cümle olarak çıkıyor. SDK'ya dokunulmadı;
değişen yalnızca uygulama ve demo-kit.

### Değişti

- **Hatalar sınıflandırılıyor, ham metin basılmıyor.** Onay ekranında "iptal"
  demek, viem'den istek argümanları, çözülmüş kontrat çağrısı, docs linki ve
  sürüm satırıyla birlikte bir sayfa döndürüyordu; ekranların on altı yerinde bu
  sayfa olduğu gibi bildirim olarak basılıyordu. `classifyFailure` semptomu
  okuyor (EIP-1193 kodu, hata adı veya her istemcinin kullandığı ifade) ve on
  sınıftan birine bağlıyor: reddedildi, bakiye, allowance, nonce, hız sınırı,
  ağ uyuşmazlığı, zaman aşımı, bağlantı, gas, revert. Tanımadığını uydurmuyor,
  hatanın kendi ilk satırını gösteriyor. Tam metin konsolda duruyor.
- **Kullanıcının kendi iptali kırmızı alarm değil.** İmzayı reddetmek bir cevap;
  cüzdan bozulmuş gibi göstermek yanlıştı.
- **Bildirim hangi adım olduğunu söylüyor.** Bir deposit üst üste iki imza
  istiyor, "iptal ettiniz" hangisi olduğunu söylemeden eksik kalıyordu.
- **Satırda cümle değil sınıf saklanıyor.** Kayıt, hatanın yaşandığı dilden uzun
  yaşıyor: İngilizce başarısız olan bir satır Türkçeye geçilince Türkçe okunuyor.
  Cüzdanın kendi sözleri ayrı bir satırda, detay görünümünde duruyor.

### Düzeltildi

- **CCTP'de yanlış adım suçlanıyordu.** SDK bir adımı bittiğinde bildiriyor, yani
  `reported`'ın sonuncusu **çalışan** son adım. Satır onu hatalı işaretliyordu:
  yakma reddedildiğinde, zincire çoktan yazılmış onay "başarısız" görünüyordu.
  Artık bildirilmemiş ilk adım suçlanıyor.
- **Onay hash'i kayboluyordu.** Satır yakma onaylanana kadar yeniden yazılmadığı
  için, onay mine olup yakma reddedildiğinde satırda işlemsiz bir onay kalıyordu.

### Test

- 20 yeni demo-kit testi: gerçek MetaMask reddi (Base Sepolia'daki tam metniyle),
  hız sınırı, iç içe cause, ethers'ın string kodu, kendini gösteren cause,
  `[object Object]`, iki dilde cümle. demo-kit 146, repo toplamı 742.
- Tarayıcıda: onay reddi ve yakma reddi ayrı ayrı, gerçek viem sarmalamasıyla;
  dil değiştirilince aynı satırın Türkçeye dönmesi.

## [0.2.1]: 2026-08-22

Tek sayı düzeltmesi, ama o sayı Arbitrum Sepolia'yı kullanılmaz yapıyordu. API
değişmedi.

### Düzeltildi

- **Arbitrum Sepolia'nın deploy bloğu yanlıştı: 11509330 yerine 299143893.**
  Deploy script'i bloğu `block.number` ile kaydediyor, Arbitrum'da ise o değer
  L1 bloğu. Bu zincir Ethereum Sepolia ile aynı dakikada çıktığı için deftere
  Sepolia'nın yüksekliği yazılmıştı. `deploymentFor(421614)` bunu okuyan her
  tarama 289 milyon blok geriden, onar binlik parçalarla başlıyordu: duyurular
  ve geçmiş o zincirde hiç dönmüyordu. Yeni değer broadcast makbuzundan alındı,
  `CodeClaimVerifier`'ın indiği blok, yani iki olay kaynağını da kapsıyor.
  Diğer dört zincirin blokları makbuzlarla karşılaştırıldı, hepsi doğru.
- **`DeployChain.s.sol` bir daha aynı şeyi yazmıyor.** Blok numarasını ArbSys
  (`0x64`) precompile'ına soruyor, cevap gelmezse `block.number`'a düşüyor. 0x64
  başka hiçbir zincirde kod tutmadığı için ayrıca zincir listesi tutmak
  gerekmiyor.

## [0.2.0]: 2026-08-21

`0.1.2`'den bu yana SDK tek zincirden çıkıp beş zincire yayıldı, kayıt defteri
kazandı ve köprü artık ücreti imzadan önce söylüyor. Kırıcı değişiklik yok: eski
çağrıların hepsi aynı imzayla çalışıyor.

### Eklendi

- **Zincir kayıt defteri.** `deploymentFor(chainId)`, `deployedChainIds()`,
  `DEPLOYMENTS`: bir zincirde ne varsa (kontratlar, USDC, RPC'ler, explorer) tek
  yerden. `ADDRESSES` ve `CTRL_ARCZ_ADDRESS` duruyor ama artık yalnızca Arc'ı
  anlatıyor; başka zincirde doğru cevabı veren kayıt defteri.
- **Zincir başına token listesi.** `tokensFor(chainId)`,
  `spendableTokensFor(chainId)`: aynı sembol her ağda başka bir kontrat, o yüzden
  liste zincire bağlı. Adres, ondalık ve arama adları dahil.
- **Tek işlemlik Private Pay.** `PrivatePayRouter` ile Permit2 üzerinden
  oluştur + fonla + öde, Arc dışındaki dört zincirde tek işlemde.
- **`bridgeFromWallet` artık `onQuote` alıyor.** Ücret sonuçta da dönüyor ama
  sonuç işlem bitince geliyor: yani satır dakikalarca ücreti söyleyemiyordu.
  `onQuote`, Circle fiyatı verir vermez ve **hiçbir şey imzalanmadan önce**
  tetikleniyor. Opsiyonel; mevcut imza değişmedi.
- **`readAccount` kutunun token'ını da dönüyor.** Kutunun yanındaki her rakam onun
  cinsinden, ve bunu çağırana sordurmak Arc'ın USDC'sini başka zincirde okumaya
  çalışan bir hata sınıfı üretiyordu.

### Değişti

- **Co-signer ve relayer zincir-bağımsız.** Her giriş noktası `chainId` alıyor,
  kayıttan çözüyor, deployment'i olmayan zinciri reddediyor. Policy o zincirin
  RPC'sinden okunuyor ve imza o zincirin id'sini EIP-712 domain'ine koyuyor.
- **`rpcUrls` artık tarayıcıda da kullanılıyor.** Eski not "yalnızca sunucu için"
  diyordu; MetaMask'in site başına istek bütçesi yüzünden genel okumalar zincirin
  kendi uçlarına taşındı. Kimlik, bağlı zincir ve imzalar cüzdanda kaldı.

### Test

- 384 SDK testi (`onQuote`'un ilk imzadan önce tetiklendiği ve sonuçla aynı rakamı
  verdiği dahil), 123 Foundry, 126 demo-kit, 56 api, 33 keeper: toplam 722.
- Gerçek testnet: aynı cüzdandan aynı anda başlatılan bir Gateway deposit ve bir
  CCTP köprüsü; beş işlemin beşi de zincirde onaylı, mint Ethereum Sepolia'da.

## 0.2.0 içinde: 2026-08-19

Kutular Arc dışında da açılıyordu ama listede görünmüyorlardı.

### Düzeltildi (Arc dışı okumalar)

- **Arc dışındaki zincir okumaları cüzdandan geçmiyor artık.** Base'de Gateway'e
  para yatırmak `approve` sırasında şu hatayla düşüyordu: `eth_getBlockByNumber:
Request is being rate limited`. Sebep kontratta değil: MetaMask bir siteyi,
  `window.ethereum` üzerinden yaptığı istek sayısıyla kısıtlıyor ve tek bir işlemi
  hazırlamak tek bir istek değil (ücret, nonce, gaz; üstelik önce approve sonra
  gönderim). Repo bunu Arc için çoktan çözmüş ve gerekçesini yazmış: _"None of
  those reads need the wallet."_ Arc dışına hiç uygulanmamıştı. Artık aynı ayrım
  her zincirde: kimlik, bağlı zincir kimliği ve bütün imzalar cüzdanda kalıyor,
  genel zincir okumaları o zincirin kayıttaki uçlarına gidiyor. Taşıyıcı zincir
  başına bir kez kuruluyor, eskiden her okumada yeniden kuruluyordu. Üretilerek
  doğrulandı: her okumayı "Request is being rate limited" ile reddeden bir cüzdanla
  bile ekran çalışıyor ve cüzdana yalnız `eth_accounts`, `eth_chainId` ve
  `personal_sign` soruluyor. Bu, `rpcUrls`'in "yalnız sunucu için" olduğu notunu
  geçersiz kılıyor; not da güncellendi.

### Değişti

- **"Cüzdan bakiyesi" okunamayınca artık sebebini söylüyor.** Etiketin yanı bomboş
  kalıyordu: değer `null` olunca yerini tutan gri çubuk açık temada zemine karışıyor
  ve ekranda bir hata varmış gibi duruyor. İki farklı sebep var ve yalnız biri
  yazılıydı. Cüzdan başka ağdaysa bunu söyleyen bir satır zaten vardı; cüzdan doğru
  ağda olup okumayı cevapsız bıraktığında ise hiçbir şey yazmıyordu. Bu durum
  üretilerek doğrulandı: `eth_call`'a `0x` dönen bir sağlayıcıyla etiketin yanı
  boşalıyor, düzgün bir sağlayıcıyla 57.9 USDC okunuyor. Okuma 15 saniyede bir
  tekrarlandığı için satır cüzdan toparlayınca kendiliğinden kayboluyor.
- **Abonelik formu, oluşturamayacağı ağda hiç görünmüyor.** Ağ uyarısı yalnız
  listenin içindeydi; üstündeki form ise Fuji'de eksiksiz duruyordu: satıcı, tutar,
  aralık, fiyatlanmış Circle ücreti ve aktif bir "Create subscription" butonu.
  Kullanıcı formu doldurup butona bastığında, stealth anahtarı için bir imza attıktan
  sonra reddediliyordu. `NeedsChain`'in var oluş sebebi bu: doldurulabilen ama
  gönderilemeyen bir form, kullanıcının dikkatini harcadıktan sonra haber veriyor.
  Uyarı artık formun yerinde duruyor, listedeki ikinci kopyası kaldırıldı.
- **Abonelik listesi zincirler arasında sızıyordu.** Tanınan kutuların önbelleği
  yalnız cüzdan adresiyle anahtarlanmıştı, oysa bir kutu tek bir zincirde yaşıyor.
  Ağ değiştirince liste, o ağda var olmayan kutularla yeniden dolduruluyordu: Fuji'de
  Arc'ın abonelikleri sayılıyordu ("All 16, Active 6") ve ancak her okuma tek tek
  başarısız oldukça boşalıyordu. Anahtar artık zincir + cüzdan. Aynı yerde bir sabit
  daha vardı: tarama imleci Arc'ın announcer deploy bloğuna düşüyordu, artık o
  zincirin kendi bloğuna düşüyor.
- **Al ekranı artık yalnız bir gönderimin başlayabileceği ağlarda açık.** Claim
  hiçbir şeyi yargılamıyor ve geçmiş kaynağına ihtiyacı yok; kontratın kendi
  log'larını RPC'den okuyor, Blockscout'tan değil. Kapısız olmasının sebebi buydu.
  Ama bir transfer, gönderim tarafının reddettiği bir zincire ulaşamıyor: firewall'un
  geçmiş kaynağı olmayan yerde `sendProtected` de fail-closed reddediyor. Fuji'de
  ortaya çıkan şey, hiçbir zaman dolamayacak bir sekmeydi. Artık orada hangi ağa
  geçileceğini söylüyor. Kapatmanın parayı kilitlemediği doğrulandı: talep edilmeyen
  transfer süresi dolunca `reclaimExpired` ile gönderene dönüyor ve bu çağrı
  izinsiz, ayrıca iptal hiçbir ağ sorusu sormuyor. Gönderene iade listesi de kapının
  dışında kaldı, yalnız claim formu kapandı.

### Düzeltildi

- **Abonelik listesi kutunun kendi token'ını okuyor.** Bakiye, modül seviyesinde
  sabitlenmiş Arc USDC'sinden (`0x3600...`) okunuyordu; istemci ise cüzdanın
  bulunduğu zincire bakıyordu. O adres Base'de kontrat bile değil, dolayısıyla
  okuma yanlış bir sayı döndürmüyor, **fırlatıyordu**; satırın etrafındaki `catch`
  onu `null`'a çeviriyor ve içinde parası olan bir abonelik ekranda hiç
  görünmüyordu. Base'deki gerçek kutuyla ölçüldü
  (`0x7da74e31873dEbb59bD006512B01F0f107f55927`): `token()` Base USDC'sini
  veriyor, yeni yol 50000 birim bakiye okuyor, eski yol
  `returned no data ("0x")` ile patlıyor. Token artık `readAccount`'un döndürdüğü
  politikanın parçası, çünkü kutunun yanındaki her rakam onun cinsinden ve onu
  çağırana sordurmak er geç yanlış cevabı almak demek.
- **Token bakiyeleri cüzdanın zincirinden okunuyor.** `useTokenBalances` Arc'a
  çivili istemciyi kullanıyor ve "bu USDC mi" sorusunu Arc'ın adresiyle
  soruyordu. Arc dışında bu iki şeyi birden bozuyordu: zincirin gerçek USDC'si
  testten geçemeyip yeniden okunmaya gidiyor (ve yanlış zincirde bulunamıyor),
  oturumun zaten çekmiş olduğu bakiye ise hiçbir satırla eşleşmediği için
  düşüyordu. Okunacak bir şey kalmadığında `attempted` artık `true`: Arc dışında
  kayıtta yalnız USDC var ve onun bakiyesi zaten oturumdan geliyor, bayrak `false`
  kalsaydı hiç gelmeyecek bir rakam için sonsuza kadar ışıldardı.

## 0.2.0 içinde: 2026-08-18

Abonelik sayfası Circle'ın ücretini okuyamıyordu ve "Abonelik oluştur" butonu
kilitli kalıyordu. İkisi de tek bir kökten geliyordu.

### Düzeltildi

- **Abonelik kutusu artık kendi zincirinde fonlanıyor.** Kutu, cüzdanın bulunduğu
  zincire deploy oluyor; ondan sonraki her adım ise Arc yazıyordu. Dört yerde:
  policy'nin token'ı Arc'ın USDC'siydi (`0x3600...`, başka hiçbir zincirde bir şey
  değil), fonlanabilirlik kontrolü Arc'a pinli istemciden okuyordu, Gateway'in
  hedefi sabit `Arc_Testnet`'ti ve paranın gelişi yine Arc'tan bekleniyordu. Hepsi
  bir zamanlar doğruydu, kutular yalnız Arc'ta yaşarken. Base, Ethereum ve Arbitrum
  Sepolia'ya çıktıktan sonra kalan şey, kutusu bir zincirde fonlaması başka zincirde
  olan bir abonelikti. Zincir artık tek yerde türetiliyor ve dördü de onu kullanıyor.
  `fundBoxFromGateway`'in `to` alanı zorunlu oldu, varsayılanı yok: varsayılan,
  çağıranın hangi zinciri kastettiği hakkında ikinci bir görüştü ve kutu adresini
  elinde tutan çağırandı.
- **Kutu fonlamasının canlı testi eklendi** (`testnet.boxfunding.test.ts`,
  `INTEGRATION=1`). Base Sepolia'da gerçek parayla: mint kutuya düşüyor, tutar tam
  geliyor (ücret Gateway bakiyesinden çıkıyor, kutudan değil), **aynı adres Arc'ta
  boş kalıyor**, ve kesilen bir bekleme hiçbir şey kaybettirmiyor çünkü Circle'ın
  transfer id'si beklemeden önce elde oluyor. Ayrıca fonlanmamış adrese, farklı
  policy'li kutuya ve bakiyenin yetmediği duruma imza atılmadan hayır deniyor.
  Ölçümle çıkan iki şey: Circle'ın `/v1/transfer` durumu kendi mint'inin gerisinde
  kalıyor (para kutudayken hâlâ `pending` diyordu, fonlama bu yüzden bakiyeye
  bakarak yargılanıyor), ve zincirin kaydettiği fonlama satırı sıfır adresten bir
  **mint**, yani Circle'ın minter'ı bile gönderen olarak görünmüyor.
- **`docs/privacy.md` kanıt olarak yanlış kutuyu gösteriyordu.** Sayfadaki Arc
  kutusu Gateway fonlamasından on iki gün önce, 2026-07-28'de fonlanmış ve zincirdeki
  kaydı hâlâ `payer -> box`. "Beşinin hiçbiri ödeyenin adresini taşımaz" cümlesinin
  altında, tam da kapatıldığı söylenen sızıntıyı belgeliyordu. Yerine 2026-08-18'de
  Base'de ölçülen kutu ve tx'i kondu, eski örnek ise silinmek yerine ne olduğu
  yazılarak bırakıldı.
- **Ücret de gideceği rotaya göre fiyatlanıyor.** Arc hedefine sorulan fiyat Base
  hedefine ödenen fiyat değil: aynı kutu için 0.050006 ile 0.111868 arasında fark
  var. Ekranda duran rakam başka bir transferin rakamıydı.
- **Gateway gövdelerindeki tutarlar artık sayfanın ortamına emanet değil.** Circle'a
  giden JSON, `typeof v === 'bigint'` sınayan bir `JSON.stringify` replacer'ı ile
  kuruluyordu. `JSON.stringify` bir değerin `toJSON`'ını replacer'dan **önce**
  çağırır, dolayısıyla `BigInt.prototype.toJSON` tanımlayan herhangi bir şey ne
  gönderdiğimize karar veriyor ve replacer'ın eline dokunmaya sebebi olmayan bir
  string geçiyordu. Varsayımsal değil: `${this}n` döndüren bir tarayıcı eklentisi
  `"value":"1000000n"` gönderdi, Circle "Must be a valid positive integer string"
  ile reddetti, ve o tarayıcıda abonelik sayfası ne fiyatlanabildi ne de kutu
  açabildi. Tutarlar artık `JSON.stringify` bir bigint görmeden önce çevriliyor;
  çevirme `v.toString()` ile değil şablon değişmeziyle yapılıyor, çünkü bigint'te
  ToString içsel bir işlem, `.toString()` ise yeniden tanımlanabilir bir metot. Bu
  hem `/v1/estimate`'i hem asıl fonlamayı yapan `/v1/transfer`'ü kurtarıyor. Depoda
  ve bağımlılıklarında o prototipi yamalayan bir şey yok; sayfa komşularını
  seçemediği için serileştiricinin onlara dayanması gerekiyor. İki test, biri
  `toJSON` biri `toString` yamalı.
- **Bakiye ile ücret ayrı okunuyor.** Abonelik formu ikisini tek bir `Promise.all`
  içinde istiyordu, yani biri patlayınca diğerinin 200 dönen cevabı da çöpe
  gidiyordu. Ücret reddedilince okunmuş bakiye atılıyor, `gwOnSource` null kalıyor
  ve "Abonelik oluştur" bakiyeyle hiç ilgisi olmayan bir sebeple kilitleniyordu.
  Artık `Promise.allSettled`: her okuma kendi sonucunu yazıyor, "Circle'ın ücreti
  okunamadı" satırı yalnız ücret düştüğünde çıkıyor, bakiyenin durumu ayrı bir
  bayrakta. `canCreate` ücretin okunmuş olmasını açıkça şart koşuyor; eskiden bu
  güvence "ikisi birlikte gelir ya da hiç gelmez" kazasına dayanıyordu.

## 0.2.0 içinde: 2026-08-17

Ağ kontrolü header'a taşındı ve Private Pay EURC ile de ödenebiliyor.

### Eklendi

- **Token seçici artık bir modül ve liste ağa göre.** Kayıt zincir anahtarlı
  (`TOKENS_BY_CHAIN`), çünkü aynı sembol her ağda başka bir kontrat; düz bir liste
  ikinci ağ geldiği gün yanlış olur. Adres doğrulanmamış bir zincirde seçici hiçbir
  şey önermiyor, doğrusu da bu. Satırda marka rengiyle çizilmiş bir işaret, sembol,
  altında tam isim ve sağda bakiye var; bakiyenin yanına sembol tekrar yazılmıyor,
  satır zaten iki kez söylüyor. Marka işareti dosya olarak eklenirse
  `ui/token-logos/<SEMBOL>.svg` otomatik kullanılıyor; çizilen işaretin glifi zeminin
  taşıyabildiği renge göre siyah ya da beyaz seçiliyor.
- **cirBTC eklendi, sekiz ondalıklı.** Adres Android'in kaydındakiyle aynı ama
  güvenilerek değil doğrulanarak: `symbol()` cirBTC, `name()` "Circle Wrapped
  Bitcoin", `decimals()` 8. Bu kontrol formalite değil; ArcScan'de "cirBTC" araması
  sembole cevap veren sekiz kontrat döndürüyor, üçünün adı Mock ya da Demo.
  Zincirde doğrulandı: 0.00012345 cirBTC ödemesi (`0x4f0da1e6`), ham 12345 birim.
- **USYC listede, ama seçilemez.** İzinli bir token; gizlenirse "uygulama bunu
  bilmiyor mu" sorusu doğuyor, bakiyesinin yerinde "Allowlist gerekiyor" yazan
  soluk bir satır ise cevabı işlem gitmeden önce veriyor.
- **Ağ seçici header'da.** Cüzdanın hangi ağda olduğunu her an yazıyor ve
  değiştiriyor. Liste `CCTP_CHAINS`ten türüyor. Tanımadığımız bir ağda numarasını
  yazıyor ve logo uydurmuyor. Arc dışına geçiş yalnız cüzdana soruluyor; Arc'ın
  ağ ekleme yolu duruyor çünkü onun uçlarını biz işletiyoruz, diğerleri için ağ
  eklemek kullanıcının sonrasında her isteğinde güveneceği bir RPC'yi bizim
  seçmemiz demek olurdu.
- **Private Pay'de token seçimi**, paylaşılan `Select` üzerine. Arama sembol, isim
  ve kontrat adresiyle çalışıyor. Listede olmayan adres "token yok" döner; adresle
  token ekleme akışı bilerek yok, çünkü her adresi kabul eden bir seçiciye er geç
  bir benzer-kontrat verilir. Kayıttaki her satırın adresi, sembolü ve ondalığı
  zincirden okunarak yazıldı.

- **Zincir seçen her kontrol cüzdana bağlandı, iki yönlü.** `useWalletChain`
  tek bir yerde: cüzdanın ağı değişince kontrol oraya geçiyor (MetaMask'ten
  yapılan değişiklik dahil, `chainChanged` -> `session.chainId` -> kontrol), ve
  kontrolde başka bir ağ seçilince cüzdan oraya taşınıyor, çünkü işlem orada
  imzalanacak. Değişim hangi yönden gelirse gelsin eski ağ için okunmuş bakiye,
  ücret ve kota temizleniyor. Kural saf iki fonksiyonda (`chainForWallet`,
  `destinationChain`) ve testli.
- **Köprünün "To" ucu bilerek bağlı değil.** Orada bir şey imzalanmıyor, dolayısıyla
  cüzdanın takip edeceği bir şey yok. Varsayılanı Arc, çünkü bu uygulamanın bütün
  kontratları orada; kaynak zaten Arc'sa kenara çekiliyor, aynı zincirden aynı
  zincire rota köprü değil. Kullanıcı elle seçerse o seçim, imkânsız hale gelene
  kadar geçerli.

### Düzeltildi

- **Zincire göre kurulması gereken hiçbir alan kurulmuyordu.** Köprünün From'u,
  Gateway fonlama kutusunun kaynağı ve header'ın bakiyesi cüzdanın ağına hiç
  bakmıyordu: hepsi sabit Arc ile açılıyordu. Ethereum Sepolia'daki bir cüzdan,
  header'da doğru ağı yazan bir chip'in hemen altında Arc'ın bakiyesini sayfanın
  en büyük rakamı olarak görüyor, Arc'ta USDC yakmayı öneren bir form buluyor ve
  altındaki notta cüzdanının başka ağda olduğunu okuyordu. Doğru açılmak için
  gereken bilgi zaten ekrandaydı.
- **Cüzdan bakiyesi hep Arc'tan okunuyordu.** `refreshBalance` sabit Arc USDC
  adresini sabit Arc RPC'siyle soruyordu. Artık cüzdanın bulunduğu ağın USDC'si
  okunuyor; girdisi olmayan bir ağda rakam sıfırlanmıyor, "okunamadı" olarak
  duruyor. Arc dışında yoklama 20 saniyeye çekildi: oradaki okuma cüzdanın
  sağlayıcısından geçiyor ve MetaMask siteyi istek sayısına göre kısıtlıyor.
- **Abonelikte cüzdan bakiyesi yanlış RPC'den okunuyordu.** Seçilen zincirin USDC
  adresi soruluyordu ama her zaman Arc'ın RPC'sine; Arc dışında bu, hiçbir zincire
  ait olmayan bir rakamdı. Köprünün doğru yapan kopyası ortak `readUsdcOn`a alındı.
- **"Per pull" yanındaki bakiye bu aboneliği ödemiyordu.** Gösterilen rakam
  cüzdanın Arc'taki USDC'siydi; kutuyu Circle, Gateway bakiyesinden fonluyor.
  173 USDC'lik cüzdan, sıfır Gateway bakiyesinin yanında, formun birazdan
  reddedeceği bir aboneliği karşılayabileceğini söylüyordu. Rakam kaldırıldı;
  ödeyen bakiye hemen üstteki fonlama kutusunda, ekleme kontrolüyle birlikte
  duruyor.
- **Gelmeyecek bir rakam için parlayan yer tutucular.** `null` hem "daha okunmadı"
  hem "okunamıyor" demekti. Ayrıldı: okuma denendiyse ve cevap yoksa yer tutucu
  duruyor, parlamıyor.
- **Denetim aracı devre dışı kontrolleri hata sayıyordu.** WCAG 1.4.3 etkisiz
  bileşenleri kontrast tabanından muaf tutuyor, ve bir yüzde çipini soluklaştırmak
  onun basılamadığını söyleme biçimi. Artık `low` olarak, `inactive` işaretiyle
  raporlanıyor: görünmez olmuyor ama doğru davranan bir ekranı hata gibi
  göstermiyor.
- **Kutuyu fonlama ayağı Arc'a özgüydü.** `settlePrivatePaymentBatched` kutuyu
  `aggregate3Value` içinde native değer göndererek fonluyordu; Arc'ta native zaten
  USDC olduğu için USDC'de doğru, başka tokende yanlış. 0.5 EURC ödemesi kutuya
  0.5 native gönderip sonra ondan EURC istiyordu ve batch "Multicall3: call
  failed" ile dönüyordu. Artık token native değilse Arc'ın `Multicall3From`u
  kullanılıyor: alt çağrıların `msg.sender`ı korunduğu için batch içindeki
  `transfer` kullanıcının kendi adresinden gidiyor, approve gerekmiyor. İki yol
  tek çağrıda birleşemiyor, çünkü `CallFrom` value taşımıyor ve bu yüzden
  `Multicall3From`da `aggregate3Value` yok. Zincirde doğrulandı: 0.25 EURC
  (`0xe2853be7`) ve 0.02 USDC (`0x6ae8c738`).
- **Para ekranları yanlış ağda çalışıyordu.** `PrivatePayTab` ve
  `SubscriptionsTab` `session.onArc`e hiç bakmıyordu: Base'deyken form dolunca
  buton açılıyor ve ödeme yine Arc'a gidiyordu. Dördü de artık tek bir
  `supportsChain` fonksiyonuna soruyor.
- **Bir durum için iki uyarı vardı.** Yanlış ağdayken hem global bant hem ekran
  içi engel çıkıyordu, iki ayrı "Arc'a geç" butonuyla. Bant kaldırıldı.
- **Abonelik listesinin arama kutusu 390px'te 15px'e sıkışıyordu.** CSS'te
  kutunun alt satıra inmesini sağlayan kural vardı ama aynı özgüllükteki ikinci
  bir kural onu iptal ediyordu.
- **480px altında ağ chip'i etiketini gizleyince** ekran okuyucuya yalnız "Ağ"
  kalıyordu; `aria-label` artık ağın adını taşıyor.
- **Menülerin arama kutusu 20px yüksekliğindeydi**, WCAG 2.5.8'in 24px tabanının
  altında, ve aranabilir her menüde parmağın ilk gittiği yer orası.
- **Denetim aracının kendi yanlış pozitifleri.** Açık bir menü varken arkasındaki
  her kontrol "dokunulamıyor" diye işaretleniyordu (ağ menüsünde 19 bulgu, hepsi
  örtünün doğru davranışı), kaydırılan bir listenin görünmeyen satırları da öyle.
  Artık yalnız en üstteki katman ve yalnız kendi kabının içinde tamamen görünen
  hedefler ölçülüyor. Marka işaretleri de tema kuralından muaf: bir token rozetinin
  temayla renk değiştirmesi düzeltilecek bir kusur değil, başka bir token demek.
- **Ondalık ve para birimi varsayımları.** Tutar, bakiye ve Max artık tokenin
  kendi ondalığını kullanıyor. Gaz Arc'ta USDC olduğu için EURC tutarından
  düşülmüyor ve maliyet bloğu iki para birimini toplamıyor ("0.5 EURC + 0.05
  USDC"). Kurunu bilmediğimiz tokende dolar satırı hiç basılmıyor.

### Değişti

- **Relayer artık bir token listesi kabul ediyor** (USDC, EURC), tek bir çivili
  adres yerine. Liste sunucu tarafında sabit; policy'ye istemcinin gönderdiği
  metin değil kayıttaki adres yazılıyor, yoksa karşılaştırma tavsiye niteliğinde
  kalırdı. Cosigner çivisi aynen duruyor. Demo tavanı da "1000 tam token" oldu,
  tokenin ondalığından türüyor; eskiden "1000 USDC" diye yorumlanmış sabit bir
  taban-birim sayısıydı ve altı ondalıklı olmayan bir tokende başka bir şey
  demek olurdu.

### Bilinen sınırlar

- **EURC aboneliği yok.** Kutunun bütçesi Circle Gateway mint'iyle geliyor,
  Gateway ise yalnız USDC taşıyor. Cüzdandan doğrudan transferle fonlamak
  çalışırdı ama kutunun stealth adresini zincirde ele veren çizgi tam olarak o
  ve bu yüzden yedek yol olarak bırakılmadı. Yani engel relayer değil, fonlama
  rayı.

## 0.2.0 içinde: 2026-08-16

Web arayüzünde ölçümle bulunmuş hatalar. Hepsi tarayıcıda sayıyla doğrulandı; denetim
`apps/sender/src/audit/uiAudit.ts` içinde, kurallar ve eşikler `PLAN_UI.md`'de.

### Düzeltildi

- **Açık tema yapısızdı.** Kartlar sayfaya karşı 1.06:1 dolgu ve 1.19:1 kenarlıktaydı,
  yani kenarlık görünmüyordu. Kenarlık katmanları 1.47 ve 1.94'e çıktı.
- **Seçili sekme görünmüyordu.** Açık temada `--surface-3` ile `--bg-sunken` aynı değer
  olduğu için Standart/Gizli sekmesi kendi zeminiyle 1.00:1'di. Segment kontrolleri artık
  kendi `--seg-track`/`--seg-thumb` çiftini kullanıyor.
- **Açık temada her birincil butonun yazısı eşiğin altındaydı** (beyaz üstü `#b4770c`,
  3.76:1). Accent üç role ayrıldı: dolgu, dolgu üstü yazı, yüzey üstü yazı.
- **Gönder/Al anahtarı temayı takip etmiyordu.** Var olmayan `--card` token'ına
  dayandığı için açık temada siyah kalıyordu; ayrıca üründe başka hiçbir yerde
  kullanılmayan iki doygun renk taşıyordu.
- **Geçen süre yukarı yuvarlanıyordu.** 2 gün 14 saat önce gönderilen bir transfer,
  iki günlük bir tarih başlığının altında "3d" yazıyordu. Aynı fonksiyonun dört kopyası
  vardı, hepsi tek bir paylaşılan sürüme indi.
- **Köprüden gelen para `0x0000…0000`'dan ödeme gibi görünüyordu.** `HistoryEntry` artık
  `kind` ve `method` taşıyor; satır hangi köprüden geldiğini yazıyor.
- **Abonelik bütçe çubuğu harcanana göre doluyordu**, üstündeki etiket "Kalan" derken.
- **Bakiye okunmadan `0` yazıyordu**, ve cüzdan değişince eski cüzdanın bakiyesi
  ekranda kalıyordu.
- **Yükleme yer tutucuları olacakları boyutta değildi.** Abonelik kartı tek karede
  115px'ten 1303px'e büyüyordu. Listeler artık `ListSkeleton` ile kendi satır
  yükseklikleri kadar yer ayırıyor ve `reservedHeight.ts` her listenin oturduğu
  yüksekliği hatırlıyor. Ölçüm: her ekranda 8px altı.
- **Başarısız okuma sonsuza kadar parlıyordu.** Yükleniyor, okunamıyor ve başarısız
  artık üç ayrı durum; Gateway ücreti okunamadığında ekran bunu yazıp "Tekrar dene"
  sunuyor.

### Değişti

- **Firewall tek bir kart oldu.** Kurallar ve derin kontrol, adres geçerli olur olmaz
  görünen tek bir panelde iki satır. Eskiden sırayla beliren dört kutuydu ve derin
  kontrol temiz döndüğünde kaybolarak bitiyordu; artık "başka bir şey bulunmadı" ya da
  "ulaşılamadı" diyor. Panel 16ms'de görünüyor, eskiden ekranda 537ms boyunca hiçbir şey
  yoktu.
- **Adres alanlarına temizleme butonu** eklendi (paylaşılan `Input`, `onClear`).
- **Favicon**, Android uygulamasının launcher ikonu oldu.
- Gönderim başarı ekranı artık paranın kilitlendiği adresi ve transfer numarasını
  gösteriyor, claim kodunun kopyalama butonu etiketlendi.

## [0.1.2]: 2026-08-15

Yine yalnız `@ctrl-arcz/sdk` README'si, paket kodu değişmedi. 0.1.1 eksik import'u kapattı ama blok hâlâ iki tanımsız isim taşıyordu, yani kopyalayan biri derleyemiyordu.

### Düzeltildi

- `typedByRecipient` hiçbir yerde tanımlı değildi. Adı SDK'dan geliyormuş gibi durduğu için yanıltıcıydı; artık `secret.secret`'tan türetiliyor ve gerçek hayatta yerine ne konacağı yanında yazıyor.
- `renderRiskCard` okuyucunun kendi UI fonksiyonuydu ama çağrısı olduğu gibi duruyordu. Yerine `console.error(e.report)` kondu, kendi kartına vermesi gerektiği yorum satırında.

30 saniyelik quickstart artık yayınlanan pakete karşı `tsc --strict` ile sıfır hatayla derleniyor. Ölçüm: temiz dizin, `npm i @ctrl-arcz/sdk`, README'den blok aynen çıkarılıp derlendi.

## [0.1.1]: 2026-08-15

Yalnız `@ctrl-arcz/sdk`. Paketin kodu 0.1.0 ile birebir aynı; değişen tek şey npm'de görünen README. Yine de yama sürümü çıkarılıyor, çünkü kırık olan şey okunan doküman değil, kopyalanan kod.

### Düzeltildi

- Quickstart `fromSecret`'i 62. satırda kullanıyor ama import listesinde saymıyordu. npmjs.com'daki örneği olduğu gibi kopyalayan biri `ReferenceError: fromSecret is not defined` alıyordu.

### Eklendi

- `### Spend boxes`: `createEphemeral` ve `predictEphemeral`. Zincirdeki politika (kilitli hedef, çekim başına tavan, asgari aralık, toplam bütçe, bitiş) token allowance'ının yerine ne koyuyor.
- `### CCTP and Gateway`: `bridgeFromWallet`, `depositToGateway`, `spendFromGateway`. Üçü de parayı elinde tutan cüzdan tarafından imzalanıyor; hiçbirinde sunucu anahtarı yok.

Üçü de 0.1.0'da zaten export edilmişti, sadece belgelenmemişti.

## [0.1.0]: 2026-07-11

İlk sürüm. Arc Testnet üzerinde korumalı USDC transferi: gönderim öncesi risk taraması, kodla claim, gönderen iptali, otomatik iade.

### Kontrat (`packages/contracts`)

- `CtrlArcZ.sol`: tek deploy, çok kiracılı korumalı transfer kontratı: `createConfig` / `createConfigWithVerifier` / `sendProtected` / `claim` / `cancel` / `reclaimExpired` / `isVerifiedRecipient`.
- `IClaimVerifier` pluggable arayüzü + `CodeClaimVerifier` (kod ile claim). SIGNATURE/REGISTERED modları arayüzde rezerve.
- Sahipsiz, pause'suz, upgrade'siz. Admin drenajı yok.
- 5-deneme brute-force kilidi (yanlış kod revert etmez, sayaç zincire yazılır).
- 61 Foundry testi; coverage satır %99, ifade %100, dal %100.
- Arc Testnet'e deploy edildi:
  - CtrlArcZ `0x8dAb7148cdc31DAcad6d7e12161AA3DEDb572Dca`
  - CodeClaimVerifier `0x2C0f268DE2Aa8BB2ab27F2Ea5Ae8a0f9a0E068c4`

### SDK (`@ctrl-arcz/sdk`)

- `risk/`: firewall: benzer-adres (prefix/suffix), taze adres, 0-değerli bait kuralları. Saf kural motoru + `IDataProvider` (Blockscout). Doğrulanmış alıcılar (`RecipientVerified` event'lerinden) lookalike karşılaştırmasına dahil.
- `transfer/`: `sendProtected` (Memo-sarmalı), `claim` (makbuz okur, `WrongClaimCodeError`/`TransferLockedError` fırlatır), `cancel`, `reclaimExpired`, `getTransfer`, `watchTransfer`, `generateClaimCode` (256-bit salt).
- `history/`: `getCleanHistory`: 0-değerli ve bilinmeyen-token satırlarını filtreler (silmez, ayırır).
- `config/`: `defineConfig`, `registerConfig`, `recommendTransferMode`, `shouldBlockSend`.
- `getLogsChunked`: Arc'ın 10k blok `eth_getLogs` limitini aşan event sorguları.
- tsup: ESM + CJS + `.d.ts`. 58 vitest unit testi + 6 testnet entegrasyon testi.

### Demo (`apps/sender`, `apps/receiver`, `packages/demo-kit`)

- İki React+Vite sitesi; MetaMask veya test modu (yerel key). Paylaşılan session altyapısı `demo-kit`.
- Sender: canlı risk kartı, korumalı gönderim, claim linki üretimi, aktif transferler + iptal, temiz geçmiş, poisoning demo sekmesi.
- Receiver: event'lerden bekleyen transfer listesi, kodla claim, konfeti + arcscan linki.
- Üç akış tarayıcı ile canlı Arc Testnet'te doğrulandı (send→claim, cancel, firewall bloğu).

### Permit2 tek-imza gönderim (v0.1.0 sonrası eklendi, v2 deploy)

- `sendProtectedWithPermit`: kullanıcı Permit2'yi bir kez approve edip sonra her gönderimi off-chain imzayla yapar; ayrı `approve` tx'i yok. Gerçek Arc Permit2 predeploy'una karşı canlı test edildi (tx `0xdbc94297…`) + tarayıcı demosunda tek-imza gönderim (#7). MockPermit2 ile Foundry birim testleri. Yeni deploy: CtrlArcZ `0x8dAb7148…`, verifier `0x2C0f268D…`, deploy block 51326557.
- SDK: `approvePermit2`, `signPermit2Transfer`, `sendProtectedWithPermit`. Sender demo'da "Permit2 ile gönder" seçeneği.

### Gasless claim (v0.1.0 sonrası eklendi)

- Alıcının USDC'si olmadan claim: `claim` permissionless olduğu için bir relayer gas'ı ödeyip parayı kayıtlı alıcıya taşır. Circle paymaster/smart wallet gerektirmez. Canlı testte doğrulandı (sıfır-bakiyeli, nonce=0 alıcı tam tutarı aldı). Demo receiver'da "Gasless al" butonu.

### Bilinen sınırlar

- Kontrat denetlenmedi; yalnız testnet.
- Risk firewall'u tek indexer'a (ArcScan Blockscout) bağlı; indexer eksikse rapor `warning`'e düşer, asla sessizce `safe` demez.
- Poisoning demosundaki benzer adres, private key grind'i yerine ilk/son karakter korunup ortası rastgeleleştirilerek üretilir (firewall kararı yalnız adresten verildiği için yeterli; bkz. DECISIONS).
