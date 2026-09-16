#!/usr/bin/env node
// Surum cikarma — TAMAMEN OTOMATIK (GitHub Actions yayinlar).
//
// Kullanim:
//   npm run release              -> patch artir (0.1.3 -> 0.1.4) + yayinla
//   npm run release minor        -> minor artir (0.1.3 -> 0.2.0)
//   npm run release major        -> major artir (0.1.3 -> 1.0.0)
//
// Yapilanlar:
//   1. package.json + package-lock.json surumunu artirir
//   2. Degisikligi commit'ler (yalnizca bu iki dosya)
//   3. v<surum> tag'i olusturup origin'e iter (main + tag)
//   4. GitHub Actions (tag tetikli) Windows paketini derler ve
//      GitHub Releases'e otomatik yukler — 3-6 dk icinde yayinda.
//
// Izleyip kontrol etmek icin:
//   https://github.com/y3nioglu/ylauncher/actions

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'

const root = process.cwd()
const pkgPath = path.join(root, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))

const bump = process.argv[2] ?? 'patch'
if (!['patch', 'minor', 'major'].includes(bump)) {
  console.error(`Bilinmeyen surum tipi: ${bump} (patch | minor | major)`)
  process.exit(1)
}

const [maj, min, pat] = pkg.version.split('.').map(Number)
const next =
  bump === 'major'
    ? `${maj + 1}.0.0`
    : bump === 'minor'
      ? `${maj}.${min + 1}.0`
      : `${maj}.${min}.${pat + 1}`
const tag = `v${next}`

console.log(`Surum: ${pkg.version} -> ${next}\n`)

// 1) Surum artisi (package-lock'u da senkron tutar, git isi yapmaz)
execSync(`npm version ${next} --no-git-tag-version`, { stdio: 'inherit', cwd: root })

// 2) Commit — yalnizca surum dosyalari (diger yerel degisikliklere dokunma)
execSync(`git add package.json package-lock.json`, { stdio: 'inherit', cwd: root })
execSync(`git commit -m "release: ${tag}"`, { stdio: 'inherit', cwd: root })

// 3) Tag + push — Actions'i tetikleyen adim. Dikkat: tag ANNOTATED olmali ve
// acikca itilmeli; hafif (lightweight) tag + --follow-tags kombinasyonu tag'i
// uzaga GONDERMEZ (sahada yasanmistir) ve Actions tetiklenmez.
execSync(`git tag -a ${tag} -m "release: ${tag}"`, { stdio: 'inherit', cwd: root })
console.log(`\n[push] main + ${tag} itiliyor...\n`)
execSync(`git push origin HEAD`, { stdio: 'inherit', cwd: root })
execSync(`git push origin ${tag}`, { stdio: 'inherit', cwd: root })

console.log(`
Bitti! GitHub Actions suruyor:
  https://github.com/y3nioglu/ylauncher/actions

Is bittiginde release burada yayinda olacak:
  https://github.com/y3nioglu/ylauncher/releases/tag/${tag}

Kurulu launcher'lar bir sonraki acilista yeni surumu kendileri bulur
(Ayarlar > Guncellemeler -> "Yeni surum var" -> indir -> yeniden baslat).
`)
