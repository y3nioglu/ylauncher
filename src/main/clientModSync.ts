// Faz 12 (host tarafi): clientMods/ klasorunu tarar, sha256 manifest uretir ve
// jar'lari API'ye publish eder; loader profilini de yayinlar. Paper "Done"
// oldugunda tetiklenir; basarisizlik yalnizca arkadaslarin otomatik senkronunu
// etkiler — sunucu calismaya devam eder (pluginSync ile ayni politika).
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import { getApiBase } from '../shared/apiBase'

const apiBase = () => getApiBase()
const MAX_FILE = 50 * 1024 * 1024
const MAX_FILES = 20

export interface ClientModPublishResult {
  ok: boolean
  count: number
  skipped?: string
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/** clientMods/ klasorundeki .jar'larin tam setini API'ye publish eder. */
export async function publishClientMods(opts: {
  token: string | null
  clientModsDir: string
  mcVersion: string
}): Promise<ClientModPublishResult> {
  if (!opts.token) return { ok: false, count: 0, skipped: 'token yok' }
  if (!existsSync(opts.clientModsDir)) return { ok: true, count: 0, skipped: 'clientMods klasoru yok' }

  const jars = readdirSync(opts.clientModsDir).filter((f) => f.toLowerCase().endsWith('.jar'))
  if (jars.length > MAX_FILES) {
    return { ok: false, count: 0, skipped: `${MAX_FILES} mod siniri asildi (${jars.length})` }
  }

  const mods: { filename: string; sha256: string; sizeBytes: number; dataBase64: string }[] = []
  let total = 0
  for (const f of jars) {
    const full = path.join(opts.clientModsDir, f)
    const st = statSync(full)
    if (st.size > MAX_FILE) return { ok: false, count: 0, skipped: `${f} 50MB sinirini asiyor` }
    total += st.size
    if (total > MAX_FILE * MAX_FILES) {
      return { ok: false, count: 0, skipped: 'toplam boyut 200MB sinirini asti' }
    }
    const buf = readFileSync(full)
    mods.push({ filename: f, sha256: sha256(buf), sizeBytes: buf.length, dataBase64: buf.toString('base64') })
  }

  const controller = new AbortController()
  const to = setTimeout(() => controller.abort(), 120_000)
  try {
    const res = await fetch(`${apiBase()}/api/clientmods/publish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.token}`
      },
      body: JSON.stringify({ mods }),
      signal: controller.signal
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status} ${text.slice(0, 120)}`)
    }
    return { ok: true, count: mods.length }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, count: 0, skipped: `API hatasi: ${msg}` }
  } finally {
    clearTimeout(to)
  }
}

/** Loader profilini yayinlar (arkadaslarin oyunu Fabric ile acilsin). */
export async function publishLoaderProfile(opts: {
  token: string | null
  loader: 'fabric' | 'vanilla'
  loaderVersion: string
  mcVersion: string
}): Promise<{ ok: boolean; skipped?: string }> {
  if (!opts.token) return { ok: false, skipped: 'token yok' }
  const controller = new AbortController()
  const to = setTimeout(() => controller.abort(), 15_000)
  try {
    const res = await fetch(`${apiBase()}/api/clientmods/profile`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.token}`
      },
      body: JSON.stringify({
        loader: opts.loader,
        loaderVersion: opts.loaderVersion,
        mcVersion: opts.mcVersion
      }),
      signal: controller.signal
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status} ${text.slice(0, 120)}`)
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, skipped: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(to)
  }
}
