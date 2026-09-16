// Faz 12: Fabric loader entegrasyonu.
// meta.fabricmc.net/v2 acik API'sinden loader surumleri ve TAM surum JSON'u
// (inheritsFrom ile vanilla'yi genisleten profil) cekilir. Surum JSON'u
// versions/<fabric-loader-...>/ klasorune yazilir; minecraft-launcher-core bu
// profili dogrudan baslatabilir (kutuphaneleri Fabric'in maven'inden indirir).
// ylauncher_profiles.json: hangi MC surumu icin hangi loader kurulu — tekrar
// indirme yapmamak ve 'localVersionId' uretmek icin.
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { createWriteStream } from 'node:fs'
import { createHash } from 'node:crypto'

const FABRIC_META = 'https://meta.fabricmc.net/v2'
const FABRIC_MAVEN = 'https://maven.fabricmc.net'

interface LoaderEntry {
  version: string
  stable: boolean
}

export interface LocalFabricProfile {
  localVersionId: string
  mcVersion: string
  loaderVersion: string
}

interface ProfileStore {
  // anahtar: `<mcVersion>` -> kurulu profil (host basina tek loader onerilir)
  [mcVersion: string]: LocalFabricProfile
}

function profilesFile(gameRoot: string): string {
  return path.join(gameRoot, 'ylauncher_profiles.json')
}

function loadProfiles(gameRoot: string): ProfileStore {
  try {
    return JSON.parse(readFileSync(profilesFile(gameRoot), 'utf8')) as ProfileStore
  } catch {
    return {}
  }
}

function saveProfiles(gameRoot: string, store: ProfileStore): void {
  mkdirSync(gameRoot, { recursive: true })
  writeFileSync(profilesFile(gameRoot), JSON.stringify(store, null, 2), 'utf8')
}

/** Fabric loader surumlerini ceker (yeni -> eski, stabil oncelikli). */
export async function listFabricLoaders(): Promise<string[]> {
  const res = await fetch(`${FABRIC_META}/versions/loader`)
  if (!res.ok) throw new Error(`Fabric loader listesi alinamadi (HTTP ${res.status})`)
  const json = (await res.json()) as LoaderEntry[]
  return json
    .filter((e) => typeof e?.version === 'string')
    .map((e) => e.version)
}

/** localVersionId: ayni MC+loader ikilisi icin ayni id (tekrar indirme yok). */
export function fabricVersionId(mcVersion: string, loaderVersion: string): string {
  return `fabric-loader-${loaderVersion}-${mcVersion}`
}

export interface EnsureFabricOpts {
  gameRoot: string
  mcVersion: string
  loaderVersion: string
  onStatus?: (message: string) => void
  onProgress?: (percent: number, label: string) => void
}

/**
 * Fabric profilini saglar: surum JSON'unu versions/<id>/...json olarak yazar.
 * minecraft-launcher-core acilista JSON'daki kutuphaneleri (Fabric loader +
 * intermediary + vanilla) otomatik indirir — burada yalnizca profil uretilir.
 */
export async function ensureFabricProfile(opts: EnsureFabricOpts): Promise<LocalFabricProfile> {
  const { gameRoot, mcVersion, loaderVersion } = opts
  const localVersionId = fabricVersionId(mcVersion, loaderVersion)
  const store = loadProfiles(gameRoot)

  const known = store[mcVersion]
  if (known && known.localVersionId === localVersionId) return known

  const versionsDir = path.join(gameRoot, 'versions', localVersionId)
  const jsonPath = path.join(versionsDir, `${localVersionId}.json`)
  if (existsSync(jsonPath)) {
    // JSON var ama kayit yok (elle kopyalama vb.) — kaydi tamamla
    const prof: LocalFabricProfile = { localVersionId, mcVersion, loaderVersion }
    store[mcVersion] = prof
    saveProfiles(gameRoot, store)
    return prof
  }

  opts.onStatus?.(`Fabric ${loaderVersion} profili hazirlaniyor (${mcVersion})...`)
  const res = await fetch(
    `${FABRIC_META}/versions/loader/${encodeURIComponent(mcVersion)}/${encodeURIComponent(loaderVersion)}/profile/json`
  )
  if (res.status === 404) {
    throw new Error(`Fabric ${loaderVersion} bu MC surumunu (${mcVersion}) desteklemiyor.`)
  }
  if (!res.ok) throw new Error(`Fabric profil JSON alinamadi (HTTP ${res.status})`)
  const profileJson = await res.json()
  if (
    typeof profileJson !== 'object' ||
    profileJson === null ||
    (profileJson as Record<string, unknown>)['inheritsFrom'] !== mcVersion
  ) {
    throw new Error('Fabric profil JSON beklenmedik bicimde (inheritsFrom uyusmadi).')
  }

  opts.onProgress?.(50, 'Fabric profili')
  mkdirSync(versionsDir, { recursive: true })
  writeFileSync(jsonPath, JSON.stringify(profileJson, null, 2), 'utf8')

  store[mcVersion] = { localVersionId, mcVersion, loaderVersion }
  saveProfiles(gameRoot, store)
  opts.onStatus?.(`Fabric profili hazir: ${localVersionId}`)
  return store[mcVersion]
}

/** MC surumu icin kurulu yerel Fabric profili (yoksa null). */
export function getLocalProfile(gameRoot: string, mcVersion: string): LocalFabricProfile | null {
  return loadProfiles(gameRoot)[mcVersion] ?? null
}

/** (Gelecek kullanım) Fabric maven artifact indirme yardimcisi. */
export function fabricMavenUrl(groupPath: string, artifact: string, version: string): string {
  return `${FABRIC_MAVEN}/${groupPath}/${artifact}/${version}/${artifact}-${version}.jar`
}

/** (Gelecek kullanım) URL'den dosya indirir. */
export async function downloadTo(url: string, dest: string): Promise<void> {
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`Indirme basarisiz (HTTP ${res.status})`)
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest))
}

// ---- Faz 12.5: fabric-api otomatik saglama ----
// Cogu Fabric modu (Xaero, Sodium vb.) fabric-api bagimligi ister; eksikken
// oyun acilista "Incompatible mods found" ile patlar. Modrinth acik
// API'sinden MC surumune uygun en yeni fabric-api mods/ altina indirilir
// (atomik + sha1 dogrulamali). Zaten kuruluysa dokunulmaz.
const MODRINTH_API = 'https://api.modrinth.com/v2'
const MODRINTH_UA = 'ylauncher/0.1 (arkadas grubu launcher)'

export interface FabricApiResult {
  ok: boolean
  installed?: string
  skipped?: string
}

export async function ensureFabricApi(opts: {
  gameRoot: string
  mcVersion: string
  onStatus?: (message: string) => void
}): Promise<FabricApiResult> {
  const modsDir = path.join(opts.gameRoot, 'mods')
  mkdirSync(modsDir, { recursive: true })
  const existing = readdirSync(modsDir).filter((f) => /^fabric-api-.*\.jar$/i.test(f))
  if (existing.length > 0) return { ok: true, skipped: 'fabric-api zaten kurulu' }

  opts.onStatus?.('Fabric API kontrol ediliyor...')
  let tmp: string | null = null
  try {
    const gv = encodeURIComponent(JSON.stringify([opts.mcVersion]))
    const ld = encodeURIComponent(JSON.stringify(['fabric']))
    const res = await fetch(`${MODRINTH_API}/project/fabric-api/version?game_versions=${gv}&loaders=${ld}`, {
      headers: { 'User-Agent': MODRINTH_UA }
    })
    if (!res.ok) return { ok: false, skipped: `Modrinth erisilemedi (HTTP ${res.status})` }
    const versions = (await res.json()) as {
      version_number: string
      files: { url: string; filename: string; primary: boolean; hashes: { sha1: string } }[]
    }[]
    if (!Array.isArray(versions) || versions.length === 0) {
      return { ok: false, skipped: `${opts.mcVersion} icin fabric-api surumu bulunamadi` }
    }
    const file = versions[0].files.find((f) => f.primary) ?? versions[0].files[0]
    if (!file) return { ok: false, skipped: 'fabric-api dosya bilgisi yok' }

    opts.onStatus?.(`Fabric API ${versions[0].version_number} indiriliyor...`)
    const dest = path.join(modsDir, file.filename)
    tmp = `${dest}.part`
    const dres = await fetch(file.url, { headers: { 'User-Agent': MODRINTH_UA } })
    if (!dres.ok || !dres.body) throw new Error(`HTTP ${dres.status}`)
    await pipeline(Readable.fromWeb(dres.body as never), createWriteStream(tmp))
    const buf = readFileSync(tmp)
    const sha1 = createHash('sha1').update(buf).digest('hex')
    if (sha1 !== file.hashes.sha1) throw new Error('butunluk kontrolu basarisiz')
    renameSync(tmp, dest)
    opts.onStatus?.(`Fabric API kuruldu: ${file.filename}`)
    return { ok: true, installed: file.filename }
  } catch (err) {
    if (tmp) rmSync(tmp, { force: true })
    return { ok: false, skipped: `fabric-api indirilemedi: ${err instanceof Error ? err.message : String(err)}` }
  }
}
