// Faz 7: plugin senkronizasyonu API'si.
// HOST: POST /publish — jar listesi (meta) + jar dosyalari (binary) yuklenir.
// FRIEND: GET /manifest — host'un aktif plugin seti; GET /download — jar.
// Dosyalar API sunucusunun diskinde saklanir (storage/plugins/<hostId>/<file>).
// Erisim: publish yalnizca host'un kendisi; manifest/indirme yalnizca ARKADASLAR
// (gizlilik: plugin seti herkese acik dosya dagitimi degil, arkadas grubu icindir).
// Jar limitleri: dosya basina 50 MB, publish basina 20 dosya / 200 MB toplam.
import express, { Router, type Request, type Response, type NextFunction } from 'express'
import { existsSync } from 'node:fs'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { sql } from '../db'
import { requireAuth } from '../auth'

export const pluginsRouter = Router()

const STORAGE_ROOT = process.env.PLUGIN_STORAGE ?? path.join(process.cwd(), 'storage', 'plugins')
const MAX_FILE_BYTES = 50 * 1024 * 1024
const MAX_TOTAL_BYTES = 200 * 1024 * 1024
const MAX_FILES = 20
// express.json API geneline küçük sinir uygular; publish meta + jar dosyalari
// tasidigindan route'a özel genis limit (200MB veri + base64 genislemesi + meta).
const PUBLISH_JSON_LIMIT = '220mb'

// Express 4 async handler sarmalayici
const ah =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next)
  }

// '+': plugin jar adlarinda surum etiketleri sik kullanir (orn.
// veinminer-paper-2.11.2+1.21.11.jar) — bu olmadan publish 400 ile reddediliyordu.
const FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,120}\.jar$/i

function hostDir(hostId: number): string {
  return path.join(STORAGE_ROOT, String(hostId))
}

class ApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

function safeFileName(file: string): string {
  if (!FILENAME_RE.test(file)) throw new ApiError('Gecersiz dosya adi.')
  return file
}

interface PublishEntry {
  filename: string
  sha256: string
  sizeBytes: number
  /** base64 kodlu jar icerigi (buyuk dosyada multipart yerine tek JSON — 50MB sinir dahil) */
  dataBase64: string
}

const publishSchema = {
  parse(body: unknown): { plugins: PublishEntry[] } {
    if (typeof body !== 'object' || body === null) throw new ApiError('Gecersiz govde')
    const b = body as Record<string, unknown>
    if (!Array.isArray(b['plugins'])) throw new ApiError('plugins dizisi gerekli')
    if (b['plugins'].length > MAX_FILES) throw new ApiError(`En fazla ${MAX_FILES} plugin yuklenebilir`)
    let total = 0
    const plugins = (b['plugins'] as unknown[]).map((raw) => {
      if (typeof raw !== 'object' || raw === null) throw new ApiError('Gecersiz plugin kaydi')
      const e = raw as Record<string, unknown>
      const filename = safeFileName(String(e['filename'] ?? ''))
      const sha256 = String(e['sha256'] ?? '')
      if (!/^[a-f0-9]{64}$/i.test(sha256)) throw new ApiError(`${filename}: gecersiz sha256`)
      const sizeBytes = Number(e['sizeBytes'] ?? 0)
      if (!Number.isInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_FILE_BYTES) {
        throw new ApiError(`${filename}: boyut 1B-${MAX_FILE_BYTES} arasi olmali`)
      }
      const dataBase64 = String(e['dataBase64'] ?? '')
      // base64 uzunlugu ~4/3; toleransli kontrol
      if (dataBase64.length < Math.floor((sizeBytes * 4) / 3) - 4) {
        throw new ApiError(`${filename}: veri boyutu uyusmuyor`)
      }
      total += sizeBytes
      return { filename, sha256, sizeBytes, dataBase64 } satisfies PublishEntry
    })
    if (total > MAX_TOTAL_BYTES) throw new ApiError(`Toplam boyut ${MAX_TOTAL_BYTES / 1024 / 1024} MB'u asmamali`)
    return { plugins }
  }
}

// POST /api/plugins/publish
// HOST: plugins/ klasorundeki jar'larin tam setini yukler. Atomik degil; once
// dosyalar yazilir, hepsi basariliysa manifest satirlari upsert edilir ve eski
// fazlaliklar (yeni sette olmayan) silinir.
pluginsRouter.post(
  '/publish',
  requireAuth,
  express.json({ limit: PUBLISH_JSON_LIMIT }),
  ah(async (req, res) => {
    const { plugins } = publishSchema.parse(req.body)
    const hostId = req.auth!.uid
    const dir = hostDir(hostId)
    await mkdir(dir, { recursive: true })

    const written: string[] = []
    try {
      for (const p of plugins) {
        const buf = Buffer.from(p.dataBase64, 'base64')
        if (buf.length !== p.sizeBytes) throw new ApiError(`${p.filename}: veri boyutu uyusmuyor`)
        await writeFile(path.join(dir, p.filename), buf)
        written.push(p.filename)
      }
    } catch (err) {
      // yarim kalan dosyalari temizle (manifest hala eski seti gosteriyor)
      for (const f of written) await rm(path.join(dir, f), { force: true }).catch(() => {})
      throw err
    }

    // Manifest upsert + eski fazlaliklarin temizligi (tek transaction)
    const keep = plugins.map((p) => p.filename)
    await sql.begin(async (tx) => {
      for (const p of plugins) {
        await tx`
          insert into public.ylauncher_host_plugins (host_id, filename, sha256, size_bytes, published_at)
          values (${hostId}, ${p.filename}, ${p.sha256.toLowerCase()}, ${p.sizeBytes}, now())
          on conflict (host_id, filename) do update
          set sha256 = excluded.sha256,
              size_bytes = excluded.size_bytes,
              published_at = now()
        `
      }
      // yeni sette olmayan satirlari sil (dosyalari da sil)
      const stale = await tx<{ filename: string }[]>`
        delete from public.ylauncher_host_plugins
        where host_id = ${hostId}
          and (filename <> all (${keep}))
        returning filename
      `
      for (const s of stale) {
        await rm(path.join(dir, s.filename), { force: true }).catch(() => {})
      }
    })

    res.status(201).json({ published: plugins.length })
  })
)

// GET /api/plugins/manifest?host=<nickname>
// FRIEND: host'un aktif plugin seti (meta; erisim arkadaslik sartli).
pluginsRouter.get(
  '/manifest',
  requireAuth,
  ah(async (req, res) => {
    const uid = req.auth!.uid
    const hostNick = String(req.query['host'] ?? '')
    if (!/^[A-Za-z0-9_]{3,16}$/.test(hostNick)) {
      res.status(400).json({ error: 'Gecersiz host parametresi' })
      return
    }
    const hostRows = await sql<{ id: number }[]>`
      select id::int from public.ylauncher_users where lower(nickname) = ${hostNick.toLowerCase()} limit 1
    `
    const host = hostRows[0]
    if (!host) {
      res.status(404).json({ error: 'Host bulunamadi' })
      return
    }
    if (host.id !== uid) {
      const friend = await sql<{ id: number }[]>`
        select 1 as id from public.ylauncher_friendships
        where status = 'accepted'
          and ((user_id = ${uid} and friend_id = ${host.id})
            or (user_id = ${host.id} and friend_id = ${uid}))
        limit 1
      `
      if (friend.length === 0) {
        res.status(403).json({ error: 'Plugin listesi yalnizca arkadaslara acik.' })
        return
      }
    }
    const rows = await sql<{ filename: string; sha256: string; size_bytes: string; published_at: Date }[]>`
      select filename, sha256, size_bytes, published_at
      from public.ylauncher_host_plugins
      where host_id = ${host.id}
      order by filename
    `
    res.json({
      host: hostNick,
      plugins: rows.map((r) => ({
        filename: r.filename,
        sha256: r.sha256,
        sizeBytes: Number(r.size_bytes),
        publishedAt: new Date(r.published_at).toISOString()
      }))
    })
  })
)

// GET /api/plugins/download?host=<nickname>&file=<filename>
// FRIEND: jar indirme (arkadaslik sartli; sha256 basligi ile dogrulama).
pluginsRouter.get(
  '/download',
  requireAuth,
  ah(async (req, res) => {
    const uid = req.auth!.uid
    const hostNick = String(req.query['host'] ?? '')
    const file = String(req.query['file'] ?? '')
    if (!/^[A-Za-z0-9_]{3,16}$/.test(hostNick) || !FILENAME_RE.test(file)) {
      res.status(400).json({ error: 'Gecersiz parametreler' })
      return
    }
    const hostRows = await sql<{ id: number }[]>`
      select id::int from public.ylauncher_users where lower(nickname) = ${hostNick.toLowerCase()} limit 1
    `
    const host = hostRows[0]
    if (!host) {
      res.status(404).json({ error: 'Host bulunamadi' })
      return
    }
    if (host.id !== uid) {
      const friend = await sql<{ id: number }[]>`
        select 1 as id from public.ylauncher_friendships
        where status = 'accepted'
          and ((user_id = ${uid} and friend_id = ${host.id})
            or (user_id = ${host.id} and friend_id = ${uid}))
        limit 1
      `
      if (friend.length === 0) {
        res.status(403).json({ error: 'Indirme yalnizca arkadaslara acik.' })
        return
      }
    }
    const meta = await sql<{ sha256: string }[]>`
      select sha256 from public.ylauncher_host_plugins
      where host_id = ${host.id} and filename = ${file}
      limit 1
    `
    if (meta.length === 0) {
      res.status(404).json({ error: 'Plugin manifestte yok' })
      return
    }
    const filePath = path.join(hostDir(host.id), file)
    if (!existsSync(filePath)) {
      res.status(410).json({ error: 'Dosya depoda yok — host yeniden publish etmeli.' })
      return
    }
    const st = await stat(filePath)
    res.setHeader('Content-Type', 'application/java-archive')
    res.setHeader('Content-Length', st.size)
    res.setHeader('X-Plugin-Sha256', meta[0].sha256)
    res.sendFile(filePath)
  })
)
