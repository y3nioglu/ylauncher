import { Router, type Request, type Response, type NextFunction } from 'express'
import { z } from 'zod'
import {
  NICKNAME_RE,
  findUserByNickname,
  findFriendshipBetween,
  getFriendshipById,
  createFriendRequest,
  acceptFriendship,
  deleteFriendshipById,
  deleteFriendshipPair,
  listAcceptedFriends,
  listIncomingRequests,
  listOutgoingRequests,
  searchUsersByPrefix
} from '../db'
import { requireAuth } from '../auth'

export const friendsRouter = Router()

// Express 4 async handler sarmalayici
const ah =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next)
  }

const ONLINE_WINDOW_MIN = 5

function isOnline(lastSeen: Date | null): boolean {
  if (!lastSeen) return false
  return Date.now() - new Date(lastSeen).getTime() < ONLINE_WINDOW_MIN * 60_000
}

function toDto(u: { id: number; nickname: string; last_seen_at: Date | null }) {
  return { id: u.id, nickname: u.nickname, online: isOnline(u.last_seen_at) }
}

// GET /api/friends -> arkadaslar + gelen/giden istekler
friendsRouter.get(
  '/',
  requireAuth,
  ah(async (req, res) => {
    const uid = req.auth!.uid
    const [friends, incoming, outgoing] = await Promise.all([
      listAcceptedFriends(uid),
      listIncomingRequests(uid),
      listOutgoingRequests(uid)
    ])
    res.json({
      friends: friends.map(toDto),
      incoming: incoming.map((r) => ({ ...toDto(r), requestId: r.requestId })),
      outgoing: outgoing.map((r) => ({ ...toDto(r), requestId: r.requestId }))
    })
  })
)

const requestSchema = z.object({
  nickname: z.string().regex(NICKNAME_RE, 'Gecersiz nickname')
})

// POST /api/friends/request { nickname }
friendsRouter.post(
  '/request',
  requireAuth,
  ah(async (req, res) => {
    const parsed = requestSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Gecersiz veri' })
      return
    }

    const me = req.auth!.uid
    const target = await findUserByNickname(parsed.data.nickname)
    if (!target) {
      res.status(404).json({ error: 'Bu nickname ile bir kullanici bulunamadi.' })
      return
    }
    if (target.id === me) {
      res.status(400).json({ error: 'Kendinizi arkadas olarak ekleyemezsiniz.' })
      return
    }

    const existing = await findFriendshipBetween(me, target.id)
    if (existing) {
      if (existing.status === 'accepted') {
        res.status(409).json({ error: 'Zaten arkadassiniz.' })
      } else if (existing.user_id === target.id) {
        // Karsi taraf bana istek gondermis -> dogrudan kabul edelim
        await acceptFriendship(existing.id)
        res.json({ accepted: true, friend: toDto(target) })
      } else {
        res.status(409).json({ error: 'Bu kullaniciya zaten istek gonderildi.' })
      }
      return
    }

    await createFriendRequest(me, target.id)
    res.status(201).json({ sent: true, to: { id: target.id, nickname: target.nickname } })
  })
)

// GET /api/friends/suggest?q=prefix -> otomatik tamamlama onerileri
friendsRouter.get(
  '/suggest',
  requireAuth,
  ah(async (req, res) => {
    const q = String(req.query.q ?? '').trim()
    if (q.length < 2) {
      res.json({ suggestions: [] })
      return
    }
    const suggestions = await searchUsersByPrefix(q, req.auth!.uid, 8)
    res.json({ suggestions })
  })
)

const respondSchema = z.object({
  requestId: z.number().int().positive(),
  accept: z.boolean()
})

// POST /api/friends/respond { requestId, accept }
friendsRouter.post(
  '/respond',
  requireAuth,
  ah(async (req, res) => {
    const parsed = respondSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Gecersiz veri.' })
      return
    }
    const { requestId, accept } = parsed.data

    const fr = await getFriendshipById(requestId)
    if (!fr) {
      res.status(404).json({ error: 'Istek bulunamadi.' })
      return
    }
    // Sadece istegin hedefi cevaplayabilir
    if (fr.friend_id !== req.auth!.uid) {
      res.status(403).json({ error: 'Bu isteg size ait degil.' })
      return
    }

    if (accept) {
      await acceptFriendship(requestId)
      res.json({ accepted: true })
    } else {
      await deleteFriendshipById(requestId)
      res.json({ accepted: false })
    }
  })
)

// DELETE /api/friends/:nickname
friendsRouter.delete(
  '/:nickname',
  requireAuth,
  ah(async (req, res) => {
    const target = await findUserByNickname(req.params.nickname)
    if (!target) {
      res.status(404).json({ error: 'Kullanici bulunamadi.' })
      return
    }
    const deleted = await deleteFriendshipPair(req.auth!.uid, target.id)
    if (deleted === 0) {
      res.status(404).json({ error: 'Arkadaslik kaydi bulunamadi.' })
      return
    }
    res.json({ removed: true })
  })
)
