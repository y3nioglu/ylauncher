# MC Friends Launcher — MVP Plan

> Not: Bu dosya özet yol haritasıdır. Ayrıntılı kurulum için KURULUM-BULUT.md'ye bak.

## Tamamlanan fazlar (1-14)

- Faz 1-3: Electron iskelet, offline auth, arkadaş sistemi (API + Postgres/Supabase)
- Faz 4: Paper sunucu kurulumu + bore.pub tünel + duyuru sistemi
- Faz 5: Katılma akışı (probe → sürüm → plugin senkronu → kick/whitelist)
- Faz 6: Sunucu izleme, komut, admin, props, yedek, world/datapack
- Faz 7: Plugin manifest yayını + senkron
- Faz 8: Sunucu istatistikleri + profiller
- Faz 9: Canlı olaylar (SSE long-poll)
- Faz 10: Fabric loader entegrasyonu (meta.fabricmc.net) + clientMods
- Faz 10.5: mod/plugin rozetleri (duyuru meta verisi + migration 009)
- Faz 11: electron-builder NSIS + electron-updater (GitHub Releases kanalı)
- Faz 12: Fabric profili + clientMod yayını + genel bağımlılık çözücüsü (Modrinth)
- Faz 12.5: uyumluluk taraması + görsel uyarı rozetleri
- Faz 13: (atlandı — kullanıcı sohbet istemedi)
- Faz 14: SkinsRestorer otomatik kurulumu (offline skin desteği)

## Faz 15: Kozmetik + QoL paketi (BU TURDA EKLENDI)

- **Animasyonlu arka plan**: saf CSS parallax (bulut + yıldız + blok dağ silueti),
  GPU dostu, `prefers-reduced-motion` duyarlı
- **Profil kartı**: kullanıcı adına tıklayınca; toplam saat, oturum sayısı,
  arkadaslarla dk, en kalabalık an, ilk/son giriş (`playtime.json` +
  `profiles/stats/*.json` birleşimi; game.ts oturum sonunda playtime yazar)
- **Sunucu tarayıcısı**: SLP protokolü ile canlı ping, oyuncu sayısı, MOTD,
  favicon ikonu (src/main/probe.ts — soket tabanlı, kütüphanesiz)
- **Performans ön ayarları**: Düşük/Dengeli/Yüksek JVM GC presetleri
  (src/shared/perfPresets.ts, MCLC customArgs kanalı)
- **Crash log analizörü**: 10+ kural; oyun kapanınca log taranır, tanı +
  çözüm önerisi panelde kırmızı/sarı kutuda (src/main/crashAnalyzer.ts)
- **Ekran görüntüsü galerisi**: screenshots/ klasörü, grid + büyütme + silme
  (İçerik sekmesinde)
- **Resource pack + modpack tarayıcısı**: Modrinth v2 API; arama, uyumlu dosya
  çözümü, sha1 doğrulamalı indirme (resourcepacks/ ve modpacks/ klasörlerine)
- **Rozet fallback**: `/active` API'si duyuruda sayı 0'sa yayımlanmış
  manifestlerden sayar — eski host paketinde bile rozetler görünür

## Bilinen kısıtlar

- Resource pack galerisi Modrinth aramasıdır; yerel zip importu ayrı
- Modpack kurulumu .mrpack indirir; otomatik profil kurulumu ileride
- Forge modları desteklenmez (yalnız Fabric)
- Cape desteği client-side mod gerektirir (kapsam dışı)

## Dağıtım

`npm run release` → GitHub Actions derler → otomatik yayın (v0.1.14+)
