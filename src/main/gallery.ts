// Faz 18: ekran goruntusu galerisi — MC F2 ile kaydettigi screenshots/
// klasorunu okur; en yeni N png'i data URI olarak dondurur (CSP dostu).
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

export interface ScreenshotInfo {
  file: string
  /** ISO zaman (dosya mtime) */
  takenAt: string
  sizeKB: number
  /** data:image/png;base64,... */
  dataUri: string
}

const MAX_COUNT = 24
const MAX_BYTES = 4 * 1024 * 1024 // 4MB ustunu gosterme (base64 sizmasin)

export async function listScreenshots(gameRoot: string): Promise<ScreenshotInfo[]> {
  const dir = path.join(gameRoot, 'screenshots')
  let names: string[] = []
  try {
    names = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith('.png'))
  } catch {
    return [] // klasor yok — hic oyun acilmamis
  }
  // mtime ile sirala (en yeni once)
  const withTime = await Promise.all(
    names.map(async (f) => {
      try {
        const st = await stat(path.join(dir, f))
        return { f, mtime: st.mtimeMs, size: st.size }
      } catch {
        return { f, mtime: 0, size: 0 }
      }
    })
  )
  withTime.sort((a, b) => b.mtime - a.mtime)

  const out: ScreenshotInfo[] = []
  for (const { f, mtime, size } of withTime) {
    if (out.length >= MAX_COUNT) break
    if (size === 0 || size > MAX_BYTES) continue
    try {
      const buf = await readFile(path.join(dir, f))
      out.push({
        file: f,
        takenAt: new Date(mtime).toISOString(),
        sizeKB: Math.round(size / 1024),
        dataUri: `data:image/png;base64,${buf.toString('base64')}`
      })
    } catch {
      /* tek dosya okunamazsa atla */
    }
  }
  return out
}

/** Ekran goruntusunu sil (galeriden). */
export async function deleteScreenshot(gameRoot: string, file: string): Promise<boolean> {
  // Path traversal korumasi: sadece dosya adi kabul edilir
  if (!/^[A-Za-z0-9][A-Za-z0-9._ ()-]*\.png$/i.test(file)) return false
  try {
    const { unlink } = await import('node:fs/promises')
    await unlink(path.join(gameRoot, 'screenshots', file))
    return true
  } catch {
    return false
  }
}
