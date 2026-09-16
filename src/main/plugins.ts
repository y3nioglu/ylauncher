// Plugin (plugins/*.jar) ve dunya/datapack yonetimi.
// Plugin "devre disi birakma": dosya adi .jar -> .disabled.jar uzantisiyla
// yeniden adlandirilir (silinmez); Paper yalnizca .jar uzantilarini yukler.
import { existsSync } from 'node:fs'
import { readdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'

export interface PluginInfo {
  file: string
  enabled: boolean
  sizeMB: number
}

const JAR_RE = /\.jar$/i
const DISABLED_RE = /\.disabled\.jar$/i

function sizeMB(s: number): number {
  return Math.round((s / (1024 * 1024)) * 10) / 10
}

/** plugins/ klasorundeki .jar ve .disabled.jar dosyalarini listeler. */
export async function listPlugins(serverDir: string): Promise<PluginInfo[]> {
  const dir = path.join(serverDir, 'plugins')
  if (!existsSync(dir)) return []
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const out: PluginInfo[] = []
  for (const e of entries) {
    if (!e.isFile()) continue
    if (!JAR_RE.test(e.name)) continue
    const st = await stat(path.join(dir, e.name)).catch(() => null)
    if (!st) continue
    out.push({ file: e.name, enabled: !DISABLED_RE.test(e.name), sizeMB: sizeMB(st.size) })
  }
  return out.sort((a, b) => a.file.localeCompare(b.file))
}

function safePluginName(file: string): string {
  const base = path.basename(file)
  if (!JAR_RE.test(base) || base.includes('/') || base.includes('\\') || base.includes('..')) {
    throw new Error('Gecersiz plugin dosya adi.')
  }
  return base
}

/** Plugin'i devre disi birakir (yeniden adlandirir; silmez). */
export async function disablePlugin(serverDir: string, file: string): Promise<void> {
  const base = safePluginName(file)
  if (DISABLED_RE.test(base)) return // zaten kapali
  const src = path.join(serverDir, 'plugins', base)
  const dst = path.join(serverDir, 'plugins', base.replace(JAR_RE, '.disabled.jar'))
  if (!existsSync(src)) throw new Error('Plugin dosyasi bulunamadi.')
  await rename(src, dst)
}

/** Devre disi plugin'i tekrar aktiflestirir. */
export async function enablePlugin(serverDir: string, file: string): Promise<void> {
  const base = safePluginName(file)
  if (!DISABLED_RE.test(base)) return // zaten acik
  const src = path.join(serverDir, 'plugins', base)
  const dst = path.join(serverDir, 'plugins', base.replace(DISABLED_RE, '.jar'))
  if (!existsSync(src)) throw new Error('Plugin dosyasi bulunamadi.')
  await rename(src, dst)
}

/** Plugin dosyasini kalici olarak siler. */
export async function deletePlugin(serverDir: string, file: string): Promise<void> {
  const base = safePluginName(file)
  await rm(path.join(serverDir, 'plugins', base), { force: true })
}

// ---- Dunyalar + datapackler ---------------------------------------------

export interface WorldInfo {
  name: string
  sizeMB: number
  /** server.properties'teki level-name bu dunya mi */
  active: boolean
  /** daha yaratilmamis (ilk baslastirmada olusacak) dunya */
  planned?: boolean
}

/** level.dat iceren klasorler = dunyalar. */
export async function listWorlds(serverDir: string, activeLevel: string): Promise<WorldInfo[]> {
  if (!existsSync(serverDir)) return []
  const entries = await readdir(serverDir, { withFileTypes: true }).catch(() => [])
  const out: WorldInfo[] = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (!existsSync(path.join(serverDir, e.name, 'level.dat'))) continue
    let total = 0
    total += (await dirSize(path.join(serverDir, e.name))).bytes
    out.push({ name: e.name, sizeMB: sizeMB(total), active: e.name === activeLevel })
  }
  // level-name ayrilmis ama henuz yaratilmamis dunya ("Yeni Dünya" sonrasi):
  // klasoru olmadigi icin yukaridaki dongude gorunmez — "baslatinca olusur"
  // olarak listele ki kullanici dunyayi kaybolmus sanmasin.
  const activeDir = path.join(serverDir, activeLevel)
  if (activeLevel && !existsSync(path.join(activeDir, 'level.dat'))) {
    out.push({ name: activeLevel, sizeMB: 0, active: true, planned: true })
  }
  return out.sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name))
}

async function dirSize(dir: string): Promise<{ bytes: number }> {
  let bytes = 0
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) bytes += (await dirSize(p)).bytes
    else {
      const st = await stat(p).catch(() => null)
      if (st) bytes += st.size
    }
  }
  return { bytes }
}

/** Dunya klasorunu siler (aktif dunya silinemez). */
export async function deleteWorld(serverDir: string, name: string, activeLevel: string): Promise<void> {
  const clean = path.basename(name)
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(clean)) throw new Error('Gecersiz dunya adi.')
  if (clean === activeLevel) throw new Error('Aktif dunya silinemez — once server.properties level-name degistirin.')
  if (!existsSync(path.join(serverDir, clean, 'level.dat'))) throw new Error('Bu klasor bir dunya degil (level.dat yok).')
  await rm(path.join(serverDir, clean), { recursive: true, force: true })
}

export interface DatapackInfo {
  file: string
  /** klasor mu tek dosya (zip) mi */
  kind: 'folder' | 'zip'
  enabled: boolean
}

/** Aktif dunyanin datapacks/ klasorunu listeler (pack.mcmeta varligi = gecerli). */
export async function listDatapacks(serverDir: string, activeLevel: string): Promise<DatapackInfo[]> {
  const dir = path.join(serverDir, activeLevel, 'datapacks')
  if (!existsSync(dir)) return []
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const out: DatapackInfo[] = []
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    if (e.isDirectory()) {
      out.push({ file: e.name, kind: 'folder', enabled: existsSync(path.join(dir, e.name, 'pack.mcmeta')) })
    } else if (/\.zip$/i.test(e.name)) {
      out.push({ file: e.name, kind: 'zip', enabled: !e.name.endsWith('.disabled') })
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file))
}

/** Datapack'i siler. */
export async function deleteDatapack(serverDir: string, activeLevel: string, file: string): Promise<void> {
  const clean = path.basename(file)
  if (clean.includes('..') || clean.includes('/') || clean.includes('\\')) throw new Error('Gecersiz datapack adi.')
  await rm(path.join(serverDir, activeLevel, 'datapacks', clean), { recursive: true, force: true })
}
