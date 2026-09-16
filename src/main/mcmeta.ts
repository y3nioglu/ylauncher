// Mojang version manifest + Java gereksinimi (game.ts ve server.ts ortak)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export interface ManifestEntry {
  id: string
  type: string
  url?: string
}

export interface VersionManifest {
  latestRelease: string
  versions: ManifestEntry[]
}

const MANIFEST_URL = 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json'
const MANIFEST_TTL_MS = 10 * 60 * 1000
const MANIFEST_TIMEOUT_MS = 8_000

let manifestCache: { at: number; data: VersionManifest } | null = null
const javaMajorCache = new Map<string, number>()

// Disk onbellek dizini (index.ts GAME_ROOT ile set eder). Mojang erisilemediginde
// son bilinen manifest buradan okunur — 'Oyun oynanabilir kalsin' politikasi.
let manifestCacheFile: string | null = null
export function setManifestCacheDir(dir: string): void {
  manifestCacheFile = path.join(dir, 'cache', 'version_manifest_v2.json')
}

export async function fetchVersionManifest(): Promise<VersionManifest> {
  if (manifestCache && Date.now() - manifestCache.at < MANIFEST_TTL_MS) {
    return manifestCache.data
  }
  try {
    const res = await fetch(MANIFEST_URL, { signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = (await res.json()) as {
      latest: { release: string }
      versions: { id: string; type: string; url?: string }[]
    }
    const data: VersionManifest = {
      latestRelease: json.latest.release,
      versions: json.versions.map((v) => ({ id: v.id, type: v.type, url: v.url }))
    }
    manifestCache = { at: Date.now(), data }
    // Disk onbellegini tazele (yazma hatasi onemli degil)
    if (manifestCacheFile) {
      try {
        mkdirSync(path.dirname(manifestCacheFile), { recursive: true })
        writeFileSync(manifestCacheFile, JSON.stringify({ at: Date.now(), data }), 'utf8')
      } catch {
        /* yazilamadi -> yalnizca bellek onbellegi */
      }
    }
    return data
  } catch (err) {
    // Ag erisilemedi: once bayat bellek, sonra bayat disk onbellegi kullan —
    // surum listesi/açilis bu sayede calisir (sahada apponfly'da yasandi:
    // launchermeta.mojang.com ConnectTimeoutError tekrar tekrar).
    if (manifestCache) return manifestCache.data
    if (manifestCacheFile && existsSync(manifestCacheFile)) {
      try {
        const cached = JSON.parse(readFileSync(manifestCacheFile, 'utf8')) as {
          at: number
          data: VersionManifest
        }
        if (cached.data?.versions?.length) {
          manifestCache = { at: cached.at, data: cached.data }
          return cached.data
        }
      } catch {
        /* bozuk onbellek -> hatayi ilet */
      }
    }
    const why = err instanceof Error ? (err as NodeJS.ErrnoException).code ?? err.message : String(err)
    throw new Error(
      `Surum listesi alinamadi (Mojang sunucusuna erisilemedi: ${why}). Internet baglantinizi kontrol edin.`
    )
  }
}

// Version JSON'unun erisilemedigi durumlar icin tahmini fallback
export function estimateJavaMajor(versionId: string): number {
  const m = versionId.match(/^(\d+)\.(\d+)(?:\.(\d+))?$/)
  if (!m) return 25 // snapshot veya bilinmeyen format -> en yeni
  const major = parseInt(m[1], 10)
  if (major > 1) return 25 // yil-bazli yeni semantik (orn. 26.2 -> Java 25)
  const minor = parseInt(m[2], 10)
  const patch = parseInt(m[3] ?? '0', 10)
  if (minor >= 20) return patch >= 5 ? 21 : 17
  if (minor >= 18) return 17
  return 8
}

// Surumun gercek Java gereksinimini version JSON'undaki javaVersion.majorVersion'dan oku
export async function resolveJavaMajor(entry: ManifestEntry): Promise<number> {
  const cached = javaMajorCache.get(entry.id)
  if (cached) return cached

  if (entry.url) {
    try {
      const res = await fetch(entry.url)
      if (res.ok) {
        const json = (await res.json()) as { javaVersion?: { majorVersion?: number } }
        const major = json.javaVersion?.majorVersion
        if (major && major >= 8) {
          javaMajorCache.set(entry.id, major)
          return major
        }
      }
    } catch {
      // JSON alinamadi -> tahmini fallback
    }
  }

  const fallback = estimateJavaMajor(entry.id)
  javaMajorCache.set(entry.id, fallback)
  return fallback
}
