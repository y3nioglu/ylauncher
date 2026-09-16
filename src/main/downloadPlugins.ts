// Faz 7 (arkadas tarafi): host'un manifest'ini ceker, kendi plugins/
// klasorundeki jar'larla karsilastirir (sha256) ve eksik/farkli dosyalari
// indirir. Sirasi gelmeyen host jar'lari SILINMEZ (kullanici kendi plugin'ini
// koyduysa dokunulmaz) — yalnizca manifestteki dosyalar hedeflenir.
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { existsSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { getApiBase } from '../shared/apiBase'

const apiBase = () => getApiBase()

export interface SyncPlan {
  host: string
  toDownload: { filename: string; sha256: string; sizeBytes: number }[]
  upToDate: string[]
  manifestTotal: number
}

export interface SyncResult {
  ok: boolean
  downloaded: string[]
  failed?: string
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

async function fetchManifest(token: string, host: string): Promise<{
  plugins: { filename: string; sha256: string; sizeBytes: number }[]
}> {
  const res = await fetch(`${apiBase()}/api/plugins/manifest?host=${encodeURIComponent(host)}`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status} ${text.slice(0, 120)}`)
  }
  return (await res.json()) as {
    plugins: { filename: string; sha256: string; sizeBytes: number }[]
  }
}

async function localSha(file: string): Promise<string | null> {
  if (!existsSync(file)) return null
  try {
    return sha256(await import('node:fs/promises').then((m) => m.readFile(file)))
  } catch {
    return null
  }
}

/** Manifesti ceker ve indirilecekleri belirler (indirmez). */
export async function planPluginSync(opts: {
  token: string
  host: string
  pluginsDir: string
}): Promise<SyncPlan> {
  const manifest = await fetchManifest(opts.token, opts.host)
  const toDownload: SyncPlan['toDownload'] = []
  const upToDate: string[] = []
  for (const p of manifest.plugins) {
    const local = await localSha(path.join(opts.pluginsDir, p.filename))
    if (local === p.sha256.toLowerCase()) upToDate.push(p.filename)
    else toDownload.push(p)
  }
  return { host: opts.host, toDownload, upToDate, manifestTotal: manifest.plugins.length }
}

/** Plandaki dosyalari indirir (atomik: .part -> rename). */
export async function syncPlugins(opts: {
  token: string
  plan: SyncPlan
  pluginsDir: string
  onProgress?: (done: number, total: number, file: string) => void
}): Promise<SyncResult> {
  const downloaded: string[] = []
  await mkdir(opts.pluginsDir, { recursive: true })
  try {
    let i = 0
    for (const p of opts.plan.toDownload) {
      i++
      opts.onProgress?.(i - 1, opts.plan.toDownload.length, p.filename)
      const url = `${apiBase()}/api/plugins/download?host=${encodeURIComponent(opts.plan.host)}&file=${encodeURIComponent(p.filename)}`
      const res = await fetch(url, { headers: { Authorization: `Bearer ${opts.token}` } })
      if (!res.ok || !res.body) throw new Error(`${p.filename}: HTTP ${res.status}`)
      const partPath = path.join(opts.pluginsDir, `${p.filename}.part`)
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(partPath))
      // butunluk kontrolu
      const buf = await import('node:fs/promises').then((m) => m.readFile(partPath))
      if (buf.length !== p.sizeBytes || sha256(buf) !== p.sha256.toLowerCase()) {
        await rm(partPath, { force: true })
        throw new Error(`${p.filename}: butunluk kontrolu basarisiz`)
      }
      await rm(path.join(opts.pluginsDir, p.filename), { force: true })
      await rename(partPath, path.join(opts.pluginsDir, p.filename))
      downloaded.push(p.filename)
    }
    opts.onProgress?.(opts.plan.toDownload.length, opts.plan.toDownload.length, '')
    return { ok: true, downloaded }
  } catch (err) {
    return {
      ok: false,
      downloaded,
      failed: err instanceof Error ? err.message : String(err)
    }
  }
}
