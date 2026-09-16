// Dunya yonetimi: yeni dunya olusturma, disaridan dunya ice aktarma
// (klasor veya zip) ve silme. Aktif dunyanin silinebilmesi icin once
// server.properties level-name baska bir dunyaya yonlendirilir (paper
// bir sonraki baslastirmada o dunyayi yaratir/kullanir).
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { cp, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { parseProperties } from './propsEdit'

export class WorldError extends Error {}

const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/

export function readLevelName(serverDir: string): string {
  const file = path.join(serverDir, 'server.properties')
  if (!existsSync(file)) return 'world'
  const parsed = parseProperties(readFileSync(file, 'utf8'))
  return parsed['level-name'] ?? 'world'
}

/** Klasorun gecerli bir Minecraft dunyasi olup olmadigi (level.dat sart). */
export function isValidWorldFolder(dir: string): boolean {
  return existsSync(path.join(dir, 'level.dat'))
}

/** Kullanilabilir yeni dunya adi uretir: world, world-2, world-3... */
export async function nextWorldName(serverDir: string): Promise<string> {
  for (let i = 1; i < 1000; i++) {
    const candidate = i === 1 ? 'world-new' : `world-new-${i}`
    if (!existsSync(path.join(serverDir, candidate))) return candidate
  }
  throw new WorldError('Yeni dunya adi uretilemedi — cok fazla dunya var.')
}

/** level-name'i degistirir (bir sonraki baslastirmada bu dunya yuklenir). */
export function setLevelName(serverDir: string, level: string): void {
  if (!NAME_RE.test(level)) throw new WorldError('Gecersiz dunya adi.')
  const file = path.join(serverDir, 'server.properties')
  // server.properties sunucu ilk acilista yazilir; hic baslatilmamis profilde
  // dosya yoktur — ama dunya ayirmek bunu gerektirmez: dosyayi olustur.
  if (!existsSync(file)) {
    writeFileSync(file, `level-name=${level}\n`, 'utf8')
    return
  }
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  let found = false
  const out = lines.map((line) => {
    if (/^level-name=/.test(line)) {
      found = true
      return `level-name=${level}`
    }
    return line
  })
  if (!found) out.push(`level-name=${level}`)
  writeFileSync(file, out.join('\n') + '\n', 'utf8')
}

/**
 * Dunyayi siler. Aktif dunya ise: once level-name'i baska bir dunyaya
 * cevirir (varsa ilk diger dunya, yoksa "world"), sonra klasoru siler —
 * bir sonraki baslastirmada yeni aktif dunya kullanilir/yaratilir.
 */
export async function deleteWorldSmart(serverDir: string, name: string): Promise<{ newLevel: string }> {
  const clean = path.basename(name)
  if (!NAME_RE.test(clean)) throw new WorldError('Gecersiz dunya adi.')
  const active = readLevelName(serverDir)
  // "Planned" dunya: level-name'i ayrilmis ama henuz klasoru olmayan dunya
  // (Yeni Dünya sonrasi). Klasor yoksa: yalnizca level-name'i geri cevir.
  if (!existsSync(path.join(serverDir, clean, 'level.dat'))) {
    if (clean === active) {
      setLevelName(serverDir, 'world')
      return { newLevel: 'world' }
    }
    throw new WorldError('Bu klasor bir dunya degil (level.dat yok).')
  }
  if (clean === active) {
    // baska bir dunya bul (tercih: "world" adiyla bilinen klasor, sonra ilk diger)
    const entries = await readdir(serverDir, { withFileTypes: true }).catch(() => [])
    const worldDirs = []
    for (const e of entries) {
      if (e.isDirectory() && e.name !== clean && isValidWorldFolder(path.join(serverDir, e.name))) {
        worldDirs.push(e.name)
      }
    }
    const newLevel = worldDirs.includes('world') ? 'world' : (worldDirs[0] ?? 'world')
    setLevelName(serverDir, newLevel)
    await rm(path.join(serverDir, clean), { recursive: true, force: true })
    return { newLevel }
  }
  await rm(path.join(serverDir, clean), { recursive: true, force: true })
  return { newLevel: active }
}

/**
 * Yeni dunya: bos bir klasor adi ayirir ve level-name'i ona cevirir.
 * Sunucu bir sonraki baslastirmada dunyayi sifirdan yaratir.
 */
export async function createWorld(serverDir: string, requested?: string): Promise<{ level: string }> {
  const level = requested?.trim() ? requested.trim() : await nextWorldName(serverDir)
  if (!NAME_RE.test(level)) throw new WorldError('Dunya adi: harf/rakam/altcizgi/tire, max 64 karakter.')
  if (existsSync(path.join(serverDir, level))) throw new WorldError(`"${level}" adi zaten kullaniliyor.`)
  setLevelName(serverDir, level)
  return { level }
}

/** Zip arsivini gecici klasore acar (System32 bsdtar; Linux/macOS tar). */
async function extractZip(zip: string, destDir: string): Promise<void> {
  const TAR = process.platform === 'win32' && existsSync('C:\\Windows\\System32\\tar.exe')
    ? 'C:\\Windows\\System32\\tar.exe'
    : 'tar'
  await new Promise<void>((resolve, reject) => {
    execFile(TAR, ['-xzf', zip, '-C', destDir], { windowsHide: true, timeout: 5 * 60_000, maxBuffer: 4 * 1024 * 1024 }, (err, _o, stderr) => {
      if (err) reject(new WorldError(`Zip acilamadi: ${err.message}${stderr ? ` — ${String(stderr).slice(0, 160)}` : ''}`))
      else resolve()
    })
  })
}

/** level.dat iceren ilk klasoru bulur (icine gomulu olabilir: dunya.zip/world/...). */
async function findWorldRoot(dir: string, depth = 0): Promise<string | null> {
  if (depth > 4) return null
  if (isValidWorldFolder(dir)) return dir
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const hit = await findWorldRoot(path.join(dir, e.name), depth + 1)
    if (hit) return hit
  }
  return null
}

/**
 * Disaridan dunya ice aktarir. Kaynak: dunya KLASORU (level.dat iceren)
 * veya dunya ZIP'i (icerisinde level.dat iceren klasor araniyor).
 * Cakisma: hedef doluysa -1, -2 ekleri denenir.
 */
export async function importWorld(
  serverDir: string,
  sourcePath: string,
  requestedName?: string
): Promise<{ level: string }> {
  const st = await stat(sourcePath).catch(() => null)
  if (!st) throw new WorldError('Kaynak bulunamadi.')

  const base = requestedName?.trim() || path.basename(sourcePath).replace(/\.zip$/i, '')
  const cleanBase = base.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 48) || 'imported'

  let target: string | null = null
  for (let i = 1; i < 100; i++) {
    const candidate = i === 1 ? cleanBase : `${cleanBase}-${i}`
    if (!existsSync(path.join(serverDir, candidate))) {
      target = candidate
      break
    }
  }
  if (!target) throw new WorldError('Uygun dunya adi bulunamadi.')

  const destDir = path.join(serverDir, target)

  if (st.isDirectory()) {
    const root = isValidWorldFolder(sourcePath) ? sourcePath : await findWorldRoot(sourcePath)
    if (!root) throw new WorldError('Klasorde level.dat bulunamadi — bu bir Minecraft dunyasi degil.')
    await mkdir(destDir, { recursive: true })
    await cp(root, destDir, { recursive: true })
  } else if (/\.zip$/i.test(sourcePath)) {
    const tmp = path.join(serverDir, `.import-${Date.now()}`)
    try {
      await mkdir(tmp, { recursive: true })
      await extractZip(sourcePath, tmp)
      const root = await findWorldRoot(tmp)
      if (!root) throw new WorldError('Zip icinde level.dat bulunamadi.')
      await mkdir(destDir, { recursive: true })
      await cp(root, destDir, { recursive: true })
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {})
    }
  } else {
    throw new WorldError('Yalnizca dunya klasoru veya .zip secilebilir.')
  }

  if (!isValidWorldFolder(destDir)) {
    await rm(destDir, { recursive: true, force: true }).catch(() => {})
    throw new WorldError('Ice aktarma dogrulanamadi (level.dat yok).')
  }
  return { level: target }
}

/** Klasor adi donusturucu — yeniden adlandirma ile duzenli silme arasinda. */
export async function renameDir(serverDir: string, from: string, to: string): Promise<void> {
  if (!NAME_RE.test(from) || !NAME_RE.test(to)) throw new WorldError('Gecersiz klasor adi.')
  await rename(path.join(serverDir, from), path.join(serverDir, to))
}
