// Faz 12: client mod senkronizasyonu API'si. plugins.ts ile ayni desen:
// HOST: POST /publish (jar meta + base64) ve POST /profile (loader bilgisi).
// FRIEND: GET /manifest?host=, GET /download?host=&file=, GET /profile?host=
// Dosyalar API sunucusunun diskinde: storage/clientmods/<hostId>/<file>.
// Erisim: publish yalnizca host; okuma yalnizca ARKADASLAR.
// Jar limitleri: dosya basina 50 MB, publish basina 20 dosya / 200 MB toplam.
import express, { Router, type Request, type Response, type NextFunction } from 'express'
import { existsSync } from 'node:fs'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { sql } from '../db'
import { requireAuth } from '../auth'

export const clientModsRouter = Router()

const STORAGE_ROOT = process.env.CLIENTMOD_STORAGE ?? path.join(process.cwd(), 'storage', 'clientmods')
const MAX_FILE_BYTES = 50 * 1024 * 1024
const MAX_TOTAL_BYTES = 200 * 1024 * 1024
const MAX_FILES = 20
// client mod jar'lari plugin'lerden buyuk olabilir (Sodium ~1-2MB ama shader
// paketli modlar buyur); publish meta + binary tasidigindan genis limit.
const PUBLISH_JSON_LIMIT = '220mb'

const ah =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next)
  }

// '+': mod jar adlarinda surum etiketi sik kullanir (orn. sodium-fabric-0.6.13+mc1.21.jar)
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

/** Host'un arkadasi mi (kendisi dahil)? */
async function isFriend(uid: number, hostId: number): Promise<boolean> {
  if (uid === hostId) return true
  const friend = await sql<{ id: number }[]>`
    select 1 as id from public.ylauncher_friendships
    where status = 'accepted'
      and ((user_id = ${uid} and friend_id = ${hostId})
        or (user_id = ${hostId} and friend_id = ${uid}))
    limit 1
  `
  return friend.length > 0
}

async function resolveHost(nick: string): Promise<{ id: number } | null> {
  const rows = await sql<{ id: number }[]>`
    select id::int from public.ylauncher_users where lower(nickname) = ${nick.toLowerCase()} limit 1
  `
  return rows[0] ?? null
}

interface PublishEntry {
  filename: string
  sha256: string
  sizeBytes: number
  dataBase64: string
}

function parsePublish(body: unknown): { mods: PublishEntry[] } {
  if (typeof body !== 'object' || body === null) throw new ApiError('Gecersiz govde')
  const b = body as Record<string, unknown>
  if (!Array.isArray(b['mods'])) throw new ApiError('mods dizisi gerekli')
  if (b['mods'].length > MAX_FILES) throw new ApiError(`En fazla ${MAX_FILES} mod yuklenebilir`)
  let total = 0
  const mods = (b['mods'] as unknown[]).map((raw) => {
    if (typeof raw !== 'object' || raw === null) throw new ApiError('Gecersiz mod kaydi')
    const e = raw as Record<string, unknown>
    const filename = safeFileName(String(e['filename'] ?? ''))
    const sha256 = String(e['sha256'] ?? '')
    if (!/^[a-f0-9]{64}$/i.test(sha256)) throw new ApiError(`${filename}: gecersiz sha256`)
    const sizeBytes = Number(e['sizeBytes'] ?? 0)
    if (!Number.isInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_FILE_BYTES) {
      throw new ApiError(`${filename}: boyut 1B-${MAX_FILE_BYTES} arasi olmali`)
    }
    const dataBase64 = String(e['dataBase64'] ?? '')
    if (dataBase64.length < Math.floor((sizeBytes * 4) / 3) - 4) {
      throw new ApiError(`${filename}: veri boyutu uyusmuyor`)
    }
    total += sizeBytes
    return { filename, sha256, sizeBytes, dataBase64 } satisfies PublishEntry
  })
  if (total > MAX_TOTAL_BYTES) throw new ApiError(`Toplam boyut ${MAX_TOTAL_BYTES / 1024 / 1024} MB'u asmamali`)
  return { mods }
}

// POST /api/clientmods/publish
clientModsRouter.post(
  '/publish',
  requireAuth,
  express.json({ limit: PUBLISH_JSON_LIMIT }),
  ah(async (req, res) => {
    const { mods } = parsePublish(req.body)
    const hostId = req.auth!.uid
    const dir = hostDir(hostId)
    await mkdir(dir, { recursive: true })

    const written: string[] = []
    try {
      for (const p of mods) {
        const buf = Buffer.from(p.dataBase64, 'base64')
        if (buf.length !== p.sizeBytes) throw new ApiError(`${p.filename}: veri boyutu uyusmuyor`)
        await writeFile(path.join(dir, p.filename), buf)
        written.push(p.filename)
      }
    } catch (err) {
      for (const f of written) await rm(path.join(dir, f), { force: true }).catch(() => {})
      throw err
    }

    const keep = mods.map((p) => p.filename)
    await sql.begin(async (tx) => {
      for (const p of mods) {
        await tx`
          insert into public.ylauncher_host_clientmods (host_id, filename, sha256, size_bytes, published_at)
          values (${hostId}, ${p.filename}, ${p.sha256.toLowerCase()}, ${p.sizeBytes}, now())
          on conflict (host_id, filename) do update
          set sha256 = excluded.sha256,
              size_bytes = excluded.size_bytes,
              published_at = now()
        `
      }
      const stale = await tx<{ filename: string }[]>`
        delete from public.ylauncher_host_clientmods
        where host_id = ${hostId}
          and (filename <> all (${keep}))
        returning filename
      `
      for (const s of stale) {
        await rm(path.join(dir, s.filename), { force: true }).catch(() => {})
      }
    })

    res.status(201).json({ published: mods.length })
  })
)

// POST /api/clientmods/profile  { loader, loaderVersion, mcVersion }
clientModsRouter.post(
  '/profile',
  requireAuth,
  ah(async (req, res) => {
    const b = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>
    const loader = String(b['loader'] ?? '')
    const loaderVersion = String(b['loaderVersion'] ?? '')
    const mcVersion = String(b['mcVersion'] ?? '')
    if (!['fabric', 'vanilla'].includes(loader)) throw new ApiError('Gecersiz loader')
    if (!/^[0-9A-Za-z.\-+]{1,32}$/.test(loaderVersion) || !/^[0-9A-Za-z.\-+]{1,32}$/.test(mcVersion)) {
      throw new ApiError('Gecersiz surum bilgisi')
    }
    await sql`
      insert into public.ylauncher_host_profiles (host_id, loader, loader_version, mc_version, published_at)
      values (${req.auth!.uid}, ${loader}, ${loaderVersion}, ${mcVersion}, now())
      on conflict (host_id) do update
      set loader = excluded.loader,
          loader_version = excluded.loader_version,
          mc_version = excluded.mc_version,
          published_at = now()
    `
    res.status(201).json({ published: true })
  })
)

// GET /api/clientmods/manifest?host=<nickname>
clientModsRouter.get(
  '/manifest',
  requireAuth,
  ah(async (req, res) => {
    const uid = req.auth!.uid
    const hostNick = String(req.query['host'] ?? '')
    if (!/^[A-Za-z0-9_]{3,16}$/.test(hostNick)) {
      res.status(400).json({ error: 'Gecersiz host parametresi' })
      return
    }
    const host = await resolveHost(hostNick)
    if (!host) {
      res.status(404).json({ error: 'Host bulunamadi' })
      return
    }
    if (!(await isFriend(uid, host.id))) {
      res.status(403).json({ error: 'Mod listesi yalnizca arkadaslara acik.' })
      return
    }
    const rows = await sql<{ filename: string; sha256: string; size_bytes: string; published_at: Date }[]>`
      select filename, sha256, size_bytes, published_at
      from public.ylauncher_host_clientmods
      where host_id = ${host.id}
      order by filename
    `
    res.json({
      host: hostNick,
      mods: rows.map((r) => ({
        filename: r.filename,
        sha256: r.sha256,
        sizeBytes: Number(r.size_bytes),
        publishedAt: new Date(r.published_at).toISOString()
      }))
    })
  })
)

// GET /api/clientmods/profile?host=<nickname>
clientModsRouter.get(
  '/profile',
  requireAuth,
  ah(async (req, res) => {
    const uid = req.auth!.uid
    const hostNick = String(req.query['host'] ?? '')
    if (!/^[A-Za-z0-9_]{3,16}$/.test(hostNick)) {
      res.status(400).json({ error: 'Gecersiz host parametresi' })
      return
    }
    const host = await resolveHost(hostNick)
    if (!host) {
      res.status(404).json({ error: 'Host bulunamadi' })
      return
    }
    if (!(await isFriend(uid, host.id))) {
      res.status(403).json({ error: 'Profil yalnizca arkadaslara acik.' })
      return
    }
    const rows = await sql<{ loader: string; loader_version: string; mc_version: string; published_at: Date }[]>`
      select loader, loader_version, mc_version, published_at
      from public.ylauncher_host_profiles
      where host_id = ${host.id}
      limit 1
    `
    if (rows.length === 0) {
      res.json({ profile: null })
      return
    }
    const r = rows[0]
    res.json({
      profile: {
        loader: r.loader,
        loaderVersion: r.loader_version,
        mcVersion: r.mc_version,
        publishedAt: new Date(r.published_at).toISOString()
      }
    })
  })
)

// GET /api/clientmods/download?host=<nickname>&file=<filename>
clientModsRouter.get(
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
    const host = await resolveHost(hostNick)
    if (!host) {
      res.status(404).json({ error: 'Host bulunamadi' })
      return
    }
    if (!(await isFriend(uid, host.id))) {
      res.status(403).json({ error: 'Indirme yalnizca arkadaslara acik.' })
      return
    }
    const meta = await sql<{ sha256: string }[]>`
      select sha256 from public.ylauncher_host_clientmods
      where host_id = ${host.id} and filename = ${file}
      limit 1
    `
    if (meta.length === 0) {
      res.status(404).json({ error: 'Mod manifestte yok' })
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
    res.setHeader('X-Mod-Sha256', meta[0].sha256)
    res.sendFile(filePath)
  })
)
