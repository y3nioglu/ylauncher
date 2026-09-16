# Ücretsiz Bulut Kurulumu — Neon (Postgres) + Render (API)

Amaç: Launcher'ın bağlandığı API'yi **tamamen ücretsiz** ve **kalıcı** olarak
bulutta çalıştırmak. Paket (`npm run dist`) artık varsayılan olarak
`https://ylauncher-api.onrender.com` adresine bakar — kullanıcılar hiçbir
ayar yapmaz.

Neden bu kombinasyon?
- **Neon** (neon.tech): Ücretsiz Postgres, 30 günde silinmez, kredi kartı istemez.
- **Render** (render.com): Ücretsiz Node API hosting. Tek kısıt: 15 dk trafik
  yoksa uyur; ilk istek ~30-60 sn gecikmeli uyanır (launcher tolere eder).
  (Render'ın kendi ücretsiz Postgres'i 30 günde silindiği için DB Neon'da.)

---

## Adım 1 — Kodu GitHub'a yükle (5 dk)

Render, kodu GitHub'dan çeker. Proje şu an git reposu değil; repo aç ve yükle:

1. https://github.com/new → repo adı: `ylauncher` (Private olabilir)
2. Proje klasöründe:

```bash
git init
git add .
git commit -m "ylauncher: bulut dağıtım hazırlığı"
git branch -M main
git remote add origin https://github.com/<KULLANICI_ADI>/ylauncher.git
git push -u origin main
```

Not: `.gitignore` hazır; `.env` ve yerel veri klasörleri repoya girmez.

## Adım 2 — Neon'da ücretsiz Postgres (3 dk)

1. https://neon.tech → GitHub ile kaydol
2. "Create project" → ad: `ylauncher`, region: **Europe (Frankfurt)** → Create
3. Açılan **Connection string**i kopyala (`postgresql://...sslmode=require`)
   — Adım 3'te lazım.

## Adım 3 — Render'da ücretsiz API servisi (7 dk)

1. https://dashboard.render.com → GitHub ile giriş → repo izni ver
2. **New → Web Service** → `ylauncher` reposunu seç → Connect
3. Formu doldur:
   - **Name:** `ylauncher-api`  ← paket bu isme göre ayarlı! Başka isim
     verirsen `src/shared/apiBase.ts`'teki adresi değiştir + `npm run dist`
   - **Region:** Frankfurt
   - **Runtime:** Node
   - **Build Command:** `npm ci && npm run migrate`
   - **Start Command:** `npm run start:server`
   - **Instance Type:** Free
4. **Environment** bölümüne ekle:
   - `DATABASE_URL` = Adım 2'deki Neon connection string
   - `JWT_SECRET` = uzun rastgele bir metin (örn. aşağıdaki komutun çıktısı:
     `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`)
5. **Create Web Service** → build + migrate logları akar, ~2-3 dk'da
   "Live" olur. Kontrol: tarayıcıda `https://ylauncher-api.onrender.com/api/health`
   → `{"ok":true,"db":"up"}` görmelisin.

> Alternatif: Repodaki `render.yaml` (blueprint) bu değerlerin çoğunu otomatik
> kurar — Dashboard'da New → Blueprint seçip repoyu göstermen yeterli;
> yalnızca DATABASE_URL'i sorar.

## Adım 4 — Şemayı Neon'a taşı (zaten otomatik)

`npm run migrate` build sırasında Neon'a karşı çalıştı (Adım 3 Build Command
içinde). Tüm tablolar (users, friendships, servers, plugins, clientmods...)
orada. Ek işlem gerekmez.

## Adım 5 — Paketi üret ve dağıt (5 dk)

Adres artık pakette gömülü (`src/shared/apiBase.ts` → `https://ylauncher-api.onrender.com`):

```bash
npm run dist
```

`release/0.1.3/` altındaki **Setup .exe**'yi arkadaşlarına ver (veya
Adım 6'daki güncelleme kanalıyla). Kimse adres/kurulum bilgisi girmeyecek.

## Adım 6 — Otomatik güncelleme kanalı (isteğe bağlı ama önerilir)

Güncellemeleri de Render üzerinden dağıtabilirsin:

1. Render panelinde servisine **Disks** ekle: Mount path `/var/data`, 1 GB
   (`render.yaml` blueprint'i bunu otomatik ekler; elle kurulumda panelden ekle)
2. Environment'a ekle (blueprint kullanıyorsan otomatik):
   - `DOWNLOADS_DIR=/var/data/downloads`
   - `PLUGIN_STORAGE=/var/data/storage/plugins`
   - `CLIENTMOD_STORAGE=/var/data/storage/clientmods`
3. Yeni sürüm çıkarırken: `package.json` version artır → `npm run dist` →
   `release/<surum>/` içindeki **.exe + latest.yml + .blockmap** dosyalarını
   diskteki `downloads/` klasörüne kopyala
4. Eski launcher'lar açılışta yeni sürümü kendileri fark eder

(Kısa yolu devam ettirmek istersen: dosyaları OneDrive/Drive linkinden
elle paylaş, updater olmadan da olur.)

---

## Bilinmesi gerekenler / sınırlar

- **Soğuk başlama:** Render free 15 dk boşta kalınca uyur. Launcher
  açılışındaki ilk istek 30-60 sn sürebilir; sonrasında hızlıdır. Sağlık
  rozeti ilk kontrolde kırmızı görünürse birkaç saniye sonra kendiliğinden
  yeşile döner.
- **Dosya depolama:** Yayımlanan plugin/client mod jar'ları ve güncelleme
  dosyaları Render Disk'ine (`/var/data`) yazılır — yeniden deploy'da
  **silinmez**. Disk 1 GB; jar birikimi dolduğunda host eski sürümleri
  `clientMods/` klasöründen çıkarıp yeniden yayımlayabilir.
- **Neon ücretsiz limitleri:** 0.5 GB depolama + hesaplama saatleri —
  arkadaş grubu boyutu için bolca yeterli. Uzun süre kullanılmazsa Neon
  hesaplama'yı duraklatır (ilk istek birkaç sn uzar, veri asla silinmez).
- **Uyku engelleme yok:** "Ping servisiyle uyutma" taktikleri free plan
  kurallarına aykırı; gerekirse $7'lık paid plan her zaman açık tutar.

## Sorun giderme

| Belirti | Neden / Çözüm |
| --- | --- |
| `/api/health` → `{"db":"down"}` | Neon string yanlış veya Neon projesi askıda — Render Logs'a bak |
| Deploy'da migrate hatası | `DATABASE_URL` env girilmemiş; Environment sekmesinden ekle |
| Launcher "Failed to fetch" | Servis uyuyor — tekrar dene; ya da adres yanlış (`app:get-info` → Ayarlar'daki aktif adres) |
| Girişte 502 | Render instance'ı yeniden başlıyor (free restart limiti) — birkaç dakika bekle |
