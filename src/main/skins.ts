// Faz 14: offline skin desteği — SkinsRestorer otomatik kurulumu.
//
// Offline (online-mode=false) sunucularda Mojang skinleri görünmez; kanonik
// çözüm sunucu tarafında SkinsRestorer plugin'idir (oyuncular /skin url ile
// skin set eder, plugin Mojang'dan ceker). Launcher burada iki sey yapar:
//  1. Sunucu ilk kez hazırlanırken plugins/ klasorune SkinsRestorer.jar indirir
//     (GitHub Releases latest — Paper/Bukkit universal jar)
//  2. Plugins sekmesindeki "Skin desteği" kutusundan tek tıkla kurulum/yenileme
// Kurulum başarısız olursa sunucu etkilenmez — sadece skin özelliği olmaz.
import { createWriteStream } from 'node:fs'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

const SR_RELEASES = 'https://api.github.com/repos/SkinsRestorer/SkinsRestorer/releases/latest'
const UA = 'ylauncher/0.1 (arkadas grubu launcher; +https://github.com/y3nioglu/ylauncher)'

export interface SkinPluginResult {
  ok: boolean
  installed?: string
  skipped?: string
}

export function findSkinsRestorer(pluginsDir: string): string | null {
  if (!existsSync(pluginsDir)) return null
  const hit = readdirSync(pluginsDir).find((f) => /^skinsrestorer.*\.jar$/i.test(f))
  return hit ?? null
}

/** SkinsRestorer'ın en son universal (Bukkit/Paper) jar'ını indirir. */
export async function ensureSkinsRestorer(opts: {
  pluginsDir: string
  onStatus?: (message: string) => void
}): Promise<SkinPluginResult> {
  mkdirSync(opts.pluginsDir, { recursive: true })
  let tmp: string | null = null
  try {
    opts.onStatus?.('SkinsRestorer surumu kontrol ediliyor...')
    const res = await fetch(SR_RELEASES, { headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const rel = (await res.json()) as {
      tag_name: string
      assets: { name: string; browser_download_url: string }[]
    }
    // Universal Bukkit/Paper jar: 'SkinsRestorer.jar' (sürüm-sonekli degil)
    const asset = rel.assets.find((a) => /^SkinsRestorer\.jar$/i.test(a.name))
    if (!asset) throw new Error('universal jar bulunamadi (release icerigi degismis olabilir)')

    const dest = path.join(opts.pluginsDir, `SkinsRestorer-${rel.tag_name}.jar`)
    if (existsSync(dest)) return { ok: true, skipped: `zaten kurulu (${rel.tag_name})` }

    opts.onStatus?.(`SkinsRestorer ${rel.tag_name} indiriliyor...`)
    const dres = await fetch(asset.browser_download_url, { headers: { 'User-Agent': UA } })
    if (!dres.ok || !dres.body) throw new Error(`HTTP ${dres.status}`)
    tmp = `${dest}.part`
    await pipeline(Readable.fromWeb(dres.body as never), createWriteStream(tmp))
    if (statSync(tmp).size < 100_000) throw new Error('indirilen dosya cok kucuk (gecersiz)')
    renameSync(tmp, dest)
    opts.onStatus?.(`SkinsRestorer ${rel.tag_name} kuruldu — sunucuyu yeniden baslat`)
    return { ok: true, installed: `SkinsRestorer-${rel.tag_name}.jar` }
  } catch (err) {
    if (tmp) rmSync(tmp, { force: true })
    return { ok: false, skipped: err instanceof Error ? err.message : String(err) }
  }
}
