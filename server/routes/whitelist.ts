import { Router, type Request, type Response, type NextFunction } from 'express'
import { z } from 'zod'
import { sql } from '../db'
import { requireAuth } from '../auth'

export const whitelistRouter = Router()

// Express 4 async handler sarmalayici
const ah =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next)
  }

interface ReqRow {
  id: number
  host_id: number
  requester_id: number
  status: 'pending' | 'accepted' | 'declined'
  created_at: Date
  responded_at: Date | null
  nickname: string
}

function dto(r: ReqRow) {
  return {
    id: r.id,
    hostId: r.host_id,
    requesterId: r.requester_id,
    nickname: r.nickname,
    status: r.status,
    createdAt: new Date(r.created_at).toISOString(),
    respondedAt: r.responded_at ? new Date(r.responded_at).toISOString() : null
  }
}

const NICK_RE = /^[A-Za-z0-9_]{3,16}$/

// POST /api/whitelist/requests { nickname }
// KATILAN taraf: host'a whitelist istegi gonderir. nickname = host'un
// launcher nickname'i. Arkadaslik sarti MANDATORY — istek sadece
// arkadaslara acik (gizlilik: yabancilar host'u rahatsiz edemez).
const requestSchema = z.object({
  nickname: z.string().regex(NICK_RE, 'Gecersiz nickname')
})

whitelistRouter.post(
  '/requests',
  requireAuth,
  ah(async (req, res) => {
    const parsed = requestSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Gecersiz veri' })
      return
    }

    const requesterId = req.auth!.uid
    const hostRows = await sql<{ id: number; nickname: string }[]>`
      select id::int, nickname
      from public.ylauncher_users
      where lower(nickname) = ${parsed.data.nickname.toLowerCase()}
      limit 1
    `
    const host = hostRows[0]
    if (!host) {
      res.status(404).json({ error: 'Bu nickname ile bir kullanici bulunamadi.' })
      return
    }
    if (host.id === requesterId) {
      res.status(400).json({ error: 'Kendinize whitelist istegi gonderemezsiniz.' })
      return
    }

    // Arkadaslik zorunlulugu
    const friendRows = await sql<{ id: number }[]>`
      select 1 as id from public.ylauncher_friendships
      where status = 'accepted'
        and ((user_id = ${requesterId} and friend_id = ${host.id})
          or (user_id = ${host.id} and friend_id = ${requesterId}))
      limit 1
    `
    if (friendRows.length === 0) {
      res.status(403).json({ error: 'Whitelist istegi yalnizca arkadaslara gonderilebilir.' })
      return
    }

    // Upsert: onceki declined/pending istek varsa yeniden pending yap
    await sql`
      insert into public.ylauncher_whitelist_requests (host_id, requester_id, status)
      values (${host.id}, ${requesterId}, 'pending')
      on conflict (host_id, requester_id)
      do update set status = 'pending', created_at = now(), responded_at = null
    `
    res.status(201).json({ sent: true })
  })
)

// GET /api/whitelist/requests -> gelen (host icin) + gonderdiklerim (sonuc takibi)
whitelistRouter.get(
  '/requests',
  requireAuth,
  ah(async (req, res) => {
    const uid = req.auth!.uid
    const incoming = await sql<ReqRow[]>`
      select r.id::int, r.host_id::int, r.requester_id::int, r.status, r.created_at, r.responded_at,
             u.nickname
      from public.ylauncher_whitelist_requests r
      join public.ylauncher_users u on u.id = r.requester_id
      where r.host_id = ${uid}
      order by r.created_at desc
      limit 50
    `
    const outgoing = await sql<ReqRow[]>`
      select r.id::int, r.host_id::int, r.requester_id::int, r.status, r.created_at, r.responded_at,
             u.nickname
      from public.ylauncher_whitelist_requests r
      join public.ylauncher_users u on u.id = r.host_id
      where r.requester_id = ${uid}
      order by r.created_at desc
      limit 50
    `
    res.json({ incoming: incoming.map(dto), outgoing: outgoing.map(dto) })
  })
)

// POST /api/whitelist/requests/:id/respond { accept }
// HOST taraf: tek tikla onayla/reddet.
const respondSchema = z.object({ accept: z.boolean() })

whitelistRouter.post(
  '/requests/:id/respond',
  requireAuth,
  ah(async (req, res) => {
    const parsed = respondSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Gecersiz veri' })
      return
    }
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Gecersiz istek id' })
      return
    }

    const rows = await sql<ReqRow[]>`
      update public.ylauncher_whitelist_requests
      set status = ${parsed.data.accept ? 'accepted' : 'declined'},
          responded_at = now()
      where id = ${id} and host_id = ${req.auth!.uid} and status = 'pending'
      returning id::int, host_id::int, requester_id::int, status, created_at, responded_at,
                (select nickname from public.ylauncher_users where id = requester_id) as nickname
    `
    if (rows.length === 0) {
      res.status(404).json({ error: 'Bekleyen istek bulunamadi (zaten yanitlanmis olabilir).' })
      return
    }
    res.json({ responded: true, status: rows[0].status, nickname: rows[0].nickname })
  })
)
