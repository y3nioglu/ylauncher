// Faz 7 (host tarafi): plugins/ klasorunu tarar, sha256 manifest uretir ve
// jar'lari API'ye publish eder. Paper "Done" oldugunda tetiklenir; basarisizlik
// yalnizca arkadaslarin otomatik senkronu etkiler — sunucu calismaya devam eder.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import { getApiBase } from '../shared/apiBase'

const apiBase = () => getApiBase()
const MAX_FILE = 50 * 1024 * 1024
const MAX_FILES = 20

export interface SyncResult {
  ok: boolean
  count: number
  skipped?: string
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * plugins/ klasorundeki .jar'lari toplar ve API'ye publish eder.
 * .disabled.jar dosyalari atlanir (aktif set yayinlanir).
 */
export async function publishPlugins(opts: {
  token: string | null
  pluginsDir: string
}): Promise<SyncResult> {
  if (!opts.token) return { ok: false, count: 0, skipped: 'token yok' }
  if (!existsSync(opts.pluginsDir)) return { ok: true, count: 0, skipped: 'plugins klasoru yok' }

  const jars = readdirSync(opts.pluginsDir).filter(
    (f) => f.toLowerCase().endsWith('.jar') && !f.toLowerCase().endsWith('.disabled.jar')
  )
  // Ayni plugin'in "ad (1).jar" kopyalari Paper'i 'Ambiguous plugin name'
  // hatasiyla IKISINI DE yuklemekten alikoyar — yayinlamadan once yakala ve
  // net bildir (host log panelinde gorunur).
  const stripped = new Map<string, string>()
  for (const f of jars) {
    const key = f.replace(/\s+\(\d+\)(?=\.jar$)/i, '').toLowerCase()
    const prev = stripped.get(key)
    if (prev) {
      return {
        ok: false,
        count: 0,
        skipped: `ayni plugin'in iki kopyasi var: "${prev}" ve "${f}" — birini plugins/ klasorunden sil`
      }
    }
    stripped.set(key, f)
  }
  if (jars.length === 0) {
    // bos set de gecerli: arkadaslarin eski jar'lari temizlenmeli
  }
  if (jars.length > MAX_FILES) {
    return { ok: false, count: 0, skipped: `${MAX_FILES} plugin siniri asildi (${jars.length})` }
  }

  const plugins: {
    filename: string
    sha256: string
    sizeBytes: number
    dataBase64: string
  }[] = []
  let total = 0
  for (const f of jars) {
    const full = path.join(opts.pluginsDir, f)
    const st = statSync(full)
    if (st.size > MAX_FILE) {
      return { ok: false, count: 0, skipped: `${f} 50MB sinirini asiyor` }
    }
    total += st.size
    if (total > 200 * 1024 * 1024) {
      return { ok: false, count: 0, skipped: 'toplam boyut 200MB sinirini asti' }
    }
    const buf = readFileSync(full)
    plugins.push({ filename: f, sha256: sha256(buf), sizeBytes: buf.length, dataBase64: buf.toString('base64') })
  }

  const controller = new AbortController()
  const to = setTimeout(() => controller.abort(), 120_000)
  try {
    const res = await fetch(`${apiBase()}/api/plugins/publish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.token}`
      },
      body: JSON.stringify({ plugins }),
      signal: controller.signal
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status} ${text.slice(0, 120)}`)
    }
    console.log(`[pluginsync] manifest yayinlandi: ${plugins.length} jar`)
    return { ok: true, count: plugins.length }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`[pluginsync] publish basarisiz (sunucu etkilenmedi): ${msg}`)
    return { ok: false, count: 0, skipped: `API hatasi: ${msg}` }
  } finally {
    clearTimeout(to)
  }
}
