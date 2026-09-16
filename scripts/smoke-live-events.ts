// Faz 9 smoke: canli olay (SSE long-poll) zincirini gercek backend uzerinde
// dogrular — gecikme olcumu dahil.
//   PORT=8797 npx tsx server/index.ts &
//   SMOKE_API=http://localhost:8797 npx tsx scripts/smoke-live-events.ts
import 'dotenv/config'

const BASE = process.env.SMOKE_API ?? 'http://localhost:8797'

interface Json {
  [k: string]: unknown
}

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

async function req(
  method: string,
  path: string,
  token: string | null,
  body?: unknown
): Promise<{ status: number; json: Json }> {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  })
  const json = (await res.json().catch(() => ({}))) as Json
  return { status: res.status, json }
}

async function register(nick: string): Promise<string> {
  const r = await req('POST', '/api/auth/register', null, { nickname: nick, password: 'test1234' })
  if (r.status === 201 || r.status === 200) return r.json.token as string
  const l = await req('POST', '/api/auth/login', null, { nickname: nick, password: 'test1234' })
  if (l.status !== 200) throw new Error(`${nick} kayit/giris basarisiz: ${l.status}`)
  return l.json.token as string
}

const stamp = Date.now().toString(36).slice(-5)

async function main(): Promise<void> {
  const hostNick = `evh${stamp}`
  const nickA = `eva${stamp}`
  const nickB = `evb${stamp}`

  const host = await register(hostNick)
  const a = await register(nickA)
  const b = await register(nickB)

  // A ile arkadas ol
  const fr = await req('POST', '/api/friends/request', a, { nickname: hostNick })
  if (fr.status !== 201) {
    console.error('arkadaslik istegi basarisiz:', fr.status, fr.json)
    process.exit(1)
  }
  const incoming = await req('GET', '/api/friends', host)
  const reqId = (incoming.json.incoming as Json[])[0].requestId as number
  await req('POST', '/api/friends/respond', host, { requestId: reqId, accept: true })

// ---- Test 1: EventSource olmadan raw fetch ile long-poll gecikmesi --------
// SSE akisini Node fetch ile taklit et: baglan, arkadasin istek gondermesini
// bekle, ilk data event'inin gelme suresini olc.
function sseOnce(token: string): Promise<{ payload: Json; connectMs: number; waitMs: number }> {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const ctl = new AbortController()
    const to = setTimeout(() => {
      ctl.abort()
      reject(new Error('SSE 30 sn icinde yanit vermedi'))
    }, 30_000)
    fetch(
      `${BASE}/api/events/stream?kinds=friend_request,wl_request,servers,kick&token=${encodeURIComponent(token)}`,
      { signal: ctl.signal }
    )
      .then(async (res) => {
        if (res.status !== 200) throw new Error(`stream HTTP ${res.status}`)
        const reader = res.body!.getReader()
        const dec = new TextDecoder()
        let buf = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          const m = buf.match(/data: (.+)\n\n/)
          if (m) {
            clearTimeout(to)
            ctl.abort()
            resolve({
              payload: JSON.parse(m[1]) as Json,
              connectMs: Date.now() - started,
              waitMs: 0
            })
            return
          }
        }
        clearTimeout(to)
        reject(new Error('stream kapanmis, data yok'))
      })
      .catch((e) => {
        clearTimeout(to)
        reject(e)
      })
  })
}

  const p = sseOnce(host)
  await new Promise((r) => setTimeout(r, 1500)) // baglanti otursun
  const t0 = Date.now()
  await req('POST', '/api/friends/request', b, { nickname: hostNick })
  const { payload, connectMs } = await p
  const latency = Date.now() - t0
check(
  'arkadaslik istegi ~1 sn icinde iletildi',
  latency < 3000 && Array.isArray(payload.kinds) && (payload.kinds as string[]).includes('friend_request'),
  `${latency} ms (baglanti kurulum: ${connectMs} ms)`
)
check('lastEventId dondu', typeof payload.lastEventId === 'number' && payload.lastEventId > 0)

// ---- Test 2: whitelist istegi olayi + gecikme -----------------------------
const p2 = sseOnce(host)
await new Promise((r) => setTimeout(r, 1200))
const t1 = Date.now()
await req('POST', '/api/whitelist/requests', a, { nickname: hostNick })
const r2 = await p2
const lat2 = Date.now() - t1
check(
  'whitelist istegi ~1 sn icinde iletildi',
  lat2 < 3000 && (r2.payload.kinds as string[]).includes('wl_request'),
  `${lat2} ms`
)

// ---- Test 3: sunucu duyurusu olayi ----------------------------------------
const p3 = sseOnce(host)
await new Promise((r) => setTimeout(r, 1200))
const t2 = Date.now()
await req('POST', '/api/servers/announce', a, {
  address: '45.155.125.146',
  port: 25565,
  mcVersion: '1.21.11',
  online: true
})
const r3 = await p3
const lat3 = Date.now() - t2
check('sunucu duyurusu ~1 sn icinde iletildi', lat3 < 3000, `${lat3} ms`)
await req('POST', '/api/servers/withdraw', a)

// ---- Test 4: token'siz erisim reddedilir ---------------------------------
const anon = await fetch(`${BASE}/api/events/stream?kinds=servers`)
check("token'siz stream 401", anon.status === 401)
await anon.body?.cancel().catch(() => {})

// ---- Test 5: bos beklemede veri akmaz (sessizlik) ------------------------
// 12 sn hicbir sey olmayan bir akista yalnizca ": connected" yorumu olmali.
const quiet = await fetch(
  `${BASE}/api/events/stream?kinds=servers&token=${encodeURIComponent(host)}`
)
const reader = quiet.body!.getReader()
const dec = new TextDecoder()
let buf = ''
const quietTo = setTimeout(() => {
  reader.cancel().catch(() => {})
}, 12_000)
for (;;) {
  const { done, value } = await reader.read()
  if (done) break
  buf += dec.decode(value, { stream: true })
}
clearTimeout(quietTo)
const dataLines = buf.split('\n').filter((l) => l.startsWith('data:')).length
check('bos beklemede data akmaz', dataLines === 0, `${dataLines} data satiri (12 sn)`)

console.log(failures === 0 ? '\nTUM KONTROLLER GECTI' : `\n${failures} KONTROL BASARISIZ`)
process.exit(failures === 0 ? 0 : 1)
}

void main().catch((e) => {
  console.error('Smoke hatasi:', e)
  process.exit(1)
})
