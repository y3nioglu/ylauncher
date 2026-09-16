// Faz 5b smoke testi: host'un raporladigi kick sebebi /active uzerinden
// katilan oyuncuya ulasiyor mu dogrular. Gercek backend uzerinde calisir:
//   PORT=8797 npx tsx server/index.ts &
//   SMOKE_API=http://localhost:8797 npx tsx scripts/smoke-kicks.ts
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
  const [tokA, tokB] = await Promise.all([register(`smka_${suf}`), register(`smkb_${suf}`)])
  console.log(`kullanicilar olusturuldu (${suf})`)

  // B -> A arkadaslik
  await req('POST', '/api/friends/request', tokB, { nickname: `smka_${suf}` })
  const fl = await req('GET', '/api/friends', tokA)
  const incoming = fl.json.incoming as { requestId: number; nickname: string }[]
  const rid = incoming.find((r) => r.nickname === `smkb_${suf}`)?.requestId
  await req('POST', '/api/friends/respond', tokA, { requestId: rid, accept: true })

  // A sunucu duyurur
  const ann = await req('POST', '/api/servers/announce', tokA, {
    address: '93.184.216.34',
    port: 25565,
    mcVersion: '1.21.11',
    online: true
  })
  check('A duyuru 201', ann.status === 201, `status=${ann.status}`)

  // B kick raporu olmadan listeler: lastKick yok
  const list0 = await req('GET', '/api/servers/active', tokB)
  const s0 = (list0.json.servers as { lastKick: unknown }[])[0]
  check('rapor yokken lastKick bos', !!s0 && s0.lastKick === null, JSON.stringify(s0))

  // A, B icin whitelist kick rapor eder
  const kick1 = await req('POST', '/api/servers/kick', tokA, {
    nickname: `smkb_${suf}`,
    reason: "Bu sunucunun whitelist listesinde değilsin. Host'tan seni listeye eklemesini iste.",
    rawLine: 'Disconnecting com.mojang.authlib.GameProfile@5ab: You are not white-listed on this server!'
  })
  check('kick raporu 201', kick1.status === 201, `status=${kick1.status} ${JSON.stringify(kick1.json)}`)

  // B listeyi yeniler: lastKick dolu
  const list1 = await req('GET', '/api/servers/active', tokB)
  const s1 = (list1.json.servers as {
    lastKick: { reason: string; rawLine: string; at: string } | null
  }[])[0]
  check(
    'B kick sebebini goruyor',
    !!s1?.lastKick && s1.lastKick.reason.includes('whitelist'),
    JSON.stringify(s1?.lastKick)
  )
  check('raw line tasinir', (s1?.lastKick?.rawLine ?? '').includes('GameProfile'))

  // Upsert: A ikinci bir kick rapor eder -> ayni kayit guncellenir
  await req('POST', '/api/servers/kick', tokA, {
    nickname: `SMKB_${suf}`, // buyuk/kucuk duyarsiz eslesme
    reason: 'Sunucu dolu! Biraz bekle, birisi çıkınca tekrar dene.',
    rawLine: 'The server is full! (20/20)'
  })
  const list2 = await req('GET', '/api/servers/active', tokB)
  const s2 = (list2.json.servers as { lastKick: { reason: string } | null }[])[0]
  check(
    'upsert: yeni sebep eskisinin ustune yazar',
    !!s2?.lastKick && s2.lastKick.reason.includes('dolu'),
    JSON.stringify(s2?.lastKick)
  )

  // Kimlik dogrulamasi olmadan kick raporu reddedilir
  const noauth = await req('POST', '/api/servers/kick', null, {
    nickname: `smkb_${suf}`,
    reason: 'test',
    rawLine: ''
  })
  check('kick auth zorunlu', noauth.status === 401, `status=${noauth.status}`)

  // Gecersiz nickname reddedilir
  const badnick = await req('POST', '/api/servers/kick', tokA, {
    nickname: 'gecti bu nick cok uzun degil',
    reason: 'test sebebi',
    rawLine: ''
  })
  check('kick gecersiz nickname 400', badnick.status === 400, `status=${badnick.status}`)

  console.log(failures === 0 ? '=== KICK SMOKE BASARILI ===' : `=== ${failures} HATA ===`)
  process.exit(failures === 0 ? 0 : 1)
}

void main().catch((e) => {
  console.error('SMOKE HATASI:', e)
  process.exit(1)
})
