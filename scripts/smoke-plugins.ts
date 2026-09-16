// Faz 7 smoke testi: plugin senkronizasyon API akisini gercek backend
// uzerinde dogrular.
//   PORT=8797 npx tsx server/index.ts &
//   SMOKE_API=http://localhost:8797 npx tsx scripts/smoke-plugins.ts
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const BASE = process.env.SMOKE_API ?? 'http://localhost:8797'

interface Json {
  [k: string]: unknown
}

async function req(
  method: string,
  path: string,
  token: string | null,
  body?: unknown
): Promise<{ status: number; json: Json; raw?: Buffer }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const ct = res.headers.get('content-type') ?? ''
  if (ct.includes('application/json')) {
    const json = (await res.json()) as Json
    return { status: res.status, json }
  }
  const raw = Buffer.from(await res.arrayBuffer())
  return { status: res.status, json: {}, raw }
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
  const hostNick = `spa_${suf}`
  const [tokHost, tokFriend, tokStranger] = await Promise.all([
    register(hostNick),
    register(`spb_${suf}`),
    register(`spc_${suf}`)
  ])
  console.log(`kullanicilar olusturuldu (${suf})`)

  // arkadaslik kur
  await req('POST', '/api/friends/request', tokFriend, { nickname: hostNick })
  const fl = await req('GET', '/api/friends', tokHost)
  const rid = (fl.json.incoming as { requestId: number }[])[0]?.requestId
  await req('POST', '/api/friends/respond', tokHost, { requestId: rid, accept: true })

  // sahte jar'lar uret
  const jarA = Buffer.from(`fake-jar-a-${suf}`.repeat(50))
  const jarB = Buffer.from(`fake-jar-b-${suf}`.repeat(30))
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

  // stranger publish edemez mi — once: auth'suz publish 401
  const noauth = await req('POST', '/api/plugins/publish', null, { plugins: [] })
  check("auth'suz publish 401", noauth.status === 401, `status=${noauth.status}`)

  // host iki jar publish eder
  const pub = await req('POST', '/api/plugins/publish', tokHost, {
    plugins: [
      { filename: 'essentials.jar', sha256: sha(jarA), sizeBytes: jarA.length, dataBase64: jarA.toString('base64') },
      { filename: 'vault.jar', sha256: sha(jarB), sizeBytes: jarB.length, dataBase64: jarB.toString('base64') }
    ]
  })
  check('host publish eder (201)', pub.status === 201 && pub.json.published === 2, JSON.stringify(pub.json))

  // Gercek dunya jar adi formati: surum etiketinde '+' olur (orn.
  // veinminer-paper-2.11.2+1.21.11.jar) — regex bunu reddedip publish'i
  // 400 ile olduruyordu (sahada raporlanan "Gecersiz dosya adi").
  const pubPlus = await req('POST', '/api/plugins/publish', tokHost, {
    plugins: [
      { filename: 'veinminer-paper-2.11.2+1.21.11.jar', sha256: sha(jarA), sizeBytes: jarA.length, dataBase64: jarA.toString('base64') }
    ]
  })
  check(
    "'+' iceren jar adi gecer",
    pubPlus.status === 201 && pubPlus.json.published === 1,
    `status=${pubPlus.status} ${JSON.stringify(pubPlus.json)}`
  )
  const mfPlus = await req('GET', `/api/plugins/manifest?host=${hostNick}`, tokFriend)
  const plusList = (mfPlus.json.plugins as { filename: string }[]).map((p) => p.filename)
  check("'+' jar manifestte", plusList.includes('veinminer-paper-2.11.2+1.21.11.jar'), JSON.stringify(plusList))
  // tekrar 2-jar'lik sete don
  const pubReset = await req('POST', '/api/plugins/publish', tokHost, {
    plugins: [
      { filename: 'essentials.jar', sha256: sha(jarA), sizeBytes: jarA.length, dataBase64: jarA.toString('base64') },
      { filename: 'vault.jar', sha256: sha(jarB), sizeBytes: jarB.length, dataBase64: jarB.toString('base64') }
    ]
  })
  check('set geri alindi (+)', pubReset.status === 201, `status=${pubReset.status}`)

  // BUYUK jar: global express.json siniri (100kb) publish'i route'a ulasmadan
  // 413 ile olduruyordu (sahada arkadaslarin plugin indirememesinin kok nedeni).
  // 2 MB'lik jar + base64 genislemesi ~2.7MB JSON — bu buyukluk gecmeli.
  const bigJar = Buffer.alloc(2 * 1024 * 1024, 7)
  const pubBig = await req('POST', '/api/plugins/publish', tokHost, {
    plugins: [{ filename: 'bigtest.jar', sha256: sha(bigJar), sizeBytes: bigJar.length, dataBase64: bigJar.toString('base64') }]
  })
  check(
    'buyuk jar publish gecer (2MB, 413 degil)',
    pubBig.status === 201 && pubBig.json.published === 1,
    `status=${pubBig.status} ${JSON.stringify(pubBig.json)}`
  )
  // ve geri eski sete don (bigtest.jar manifestten dusmeli)
  const pubBack = await req('POST', '/api/plugins/publish', tokHost, {
    plugins: [
      { filename: 'essentials.jar', sha256: sha(jarA), sizeBytes: jarA.length, dataBase64: jarA.toString('base64') },
      { filename: 'vault.jar', sha256: sha(jarB), sizeBytes: jarB.length, dataBase64: jarB.toString('base64') }
    ]
  })
  check('set geri alindi', pubBack.status === 201, `status=${pubBack.status}`)

  // gecersiz dosya adi reddedilir
  const bad = await req('POST', '/api/plugins/publish', tokHost, {
    plugins: [
      {
        filename: '../evil.jar',
        sha256: sha(jarA),
        sizeBytes: jarA.length,
        dataBase64: jarA.toString('base64')
      }
    ]
  })
  check('path traversal reddedilir (400)', bad.status === 400, `status=${bad.status} ${JSON.stringify(bad.json)}`)

  // sha uyusmazligi reddedilir
  const badSha = await req('POST', '/api/plugins/publish', tokHost, {
    plugins: [
      {
        filename: 'x.jar',
        sha256: 'z'.repeat(64),
        sizeBytes: jarA.length,
        dataBase64: jarA.toString('base64')
      }
    ]
  })
  check('gecersiz sha reddedilir (400)', badSha.status === 400, `status=${badSha.status}`)

  // stranger manifest goremez
  const strangerMf = await req('GET', `/api/plugins/manifest?host=${hostNick}`, tokStranger)
  check('stranger manifest 403', strangerMf.status === 403, `status=${strangerMf.status}`)

  // friend manifesti gorur
  const mf = await req('GET', `/api/plugins/manifest?host=${hostNick}`, tokFriend)
  const plugins = mf.json.plugins as { filename: string; sha256: string; sizeBytes: number }[]
  check('friend manifest gorur (2 jar)', mf.status === 200 && plugins.length === 2, JSON.stringify(mf.json))

  // host kendi manifestini gorebilir — republish'tan SONRA test et:
  // bos publish (asagida) manifesti sifirlar; buradan sonrasi sira hatasiydi.
  const mfSelf = await req('GET', `/api/plugins/manifest?host=${hostNick}`, tokHost)
  check('host kendi manifestini gorur', mfSelf.status === 200 && Array.isArray(mfSelf.json.plugins), JSON.stringify(mfSelf.json))

  // friend jar indirir ve icerik dogrulanir
  const dl = await req('GET', `/api/plugins/download?host=${hostNick}&file=essentials.jar`, tokFriend)
  check('friend jar indirir', dl.status === 200 && !!dl.raw && dl.raw.equals(jarA), `status=${dl.status}`)
  check('sha basligi doner', dl.raw ? sha(dl.raw) === sha(jarA) : false)

  // stranger indiremez
  const strangerDl = await req('GET', `/api/plugins/download?host=${hostNick}&file=essentials.jar`, tokStranger)
  check('stranger indiremez (403)', strangerDl.status === 403, `status=${strangerDl.status}`)

  // manifestte olmayan dosya indirilemez
  const missing = await req('GET', `/api/plugins/download?host=${hostNick}&file=nope.jar`, tokFriend)
  check('manifestte olmayan 404', missing.status === 404, `status=${missing.status}`)

  // republish ile set degisir: vault kaldirilir, worldguard eklenir
  const jarC = Buffer.from(`fake-jar-c-${suf}`)
  const pub2 = await req('POST', '/api/plugins/publish', tokHost, {
    plugins: [
      { filename: 'essentials.jar', sha256: sha(jarA), sizeBytes: jarA.length, dataBase64: jarA.toString('base64') },
      { filename: 'worldguard.jar', sha256: sha(jarC), sizeBytes: jarC.length, dataBase64: jarC.toString('base64') }
    ]
  })
  check('republish basarili', pub2.status === 201, JSON.stringify(pub2.json))
  const mf2 = await req('GET', `/api/plugins/manifest?host=${hostNick}`, tokFriend)
  const plugins2 = mf2.json.plugins as { filename: string }[]
  check(
    'eski jar setten duser (vault yok, worldguard var)',
    plugins2.length === 2 &&
      plugins2.some((p) => p.filename === 'worldguard.jar') &&
      !plugins2.some((p) => p.filename === 'vault.jar'),
    JSON.stringify(mf2.json)
  )
  const oldDl = await req('GET', `/api/plugins/download?host=${hostNick}&file=vault.jar`, tokFriend)
  check('dusen jar artik indirilemez (404)', oldDl.status === 404, `status=${oldDl.status}`)

  // bos publish: tum seti kaldirir
  const pub3 = await req('POST', '/api/plugins/publish', tokHost, { plugins: [] })
  check('bos publish (201)', pub3.status === 201, JSON.stringify(pub3.json))
  const mf3 = await req('GET', `/api/plugins/manifest?host=${hostNick}`, tokFriend)
  check('bos manifest', ((mf3.json.plugins as unknown[]) ?? []).length === 0, JSON.stringify(mf3.json))

  // host-side moduller: publishPlugins + planPluginSync/syncPlugins entegre test
  console.log('--- host/joiner modulleri ---')
  // Moduller API_BASE env'sini okur; smoke API'sine yonlendir
  process.env['API_BASE'] = BASE
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'ylplug7-'))
  try {
    const pluginsDir = path.join(tmp, 'plugins')
    mkdirSync(pluginsDir, { recursive: true })
    writeFileSync(path.join(pluginsDir, 'essentials.jar'), jarA)
    writeFileSync(path.join(pluginsDir, 'ignoreme.disabled.jar'), 'disabled')

    const { publishPlugins } = await import('../src/main/pluginSync')
    const pubRes = await publishPlugins({ token: tokHost, pluginsDir })
    check('publishPlugins 1 jar yayinlar', pubRes.ok && pubRes.count === 1, JSON.stringify(pubRes))

    const { planPluginSync, syncPlugins } = await import('../src/main/downloadPlugins')
    // friend'in pluginsDir'i bos -> 1 indirme planlanir
    const friendDir = path.join(tmp, 'friend-plugins')
    const plan = await planPluginSync({ token: tokFriend, host: hostNick, pluginsDir: friendDir })
    check('plan 1 indirme icerir', plan.toDownload.length === 1 && plan.toDownload[0].filename === 'essentials.jar', JSON.stringify(plan))
    const syncRes = await syncPlugins({ token: tokFriend, plan, pluginsDir: friendDir })
    check('sync indirir', syncRes.ok && syncRes.downloaded.length === 1)
    const dlBuf = await readFile(path.join(friendDir, 'essentials.jar'))
    check('indirilen icerik birebir', dlBuf.equals(jarA))
    // ikinci plan: artik guncel
    const plan2 = await planPluginSync({ token: tokFriend, host: hostNick, pluginsDir: friendDir })
    check('ikinci plan guncel', plan2.toDownload.length === 0 && plan2.upToDate.length === 1, JSON.stringify(plan2))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }

  console.log(failures === 0 ? '=== PLUGINS SMOKE BASARILI ===' : `=== ${failures} HATA ===`)
  process.exit(failures === 0 ? 0 : 1)
}

void main().catch((e) => {
  console.error('SMOKE HATASI:', e)
  process.exit(1)
})
