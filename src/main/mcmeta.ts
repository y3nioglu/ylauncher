// Mojang version manifest + Java gereksinimi (game.ts ve server.ts ortak)

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

let manifestCache: { at: number; data: VersionManifest } | null = null
const javaMajorCache = new Map<string, number>()

export async function fetchVersionManifest(): Promise<VersionManifest> {
  if (manifestCache && Date.now() - manifestCache.at < MANIFEST_TTL_MS) {
    return manifestCache.data
  }
  const res = await fetch(MANIFEST_URL)
  if (!res.ok) throw new Error(`Surum listesi alinamadi (HTTP ${res.status})`)
  const json = (await res.json()) as {
    latest: { release: string }
    versions: { id: string; type: string; url?: string }[]
  }
  const data: VersionManifest = {
    latestRelease: json.latest.release,
    versions: json.versions.map((v) => ({ id: v.id, type: v.type, url: v.url }))
  }
  manifestCache = { at: Date.now(), data }
  return data
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
