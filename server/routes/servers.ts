import { Router, type Request, type Response, type NextFunction } from 'express'
import { z } from 'zod'
import { sql } from '../db'
import { requireAuth } from '../auth'

export const serversRouter = Router()

// Express 4 async handler sarmalayici
const ah =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next)
  }

// Duyurular bu pencere icindeyse "aktif" sayilir (host heartbeat'i ile birlikte)
const ACTIVE_WINDOW_MIN = 10

const announceSchema = z.object({
  // IPv4 ya da hostname (bore.pub gibi) kabul edilir; loopback/ozel IP reddedilir
  address: z
    .string()
    .max(253)
    .regex(/^(\d{1,3}(?:\.\d{1,3}){3}|[a-z0-9][a-z0-9.\-]*\.[a-z]{2,})$/i, 'Adres IPv4 veya hostname olmali')
    .refine(
      (a) =>
        !a.startsWith('127.') &&
        !a.startsWith('10.') &&
        !a.startsWith('192.168.') &&
        !a.startsWith('169.254.') &&
        !/^172\.(1[6-9]|2\d|3[01])\./.test(a),
      { message: 'Ozel/loopback IP duyurulamaz' }
    ),
  port: z.number().int().min(1).max(65535).default(25565),
  mcVersion: z.string().regex(/^[0-9a-zA-Z.\-]+$/, 'Gecersiz surum'),
  online: z.boolean().default(true)
})

interface ActiveServerRow {
  host_id: number
  nickname: string
  last_seen_at: Date | null
  address: string
  port: number
  mc_version: string
  announced_at: Date
  kick_reason?: string | null
  kick_raw?: string | null
  kick_at?: Date | null
}

function isActive(row: Pick<ActiveServerRow, 'announced_at' | 'last_seen_at'>): boolean {
  const announcedAge = Date.now() - new Date(row.announced_at).getTime()
  if (announcedAge > ACTIVE_WINDOW_MIN * 60_000) return false
  if (!row.last_seen_at) return false
  const seenAge = Date.now() - new Date(row.last_seen_at).getTime()
  return seenAge < 15 * 60_000
}

function toDto(row: ActiveServerRow) {
  return {
    hostId: row.host_id,
    host: row.nickname,
    address: row.address,
    port: row.port,
    mcVersion: row.mc_version,
    announcedAt: new Date(row.announced_at).toISOString(),
    lastKick:
      row.kick_reason && row.kick_at
        ? { reason: row.kick_reason, rawLine: row.kick_raw ?? '', at: new Date(row.kick_at).toISOString() }
        : null
  }
}

// POST /api/servers/announce { address, port, mcVersion, online }
// Host tarafindan cagrilir: "sunucu acik, su adreste" bildirimi.
// Upsert: ayni host tekrar duyurursa guncelle.
serversRouter.post(
  '/announce',
  requireAuth,
  ah(async (req, res) => {
    const parsed = announceSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Gecersiz veri' })
      return
    }
    const { address, port, mcVersion, online } = parsed.data
    const uid = req.auth!.uid

    if (!online) {
      await sql`delete from public.ylauncher_servers where host_id = ${uid}`
      res.json({ withdrawn: true })
      return
    }

    await sql`
      insert into public.ylauncher_servers (host_id, address, port, mc_version, announced_at)
      values (${uid}, ${address}, ${port}, ${mcVersion}, now())
      on conflict (host_id) do update
      set address = excluded.address,
          port = excluded.port,
          mc_version = excluded.mc_version,
          announced_at = now()
    `
    res.status(201).json({ announced: true })
  })
)

// POST /api/servers/withdraw  — sunucu kapaninca duyuruyu kaldir
serversRouter.post(
  '/withdraw',
  requireAuth,
  ah(async (req, res) => {
    await sql`delete from public.ylauncher_servers where host_id = ${req.auth!.uid}`
    res.json({ withdrawn: true })
  })
)

// POST /api/servers/kick { nickname, reason, rawLine }
// Faz 5b: HOST tarafindan cagrilir. Paper log'unda yakalanan kick sebebini
// katilan oyuncunun launcher'i tasir. Kisa omurlu (2 dk) ve host+oyuncu
// basina tek satir: gecmis tutulmaz.
const kickSchema = z.object({
  nickname: z.string().regex(/^[A-Za-z0-9_]{3,16}$/, 'Gecersiz oyuncu adi'),
  reason: z.string().min(3).max(300),
  rawLine: z.string().max(500).default('')
})

serversRouter.post(
  '/kick',
  requireAuth,
  ah(async (req, res) => {
    const parsed = kickSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Gecersiz veri' })
      return
    }
    const { nickname, reason, rawLine } = parsed.data
    await sql`
      insert into public.ylauncher_server_kicks (host_id, nickname_ci, reason, raw_line)
      values (${req.auth!.uid}, ${nickname.toLowerCase()}, ${reason}, ${rawLine})
      on conflict (host_id, nickname_ci) do update
      set reason = excluded.reason,
          raw_line = excluded.raw_line,
          created_at = now()
    `
    res.status(201).json({ recorded: true })
  })
)

// GET /api/servers/active
// Arkadaslarin acik sunucularini getirir: kendisinin VE arkadaslarinin duyurulari.
serversRouter.get(
  '/active',
  requireAuth,
  ah(async (req, res) => {
    const uid = req.auth!.uid
    const rows = await sql<ActiveServerRow[]>`
      select s.host_id, s.address, s.port, s.mc_version, s.announced_at,
             u.nickname, u.last_seen_at,
             k.reason as kick_reason, k.raw_line as kick_raw, k.created_at as kick_at
      from public.ylauncher_servers s
      join public.ylauncher_users u on u.id = s.host_id
      left join public.ylauncher_server_kicks k
        on k.host_id = s.host_id
       and k.nickname_ci = lower((select nickname from public.ylauncher_users where id = ${uid}))
       and k.created_at > now() - interval '2 minutes'
      where s.host_id = ${uid}
         or s.host_id in (
           select friend_id from public.ylauncher_friendships
           where user_id = ${uid} and status = 'accepted'
         )
      order by s.announced_at desc
    `
    res.json({
      servers: rows.filter(isActive).map(toDto)
    })
  })
)
