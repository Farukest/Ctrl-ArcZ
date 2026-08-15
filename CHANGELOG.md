# Changelog

Bu proje [Keep a Changelog](https://keepachangelog.com/) biçimini izler.

## Yayınlanmamış: 2026-08-16

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
