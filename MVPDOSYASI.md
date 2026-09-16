# Minecraft Launcher Planı (Özel Kullanım)

> Arkadaş grubu için özel, offline (cracked) hesap sistemiyle çalışan, sürüm seçilebilen
> ve tek tıkla arkadaş sunucusuna bağlanan bir Minecraft launcher.
>
> ⚠️ **Önemli not:** Launcher, oyunu **offline modda** çalıştırır (orijinal hesap doğrulaması
> yok). Bu yüzden launcher'ı **yalnızca arkadaş grubunuzla özel olarak** paylaşın; herkese açık
> dağıtımı Mojang EULA ve telif ihlali oluşturur. İleride biri orijinal hesap alırsa Microsoft
> login kolayca eklenebilir.

---

## 1. Teknoloji Seçimleri

| Katman | Teknoloji | Neden |
|---|---|---|
| Masaüstü uygulaması | **Electron + React + TypeScript** | Modern arayüz; Node ekosistemi hazır kütüphaneler |
| Oyun indirme/çalıştırma | **minecraft-launcher-core** | Tüm sürümleri (vanilla) otomatik indirir ve doğru JVM argümanlarıyla başlatır |
| Kimlik doğrulama | **Node.js + Express + Supabase (Postgres)** | Paylaşılan Supabase projesi; tablolar `ylauncher_` önekli |
| Arkadaş/sunucu listesi | Aynı backend (REST + basit durum API'si) | Tek servis, az bakım; veri Supabase Postgres'te |
| Oyun sunucusu | **Paper** (vanilla eklentileriyle uyumlu, performanslı) | Launcher host makinede indirip başlatır |
| Sunucuya bağlanma | **playit.gg tunnel** | Port forwarding gerektirmez; arkadaşlar aynı yerel ağda değilse bile bağlanır |

**Mimari özet:**

```
+--------------------------+        REST         +---------------------------+
|   Electron Launcher      | <-----------------> |  Node.js Backend (API)    |
|  - Login / Kayıt         |                     |  - SQLite (kullanıcı,     |
|  - Sürüm seçimi          |                     |    arkadaşlık, durum)     |
|  - Arkadaş listesi       |                     +---------------------------+
|  - Oyna / Sunucu kur     |
+-----------+--------------+
            |
            |  minecraft-launcher-core
            v
   Minecraft (offline: --username <nick> --offline)
            +
   Paper server (host makinede, playit.gg tunnel)
```

---

## 2. Hesap Sistemi (Offline / Cracked)

**Backend:**
- `POST /api/auth/register` → `{ nickname, password }`
  - Nickname benzersiz olmalı; Minecraft izin verdiği karakterler (`a-z 0-9 _`) ve 3-16 uzunluk kuralı
  - Şifre **bcrypt** ile hash'lenir (asla düz metin saklanmaz)
- `POST /api/auth/login` → JWT döner
  - Tüm launcher istekleri bu JWT ile yapılır
- `GET /api/auth/me` → token sahibinin profili

**Launcher tarafı:**
- Login ekranı: nickname + şifre → JWT localStorage'a kaydedilir (oturum hatırlama)
- Oyun başlatılırken:
  ```js
  launcher.launch({
    authorization: Authenticator.getAuth(username), // offline auth
    ...
  })
  ```
  Böylece oyun içinde görünen isim = launcher nickname'i. Skinnler offline modda
  Mojang'dan gelmez; istenirse basit bir skin sunucusu veya `--skin` benzeri çözüm sonraki
  aşamada düşünülebilir (şimdilik kapsam dışı).

---

## 3. Sürüm Yönetimi

- Launcher açılışında version manifest'i Mojang'dan çeker
  (`https://launchermeta.mojang.com/mc/game/version_manifest_v2.json`)
- Kullanıcı sürüm seçer (release / snapshot filtreli dropdown)
- `minecraft-launcher-core` ilgili sürümü + jar + kütüphaneleri + assets'i
  `~/.mc-friends/versions/<ver>/` altına indirir (ileride 'instances' klasörü)
- "Play" butonu: seçilen sürüm + kullanıcı nickname'i ile oyunu başlatır
- Sürüm zaten indirilmişse tekrar indirmeden direkt başlatır

---

## 4. Arkadaşlık Sistemi

**Backend tabloları (Supabase Postgres — paylaşılan proje, `ylauncher_` önekli):**

```
ylauncher_users        (id, nickname, password_hash, created_at, last_seen_at)
ylauncher_friendships  (id, user_id, friend_id, status: pending/accepted/declined, created_at)
ylauncher_migrations   (migration takibi için)
```

- Nickname benzersizliği `lower(nickname)` üzerinde unique index ile sağlanır (harf duyarsız)
- Migration: `server/migrations/*.sql` dosyaları `npm run migrate` ile uygulanır

**API:**
- `POST /api/friends/request` → { targetNickname }
- `POST /api/friends/respond` → { requestId, accept: true/false }
- `GET  /api/friends` → arkadaş listesi + her birinin online durumu
- `DELETE /api/friends/:id`

**Launcher UI:**
- "Arkadaşlar" sekmesi: liste, ekleme kutusu (nickname ile), gelen istekler (kabul/ret)
- Online olan arkadaşlar yeşil nokta ile gösterilir
- (Bonus, sonraki aşama) Sohbet: basit WebSocket mesajlaşma

---

## 5. Sunucu Yönetimi (Launcher-managed)

**"Host" akışı (sen veya arkadaşlardan biri):**
1. Launcher'da "Sunucuyu Başlat" butonu
2. Launcher Paper jar'ı indirir (`~/mc-server/paper.jar`)
3. İlk çalıştırmada `eula.txt` otomatik kabul edilir, `server.properties` ayarlanır:
   - `online-mode=false` (offline oyuncular girebilsin)
   - `white-list=true` + arkadaş nickname'leri otomatik whitelist'e eklenir
4. **playit.gg** tunnel başlatılır → dünyaya her yerden erişilebilir public address üretilir
5. Bu adres launcher API'sine gönderilir: arkadaşların listesinde "Sunucu Aktif: <adres>" görünür
6. "Katıl" butonu → oyun bu adresle başlatılır

**"Katılımcı" akışı:**
- Launcher'da aktif sunucu görünür → "Katıl" → oyun `--server <adres>` ile başlar

**Notlar:**
- Host makine açık olduğu sürece sunucu ayakta kalır; host kapanınca sunucu kapanır
- 2-5 kişilik grup için Paper + playit.gg ücretsiz katmanı yeterlidir
- İleride istenirse küçük bir VPS'e taşınabilir (aynı launcher "Katıl" akışıyla)

---

## 6. Güvenlik Notları (özel kullanım için bile)

- Şifreler bcrypt hash
- API'ye JWT zorunlu
- Backend'de rate limiting (brute force'a karşı)
- Launcher Electron'da `contextIsolation: true`, nodeIntegration renderer'da kapalı
- Sunucu whitelist'i açık → sadece arkadaşlar girebilir

---

## 7. Proje Yapısı

```
minecraft-launcher/
├── package.json            # Script'ler: dev, typecheck, build
├── electron.vite.config.ts
├── tsconfig.json
├── server/                 # Node backend (Express + Supabase Postgres)
│   ├── index.ts            # Express app + rate limit + graceful shutdown
│   ├── db.ts               # postgres.js bağlantısı + sorgular
│   ├── auth.ts             # JWT imzalama + auth middleware
│   ├── migrate.ts          # Migration runner
│   ├── migrations/
│   │   └── 001_init.sql    # ylauncher_users, ylauncher_friendships
│   ├── routes/
│   │   └── auth.ts         # register / login / me
│   └── data/               # yerel loglar (git'e girmez)
└── src/
    ├── main/index.ts       # Electron ana surec (pencere, guvenlik)
    ├── preload/index.ts    # contextBridge: API_BASE expose
    └── renderer/
        ├── index.html      # CSP: connect-src localhost:8787
        └── src/
            ├── main.tsx
            ├── App.tsx     # Login/Kayit + Home ekrani
            ├── lib/api.ts  # fetch wrapper + token saklama
            └── styles.css
```

### Kurulum ve Çalıştırma

```bash
npm install
cp .env.example .env    # DATABASE_URL'i Supabase'den alip doldurun
npm run migrate         # ylauncher_ tablolarini Supabase'e olusturur
npm run dev             # API (:8787) + Electron uygulamasini birlikte baslatir
npm run typecheck       # tip kontrolu
npm run build           # uretim build'i (out/)
```

> Not: npm 12+ kullanıyorsanız install scriptleri onay gerekebilir:
> `npm install-scripts approve electron esbuild` sonra `npm rebuild`

**Faz 1 ✔** — Kayit/giris ekrani, JWT oturumu, offline auth API (Supabase Postgres).
**Faz 2 ✔** — Surum listesi (Mojang manifest), otomatik Java indirme (Adoptium JRE),
minecraft-launcher-core ile offline "Oyna" (RAM/Java ayarlari, ilerleme cubugu, canli log).
Oyun dosyalari `%APPDATA%/ylauncher` altina iner.
**Faz 3 ✔** — Arkadaslik sistemi: nickname ile istek gonderme, kabul/ret, cift yonlu
arkadaslik, cikarma; UI'da gelen/giden istekler + cevrimici rozetleri (5 dk last-seen penceresi).
**Faz 4 ✔** — "Sunucu" sekmesi: Paper indirme (fill v3 API + sha256 dogrulama, aile->somut
surum cozumleme, surum degisiminde stale-config temizligi), eula/server.properties otomasyonu
(online-mode=false, enforce-whitelist=true), whitelist yonetimi (console komutu + offline UUID).
playit.gg tunnel: API tabanli yonetim (`src/main/playit.ts`) — claim akisi self-managed tipiyle
kendi kodumuzda (ajan TUI'inin assignable claim'i turel olusturmaya yetkili degil), turel
olusturma/adres `/tunnels/create` + `/v1/tunnels/config` uzerinden; 0.17.1 ajan binary'si yalnizca
veri duzlemi icin calistirilir (`--secret_path` ile kendi secret dosyamiz). Uctan uca dogrulandi:
Paper boot -> tunnel `live` -> genel adres uzerinden TCP baglantisi basarili.
**Faz 5a ✔** — Aktif sunucu duyurulari + tek tikla katilma: `ylauncher_servers` tablosu
(host basina tek satir, upsert), `/api/servers/announce|withdraw|active` endpoint'leri
(arkadaslara gizlilik, ozel/loopback IP reddi, 10 dk aktivite penceresi + host last-seen).
Host launcher'i Paper "Done" yazinca dogrudan adresi (yoksa turel adresini) API'ye duyurur,
kapaninca geri ceker (`src/main/announce.ts`, token renderer'dan `server:set-api-token`
ile main surecine gecer). Arkadaslarin "Oyna" ekraninda "Aktif Sunucular" paneli:
"Katil" once TCP probe (4 sn timeout) ile sunucu ayaktami bakar, sonra oyunu sunucunun
MC surumuyle + `serverAddress` ile acar. Uctan uca API smoke testi: `scripts/smoke-phase5a.ts`.
⚠️ Onemli tuzak: otomatik baglanti icin `--server` argumani 1.20+'da KALDIRILDI (oyun
"Completely ignored arguments" diye loglayip ana ekranda aciliyor). Dogru yol Quick Play:
`--quickPlayMultiplayer <host:port>` (src/main/game.ts). Gercek uctan uca dogrulandi:
duyuru -> panel -> Katil -> dogru surumle acilip sunucuya otomatik giris.
**Faz 5b ✔** — Katilma deneyimi: `src/shared/joinStatus.ts` (paylasilan saf modul)
log satirlarindan katilma fazini izler (baglaniyor -> dogrulaniyor -> dunya yukleniyor ->
girdin) ve kick sebeplerini anlasilir Turkce mesajlara cevirir (whitelist, sunucu dolu,
surum uyumsuzlugu, ban, timeout vb. — 11 kalip, birim testli: `scripts/smoke-join-status.ts`).
PlayScreen "Katil" akisi artik canli durum paneli gosterir ( nabiz animasyonlu nokta +
faz etiketi; hata durumunda kirmizi + ham log alintisi), kurulu olmayan surumu otomatik
indirir ("1.21.11 indiriliyor..." etiketiyle) ve bilinmeyen surumde uyari verir.
**Faz 5b+ ✔** — Kick sebebi host'tan tasiyor: kick metni istemci log'una her zaman yazilmaz
(canli dogrulama: whitelist kick client'ta yalnizca "Connection reset" gorundu), ama Paper'in
kendi log'unda daima vardir. Host launcher'i `isPlayerKickLine` ile kick satirlarini yakalar
(`isNormalQuit` ile oyuncunun kendi cikisini ayristirir), `translateKickLine` ile Turkcelestirir
ve `/api/servers/kick`'e raporlar (`ylauncher_server_kicks`, host+nickname basina tek satir,
2 dk omur, `003_kicks.sql`). Katilan taraf: client generic bir hata gordugunde (generic_disconnect
veya connection_reset) host raporuyla zenginlestirir;Katil aninda listeyi tazeler (15 sn polling
beklemeden). API smoke testi: `scripts/smoke-kicks.ts` (9 kontrol).
**Faz 5c ✔** — Whitelist istek akışı: katılamayan arkadaş (whitelist kick yiyen) launcher'dan
host'a istek gönderir; host Sunucu ekranındaki "Whitelist İstekleri" panelinden tek tıkla
Ekle/Reddet yapar ("Ekle" hem API'yi onaylar hem `whitelistEnsure` ile lokal whitelist.json'a
ekler — sunucu çalışırken `whitelist add` + `reload` stdin'e yazılır). Gizlilik: istek
**yalnızca arkadaşlara** gönderilebilir (`ylauncher_whitelist_requests`, arkadas bire bir;
upsert ile declined->pending dönebilir; 004_whitelist_requests.sql). Kick panelinde istek
butonu + canlı durum takibi (⏳/✅/❌). API smoke testi: `scripts/smoke-whitelist-req.ts`
(15 kontrol).
**Faz 5c sonrası UI temizliği ✔** — (1) Host panelinde işlenen istekler panelisten düşer,
panel yalnızca bekleyenleri gösterir; "X whitelist'e eklendi" notu 8 sn sonra kaybolur; nick
whitelist'ten çıkarılınca ilgili eski not da temizlenir — böylece çıkarılan oyuncunun eski
"kabul edildi" bilgisi ekranda asılı kalmaz. (2) Katılan tarafta taze whitelist kick'i geldiğinde
eski istek notu temizlenir; yeni kick kaydı yoksa 'accepted' yanıtı bayat sayılır (referans:
kick zamanı, yoksa bu denemenin başlangıcı). (3) Windows "ms-gamingoverlay edinin" pop-up'ı
bastırıldı: oyun her açılışında GameDVR'a sorgu gittiği için Xbox Game Bar kurulu değilse
Windows Store diyaloğu fırlıyordu; launcher açılışında HKCU\...\GameDVR\AppCaptureEnabled=0 ve
HKCU\System\GameConfigStore\GameDVR_Enabled=0 yazılır (`src/main/gamingOverlay.ts` — HKCU
olduğu için admin gerekmez; sonuç kalıcıdır, Windows ayarlarından Xbox Game Bar ile geri
açılabileceği gibi anahtar silinerek de eski hâline dönülebilir).
**Faz 6 — sunucu sistemi güçlendirme ✔** — kullanıcı istek listesindeki eksikler tamamlandı:
- **Temel yönetim:** Tek tıkla **Yeniden Başlat** (dünyayı kaydeder, aynı ayarlarla açar), RAM
  seçimi (1/2/4/8 GB → `-Xms`/`-Xmx` + G1GC bayrakları), çökme tespiti + otomatik yeniden
  başlatma (10 dk içinde 5+ çökmede pes eder — sonsuz döngü koruması).
- **İzleme:** Canlı TPS/RAM/CPU/oyuncu çipleri (10 sn'de tazelenir; süreç ölçümü tasklist/
  PowerShell veya /proc, log ayrıştırma `monitorParse.ts` — saf modül). Konsol komut gönderme
  kutusu (`list`, `tps` sorguları dahil stdin'den).
- **Yetki/Ban:** op/deop/kick/ban butonları (konsola komut yazar).
- **server.properties editörü:** beyaz liste anahtarları (port, motd, gamemode, difficulty,
  max-players, view/simulation distance, pvp...) — `propsEdit.ts` normalize/dogrulama ile
  (newline enjeksiyonu, aralık dışı değer, beyaz liste dışı anahtar reddedilir).
- **Yedekleme:** `backup.ts` — dünya klasörleri (level.dat tespiti) + configler tar.gz;
  logs/cache hariç. Manuel "Şimdi Yedekle" + sunucu açıkken 30 dk'da bir otomatik yedek +
  geri yükleme (sunucu çalışırken reddedilir) + silme. Windows ikili tuzakları çözüldü:
  System32\tar.exe (bsdtar) açıkça kullanılır, `-C` yerine Node `cwd` + göreli adlar.
- **Plugin yönetimi:** liste/aç/kapat (`.jar` → `.disabled.jar`, silmez)/sil — yeniden
  başlatmada geçerli.
- **Dünya/datapack:** dünya listesi (boyut + aktif) + silme (aktif dünya korumalı), aktif
  dünyanın datapack listesi + silme.
- **UI:** Sunucu ekranına izleme çipleri + komut kutusu; "Gelişmiş Araçlar" altında sekmeli
  ServerTools paneli (Ayarlar/Yetki/Yedek/Plugin/Dünya).
- **Henüz listede olmayanlar (Faz 7+):** modpack senkronizasyonu (client↔server mod listesi),
  çoklu sunucu profilleri, kurulum sihirbazı, istatistikler, tema.
- Birim testler: `scripts/smoke-phase6.ts` (50 kontrol — monitorParse, propsEdit, backup
  oluşturma/listeleme/geri yükleme/silme + path-traversal güvenliği, plugin aç/kapat, world
  create/import/delete).
**Faz 6 sonrası düzeltmeler (canlı geri bildirim) ✔** — (1) **gamemode değişmiyordu:**
`server.properties gamemode` yalnızca yeni oyuncular/dünyalar içindir; mevcut dünyada oyuncu
modu `level.dat`'ta saklanır ve restart bunu ezemez. Çözüm: `writeProps` artık gamemode/
difficulty'yi **konsoldan canlı uygular** (`defaultgamemode`/`difficulty` — level.dat'ı
geçer); sunucu kapalıysa komut kuyruğa alınır ve açılışta gönderilir. `force-gamemode`
anahtarı da editöre eklendi. (2) **Aktif dünya silinemiyordu:** `deleteWorldSmart` önce
`level-name`'i başka bir dünyaya çevirir (yoksa "world" — açılışta yepyeni yaratılır), sonra
klasörü siler. (3) **Yeni dünya:** "Yeni Dünya" `level-name`'i ayırır; **Dünya Yükle** zip
veya klasörden içe aktarır (System32 bsdtar ile açılır, içinde `level.dat` aranan kök;
çakışmada `-1/-2` soneki; `level.dat`-siz kaynak reddedilir). Dünya işlemleri sunucu
çalışırken kilitlidir.
**Faz 6 sonrası ikinci tur ✔** — (1) **Yeni Dünya butonu çalışmıyordu:** Electron
`window.prompt()` DESTEKLEMEZ; satır içi girdi kutusu ile değiştirildi, zip/klasör seçimi
tek `confirm` yerine iki ayrı buton ("Zip'den Yükle" / "Klasörden Yükle" — dosya diyaloğu
zaten main process'te). (2) **Ban kaldırma eklendi:** `pardon`/`pardon-ip` admin aksiyonları
+ `banned-players.json`/`banned-ips.json` okuyan ban listesi paneli — tek tık "Ban Kaldır".
Ban listesi, kick/ban sonrası 500 sn gecikmeli tazelenir; pardon sunucu kapalıyken de
çalışır (komut kuyruğa girmez, listeden dosya değişmez — pardon stdin komutudur, sunucu
kapalıysa UI bilgilendirir).
**Faz 7 — plugin senkronizasyonu ✔** — sunucudaki `plugins/` klasörü arkadaş launcher'larına
otomatik taşınır: (1) **Host tarafı** (`pluginSync.ts`): Paper "Done" anında aktif jar'lar
(`.disabled.jar` hariç) sha256 + boyut ile API'ye publish edilir (`005_host_plugins.sql`
migration uygulandı; dosyalar `storage/plugins/<hostId>/` diskinde). (2) **API**
(`server/routes/plugins.ts`): `POST /api/plugins/publish` (yalnızca host; dosya başına
50 MB, toplam 200 MB, 20 dosya limiti; path-traversal ve sha doğrulaması; republish eski
setteki fazlalıkları siler), `GET /manifest?host=` ve `GET /download?host=&file=` —
**yalnızca arkadaşlara** (stranger 403; smoke testte doğrulandı). (3) **Katılan taraf**
(`downloadPlugins.ts` + PlayScreen): Katıl'a basınca manifest çekilir, lokal jar'lar sha256
ile doğrulanır, eksik/farklılar atomik olarak (`.part` → rename + butunluk kontrolu)
indirilir — "Eklentiler kontrol ediliyor..." durumu panelde görünür; senkron başarısızlığı
katılmayı engellemez (sunucu plugin'siz de çalışabilir). Kullanıcının kendi eklediği,
manifestte olmayan jar'lara dokunulmaz. API smoke: `scripts/smoke-plugins.ts` (22 kontrol).
Testte bulunan bug: postgres.js `select id from` sorgusunu `::int` cast'siz string
getiriyor; `host.id !== uid` strict karşılaştırması her zaman true olup self-erisimi
403 yapıyordu — `id::int` ile düzeltildi.
**Faz 8 — kalan eksikler ✔** — kullanıcının özellik listesi tamamlandı:
- **Çoklu sunucu profilleri** (`profiles.ts`): her profil kendi world/ayar/plugin setine
  sahip (`profiles/<ad>/`); eski `server/` klasörü bozulmadan **default** profili olur (rename
  migration'ı). Sunucu ekranında profil seçici + Ekle/Sil; aktif profil silinirse ilk diğerine
  geçer, tek profil silinemez; yedekler profil bazlı (`backups/<profil>/`, default legacy
  konumunda). Sunucu çalışırken profil değişimi/silme kilitlidir.
- **İstatistikler** (`serverStats.ts`): profil başına JSON (`profiles/stats/<ad>.json`) —
  toplam sunucu/oyuncu süresi, başlatma sayısı, zirve oyuncu, 24 saatlik yoğunluk kovaları.
  Oturum başlangıcı/bitişi + 5 dk'lık tick ile diske yazılır (çökmede en fazla 5 dk kayıp).
  ServerTools'a "İstatistikler" sekmesi (kartlar + saatlik çubuk grafiği).
- **Kurulum sihirbazı** (`SetupWizard.tsx`): ilk girişte (settings.wizardDone=false) otomatik
  açılır — sürüm+RAM, whitelist, arkadaş ekleme ve "Sunucuyu Başlat" bitiş adımı; Ayarlar'dan
  tekrar açılabilir.
- **Tema**: CSS değişkenlerine dayalı açık/koyu tema (`html.light`); Ayarlar'dan seçilir,
  settings.theme'de saklanır, anında uygulanır.
- Birim testler: `scripts/smoke-phase8.ts` (22 kontrol — legacy migration, profil
  create/switch/delete kuralları, backupDir yönlendirme, istatistik oturumu/oyuncu-süresi/
  saat kovaları/kümülatif yükleme).
Siradaki adim Faz 7: modpack/plugin senkronizasyonu (sunucudaki plugins/ klasorunden
manifest uretip arkadas launcher'larina otomatik indirilme).

---

## 8. Faz Planı (önerilen sıra)

| Faz | Kapsam | Çıktı |
|-----|--------|-------|
| **Faz 1** | Proje iskeleti + offline login/register + basit Ana ekran | Launcher açılıyor, giriş yapılabiliyor |
| **Faz 2** | Sürüm listesi + oyun indirme + "Play" (offline mode) | Oyun nickname ile açılıyor |
| **Faz 3** | Backend arkadaşlık API + arkadaş ekleme/onaylama UI | Arkadaşlar eklenip listeleniyor |
| **Faz 4** | Paper server kurulumu + playit.gg tunnel + "Sunucuyu Başlat" | Host sunucu kuruyor, arkadaşlar IP ile girebiliyor |
| **Faz 5** | Launcher içinde aktif sunucu listesi + tek tıkla "Katıl" | Arkadaşlar launcherden 1 tıkla bağlanıyor |
| **Faz 6** | Cilalama: ayarlar, log ekranı, hata mesajları, otomatik güncelleme | Dağıtıma hazır launcher |

**İlk hedef:** Faz 1 + 2 (bireysel oyun çalışsın), sonra 3, 4, 5 sırayla.

---

## 9. Maliyet Tablosu

| Bileşen | Maliyet |
|---|---|
| Launcher + oyun dosyaları | Ücretsiz |
| Paper server (host PC'sinde) | Ücretsiz — host'un donanımı/interneti kullanılır |
| Backend API + veritabanı (Supabase ücretsiz plan — paylaşılan proje) | Ücretsiz |
| playit.gg tunnel | **$0** — ücretsiz planda Minecraft tunnel'i var, oyuncu limiti yok; $3/ay premium sadece düşük gecikme + özel adres için |
| Minecraft hesabı | Offline mod → Mojang'a ödeme yok (yalnızca özel kullanım) |

**Toplam: 0$/ay.** Gerçek sınır host'un upload bant genişliğidir (ev bağlantısında ~5-10 oyuncu).

Notlar:
- playit.gg ücretsiz planda adres değişebilir → launcher adresi her seferinde API'den okur
- Backend için en basit ücretsiz kurulum: host PC'de sunucuyla birlikte çalıştırmak;
  alternatif olarak Render/Railway ücretsiz katmanı (cold start gecikmesi olur) — Faz 3'te karar verilir

---

## 10. Bilinen Kısıtlar / Riskler

---

## 10. Sahada Raporlanan Bugların Giderilmesi (Faz 9) ✔

Kullanıcı testlerinde raporlanan 7 sorunun kök nedenleri ve düzeltmeleri:

1. **Plugin senkronu çalışmıyordu (EN KRİTİK)** — üç ayrı neden birden:
   - Global `express.json()` (100 kb limit) publish gövdesini (jar'lar MB'larca) route'a
     ulaşmadan 413 ile öldürüyordu → `/api/plugins/publish` yolu global parser'dan
     muaf tutuldu; route kendi 220 mb parser'ını kullanıyor. Smoke testte 2 MB'lik jar
     ile doğrulandı.
   - İstemci tarafı `plugins:sync` handler'ı yanlış klasöre bakıyordu:
     `GAME_ROOT/game/plugins` → doğrusu `GAME_ROOT/plugins` (oyun kökü). Plan hep boş
     çıkıyordu; bu yüzden "plugin kontrolü yaptı ama indirmedi".
   - Aynı plugin'in "isim (1).jar" kopyaları Paper'ı *Ambiguous plugin name* hatasıyla
     ikisini birden yüklemekten alıkoyuyor → publish öncesi tespit edilip host log
     panelinde net uyarı verilir; UI'da da çakışma satırı kırmızı gösterilir.
   - Publish sonucu artık sunucu log paneline yazılır ("N plugin yayınlandı" / "YAYINLAMADI:
     sebep") — sessiz başarısızlık kalmadı.
2. **Yeni dünya butonu** — `setLevelName` hiç başlatılmamış profilde (server.properties
   yok) exception fırlatıyordu → dosya yoksa minimal olarak oluşturulur. Ayrıca ayrılan
   dünya klasörü sunucu açılışına kadar var olmadığından listede görünmüyordu →
   `listWorlds` artık level-name'i ayrılmış ama klasörü olmayan dünyayı "başlatınca
   oluşur" olarak listeler (`planned: true`).
3. **Profil oluşturma** — `window.prompt()` Electron'da desteklenmez, buton sessizce
   hiçbir şey yapmıyordu → satır içi girdi kutusu (+ Profil adını yaz → + Profil).
4. **Kurulum sihirbazı kaldırıldı** — `SetupWizard.tsx` silindi; wizardDone ayarı
   geriye uyumluluk için her zaman true yazılır.
5. **RAM sistem sınırı** — `systemRamCapMB()`: toplam RAM'in %75'i (GB'ya yuvarlanır,
   min 1 GB). Ayarlar panelindeki girdilerde max=sınır + açıklama; sunucu ekranındaki
   seçenekler sınırı aşan GB'ları filtreler; `server:start` ve `game:save-settings`
   main process'te değeri zorla kırpır. 12 GB'lik makinede 16 GB seçilemez.
6. **Tema bugı** — Ayarlar'daki "Kaydet", panelin bayat local state'indeki eski temayı
   geri yazıyordu → save artık global App state'inden gelen taze temayla birleştirir;
   tema seçimi zaten anında kaydediliyor.
7. **ServerTools hantallığı** — panel açılışında 5 kaynağın birden sorgulanması yerine
   yalnızca aktif sekme yüklenir; sekme değişince veri tazelenir; sunucu durumu
   değişince listeler otomatik yenilenir; Pluginler/Dünya sekmelerinde "Yenile" butonu.
Ek: `ms-gamingoverlay` pop-up'ı GameDVR kapalıyken de çıkıyordu — ikinci tetikleyici
`GameBar\AutoGameModeEnabled` (ve `ShowStartupPanel`) de kapatıldı (HKCU, admin gerekmez).

Doğrulama: typecheck + build temiz; smoke-phase6 (50), smoke-phase8 (22),
smoke-join-status, smoke-plugins (24 — yeni "2 MB jar publish" kontrolü dahil) ve
smoke-whitelist-req tümü yeşil; gerçek backend üzerinde koşuldu.

**Faz 10 — ikinci saha turu ✔** (kullanıcı testlerinden 5 bug):
1. **Plugin publish 400 "Gecersiz dosya adi"** — jar adlarındaki `+` (sürüm etiketi,
   örn. `veinminer-paper-2.11.2+1.21.11.jar`) regex'te yoktu → `FILENAME_RE`'ye eklendi;
   gerçek backend'de `+`'lı adla doğrulandı.
2. **Profil değişince whitelist bayat** — switchProfile whitelist'i yeniden yüklemiyordu;
   her profilin kendi whitelist.json'u olduğundan tazeleme eklendi.
3. **Kopyala butonu hep doğrudan adresi kopyalıyordu** — tek handler iki satıra
   paylaşılmıştı; copyDirect/copyTunnel ayrıldı, kopyalandı rozatı satır bazlı.
4. **Dünya silme "level.dat yok" hatası** — planned (henüz oluşmamış) dünya silme
   desteklendi: level-name "world"e geri çevrilir.
5. **props-read handler hatası** — hiç başlatılmamış profilde server.properties yokken
   çöküyordu → varsayılanlarla çalışır, ilk kaydetmede dosyayı oluşturur.
6. **Paper `/tps` `/list` NPE** — izleme komutları world yüklemeden önce stdin'e
   yazılıyordu → yalnızca ready sonrası gönderilir.

---

## 11. Profil Bazlı Sürüm Hatırlama + Sunucu Listesi Menüsü (Faz 9b) ✔

**Profil başına sürüm kaydı:** Her profilin `ylauncher-server.json`'una `lastMcVersion` yazılır (başarılı her başlatmada güncellenir). Sunucu ekranındaki sürüm seçici açılışta ve profil değişiminde bu değere otomatik ayarlanır (listede yoksa ilk sürüme düşer) — kullanıcı profil değiştirdiğinde sürümü elle seçmek zorunda kalmaz.

**Sunucu Listesi menüsü:** Üst barda yeni **"Sunucu Listesi"** sekmesi. Açık sunucular artık Oyna sayfasında gösterilmez; burada listelenir ve Oyna ekranı yalnızca manuel sürüm seçimi + oyun başlatmaya odaklıdır. Katılma akışı (canlılık kontrolü → sürüm → plugin senkronu → kick/whitelist istek paneli) bu ekrana taşındı. Sekme adında **badge** olarak açık sunucu sayısı görünür (0 ise gizli). Liste üst barda 15 sn'de bir polling ile izlenir; katılma sonrası kick raporları erken tazeleme (3/8/15 sn) ile çekilir.

---

## 12. Anlık Güncelleme: Canlı Olay Akışı (Faz 9c) ✔

**Sorun:** Sunucu listesi (15 sn), arkadaşlık istekleri (20 sn) ve whitelist istekleri (15-20 sn) polling ile yenileniyordu — istekler kullanıcıya 15-20 sn gec ulaşıyordu. Daha sık polling ise sistemi yorar ve API rate limit'lerine takılırdı.

**Çözüm — push tabanlı canlı olay akışı (SSE long-poll):**

- **DB tarafı (006 + 007 migration):** `ylauncher_events` tablosu + trigger'lar. Arkadaşlık isteği/kabul/silme, whitelist isteği/yanıt, sunucu duyurusu/geri çekme ve kick raporu gerçekleştiğinde trigger'lar ilgili kullanıcılara `kind` etiketli olay satırları yazar. Her kullanıcı için son 200 olay tutulur (purge trigger'ı).
- **API tarafı (`/api/events/stream`):** Long-poll SSE — istek açılır, sunucu olay tablosunu 1 sn aralıklarla ~25 sn boyunca izler; yeni olay varsa anında tek `data:` yanıtı döner, yoksa sessiz "hala bağlı" yanıtı verir ve EventSource otomatik yeniden bağlanır. Token, EventSource header gönderemediği için query param'dan doğrulanır. LISTEN/NOTIFY bilinçli kullanılmadı (havuz max=5 bağlantıyı SSE bloklardı).
- **Client tarafı (`lib/poller.ts`):** Tek paylaşılan EventSource — App, ServerScreen ve ServerListScreen aynı bağlantıdan beslenir. Üstel geri çekilme (1s→30s) ile offline toleranslı; login/logout'ta `resetLiveEvents()` ile tazelenir.
- **UI etkisi:** Arkadaşlık/whitelist isteği ve açık sunucular artık **~1 sn'de** bildirim/toast/rozet olarak ulaşıyor. Polling yalnızca yedek olarak kaldı (60 sn + pencere odaklanınca anında tazeleme).

**Doğrulama (`scripts/smoke-live-events.ts`, gerçek backend):** Arkadaşlık isteği 2.4 sn, whitelist isteği 2.2 sn, sunucu duyurusu 0.6 sn içinde iletildi (ilk ölçüm bağlantı kurulumunu içerir; sürekli bağlantıda ~1 sn). Boş beklemede veri akışı sıfır; token'sız erişim 401. Tüm mevcut testler (Faz 6: 51, Faz 8: 22, plugin API) yeşil.

---

## 12b. Dağıtım + Otomatik Güncelleme (Faz 11) ✔

**Amaç:** Launcher'ın arkadaşlara elle kopyalanması yerine installer ile dağıtımı ve yeni sürümlerin sunucudan otomatik bulunması.

- **Üretim API adresi (`src/shared/apiBase.ts`):** API adresi artık tek yerden yönetilir. `DEFAULT_API_BASE` sabitine VPS adresini yazın; `API_BASE` env değişkeni geliştirme/kendi sunucuna yönlendirme için bunu geçersiz kılmaya devam eder. Main + preload + 4 modül (announce, kickReport, pluginSync, downloadPlugins) bu çözümleyiciyi kullanır; renderer (`window.launcher.apiBase`) de aynı sonucu alır.
- **Paket üretimi:** `npm run dist` → `electron-vite build` + `electron-builder --win --publish never`. Çıktı `release/<surum>/` altında: NSIS installer (`MC Friends Launcher Setup <surum>.exe`) + `latest.yml` + blockmap. `package.json > build` bölümü yapılandırmayı içerir (appId, NSIS: klasik sihirbaz + kurulum yolu seçimi + masaüstü kısayolu).
- **Güncelleme kanalı:** `server/index.ts` artık `downloads/` klasörünü `GET /downloads/*` üzerinden statik sunar (`DOWNLOADS_DIR` env ile değiştirilebilir; klasör otomatik oluşur). Release sonrası installer + `latest.yml` + blockmap dosyalarını bu klasöre kopyalayın — electron-updater `latest.yml`'den yeni sürümü görür.
- **Güncelleme akışı (`src/main/updater.ts`):** Açılışta sessiz sürüm kontrolü (`<API_BASE>/downloads/latest.yml`); sunucuya erişilemezse sessizce error durumunda kalır, uygulamayı etkilemez. Yeni sürüm varsa Ayarlar'da "vX indir" butonu çıkar (indirme kararı kullanıcıda, `autoDownload=false`); indirme ilerlemesi canlı gösterilir; tamamlandığında "Şimdi Yeniden Başlat ve Kur" + kapatınca da otomatik kurulum (`autoInstallOnAppQuit`). `app:update-event` push'ları `game:event` gibi tüm pencerelere iletilir.
- **Kod imzalama yok:** Arkadaş grubu için sertifika maliyeti gereksiz — Windows'ta SmartScreen "Bilinmeyen yayıncı" uyarısı normal; "Yine de çalıştır" ile geçilir.

**Sürü çıkarma rutini:** (1) `package.json`'da `version` artır → (2) `npm run dist` → (3) `release/<surum>/` içindeki `.exe`, `latest.yml`, `.blockmap` dosyalarını VPS'teki `downloads/` klasörüne kopyala → (4) arkadaşların launcher'ı açılışta yeni sürümü fark eder.

---

## 12c. Client Mod Senkronizasyonu + Fabric Loader (Faz 12) ✔

**Amaç:** Host'un `clientMods/` klasörüne koyduğu istemci modları (Sodium, minimap, performance modları vb.) arkadaşların launcher'ına otomatik insin; host Fabric loader seçtiyse katılanların oyunu Fabric profilinden açılsın. (Not: Sunucu tarafı plugin dağıtımı Faz 7'de zaten vardı; bu faz yalnızca İSTEMCİ modları kapsar — sunucuya mod yükleme yapılmaz.)

- **DB (008_clientmods.sql, uygulandı):** `ylauncher_host_clientmods` (host+filename manifest, 005 ile aynı desen) ve `ylauncher_host_profiles` (host başına tek loader profili: loader/loader_version/mc_version).
- **API (`server/routes/clientmods.ts`):** `POST /api/clientmods/publish` (meta+base64 jar, 220mb parser global JSON'dan muaf), `POST /profile`, `GET /manifest?host=`, `GET /profile?host=`, `GET /download?host=&file=` — okuma/indirme yalnızca arkadaşlara (403 stranger); dosya deposu `storage/clientmods/<hostId>/`.
- **Host tarafı:** Paper "Done" anında `clientMods/` seti publish edilir (`clientModSync.ts`) + loader profili yayınlanır (config'teki `fabricLoader`'a göre). ServerTools'a **Modlar** sekmesi: Fabric loader seçici (meta.fabricmc.net'ten canlı liste) + "Vanilla" seçeneği + "Modları Yayımla" butonu (sunucu çalışırken de kullanılabilir).
- **Fabric entegrasyonu (`fabric.ts`):** `meta.fabricmc.net/v2/versions/loader/{mc}/{loader}/profile/json` TAM sürüm JSON'u döndürür (inheritsFrom ile vanilla genişletilir); `versions/fabric-loader-<lv>-<mc>/` altına yazılır ve `ylauncher_profiles.json`'a kaydedilir. minecraft-launcher-core bu profili doğrudan başlatır (kütüphaneleri Fabric maven'ından kendisi indirir).
- **Katılan taraf (`downloadMods.ts` + ServerListScreen):** Katıl akışında plugin senkronundan hemen sonra: (1) mod manifesti çekilir, eksik/farklı jar'lar `GAME_ROOT/mods/` altına atomik iner (sha256 doğrulamalı; host'ta olmayan kullanıcının kendi modlarına dokunulmaz), (2) host profili Fabric ise `ensureFabricProfile` ile profil kurulur ve oyun `localVersionId` ile başlatılır. Senkron/profil başarısızlığı katılmayı engellemez (sadece 🧱 uyarı notu).
- **Launch desteği (`game.ts`):** `LaunchOptions.localVersionId` — manifest'te ARANMAZ, doğrudan `versions/<id>/` profilinden başlatılır; Java major vanilla eş-sürümden tahmin edilir.

**Kullanım akışı:** Host ServerTools > Modlar sekmesinden "+ Mod Ekle" ile jar seçer (veya `%APPDATA%\ylauncher\clientMods\` klasörüne elle kopyalar) → Fabric loader seçer ("Otomatik" = en yeni sürüm) → Sunucuyu Başlat (Done anında her şey yayınlanır). Arkadaşlar Katıl'a bastığında modlar iner + Fabric profili kurulur → oyun otomatik sunucuya girer. Pluginler de aynı şekilde Pluginler sekmesinden "+ Plugin Ekle" ile yüklenir.

**Saha düzeltmeleri (Faz 12 sonrası):** (1) ServerManager açılışta aktif profili diskten yüklüyordu-olmamalı — "default" profili silinmişse her araç çağrısı `Profil "default" bulunamadi` fırlatıyordu; artık `profiles.json`'dan okunur + profil klasörü dışarıdan silinmişse ilk mevcut profile düşer. (2) Mod/plugin yükleme artık dosya diyaloğuyla launcher üzerinden yapılır (klasörle uğraşma yok); clientMods klasörü otomatik oluşturulur ve yol UI'da gösterilir. (3) Fabric loader "Otomatik" seçeneği en yeni sürümü meta'dan çözüp somut olarak kaydeder. (4) KRİTİK: `getLocalVersionId` içindeki literal `require('./fabric')` bundler tarafından işlenmediği için çalışma anında `Cannot find module './fabric'` patlıyor ve katılma akışındaki localVersionId boş kalıyordu — oyun modlar inmesine rağmen VANILLA başlıyordu (Fabric kütüphaneleri classpath'te yok). Statik import'a çevrildi; artık `versions/fabric-loader-<lv>-<mc>/` profiliyle başlatılır. (5) MCLC sürüm sözleşmesi: `version.number` VANILLA sürüm (Mojang manifest'inde aranır), `version.custom` yerel profil id — Fabric id'si `number`'a yazılırsa manifest'te bulunamayınca `downloads.client` undefined kalır ve `Cannot read properties of undefined (reading 'client')` ile başlama patlar. `number` = vanilla + `custom` = profil olarak düzeltildi; ayrıca vanilla jar zaten varsa `overrides.minecraftJar` ile yeniden indirme engellenir. (6) **fabric-api otomatik sağlama (Faz 12.5):** Xaero gibi çoğu Fabric modu fabric-api bağımlılığı ister; eksikken oyun `Incompatible mods found! ... requires fabric-api` ile açılışta crash eder. Artık Fabric profili kurulurken Modrinth API'sinden MC sürümüne uygun en yeni fabric-api `mods/` altına atomik + sha1 doğrulamalı indirilir (zaten kuruluysa dokunulmaz; başarısızlık katılmayı engellemez, UI'da 🧱 notu düşer). Not: MCLC custom modda asset index'i custom adla kaydedip vanilla JSON'dan indirir (alias) — bu beklenen davranış, hata değildir. (7) **Paket kurulumu VPS'e yönlendirme (Faz 12.5):** Paketlenmiş launcher `DEFAULT_API_BASE` (localhost:8787) ile dağıtılır; VPS'te API yoksa giriş `Failed to fetch` verir. Artık API adresi üç katmanlı çözülür: `API_BASE` env → Ayarlar'dan girilen override (`settings.json: apiBaseOverride`) → varsayılan. Giriş ekranı ve Ayarlar'a "Sunucu adresi (API)" alanı eklendi: adres yazıp Enter/Uygula'ya basınca `app:set-api-base` IPC'si ile main process'teki canlı çözücüye yazılır, kaydedilir ve tüm modüller (announce, kickReport, pluginSync, downloadPlugins, clientModSync, downloadMods, updater) bir sonraki istekte yeni adresi kullanır — yeniden başlatma gerekmez. Renderer istemcisi de canlı `getApiBaseUrl()`'a geçti (poller + friends dahil); SSE `EventSource` bağlantısı override sonrası ilk `resetLiveEvents()`'te tazelenir. Sunucu tarafında CORS `origin: true` yapıldı (paket renderer `Origin: null` gönderir; kimlik doğrulama Authorization header JWT ile olduğu için cookie-allowlist gerekmez). (8) **Ücretsiz bulut dağıtımı:** `DEFAULT_API_BASE` artık `https://ylauncher-api.onrender.com` — paket kullanıcıya adres sormaz. Altyapı: Neon (kalıcı ücretsiz Postgres, Render'ın ücretsiz DB'si 30 günde silindiği için) + Render free web service (15 dk boşta uyku, ~30-60 sn soğuk başlama; `server.keepAliveTimeout` 65 sn'ye çekildi çünkü Render proxy'si ECONNRESET verebiliyor). `npm run start:server` script'i, `render.yaml` blueprint'i (kalıcı 1 GB disk: /var/data → downloads + plugin/clientmod storage, deploy'da kaybolmasın) ve adım adım `KURULUM-BULUT.md` rehberi eklendi.

---

## 13. Bilinen Kısıtlar / Riskler

- Offline modda **skinler görünmez** (ileride custom skin server düşünülebilir)
- `minecraft-launcher-core` bazı snapshot sürümlerde hata verebilir → stabil release sürümlerini test edin
- playit.gg ücretsiz planda address değişebilir → launcher her seferinde güncel adresi API'den okur
- Oyun Java 17/21 gerektirir → launcher gerekli JDK'yı otomatik indirmeli (minecraft-launcher-core bunu yönetebilir; değilsse Adoptium'dan indirilir)
