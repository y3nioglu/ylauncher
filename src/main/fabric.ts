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
import { inflateRawSync } from 'node:zlib'

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

// ---- Faz 12.6: genel Fabric modu bağımlılık çözücüsü --------------------
//
// Problem: fabric-api'yi otomatik kurduk ama bağımlılık zinciri bitmedi —
// sahada VeinMiner gibi modlar `fabric-language-kotlin` gibi İKİNCİL
// bağımlılıklar isteyebiliyor; eksikken oyun `Incompatible mods found!`
// ile açılışta crash ediyor.
//
// Çözüm: oyun başlatılmadan önce `mods/` içindeki TÜM jar'ların
// `fabric.mod.json` manifestosu okunur, `depends` girdilerinde eksik olan
// bağımlılıklar Modrinth'ten indirilir. Zincirleme: indirilen jar'ın kendisi
// de kuyruğa eklenir. Döngü emniyeti: en fazla 12 tur.

interface FabricModJson {
  id?: string
  version?: string
  provides?: string[]
  depends?: Record<string, string>
}

export interface ModCompatWarning {
  jar: string
  modId: string
  modVersion: string
  problem: string
}

/**
 * clientMods klasörünü sürüm uyumluluğu açısından tarar (host'a YAYIMLAMA
 * ANINDA uyarı için): Fabric manifestosu olmayan jar'lar, mc sürümünü
 * bildirmeyen Fabric modları ve MC sürümünü desteklemeyenler işaretlenir.
 * Bu bir ENGEL DEGIL — sadece host'un dikkatini çeker (uyumsuz mod, arkadas
 * tarafinda oyun acilisini crash edebilir).
 */
export function scanModCompatibility(clientModsDir: string, mcVersion: string): ModCompatWarning[] {
  const warnings: ModCompatWarning[] = []
  if (!existsSync(clientModsDir)) return warnings
  for (const f of readdirSync(clientModsDir)) {
    if (!f.toLowerCase().endsWith('.jar')) continue
    const full = path.join(clientModsDir, f)
    let mj: FabricModJson | null = null
    try {
      mj = readFabricModJson(full)
    } catch {
      mj = null
    }
    if (!mj?.id) {
      // Forge jar'ı ya da fabric.mod.json olmayan paket — dikkat çekici
      warnings.push({
        jar: f,
        modId: '?',
        modVersion: '?',
        problem: 'Fabric mod manifestosu (fabric.mod.json) yok — Forge modu olabilir, Fabric istemcisinde yuklenmez'
      })
      continue
    }
    // MC surumu destegi: 'minecraft' depends'i surum araligi icerir
    // (orn. ">=1.21", "1.21.x", "*"). Semver-katlama yerine pratik kontrol:
    // aralik 'x'/'*' ise uyumlu say; degilse mcVersion'un disinda bir SEMVER
    // var mi diye kabaca bak (yalnizca net uyusmazliklari isaretle).
    const mcDep = (mj.depends ?? {})['minecraft']
    if (typeof mcDep === 'string' && !/^[\s*x^~.,()\-]*$/.test(mcDep)) {
      // surum numaralari iceriyor: mcVersion'un bu aralikta olup olmadigini
      // anlamlı kıyaslayabilmek icin basit x.y karsilastirmasi yap
      const parse = (s: string) => s.split('.').map((n) => parseInt(n, 10) || 0)
      const cur = parse(mcVersion)
      let matched = false
      for (const m of mcDep.matchAll(/(\d+\.\d+(?:\.\d+)?)/g)) {
        const v = parse(m[1])
        const [a, b] = [cur[0] ?? 0, cur[1] ?? 0]
        const [c, d] = [v[0] ?? 0, v[1] ?? 0]
        if (a === c && b === d) {
          matched = true
          break
        }
      }
      if (!matched) {
        warnings.push({
          jar: f,
          modId: mj.id,
          modVersion: mj.version ?? '?',
          problem: `MC ${mcVersion} destegi bildirmiyor (depends.minecraft: ${mcDep}) — arkadas tarafinda crash edebilir`
        })
      }
    }
  }
  return warnings
}

/**
 * Zip central directory'den `fabric.mod.json` girdisini bulup içeriğini
 * döndürür. (Local header'daki compSize veri-descriptor'lu jar'larda 0
 * olabildiği için central directory kullanılır — her jar'da kesindir.)
 */
export function readFabricModJson(jarPath: string): FabricModJson | null {
  try {
    const buf = readFileSync(jarPath)
    // EOCD imzasını dosya sonundan tara (max yorum uzunluğu 65_535)
    const eocdSig = 0x06054b50
    let eocd = -1
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
      if (buf.readUInt32LE(i) === eocdSig) {
        eocd = i
        break
      }
    }
    if (eocd === -1) return null
    const entryCount = buf.readUInt16LE(eocd + 10)
    let ptr = buf.readUInt32LE(eocd + 16) // ilk central directory girdisi
    for (let n = 0; n < entryCount; n++) {
      if (ptr + 46 > buf.length || buf.readUInt32LE(ptr) !== 0x02014b50) break
      const method = buf.readUInt16LE(ptr + 10)
      const compSize = buf.readUInt32LE(ptr + 20)
      const fnLen = buf.readUInt16LE(ptr + 28)
      const exLen = buf.readUInt16LE(ptr + 30)
      const cmLen = buf.readUInt16LE(ptr + 32)
      const localOff = buf.readUInt32LE(ptr + 42)
      const name = buf.toString('utf8', ptr + 46, ptr + 46 + fnLen)
      if (name === 'fabric.mod.json') {
        // local header: imza(4) + ... + fnLen(+26) + exLen(+28) -> veri +30
        const lfn = buf.readUInt16LE(localOff + 26)
        const lex = buf.readUInt16LE(localOff + 28)
        const dataStart = localOff + 30 + lfn + lex
        const data = buf.subarray(dataStart, dataStart + compSize)
        const raw = method === 8 ? inflateRawSync(data) : data
        const json = JSON.parse(raw.toString('utf8')) as FabricModJson
        return json
      }
      ptr += 46 + fnLen + exLen + cmLen
    }
    return null
  } catch {
    return null
  }
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

export interface DepsResult {
  ok: boolean
  installed: string[]
  failures: string[]
  skipped?: string
}

/**
 * Faz 12.6: `mods/` klasöründeki Fabric modlarının `depends` bildirimlerini
 * tarayıp eksik bağımlılıkları Modrinth'ten indirir (zincirleme, en fazla
 * 12 tur). Başarısızlık katılmayı engellemez — dönen `failures` UI'da
 * gösterilir.
 */
export async function resolveModDependencies(opts: {
  gameRoot: string
  mcVersion: string
  onStatus?: (message: string) => void
}): Promise<DepsResult> {
  const modsDir = path.join(opts.gameRoot, 'mods')
  mkdirSync(modsDir, { recursive: true })

  // ---- 1) Kurulu mod id'leri + manifest'leri topla ----
  const installed = new Map<string, FabricModJson>() // fabric mod id -> manifest
  const provided = new Set<string>() // id + provides (örn. fabric-api soyutlama)
  const jars: string[] = []
  for (const f of readdirSync(modsDir)) {
    if (!f.toLowerCase().endsWith('.jar')) continue
    const full = path.join(modsDir, f)
    jars.push(full)
    const mj = readFabricModJson(full)
    if (!mj?.id) continue
    installed.set(mj.id, mj)
    provided.add(mj.id)
    for (const p of mj.provides ?? []) provided.add(p)
  }
  if (jars.length === 0) return { ok: true, installed: [], failures: [], skipped: 'mods klasoru bos' }

  // Modrinth slug'u != fabric mod id olabilir (örn. id 'fabric-language-kotlin'
  // = slug 'fabric-language-kotlin' — çoğunlukla aynı; bilinen farklıları haritala)
  const slugAlias: Record<string, string> = {
    'fabric-api': 'fabric-api',
    'fabric-language-kotlin': 'fabric-language-kotlin'
  }

  const dl: string[] = []
  const fails: string[] = []
  const seenRequests = new Set<string>()

  // ---- 2) Zincirleme bağımlılık çözümü ----
  for (let round = 0; round < 12; round++) {
    const missing: string[] = []
    for (const mj of installed.values()) {
      for (const dep of Object.keys(mj.depends ?? {})) {
        if (!provided.has(dep)) missing.push(dep)
      }
    }
    if (missing.length === 0) break

    let progress = false
    for (const dep of [...new Set(missing)]) {
      if (seenRequests.has(dep)) continue
      seenRequests.add(dep)
      // Minecraft ile gelen çekirdek modüller Modrinth'te yok — bunlar loader
      // tarafından sağlanır, atla.
      if (/^(minecraft|java|fabricloader|fabric-api-base)$/.test(dep)) {
        provided.add(dep)
        continue
      }
      const slug = slugAlias[dep] ?? dep
      try {
        opts.onStatus?.(`Eksik bağımlılık indiriliyor: ${slug}...`)
        const gv = encodeURIComponent(JSON.stringify([opts.mcVersion]))
        const res = await fetch(
          `${MODRINTH_API}/project/${encodeURIComponent(slug)}/version?game_versions=${gv}&loaders=%5B%22fabric%22%5D`,
          { headers: { 'User-Agent': MODRINTH_UA } }
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const versions = (await res.json()) as {
          version_number: string
          files: { url: string; filename: string; primary: boolean; hashes: { sha1: string } }[]
        }[]
        if (!Array.isArray(versions) || versions.length === 0) {
          throw new Error(`${opts.mcVersion} icin surum yok (slug: ${slug})`)
        }
        const file = versions[0].files.find((f) => f.primary) ?? versions[0].files[0]
        if (!file) throw new Error('dosya bilgisi yok')
        const dest = path.join(modsDir, file.filename)
        if (existsSync(dest)) {
          // zaten indirilmiş ama id seti güncellenmemiş — manifest'ini oku
          const mj = readFabricModJson(dest)
          if (mj?.id) {
            installed.set(mj.id, mj)
            provided.add(mj.id)
            for (const p of mj.provides ?? []) provided.add(p)
          }
          progress = true
          continue
        }
        const tmp = `${dest}.part`
        const dres = await fetch(file.url, { headers: { 'User-Agent': MODRINTH_UA } })
        if (!dres.ok || !dres.body) throw new Error(`HTTP ${dres.status}`)
        await pipeline(Readable.fromWeb(dres.body as never), createWriteStream(tmp))
        const buf = readFileSync(tmp)
        if (createHash('sha1').update(buf).digest('hex') !== file.hashes.sha1) {
          throw new Error('butunluk kontrolu basarisiz')
        }
        renameSync(tmp, dest)
        dl.push(file.filename)
        const mj = readFabricModJson(dest)
        if (mj?.id) {
          installed.set(mj.id, mj)
          provided.add(mj.id)
          for (const p of mj.provides ?? []) provided.add(p)
        }
        progress = true
        opts.onStatus?.(`Bağımlılık kuruldu: ${file.filename}`)
      } catch (err) {
        fails.push(`${dep}: ${err instanceof Error ? err.message : String(err)}`)
        provided.add(dep) // tekrar deneme döngüsüne düşmesin
      }
    }
    if (!progress && fails.length > 0) break
  }

  return { ok: fails.length === 0, installed: dl, failures: fails }
}
