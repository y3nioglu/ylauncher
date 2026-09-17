// Faz 17: Modrinth v2 API entegrasyonu — modpack ve resource pack arama.
// API anahtari gerektirmez (User-Agent yeterli); ucretsiz ve acik.
// Dokuman: https://docs.modrinth.com

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const MODRINTH = 'https://api.modrinth.com/v2'
const UA = 'ylauncher/0.1 (Minecraft friend-group launcher)'

export interface SearchResult {
  projectId: string
  slug: string
  title: string
  description: string
  /** raw download+follow toplami (populerlik sirasi icin) */
  downloads: number
  iconUrl: string | null
  /** Modrinth projesi (taraycida acilmak uzere) */
  pageUrl: string
}

export interface FileEntry {
  url: string
  filename: string
  sha1: string
  sizeBytes: number
}

async function get<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(MODRINTH + path)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const controller = new AbortController()
  const to = setTimeout(() => controller.abort(), 10_000)
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: controller.signal
    })
    if (!res.ok) throw new Error(`Modrinth HTTP ${res.status}`)
    return (await res.json()) as T
  } finally {
    clearTimeout(to)
  }
}

/** /search yaniti: { hits: [...], total: n } — dizi degil! */
function extractHits(res: unknown): Array<Parameters<typeof toResult>[0]> {
  if (Array.isArray(res)) return res as Array<Parameters<typeof toResult>[0]>
  if (res && typeof res === 'object') {
    const hits = (res as { hits?: unknown }).hits
    if (Array.isArray(hits)) return hits as Array<Parameters<typeof toResult>[0]>
  }
  return []
}

function toResult(p: {
  project_id: string
  slug: string
  title: string
  description: string
  downloads: number
  icon_url: string | null
}): SearchResult {
  return {
    projectId: p.project_id,
    slug: p.slug,
    title: p.title,
    description: p.description,
    downloads: p.downloads,
    iconUrl: p.icon_url,
    pageUrl: `https://modrinth.com/${p.slug}`
  }
}

/** Modpack arama (project_type=modpack). */
export async function searchModpacks(query: string, limit = 20): Promise<SearchResult[]> {
  const facets = JSON.stringify([['project_type:modpack']])
  const res = await get<unknown>('/search', {
    query,
    limit: String(limit),
    index: 'downloads',
    facets
  })
  return extractHits(res).map(toResult)
}

/** Resource pack arama (project_type=resourcepack). */
export async function searchResourcePacks(query: string, limit = 20): Promise<SearchResult[]> {
  const facets = JSON.stringify([['project_type:resourcepack']])
  const res = await get<unknown>('/search', {
    query,
    limit: String(limit),
    index: 'downloads',
    facets
  })
  return extractHits(res).map(toResult)
}

/** Bir projenin belirli MC surumuyle uyumlu dosyalarinin en yenisini dondurur. */
export async function latestCompatibleFile(
  projectId: string,
  mcVersion: string,
  loader: 'fabric' | 'vanilla' = 'fabric'
): Promise<FileEntry | null> {
  const versions = await get<
    Array<{
      files: Array<{ url: string; filename: string; hashes: { sha1: string }; size: number }>
      game_versions: string[]
      loaders: string[]
      version_type: string
      date_published: string
    }>
  >(`/project/${projectId}/version`, {
    game_versions: JSON.stringify([mcVersion]),
    loaders: JSON.stringify(loader === 'fabric' ? ['fabric'] : ['minecraft'])
  })
  if (!Array.isArray(versions) || versions.length === 0) return null
  // API tarih sirali donuyor; release tercih et, yoksa en yeni
  const release = versions.find((v) => v.version_type === 'release') ?? versions[0]
  const file = release.files.find((f) => f.filename.endsWith('.mrpack') || f.filename.endsWith('.zip'))
  if (!file) return null
  return {
    url: file.url,
    filename: file.filename,
    sha1: file.hashes.sha1,
    sizeBytes: file.size
  }
}

/**
 * Resource pack'i oyunun resourcepacks/ klasorune indirir (sha1 dogrulamali).
 */
export async function downloadResourcePack(
  projectId: string,
  mcVersion: string,
  gameRoot: string
): Promise<{ ok: boolean; file?: string; error?: string }> {
  try {
    const file = await latestCompatibleFile(projectId, mcVersion, 'vanilla')
    if (!file) return { ok: false, error: 'Bu MC surumuyle uyumlu dosya bulunamadi' }
    const dir = path.join(gameRoot, 'resourcepacks')
    await mkdir(dir, { recursive: true })
    const dest = path.join(dir, file.filename)
    const res = await fetch(file.url)
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    const { createHash } = await import('node:crypto')
    const sha1 = createHash('sha1').update(buf).digest('hex')
    if (file.sha1 && sha1 !== file.sha1) return { ok: false, error: 'Dosya dogrulamasi basarisiz (sha1)' }
    await writeFile(dest, buf)
    return { ok: true, file: file.filename }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Modpack'i .mrpack olarak indirir (modpacks/ klasorune).
 * Kurulum (modlari indirip profil olusturma) ayri bir fazda eklenecek.
 */
export async function downloadModpack(
  projectId: string,
  mcVersion: string,
  gameRoot: string
): Promise<{ ok: boolean; file?: string; error?: string }> {
  try {
    const file = await latestCompatibleFile(projectId, mcVersion, 'fabric')
    if (!file) return { ok: false, error: 'Bu MC surumuyle uyumlu modpack bulunamadi' }
    const dir = path.join(gameRoot, 'modpacks')
    await mkdir(dir, { recursive: true })
    const dest = path.join(dir, file.filename)
    const res = await fetch(file.url)
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    const { createHash } = await import('node:crypto')
    const sha1 = createHash('sha1').update(buf).digest('hex')
    if (file.sha1 && sha1 !== file.sha1) return { ok: false, error: 'Dosya dogrulamasi basarisiz (sha1)' }
    await writeFile(dest, buf)
    return { ok: true, file: file.filename }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** .mrpack (modpack) dosyasini cozer: indirilenenler listesi + override bilgi basinca. */
export async function parseMrpack(
  filePath: string
): Promise<{ files: FileEntry[]; mcVersion: string | null; loaderVersion: string | null }> {
  // mrpack = zip; modrinth.index.json icinde downloads var
  const { inflateRawSync } = await import('node:zlib')
  const { readFileSync } = await import('node:fs')
  const buf = readFileSync(filePath)

  // Basit zip central directory okuma (fabric.ts'teki yaklasimla ayni)
  const EOCD = 0x06054b50
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66_000); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('.mrpack dosyasi okunamadi (zip bos/bozuk)')

  const count = buf.readUInt16LE(eocd + 10)
  let ptr = buf.readUInt32LE(eocd + 16)
  const files: FileEntry[] = []
  let mcVersion: string | null = null
  let loaderVersion: string | null = null

  const readStr = (offset: number, len: number): string => buf.subarray(offset, offset + len).toString('utf8')

  for (let i = 0; i < count; i++) {
    const nameLen = buf.readUInt16LE(ptr + 28)
    const extraLen = buf.readUInt16LE(ptr + 30)
    const commentLen = buf.readUInt16LE(ptr + 32)
    const localOff = buf.readUInt32LE(ptr + 42)
    const name = readStr(ptr + 46, nameLen)

    if (name === 'modrinth.index.json') {
      // Local header: nameLen2, extraLen2 -> sonra data
      const nameLen2 = buf.readUInt16LE(localOff + 26)
      const extraLen2 = buf.readUInt16LE(localOff + 28)
      const dataStart = localOff + 30 + nameLen2 + extraLen2
      const compSize = buf.readUInt32LE(ptr + 24)
      const method = buf.readUInt16LE(ptr + 10)
      const raw = method === 0 ? buf.subarray(dataStart, dataStart + compSize) : inflateRawSync(buf.subarray(dataStart, dataStart + compSize))
      try {
        const index = JSON.parse(raw.toString('utf8')) as {
          files?: Array<{ downloads: string[]; hashes?: { sha1?: string }; file_size?: number; path?: string }>
          dependencies?: Record<string, string>
        }
        mcVersion = index.dependencies?.minecraft ?? null
        loaderVersion = index.dependencies?.['fabric-loader'] ?? null
        for (const f of index.files ?? []) {
          if (f.downloads?.[0]) {
            files.push({
              url: f.downloads[0],
              filename: f.path ?? f.downloads[0].split('/').pop() ?? 'mod.jar',
              sha1: f.hashes?.sha1 ?? '',
              sizeBytes: f.file_size ?? 0
            })
          }
        }
      } catch {
        /* index bozuksa bos donebilir */
      }
    }
    ptr += 46 + nameLen + extraLen + commentLen
  }
  return { files, mcVersion, loaderVersion }
}
