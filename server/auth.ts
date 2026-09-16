import jwt from 'jsonwebtoken'
import type { NextFunction, Request, Response } from 'express'
import { touchLastSeen } from './db'

export const JWT_SECRET =
  process.env.JWT_SECRET ?? 'dev-only-secret-change-me-before-sharing-with-friends'

const TOKEN_TTL = '7d'

export interface AuthPayload {
  uid: number
  nick: string
}

export function signToken(payload: AuthPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_TTL })
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthPayload
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) {
    res.status(401).json({ error: 'Oturum bulunamadi. Lutfen giris yapin.' })
    return
  }
  try {
    req.auth = jwt.verify(token, JWT_SECRET) as AuthPayload
    // Son gorulme guncellemesi kritik degil; hata olursa sessiz gec
    touchLastSeen(req.auth.uid).catch(() => {})
    next()
  } catch {
    res.status(401).json({ error: 'Oturum suresi dolmus veya gecersiz. Yeniden giris yapin.' })
  }
}
