# Changelog

Bu proje [Keep a Changelog](https://keepachangelog.com/) biçimini izler.

## [0.1.0] — 2026-07-11

İlk sürüm. Arc Testnet üzerinde korumalı USDC transferi: gönderim öncesi risk taraması, kodla claim, gönderen iptali, otomatik iade.

### Kontrat (`packages/contracts`)

- `CtrlArcZ.sol` — tek deploy, çok kiracılı korumalı transfer kontratı: `createConfig` / `createConfigWithVerifier` / `sendProtected` / `claim` / `cancel` / `reclaimExpired` / `isVerifiedRecipient`.
- `IClaimVerifier` pluggable arayüzü + `CodeClaimVerifier` (kod ile claim). SIGNATURE/REGISTERED modları arayüzde rezerve.
- Sahipsiz, pause'suz, upgrade'siz — admin drenajı yok.
- 5-deneme brute-force kilidi (yanlış kod revert etmez, sayaç zincire yazılır).
- 61 Foundry testi; coverage satır %99, ifade %100, dal %100.
- Arc Testnet'e deploy edildi:
  - CtrlArcZ `0x8dAb7148cdc31DAcad6d7e12161AA3DEDb572Dca`
  - CodeClaimVerifier `0x2C0f268DE2Aa8BB2ab27F2Ea5Ae8a0f9a0E068c4`

### SDK (`@ctrl-arcz/sdk`)

- `risk/` — firewall: benzer-adres (prefix/suffix), taze adres, 0-değerli bait kuralları. Saf kural motoru + `IDataProvider` (Blockscout). Doğrulanmış alıcılar (`RecipientVerified` event'lerinden) lookalike karşılaştırmasına dahil.
- `transfer/` — `sendProtected` (Memo-sarmalı), `claim` (makbuz okur, `WrongClaimCodeError`/`TransferLockedError` fırlatır), `cancel`, `reclaimExpired`, `getTransfer`, `watchTransfer`, `generateClaimCode` (256-bit salt).
- `history/` — `getCleanHistory`: 0-değerli ve bilinmeyen-token satırlarını filtreler (silmez, ayırır).
- `config/` — `defineConfig`, `registerConfig`, `recommendTransferMode`, `shouldBlockSend`.
- `getLogsChunked` — Arc'ın 10k blok `eth_getLogs` limitini aşan event sorguları.
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
