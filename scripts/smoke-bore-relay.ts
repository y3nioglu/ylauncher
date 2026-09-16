// bore relay smoke testi — TAMAMI LOKAL (bore.pub'a baglanmaz)
//
// Senaryo 1 (ilk bug): oyuncu yerel sunucu dinlemeden once baglanir.
//   Eski kod akisi resetliyordu -> istemcide "Connection reset".
//   Yeni kod yerel sunucu acilana kadar yeniden dener.
//
// Senaryo 2 (ikinci bug): login sonrasi Paper'in gonderdigi buyuk
//   config/registry burst'i (~100KB+) ozel pompanin pause/drain
//   diziliminde takiliyordu -> 30 sn sonra "Timed out".
//   2MB'lik cift yonlu burst tasima siniri dogrular.
import net from 'node:net'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { BoreTunnel } from '../src/main/bore'

// ---- JSON cerceveleme (0x00 ile ayrilmis) ----
function frame(msg: unknown): Buffer {
  return Buffer.from(JSON.stringify(msg) + '\0', 'utf8')
}
class FrameReader {
  private buf: Buffer = Buffer.alloc(0)
  push(chunk: Buffer): Record<string, unknown>[] {
    this.buf = Buffer.concat([this.buf, chunk])
    const out: Record<string, unknown>[] = []
    let idx: number
    while ((idx = this.buf.indexOf(0x00)) !== -1) {
      const raw = this.buf.subarray(0, idx)
      this.buf = this.buf.subarray(idx + 1)
      if (raw.length === 0) continue
      try {
        const p: unknown = JSON.parse(raw.toString('utf8'))
        if (p && typeof p === 'object') out.push(p as Record<string, unknown>)
      } catch {
        /* yoksay */
      }
    }
    return out
  }

  // Son tamamlanmamış frame dahil kalan ham baytları döndürüp tamponu boşaltır
  takeRest(): Buffer {
    const rest = this.buf
    this.buf = Buffer.alloc(0)
    return rest
  }
}

// ---- Mock bore sunucusu ----
// Tek dinleyici (gercek bore'daki gibi kontrol + Accept ayni porttan akar),
// ayrica turel dinleyicisi (oyuncularin baglandigi port).
// GERCEK bore GIBI: ayni Connection icin IKINCI Accept geldiginde kalan
// veriyi Player'a OYUN VERISI olarak iletir (hata vermez!) — cift Accept
// bugini yakalayabilmek icin duplicateAccepts sayaci tutar.
function startMockBore(): Promise<{
  controlPort: number
  tunnelPort: number
  duplicateAccepts: () => number
  close: () => void
}> {
  return new Promise((resolve) => {
    const pending = new Map<string, net.Socket>()
    const accepted = new Set<string>()
    let dupAccepts = 0

    const tunnel = net.createServer((player) => {
      const id = crypto.randomUUID()
      pending.set(id, player)
      player.on('error', () => {})
      for (const c of controls) c.write(frame({ Connection: id }))
    })

    const controls: net.Socket[] = []
    const control = net.createServer((sock) => {
      controls.push(sock)
      const reader = new FrameReader()
      sock.on('data', (d: Buffer) => {
        for (const msg of reader.push(d)) {
          if ('Hello' in msg) {
            sock.write(frame({ Hello: tunnelPort }))
          } else if ('Accept' in msg) {
            const id = String(msg.Accept)
            if (accepted.has(id)) {
              // GERCEK bore davranisi: bu akista artık kontrol protokolu yok;
              // farkli frame ise OYUN VERISI gibi ilerletir (kabul edilmez).
              dupAccepts++
              const after = reader.takeRest()
              if (after.length > 0) {
                const player = pending.get(id)
                if (player) player.write(after)
              }
              continue
            }
            const player = pending.get(id)
            if (!player) continue
            accepted.add(id)
            pending.delete(id)
            sock.write(player.read() ?? Buffer.alloc(0)) // erken gelen oyuncu verisi
            player.pipe(sock)
            sock.pipe(player)
            player.on('error', () => {
              sock.destroy()
            })
            sock.on('error', () => {
              player.destroy()
            })
          }
        }
      })
      sock.on('error', () => {})
    })

    let tunnelPort = 0
    tunnel.listen(0, '127.0.0.1', () => {
      tunnelPort = (tunnel.address() as net.AddressInfo).port
      control.listen(0, '127.0.0.1', () => {
        const controlPort = (control.address() as net.AddressInfo).port
        resolve({
          controlPort,
          tunnelPort,
          close: () => {
            tunnel.close()
            control.close()
            for (const c of controls) c.destroy()
            for (const p of pending.values()) p.destroy()
          },
          duplicateAccepts: () => dupAccepts
        })
      })
    })
  })
}

// ---- Yerel "Paper" (echo) sunucusu ----
function startLocalEcho(): Promise<{ port: number; got: string[]; close: () => void }> {
  return new Promise((resolve) => {
    const got: string[] = []
    const srv = net.createServer((sock) => {
      sock.on('data', (d: Buffer) => {
        got.push(d.toString('utf8'))
        sock.write(Buffer.concat([Buffer.from('ECHO:'), d]))
      })
      sock.on('error', () => {})
    })
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port
      resolve({
        port,
        got,
        close: () => srv.close()
      })
    })
  })
}

function makeTunnel(
  root: string,
  localPort: number,
  controlAddr: string,
  verbose: boolean
): BoreTunnel {
  return new BoreTunnel(root, localPort, controlAddr, (ev) => {
    if (!verbose) return
    if (ev.type === 'log') console.log('  |', ev.line)
    else if (ev.type === 'state') console.log('[state]', ev.state)
    else if (ev.type === 'address') console.log('[ADDRESS]', ev.address)
  })
}

function waitAddress(t: BoreTunnel, timeoutMs = 8000): Promise<void> {
  return new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('adres gelmedi')), timeoutMs)
    const poll = setInterval(() => {
      if (t.address) {
        clearInterval(poll)
        clearTimeout(to)
        res()
      }
    }, 50)
  })
}

// ---- Senaryo 1: oyuncu yerel sunucu acilmadan once baglanir ----
async function earlyJoinTest(): Promise<boolean> {
  const mock = await startMockBore()
  const echoProbe = await startLocalEcho()
  const realLocalPort = echoProbe.port
  echoProbe.close() // yerel sunucu YOK; oyuncu bos porta baglanacak
  await new Promise((r) => setTimeout(r, 150))

  const root = path.join(os.tmpdir(), 'bore-relay-smoke')
  const t = makeTunnel(root, realLocalPort, `127.0.0.1:${mock.controlPort}`, true)
  t.start()
  await waitAddress(t)
  console.log('turel adresi:', t.address)

  // 1) Oyuncu yerel sunucu KAPALIYKEN baglanir ve veri yollar
  const player = net.connect(mock.tunnelPort, '127.0.0.1')
  await new Promise<void>((res) => player.once('connect', res))
  player.on('error', (e) => console.error('[oyuncu soket hatasi]', e.message))
  player.write('HELLO-FROM-PLAYER')

  // 2) 1.5 sn bekle: eski kod burada oyuncuyu resetlerdi
  await new Promise((r) => setTimeout(r, 1500))

  // 3) Yerel sunucu acilir
  const got: string[] = []
  const srv = net.createServer((sock) => {
    sock.on('data', (d: Buffer) => {
      got.push(d.toString('utf8'))
      sock.write(Buffer.concat([Buffer.from('ECHO:'), d]))
    })
    sock.on('error', () => {})
  })
  await new Promise<void>((res, rej) => {
    srv.once('error', rej)
    srv.listen(realLocalPort, '127.0.0.1', () => res())
  })
  console.log('yerel sunucu acildi (port', realLocalPort + ')')

  // 4) Oyuncunun cevabini bekle
  let ok = true
  try {
    const reply = await new Promise<string>((res, rej) => {
      let acc = ''
      const to = setTimeout(() => rej(new Error('oyuncuya cevap donmedi')), 8000)
      player.on('data', (d: Buffer) => {
        acc += d.toString('utf8')
        if (acc.includes('ECHO:HELLO-FROM-PLAYER')) {
          clearTimeout(to)
          res(acc)
        }
      })
    })
    if (!reply.includes('ECHO:HELLO-FROM-PLAYER')) ok = false
    // İlk gelen bayt temiz oyun verisi olmalı (JSON çerçeve çöpü DEĞİL)
    if (!reply.startsWith('ECHO:')) {
      console.error('HATA: oyuncuya ilk donen veri temiz degil (Accept/enjekte çöp var):', reply.slice(0, 60))
      ok = false
    }
  } catch {
    ok = false
  }
  if (!got.join('').includes('HELLO-FROM-PLAYER')) {
    console.error('HATA: oyuncu paketi yerel sunucuya ulasmadi')
    ok = false
  }
  if (mock.duplicateAccepts() > 0) {
    console.error(`HATA: ${mock.duplicateAccepts()} adet DUPLIKE Accept frame yazildi!`)
    ok = false
  }
  console.log(ok ? '=== SENARYO 1 (erken katilim) BASARILI ===' : '=== SENARYO 1 BASARISIZ ===')

  player.destroy()
  srv.close()
  t.stop()
  mock.close()
  return ok
}

// ---- Senaryo 2: 2MB cift yonlu burst (login sonrasi config/registry benzeri) ----
async function burstTest(): Promise<boolean> {
  const mock = await startMockBore()
  const echo = await startLocalEcho()
  const root = path.join(os.tmpdir(), 'bore-relay-burst')
  const t = makeTunnel(root, echo.port, `127.0.0.1:${mock.controlPort}`, false)
  t.start()
  await waitAddress(t)

  const SIZE = 2 * 1024 * 1024
  const prefix = 'BURST:'
  const payload = Buffer.alloc(SIZE, 0x61) // 2MB 'aaaa...'

  const player = net.connect(mock.tunnelPort, '127.0.0.1')
  await new Promise<void>((res) => player.once('connect', res))
  player.on('error', (e) => console.error('[oyuncu soket hatasi]', e.message))

  const t0 = Date.now()
  player.write(prefix)
  player.write(payload)

  // Echo cevabi: "ECHO:" + ayni 2MB — tamamlanmasini bekle (takilma testi)
  const expected = prefix.length + SIZE
  let ok = true
  try {
    await new Promise<void>((res, rej) => {
      let acc = Buffer.alloc(0)
      const to = setTimeout(
        () => rej(new Error(`burst 10sn'de tamamlanmadi (${acc.length}/${expected} byte)`)),
        10_000
      )
      player.on('data', (d: Buffer) => {
        acc = Buffer.concat([acc, d])
        if (acc.length >= expected) {
          clearTimeout(to)
          res()
        }
      })
    })
  } catch (e) {
    console.error('HATA:', e instanceof Error ? e.message : e)
    ok = false
  }
  const dt = Date.now() - t0
  if (mock.duplicateAccepts() > 0) {
    console.error(`HATA: ${mock.duplicateAccepts()} adet DUPLIKE Accept frame yazildi!`)
    ok = false
  }
  console.log(
    ok
      ? `=== SENARYO 2 (2MB burst, ${dt}ms) BASARILI ===`
      : '=== SENARYO 2 BASARISIZ ==='
  )

  player.destroy()
  echo.close()
  t.stop()
  mock.close()
  return ok
}

async function main(): Promise<number> {
  const hardTimeout = setTimeout(() => {
    console.error('ZAMAN ASIMI: smoke test 45sn icinde bitmedi')
    process.exit(2)
  }, 45_000)
  hardTimeout.unref()

  const a = await earlyJoinTest()
  const b = await burstTest()
  const ok = a && b
  console.log(ok ? '=== RELAY SMOKE BASARILI ===' : '=== RELAY SMOKE BASARISIZ ===')
  setTimeout(() => process.exit(ok ? 0 : 1), 300)
  return ok ? 0 : 1
}

void main().catch((e) => {
  console.error('SMOKE HATASI:', e)
  process.exit(1)
})
