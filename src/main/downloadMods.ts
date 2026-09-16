// Faz 12 (arkadas tarafi): host'un client mod manifest'ini ceker, kendi
// GAME_ROOT/mods/ klasorundeki jar'larla karsilastirir (sha256) ve eksik/
// farkli dosyalari indirir. Host manifestte olmayan KENDI modlarina
// dokunulmaz (plugin senkronundaki politika ile ayni).
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { getApiBase } from '../shared/apiBase'

const apiBase = () => getApiBase()

export interface ModsPlan {
  host: string
  toDownload: { filename: string; sha256: string; sizeBytes: number }[]
  upToDate: string[]
  manifestTotal: number
}

export interface ModsSyncResult {
  ok: boolean
  downloaded: string[]
  failed?: string
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

async function fetchModsManifest(token: string, host: string): Promise<{
  mods: { filename: string; sha256: string; sizeBytes: number }[]
}> {
  const res = await fetch(`${apiBase()}/api/clientmods/manifest?host=${encodeURIComponent(host)}`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status} ${text.slice(0, 120)}`)
  }
  return (await res.json()) as {
    mods: { filename: string; sha256: string; sizeBytes: number }[]
  }
}

/** Manifesti ceker ve indirilecekleri belirler (indirmez). */
export async function planModsSync(opts: {
  token: string
  host: string
  modsDir: string
}): Promise<ModsPlan> {
  const manifest = await fetchModsManifest(opts.token, opts.host)
  const toDownload: ModsPlan['toDownload'] = []
  const upToDate: string[] = []
  for (const p of manifest.mods) {
    const file = path.join(opts.modsDir, p.filename)
    let local: string | null = null
    if (existsSync(file)) {
      try {
        local = sha256(await readFile(file))
      } catch {
        local = null
      }
    }
    if (local === p.sha256.toLowerCase()) upToDate.push(p.filename)
    else toDownload.push(p)
  }
  return { host: opts.host, toDownload, upToDate, manifestTotal: manifest.mods.length }
}

/** Plandaki dosyalari indirir (atomik: .part -> rename + butunluk kontrolu). */
export async function syncMods(opts: {
  token: string
  plan: ModsPlan
  modsDir: string
  onProgress?: (done: number, total: number, file: string) => void
}): Promise<ModsSyncResult> {
  const downloaded: string[] = []
  await mkdir(opts.modsDir, { recursive: true })
  try {
    let i = 0
    for (const p of opts.plan.toDownload) {
      i++
      opts.onProgress?.(i - 1, opts.plan.toDownload.length, p.filename)
      const url = `${apiBase()}/api/clientmods/download?host=${encodeURIComponent(opts.plan.host)}&file=${encodeURIComponent(p.filename)}`
      const res = await fetch(url, { headers: { Authorization: `Bearer ${opts.token}` } })
      if (!res.ok || !res.body) throw new Error(`${p.filename}: HTTP ${res.status}`)
      const partPath = path.join(opts.modsDir, `${p.filename}.part`)
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(partPath))
      const buf = await readFile(partPath)
      if (buf.length !== p.sizeBytes || sha256(buf) !== p.sha256.toLowerCase()) {
        await rm(partPath, { force: true })
        throw new Error(`${p.filename}: butunluk kontrolu basarisiz`)
      }
      await rm(path.join(opts.modsDir, p.filename), { force: true })
      await rename(partPath, path.join(opts.modsDir, p.filename))
      downloaded.push(p.filename)
    }
    opts.onProgress?.(opts.plan.toDownload.length, opts.plan.toDownload.length, '')
    return { ok: true, downloaded }
  } catch (err) {
    return { ok: false, downloaded, failed: err instanceof Error ? err.message : String(err) }
  }
}
