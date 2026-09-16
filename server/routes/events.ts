import { Router } from 'express'
import jwt from 'jsonwebtoken'
import { sql } from '../db'
import { JWT_SECRET, type AuthPayload } from '../auth'

export const eventsRouter = Router()

// EventSource Authorization header'i GONDEREMEZ — token query param'dan gelir
// ve burada elle dogrulanir (requireAuth yerine).

// ---- Long-poll SSE -------------------------------------------------------
// NOT: Gercek bir kuyrukla karsilastirilmasi — POSTGRES LISTEN/NOTIFY
// kullanilMAdi. NOTIFY connection havuzlu pg istemcilerde tek kanaldir ve
// havuz max=5 oldugu icin her SSE istemcisi bir baglantiyi bloklardi; bu
// kurulumda (kucuk arkadas grubu, tek API sureci) tablo-bazli long-poll
// ayni gecikmeyi sn'lerin cok altinda saglar, havuz baglantisi harcamaz.
//
// Nasıl calisir: client baglanir -> son olay id'sini bir onceki baglantidan
// gonderir -> sunucu olay tablosunu 1 sn'lik araliklarla (toplam ~25 sn)
// kontrol eder -> yeni olay varsa (veya 25 sn dolduysa) tek bir response
// doner. Tarayici EventSource otomatik yeniden baglanir. Sonuc: degisiklik
// ~1 sn'de client'a ulasir, bos beklemelerde istek akisi yoktur.
const POLL_INTERVAL_MS = 1_000
const MAX_WAIT_MS = 25_000

const KINDS = new Set(['friend_request', 'friend_update', 'wl_request', 'servers', 'kick'])

function parseLastEventId(v: string | undefined): number {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : 0
}

// GET /api/events/stream?kinds=friend_request,wl_request&lastEventId=42
// Cevap: text/event-stream;  "data: { lastEventId, kinds }\n\n" (tek event,
// sonra baglanti kapanir ve EventSource otomatik yeniden baglanir).
eventsRouter.get('/stream', async (req, res) => {
  // Token query param (EventSource header set edemez)
  const token = String(req.query.token ?? '')
  let auth: AuthPayload
  try {
    auth = jwt.verify(token, JWT_SECRET) as AuthPayload
  } catch {
    res.status(401).json({ error: 'Oturum suresi dolmus veya gecersiz. Yeniden giris yapin.' })
    return
  }
  const uid = auth.uid
  const kindsParam = String(req.query.kinds ?? '')
  const kinds = kindsParam.split(',').map((k) => k.trim()).filter((k) => KINDS.has(k))
  const useKinds = kinds.length > 0 ? kinds : [...KINDS]
  const lastEventId = parseLastEventId(req.query.lastEventId as string | undefined)

  // SSE headerlari: proxy/express sikistirmasinin baglantiyi bufferlamasini engelle
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  })
  res.write(': connected\n\n')

  let waited = 0
  let closed = false
  req.on('close', () => {
    closed = true
  })

  // Ilk baglanti (lastEventId yok): backlog'u atla — mevcut en buyuk id'den
  // itibaren dinlemeye basla. Client tam listeleri zaten ayrica ceker.
  const baseId = lastEventId > 0 ? lastEventId : await getLatestId(uid, useKinds)

  const tick = async (): Promise<void> => {
    if (closed || waited >= MAX_WAIT_MS) {
      // Timeout: client "hala bagliyim" bilgisini alsin (son id ile)
      send({ lastEventId: baseId, kinds: useKinds })
      return
    }
    const rows = await sql<{ id: number; kind: string }[]>`
      select id::int, kind
      from public.ylauncher_events
      where user_id = ${uid}
        and id > ${baseId}
        and kind in ${sql(useKinds)}
      order by id
      limit 20
    `
    if (rows.length > 0 && !closed) {
      send({ lastEventId: rows[rows.length - 1].id, kinds: [...new Set(rows.map((r) => r.kind))] })
      return
    }
    waited += POLL_INTERVAL_MS
    setTimeout(() => void tick().catch(() => send({ lastEventId: baseId, kinds: useKinds })), POLL_INTERVAL_MS)
  }

  function send(payload: { lastEventId: number; kinds: string[] }): void {
    if (closed) return
    res.write(`data: ${JSON.stringify(payload)}\n\n`)
    res.end()
  }

  void tick().catch(() => send({ lastEventId: baseId, kinds: useKinds }))
})

// Connect anindaki son olay id'si (ilk baglantida backlog'u atlamak icin;
// client zaten tam listeleri polling'ten/ilk cekimden aliyor).
async function getLatestId(uid: number, kinds: string[]): Promise<number> {
  const rows = await sql<{ id: number | null }[]>`
    select max(id)::int as id
    from public.ylauncher_events
    where user_id = ${uid} and kind in ${sql(kinds)}
  `
  return rows[0]?.id ?? 0
}
