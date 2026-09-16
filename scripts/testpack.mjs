#!/usr/bin/env node
// VPS test paketi olusturucu.
//
// Kullanim:
//   node scripts/testpack.mjs           -> sadece dist-test/mc-launcher-test.zip uretir
//   node scripts/testpack.mjs --push    -> ek olarak transfer.sh'a yukler, tek URL verir
//
// Paket icerigi (node_modules YOK, ~1-2 MB):
//   out/                 (electron-vite build cikti)
//   server/, src/ gerekli degil; sadece API server + migrate icin kaynaklar:
//   server/**, package.json, package-lock.json, tsconfig.json
//   START.bat            (VPS'te cift tikla: portable Node indirir, npm ci, app+api baslatir)
//   README-VPS.txt       (adim adim VPS talimatlari)
import { rmSync, mkdirSync, cpSync, writeFileSync, readFileSync, createReadStream, existsSync } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const push = process.argv.includes('--push')

// ---- 1) electron-vite build (main + preload + renderer) ----
console.log('[1/5] Build aliniyor (electron-vite)...')
const bv = spawnSync('npx electron-vite build', { cwd: root, stdio: 'inherit', shell: true })
if (bv.status !== 0) {
  console.error('Build basarisiz.')
  process.exit(1)
}

// ---- 2) Staging klasoru ----
console.log('[2/5] Staging hazirlaniyor...')
const stage = path.join(root, 'dist-test', 'stage')
rmSync(path.join(root, 'dist-test'), { recursive: true, force: true })
mkdirSync(stage, { recursive: true })

const copy = [
  ['out', 'out'],
  ['server', 'server'],
  ['package.json', 'package.json'],
  ['package-lock.json', 'package-lock.json'],
  ['tsconfig.json', 'tsconfig.json'],
  ['electron.vite.config.ts', 'electron.vite.config.ts'],
  ['.env.example', '.env.example']
]
for (const [src, dest] of copy) {
  const s = path.join(root, src)
  if (!existsSync(s)) continue
  cpSync(s, path.join(stage, dest), { recursive: true })
}
// server/data gibi calisma zamanı klasörlerini paketleme
rmSync(path.join(stage, 'server', 'data'), { recursive: true, force: true })

// ---- 3) START.bat + README-VPS.txt ----
console.log('[3/5] VPS bootstrap dosyalari yaziliyor...')
const startBat = `@echo off
setlocal enabledelayedexpansion
title MC Friends Launcher - VPS Test
cd /d "%~dp0"

echo ============================================
echo  MC Friends Launcher - VPS Test Kurulumu
echo ============================================

rem -- 1) Portable Node.js (dakika icinde indirir, sisteme kurulmaz) --
if not exist "node\\node.exe" (
  echo [1/4] Portable Node.js indiriliyor ^(yaklasik 30 MB^)...
  powershell -NoProfile -Command "try { Invoke-WebRequest -Uri 'https://nodejs.org/dist/v22.14.0/node-v22.14.0-win-x64.zip' -OutFile 'node.zip' } catch { exit 1 }"
  if errorlevel 1 (
    echo HATA: Node indirilemedi. VPS'te internet erisimini kontrol et.
    pause & exit /b 1
  )
  powershell -NoProfile -Command "Expand-Archive -LiteralPath 'node.zip' -DestinationPath '.' -Force"
  ren "node-v22.14.0-win-x64" "node" 2>nul
  del node.zip 2>nul
)
set "PATH=%~dp0node;%PATH%"
for /f "delims=" %%v in ('node --version') do echo [OK] Node %%v hazir

rem -- 2) .env olustur (yoksa) --
if not exist ".env" (
  echo.
  set /p DBURL="PostgreSQL baglanti adresi (orn. postgres://user:pass@host:5432/db): "
  echo DATABASE_URL=!DBURL!> .env
  echo JWT_SECRET=vps-test-secret-%RANDOM%%RANDOM%>> .env
  echo [OK] .env olusturuldu
)

rem -- 3) Bagimliliklar (ilk sefer ~1-2 dk, sonra atlasir) --
if not exist "node_modules" (
  echo [2/4] Bagimliliklar kuruluyor (npm ci, ilk sefer 1-2 dk)...
  call npm ci --no-audit --no-fund
  if errorlevel 1 ( echo HATA: npm ci basarisiz. & pause & exit /b 1 )
) else (
  echo [2/4] Bagimliliklar zaten kurulu, atlaniliyor
)

rem -- 4) Veritabani tablolari --
echo [3/4] Veritabani migrasyonu...
call npm run migrate
if errorlevel 1 ( echo UYARI: migrate hata verdi; DB hazir degilse API ozellikleri kisitli calisir. )

rem -- 5) Baslat: API + Electron launcher --
echo [4/4] API ve launcher baslatiliyor...
echo.
echo   API     : http://localhost:8787
echo   Launcher: Electron penceresi acilacak
echo   Kapatmak icin bu pencerede Ctrl+C ya da pencereyi kapat
echo.
start "API" cmd /c "set PATH=%~dp0node;%%PATH%% && npx tsx server/index.ts & pause"
timeout /t 3 /nobreak >nul
call npx electron out/main/index.js
pause
`
writeFileSync(path.join(stage, 'START.bat'), startBat.replace(/\n/g, '\r\n'), 'utf8')

const readme = `MC FRIENDS LAUNCHER - VPS TEST PAKETI
=====================================

Bu paket launcher'i baska bilgisayarda (VPS) test etmek icindir.
node_modules dahil degildir; ilk kurulumda internet gerekir.

HIZLI BASLANGIC
---------------
1. START.bat'a cift tikla (dikkat: klasoru once C:\\test gibi bir yere cikart,
   OneDrive/Masaustu senkronizasyonu ve uzun yol sorunlarini onler).
2. Ilk calistirmada:
   - Portable Node.js indirilir (~30 MB, sadece bu klasore kurulur)
   - PostgreSQL baglanti adresi sorulur -> yazilir, .env olusur
   - npm ci ile bagimliliklar kurulur (1-2 dk, sonraki seferlerde atlanir)
3. API penceresi + Electron launcher penceresi acilir.

GUNCELLEME (yeni test paketi geldiğinde)
----------------------------------------
Yeni zip'i ayni klasore cikartip ustune yaz, START.bat'i tekrar calistir.
node_modules degismediyse (package-lock ayniysa) yeniden kurulmaz;
bu yuzden guncellemeler saniyeler surer.

NOTLAR
------
- Electron GUI icin VPS'te masaustu (RDP/browser console) sarttir.
  (AppOnFly tarayici konsolu uygundur.)
- Tünel: launcher saf Node bordo tunnel'i icerir; dis .exe indirmaz.
- API portu 8787, oyun sunucusu portu 25565 (yalnizca yerel).
- Sorun cikarsa: API penceresindeki ciktiyi ve out/ klasorunu kontrol et.
`
writeFileSync(path.join(stage, 'README-VPS.txt'), readme.replace(/\n/g, '\r\n'), 'utf8')

// ---- 4) Zip ----
console.log('[4/5] Zip olusturuluyor...')
const zipPath = path.join(root, 'dist-test', 'mc-launcher-test.zip')
// Electron'da gelen zlib; safest: powershell Compress-Archive (Windows'ta her zaman var)
const zipCmd = `powershell -NoProfile -NonInteractive -Command "Compress-Archive -Path '${stage}\\*' -DestinationPath '${zipPath}' -Force"`
const zipRes = spawnSync(zipCmd, { shell: true })
if (zipRes.status !== 0) {
  console.error('Zip olusturulamadi:', zipRes.stderr?.toString())
  process.exit(1)
}
rmSync(stage, { recursive: true, force: true })

// SHA256
const hash = crypto.createHash('sha256')
for await (const chunk of createReadStream(zipPath)) hash.update(chunk)
const sha = hash.digest('hex')
const sizeMB = (readFileSync(zipPath).length / 1024 / 1024).toFixed(2)

console.log('\n============================================')
console.log(`PAKET HAZIR : ${zipPath}`)
console.log(`BOYUT       : ${sizeMB} MB`)
console.log(`SHA256      : ${sha}`)
console.log('============================================')

// ---- 5) Opsiyonel push ----
if (push) {
  console.log('\n[5/5] transfer.sh a yukleniyor...')
  const up = spawnSync(`curl --upload-file "${zipPath}" "https://transfer.sh/mc-launcher-test-${Date.now()}.zip"`, {
    shell: true,
    encoding: 'utf8',
    timeout: 120_000
  })
  if (up.status !== 0 || !up.stdout?.startsWith('https://')) {
    console.error('Yukleme basarisiz:', up.stderr || up.stdout)
    console.log('Alternatif: zip dosyasini elle herhangi bir dosya paylasim sitesine yukle.')
    process.exit(1)
  }
  console.log('\nINDIRME LINKI (VPS tarayicisinda ac):')
  console.log(up.stdout.trim())
  console.log(`Dogrulama icin SHA256: ${sha}`)
}
