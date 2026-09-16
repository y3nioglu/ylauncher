import { Router, type Request, type Response, type NextFunction } from 'express'
import { z } from 'zod'
import {
  NICKNAME_RE,
  createUser,
  findUserByNickname,
  getPasswordHash,
  verifyPassword
} from '../db'
import { requireAuth, signToken } from '../auth'

export const authRouter = Router()

// Express 4 async handler hatalarini otomatik yakalamaz -> kucuk sarmalayici
const ah =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next)
  }

const registerSchema = z.object({
  nickname: z.string().regex(NICKNAME_RE, 'Nickname 3-16 karakter olmali; sadece harf, rakam ve _'),
  password: z.string().min(6, 'Sifre en az 6 karakter olmali')
})

const loginSchema = z.object({
  nickname: z.string().min(1),
  password: z.string().min(1)
})

// POST /api/auth/register
authRouter.post(
  '/register',
  ah(async (req, res) => {
    const parsed = registerSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Gecersiz veri' })
      return
    }
    const { nickname, password } = parsed.data

    if (await findUserByNickname(nickname)) {
      res.status(409).json({ error: 'Bu nickname zaten alinmis.' })
      return
    }
    try {
      const user = await createUser(nickname, password)
      const token = signToken({ uid: user.id, nick: user.nickname })
      res.status(201).json({ token, user: { id: user.id, nickname: user.nickname } })
    } catch {
      // unique index yarisi (aynı anda iki kayit)
      res.status(409).json({ error: 'Bu nickname zaten alinmis.' })
    }
  })
)

// POST /api/auth/login
authRouter.post(
  '/login',
  ah(async (req, res) => {
    const parsed = loginSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Nickname ve sifre gerekli.' })
      return
    }
    const { nickname, password } = parsed.data

    const user = await findUserByNickname(nickname)
    const hash = user ? await getPasswordHash(user.id) : undefined
    if (!user || !hash || !verifyPassword(password, hash)) {
      res.status(401).json({ error: 'Nickname veya sifre hatali.' })
      return
    }
    const token = signToken({ uid: user.id, nick: user.nickname })
    res.json({ token, user: { id: user.id, nickname: user.nickname } })
  })
)

// GET /api/auth/me  (korumali)
authRouter.get(
  '/me',
  requireAuth,
  ah(async (req, res) => {
    res.json({ user: { id: req.auth!.uid, nickname: req.auth!.nick } })
  })
)
