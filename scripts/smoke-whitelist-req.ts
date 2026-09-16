// Faz 5c smoke testi: whitelist istek akisini gercek backend uzerinde dogrular.
//   PORT=8797 npx tsx server/index.ts &
//   SMOKE_API=http://localhost:8797 npx tsx scripts/smoke-whitelist-req.ts
const BASE = process.env.SMOKE_API ?? 'http://localhost:8797'

interface Json {
  [k: string]: unknown
}

async function req(
  method: string,
  path: string,
  token: string | null,
  body?: unknown
): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  let json: Json = {}
  try {
    json = (await res.json()) as Json
  } catch {
    /* JSON olmayan cevap */
  }
  return { status: res.status, json }
}

let failures = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  OK  ${name}`)
  } else {
    failures++
    console.error(`  FAIL ${name} ${detail}`)
  }
}

async function register(nick: string): Promise<string> {
  const { status, json } = await req('POST', '/api/auth/register', null, {
    nickname: nick,
    password: 'test123'
  })
  if (status === 409) {
    const login = await req('POST', '/api/auth/login', null, { nickname: nick, password: 'test123' })
    return String(login.json.token)
  }
  if (status !== 201) throw new Error(`register ${nick} basarisiz: ${status}`)
  return String(json.token)
}

async function main(): Promise<void> {
  const health = await req('GET', '/api/health', null)
  check('API saglik', health.status === 200, `status=${health.status}`)
  if (health.status !== 200) process.exit(2)

  const suf = Date.now().toString(36).slice(-5)
  const hostNick = `smha_${suf}`
  const [tokHost, tokFriend, tokStranger] = await Promise.all([
    register(hostNick),
    register(`smhb_${suf}`),
    register(`smhc_${suf}`)
  ])
  console.log(`kullanicilar olusturuldu (${suf})`)

  // Host <-> friend arkadaslik kur; stranger arkadas degil
  await req('POST', '/api/friends/request', tokFriend, { nickname: hostNick })
  const fl = await req('GET', '/api/friends', tokHost)
  const incoming = fl.json.incoming as { requestId: number; nickname: string }[]
  const rid = incoming.find((r) => r.nickname === `smhb_${suf}`)?.requestId
  await req('POST', '/api/friends/respond', tokHost, { requestId: rid, accept: true })

  // Stranger arkadas degilken istek gonderemez (gizlilik kurali)
  const strangerTry = await req('POST', '/api/whitelist/requests', tokStranger, {
    nickname: hostNick
  })
  check('arkadas olmayan istek gonderemez (403)', strangerTry.status === 403, `status=${strangerTry.status}`)

  // Friend istek gonderir
  const sent = await req('POST', '/api/whitelist/requests', tokFriend, { nickname: hostNick })
  check('friend istek gonderir (201)', sent.status === 201, `status=${sent.status} ${JSON.stringify(sent.json)}`)

  // Host gelen istekleri gorur
  const inbox = await req('GET', '/api/whitelist/requests', tokHost)
  const inc = inbox.json.incoming as { id: number; nickname: string; status: string }[]
  check('host gelen istegi gorur', inc.length === 1 && inc[0]?.nickname === `smhb_${suf}` && inc[0]?.status === 'pending', JSON.stringify(inbox.json))

  // Friend gonderdiklerini gorur (durum takibi)
  const outbox = await req('GET', '/api/whitelist/requests', tokFriend)
  const out = outbox.json.outgoing as { status: string }[]
  check('friend kendi istegini pending gorur', out.length === 1 && out[0]?.status === 'pending', JSON.stringify(outbox.json))

  // Idempotent upsert: tekrar gondermek yeni kayit acmaz
  await req('POST', '/api/whitelist/requests', tokFriend, { nickname: hostNick })
  const inbox2 = await req('GET', '/api/whitelist/requests', tokHost)
  check('tekrar istek: hala tek kayit', ((inbox2.json.incoming as unknown[]) ?? []).length === 1)

  // Strangler host'un gelen kutusunu goremaz
  const strangerInbox = await req('GET', '/api/whitelist/requests', tokStranger)
  check('stranger bos kutu gorur', ((strangerInbox.json.incoming as unknown[]) ?? []).length === 0)

  // Reddet: durum declined olur
  const reqId = inc[0]!.id
  const declined = await req(`POST`, `/api/whitelist/requests/${reqId}/respond`, tokHost, { accept: false })
  check('host reddeder', declined.status === 200 && declined.json.status === 'declined', JSON.stringify(declined.json))

  // Reddedilen istek tekrar respond edilemez (zaten yanitlanmis)
  const redecline = await req('POST', `/api/whitelist/requests/${reqId}/respond`, tokHost, { accept: true })
  check('yanitlanmis istek tekrar yanitlanamaz (404)', redecline.status === 404, `status=${redecline.status}`)

  // Yeniden istek: declined -> pending'e donebilir (upsert)
  await req('POST', '/api/whitelist/requests', tokFriend, { nickname: hostNick })
  const inbox3 = await req('GET', '/api/whitelist/requests', tokHost)
  const inc3 = inbox3.json.incoming as { id: number; status: string }[]
  check('yeniden istek: pending ve ayni satir', inc3.length === 1 && inc3[0]?.status === 'pending', JSON.stringify(inbox3.json))

  // Kabul: accepted
  const accepted = await req('POST', `/api/whitelist/requests/${inc3[0]!.id}/respond`, tokHost, { accept: true })
  check('host kabul eder', accepted.status === 200 && accepted.json.status === 'accepted', JSON.stringify(accepted.json))
  check('kabul cevabi nickname tasiyor', accepted.json.nickname === `smhb_${suf}`, JSON.stringify(accepted.json))

  // Friend sonucu gorur: accepted
  const outbox2 = await req('GET', '/api/whitelist/requests', tokFriend)
  const out2 = outbox2.json.outgoing as { status: string }[]
  check('friend sonucu accepted gorur', out2.length === 1 && out2[0]?.status === 'accepted', JSON.stringify(outbox2.json))

  // Auth zorunlu
  const noauth = await req('GET', '/api/whitelist/requests', null)
  check('auth zorunlu (401)', noauth.status === 401, `status=${noauth.status}`)

  // Kendine istek gonderilemez
  const selfReq = await req('POST', '/api/whitelist/requests', tokHost, { nickname: hostNick })
  check('kendine istek reddedilir (400)', selfReq.status === 400, `status=${selfReq.status}`)

  // Gecersiz nickname
  const badNick = await req('POST', '/api/whitelist/requests', tokFriend, { nickname: 'bu nick cok uzun ve gecersiz' })
  check('gecersiz nickname 400', badNick.status === 400, `status=${badNick.status}`)

  console.log(failures === 0 ? '=== WHITELIST REQ SMOKE BASARILI ===' : `=== ${failures} HATA ===`)
  process.exit(failures === 0 ? 0 : 1)
}

void main().catch((e) => {
  console.error('SMOKE HATASI:', e)
  process.exit(1)
})
