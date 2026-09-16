// Faz 5a smoke testi: duyuru/katilma API'sini gercek backend uzerinde dogrular.
// Kullanim: API'yi baska bir portta basip SMOKE_API ile bu scripti calistirin.
//   PORT=8797 npx tsx server/index.ts &
//   npx tsx scripts/smoke-phase5a.ts
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
  const [tokA, tokB, tokC] = await Promise.all([
    register(`smka_${suf}`),
    register(`smkb_${suf}`),
    register(`smkc_${suf}`)
  ])
  console.log(`kullanicilar olusturuldu (${suf})`)

  // B -> A arkadaslik istegi; A kabul
  await req('POST', '/api/friends/request', tokB, { nickname: `smka_${suf}` })
  const fl = await req('GET', '/api/friends', tokA)
  const incoming = fl.json.incoming as { requestId: number; nickname: string }[]
  const rid = incoming.find((r) => r.nickname === `smkb_${suf}`)?.requestId
  check('B->A istek geldi', !!rid)
  await req('POST', '/api/friends/respond', tokA, { requestId: rid, accept: true })

  // A sunucu duyurur
  const ann = await req('POST', '/api/servers/announce', tokA, {
    address: '93.184.216.34',
    port: 25565,
    mcVersion: '1.21.11',
    online: true
  })
  check('A duyuru 201', ann.status === 201, `status=${ann.status}`)

  // B aktif listeyi gorur
  const list1 = await req('GET', '/api/servers/active', tokB)
  const servers1 = list1.json.servers as { host: string; address: string; mcVersion: string }[]
  check('B listede goruyor', servers1.length === 1 && servers1[0]?.address === '93.184.216.34', JSON.stringify(servers1))

  // A kendi listesini de gorur
  const listSelf = await req('GET', '/api/servers/active', tokA)
  check('A kendi duyurusunu gorur', ((listSelf.json.servers as unknown[]) ?? []).length === 1)

  // Upsert: A adres degistirip tekrar duyurur -> hala tek kayit, adres guncel
  await req('POST', '/api/servers/announce', tokA, {
    address: 'bore.pub',
    port: 24785,
    mcVersion: '1.21.11',
    online: true
  })
  const list2 = await req('GET', '/api/servers/active', tokB)
  const servers2 = list2.json.servers as { address: string; port: number }[]
  check(
    'upsert: tek kayit + adres guncel',
    servers2.length === 1 && servers2[0]?.address === 'bore.pub' && servers2[0]?.port === 24785,
    JSON.stringify(servers2)
  )

  // Ozel IP reddi
  const bad = await req('POST', '/api/servers/announce', tokA, {
    address: '192.168.1.5',
    port: 25565,
    mcVersion: '1.21.11',
    online: true
  })
  check('ozel IP reddedilir', bad.status === 400, `status=${bad.status}`)

  // Arkadas olmayan C goremez
  const listC = await req('GET', '/api/servers/active', tokC)
  check('arkadas olmayan goremez', ((listC.json.servers as unknown[]) ?? []).length === 0)

  // Kimlik dogrulamasi olmadan erisilemez
  const noauth = await req('GET', '/api/servers/active', null)
  check('auth zorunlu', noauth.status === 401, `status=${noauth.status}`)

  // A geri cekince liste bosalir
  await req('POST', '/api/servers/withdraw', tokA)
  const list3 = await req('GET', '/api/servers/active', tokB)
  check('withdraw sonrasi bos', ((list3.json.servers as unknown[]) ?? []).length === 0)

  console.log(failures === 0 ? '=== FAZ 5A SMOKE BASARILI ===' : `=== ${failures} HATA ===`)
  process.exit(failures === 0 ? 0 : 1)
}

void main().catch((e) => {
  console.error('SMOKE HATASI:', e)
  process.exit(1)
})
