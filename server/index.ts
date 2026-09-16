import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import rateLimit from 'express-rate-limit'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { authRouter } from './routes/auth'
import { friendsRouter } from './routes/friends'
import { serversRouter } from './routes/servers'
import { whitelistRouter } from './routes/whitelist'
import { pluginsRouter } from './routes/plugins'
import { clientModsRouter } from './routes/clientmods'
import { eventsRouter } from './routes/events'
import { pingDb, closeDb } from './db'

const app = express()
// NOT: plugin publish gövdesi jar içerdiginden MB'larca agirir; küçük limitli
// global parser isteği route'a ulasmadan 413 ile öldürür. O yola global JSON
// parser'ı uygulamıyoruz (route kendi 220mb parser'ina sahip).
app.use((req, res, next) => {
  if (req.path === '/api/plugins/publish' || req.path === '/api/clientmods/publish') return next()
  return express.json()(req, res, next)
})

// Electron renderer'i tarayici baglami oldugu icin CORS gerektirir. Artık her
// Origin kabul edilir: paketlenmiş uygulamada renderer file:// (Origin: null)
// gonderir, VPS'ten test icin her makine farkli bir kaynak kullanir. Kimlik
// dogrulamasi Authorization header'indaki JWT ile yapilir (cerez yok), bu
// yuzden credential'li cererez gerektiren origin allowlist'e gerek kalmadi.
app.use(
  cors({
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
  })
)

// Brute-force korumasi: auth endpointlerine dakikada 20 istek
app.use(
  '/api/auth',
  rateLimit({
    windowMs: 60_000,
    limit: 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Cok fazla istek gonderildi, birazdan tekrar deneyin.' }
  })
)

app.use('/api/auth', authRouter)
app.use('/api/friends', friendsRouter)
app.use('/api/servers', serversRouter)
app.use('/api/whitelist', whitelistRouter)
app.use('/api/plugins', pluginsRouter)
app.use('/api/clientmods', clientModsRouter)
app.use('/api/events', eventsRouter)

// Faz 11: launcher guncelleme paketleri (electron-builder cikti: .exe + latest.yml)
// Bu klasore kopyalanan surumler electron-updater tarafindan otomatik bulunur.
const DOWNLOADS_DIR = process.env.DOWNLOADS_DIR ?? path.join(process.cwd(), 'downloads')
mkdirSync(DOWNLOADS_DIR, { recursive: true })
// Yalnizca okuma; liste suz (index yok) — dosya adi bilen indirir.
// electron-builder ciktisindaki (.exe + latest.yml + .blockmap) dosyalarini buraya kopyalayin.
// fallthrough: true — eksik dosya (orn. diff indirme icin istenen ESKI surumun
// blockmap'i) normal 404 olarak donsun; hata logger'ini kirletmesin. electron-updater
// blockmap bulamazsa tam indirmeye duser, akis etkilenmez (sahada dogrulandi).
app.use(
  '/downloads',
  express.static(DOWNLOADS_DIR, {
    fallthrough: true,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.yml')) res.setHeader('Content-Type', 'text/yaml; charset=utf-8')
    }
  })
)
console.log(`[api] guncelleme dizini yayinda: /downloads -> ${DOWNLOADS_DIR}`)

app.get('/api/health', async (_req, res) => {
  const dbOk = await pingDb()
  res.status(dbOk ? 200 : 503).json({
    ok: dbOk,
    service: 'mc-friends-launcher-api',
    db: dbOk ? 'up' : 'down'
  })
})

// JSON hatalari duzenli dondur
app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    // Kontrol edilmesi beklenen istemci hatalari (ApiError) 400 olarak doner
    if (err instanceof Error && err.name === 'ApiError') {
      res.status(400).json({ error: err.message })
      return
    }
    console.error('[api] unexpected error:', err)
    res.status(500).json({ error: 'Sunucu hatasi. Daha sonra tekrar deneyin.' })
  }
)

const PORT = Number(process.env.PORT ?? 8787)
const server = app.listen(PORT, () => {
  console.log(`[api] mc-friends-launcher API http://localhost:${PORT} adresinde calisiyor`)
})
// Render ucretsiz proxy'si bos bekleyen soketleri ~75 sn'de kendi tarafindan
// kapatabiliyor; Node'un varsayilan keep-alive (5 sn) ile cakisinca arada
// sireklenmis istekler ECONNRESET verebiliyor. Render'in siniriyla uyumlu
// degerlere cekiyoruz (proxy'den uzun, baglanti yenileme sikligindan kisa).
server.keepAliveTimeout = 65000
server.headersTimeout = 66000

// Duzgun kapanis: Postgres havuzunu serbest birak
async function shutdown(signal: string) {
  console.log(`[api] ${signal} alindi, kapaniliyor...`)
  server.close()
  await closeDb().catch(() => {})
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
