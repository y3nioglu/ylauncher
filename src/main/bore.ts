// bore tüneli — SAF NODE.JS uygulaması, harici .exe YOK.
//
// Neden: bore'un resmi binary'si imzasız olduğu için Windows Defender
// "spawn UNKNOWN" ile engelliyor ve kullanıcıdan AV istisnası istemek
// gerekliyordu. bore protokolü çok basit olduğu için (bkz.
// https://github.com/ekzhang/bore, MIT) burada gömülü implemente edildi:
//
//   - Kontrol portu 7835, JSON mesajlar 0x00 (null byte) ile ayrılır.
//   - Istemci: {"Hello":<istenilenRemotePort>} (0 = rastgele) -> sunucu:
//     {"Hello":<atananRemotePort>}
//   - Her gelen bağlantı için sunucu {"Connection":"<uuid>"} gönderir;
//     istemci yeni bir TCP baglantiyla {"Accept":"<uuid>"} yazip o
//     akisi yerel sunucuya (127.0.0.1:25565) piksel piksel kopruler.
//   - {"Heartbeat"} yoksayilir; {"Error"} tureli sonlandirir.
//   - Self-host sunucu auth aciksa: {"Challenge":"<uuid>"} -> HMAC-SHA256
//     ile {"Authenticate":"<hex>"} cevaplanir.
//
// AV/Defender artik imzalayacagi bir dosya bulamuyor: Electron'un kendi
// surecinde calisiyor. Bazi AV'ler launcheri imzaladigindan bu yol sorun
// cikarmaz.
import net from 'node:net'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const CONTROL_PORT = 7835
const MAX_FRAME_LENGTH = 256
const DEFAULT_SERVER = 'bore.pub'
const MAX_RETRIES = 5
// Aktarim veriyolu surumu. Loglarda gormek icin: dogru derlemenin
// VPS'te calistigini dogrulamak icin kullanilir.
export const TUNNEL_IMPL_VERSION = 'relay-v5-kickpipe'
// Akis izleyici: bu kadar ms'dir veri akmazsa uyari logla
const STALL_CHECK_MS = 5_000
const STALL_WARN_AFTER_MS = 12_000
// Oyuncu akisi aciktan sonra yerel sunucuya kac ms daha denenecek?
// (Paper 'Done' yazana kadar baglanti reddedilir; erken gelen el sikma
// paketleri o ana kadar bekletilir, bu sureyi asarsa akis kapatilir.)
const LOCAL_CONNECT_TIMEOUT_MS = 15_000
const LOCAL_CONNECT_RETRY_MS = 250

export type BoreState = 'stopped' | 'starting' | 'live'

export interface BoreEvent {
  type: 'log' | 'state' | 'address' | 'status' | 'error'
  line?: string
  state?: BoreState
  address?: string
  message?: string
}

function frame(msg: unknown): Buffer {
  return Buffer.from(JSON.stringify(msg) + '\0', 'utf8')
}

// 0x00 ile ayrilmis JSON cercevelerini akisdan ayiklar
class FrameReader {
  private buf: Buffer = Buffer.alloc(0)
  push(chunk: Buffer): Record<string, unknown>[] {
    this.buf = Buffer.concat([this.buf, chunk])
    const out: Record<string, unknown>[] = []
    let idx: number
    while ((idx = this.buf.indexOf(0x00)) !== -1) {
      const raw = this.buf.subarray(0, idx)
      this.buf = this.buf.subarray(idx + 1)
      if (raw.length === 0 || raw.length > MAX_FRAME_LENGTH) continue
      try {
        const parsed: unknown = JSON.parse(raw.toString('utf8'))
        if (parsed && typeof parsed === 'object') out.push(parsed as Record<string, unknown>)
      } catch {
        /* bozuk cerceve: yoksay */
      }
    }
    return out
  }
}

export class BoreTunnel {
  private ctrl: net.Socket | null = null
  private open = new Set<net.Socket>()
  private _state: BoreState = 'stopped'
  private _address: string | null = null
  private wantRunning = false
  private retries = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  private localConnectFailures = 0

  constructor(
    private root: string,
    private localPort: number,
    private serverAddr: string | null,
    private onEvent: (ev: BoreEvent) => void
  ) {}

  get state(): BoreState {
    return this._state
  }
  get address(): string | null {
    return this._address
  }

  private setState(s: BoreState) {
    this._state = s
    this.onEvent({ type: 'state', state: s })
  }
  private status(message: string) {
    this.onEvent({ type: 'status', message })
  }
  private log(line: string) {
    this.onEvent({ type: 'log', line: `[tunnel] ${line}` })
  }
  private fail(message: string) {
    this.onEvent({ type: 'error', message })
    this.log(`HATA: ${message}`)
  }

  private get dir(): string {
    return path.join(this.root, 'bore')
  }

  // Self-host bore sunucusu: <root>/bore/server.txt ("host[:port]") varsa
  // onu kullan; secret.txt varsa auth'a gir. Yoksa herkese acik bore.pub.
  private resolveServer(): { host: string; port: number; secret: string | null } {
    let addr = this.serverAddr?.trim() || ''
    if (!addr) {
      try {
        addr = readFileSync(path.join(this.dir, 'server.txt'), 'utf8').trim()
      } catch {
        /* yok */
      }
    }
    if (!addr) addr = DEFAULT_SERVER
    let host = addr
    let port = CONTROL_PORT
    const m = /^([^\s:]+):(\d+)$/.exec(addr)
    if (m) {
      host = m[1]
      port = Number(m[2])
    }
    let secret: string | null = null
    try {
      const s = readFileSync(path.join(this.dir, 'secret.txt'), 'utf8').trim()
      if (s) secret = s
    } catch {
      /* yok */
    }
    return { host, port, secret }
  }

  start(): void {
    if (this.ctrl && this.wantRunning) return // zaten calisiyor
    this.wantRunning = true
    this.retries = 0
    this.connect()
  }

  private connect(): void {
    if (!this.wantRunning) return
    const { host, port, secret } = this.resolveServer()

    this._address = null
    this.setState('starting')
    this.status(`Tünel kuruluyor (${host})...`)
    this.log(`${host}:${port} kontrol baglantisi açılıyor`)

    const ctrl = net.connect({ host, port })
    this.ctrl = ctrl
    const reader = new FrameReader()

    ctrl.on('connect', () => {
      this.log(`sunucuya bağlandı, tünel isteniyor... (aktarim: ${TUNNEL_IMPL_VERSION})`)
      // Hello = istenilen REMOTE port (0 = sunucu rastgele atar).
      // Yerel port bu asamada sunucuya bildirilmez; trafik Accept akislariyla akar.
      ctrl.write(frame({ Hello: 0 }))
    })

    ctrl.on('data', (d: Buffer) => {
      for (const msg of reader.push(d)) {
        if ('Challenge' in msg) {
          // Self-host auth: HMAC-SHA256(secret, challenge)
          const challenge = String(msg.Challenge)
          if (!secret) {
            this.fail('bore sunucusu kimlik doğrulaması istiyor ama secret.txt yok.')
            ctrl.destroy()
            return
          }
          const hmac = crypto.createHmac('sha256', secret).update(challenge).digest('hex')
          ctrl.write(frame({ Authenticate: hmac }))
        } else if ('Hello' in msg) {
          const remotePort = Number(msg.Hello)
          if (!Number.isFinite(remotePort) || remotePort <= 0) {
            this.fail(`bore sunucusu gecersiz port dondurdu: ${String(msg.Hello)}`)
            ctrl.destroy()
            return
          }
          this._address = `${host}:${remotePort}`
          this.onEvent({ type: 'address', address: this._address })
          this.setState('live')
          this.retries = 0
          this.status(`Tünel hazır: ${this._address}`)
        } else if ('Connection' in msg) {
          this.handleConnection(String(msg.Connection), host, port)
        } else if ('Error' in msg) {
          this.fail(`bore sunucusu hata döndürdü: ${String(msg.Error)}`)
          ctrl.destroy()
        }
        // Heartbeat: yoksay (sunucu canlilik testi)
      }
    })

    ctrl.on('error', (err: NodeJS.ErrnoException) => {
      if (!this.wantRunning) return
      const detail =
        err.code === 'ECONNREFUSED'
          ? 'sunucuya ulasilamadi (port kapali/hiz dustu)'
          : err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN'
            ? 'sunucu adresi cozumlenemedi (DNS)'
            : err.code === 'ETIMEDOUT'
              ? 'baglanti zaman asimi'
              : err.message
      if (this._state === 'live') {
        this.status(`Tünel bağlantısı koptu (${detail}) — yeniden bağlanılıyor...`)
      } else {
        this.log(`kontrol baglantisi hata verdi: ${detail}`)
      }
    })

    ctrl.on('close', () => {
      if (this.ctrl !== ctrl) return
      this.ctrl = null
      if (!this.wantRunning) {
        this.setState('stopped')
        return
      }
      // Beklenmedik kopma: sunucu (Paper) hala aciksa yavas yeniden dene
      if (this.retries < MAX_RETRIES) {
        this.retries++
        const delay = Math.min(2000 * this.retries, 10_000)
        this.status(`Tünel yeniden bağlanıyor (deneme ${this.retries}/${MAX_RETRIES})...`)
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null
          if (this.wantRunning) this.connect()
        }, delay)
      } else {
        this.fail('bore tüneli art arda bağlanamadı; "Yenile" ile tekrar deneyin.')
        this.setState('stopped')
      }
    })
  }

  // Iki akisi kopruler. KASTEN .pipe(): Node'un yillardir test edilmis,
  // geri basinç kontrollü yolu. Ozel pompa YAZMADIK — login sonrasi gonderilen
  // buyuk kayit/config paketleri (registry sync ~100KB+) ozel pompanin
  // pause/drain diziliminde takilip 30 sn sonra 'Timed out' ile oyuncu
  // atiliyor (gercek hayatta goruldu). pipe() bu yuku sorunsuz tasiyor.
  private pipeBidirectional(remote: net.Socket, local: net.Socket): void {
    remote.pipe(local)
    local.pipe(remote)
  }

  // Sunucudan {"Connection":"<uuid>"} geldi: yeni bir akis acip Accept
  // yaz, sonra o akisi yerel Paper sunucusuyla boru hatti gibi bagla.
  //
  // ÖNEMLI: Oyuncu tane tane baglanirken sunucu henuz dinlemede olmayabilir
  // (Paper 'Done' yazmadan once). ECONNREFUSED'da oyuncunun akisini KAPATMAK
  // istemcide 'Connection reset' hatasina doner; bunun yerine yerel baglanti
  // hazir olana kadar tekrar deneriz.
  private handleConnection(uuid: string, host: string, port: number): void {
    this.log('yeni oyuncu bağlantısı')
    const remote = net.connect({ host, port })
    this.open.add(remote)

    let local: net.Socket | null = null
    let settled = false
    let bridged = false
    let up = 0
    let down = 0
    let lastProgress = Date.now()
    let stallTimer: NodeJS.Timeout | null = null
    const startedAt = Date.now()
    const fmtBytes = (n: number): string =>
      n >= 1024 * 1024
        ? `${(n / 1024 / 1024).toFixed(1)}MB`
        : n >= 1024
          ? `${(n / 1024).toFixed(1)}KB`
          : `${n}B`

    const teardown = (): void => {
      settled = true
      if (stallTimer) {
        clearInterval(stallTimer)
        stallTimer = null
      }
      local?.destroy()
      remote.destroy()
      this.open.delete(remote)
      if (local) this.open.delete(local)
    }

    let accepted = false
    const acceptOnce = (target: net.Socket): void => {
      if (accepted) {
        this.log('UYARI: Accept cercevesi iki kez yazilmaya calisildi (bug yakalandi, yoksayildi)')
        return
      }
      accepted = true
      target.write(frame({ Accept: uuid }))
    }

    const connectLocal = (): void => {
      if (settled) return
      const sock = net.connect({ host: '127.0.0.1', port: this.localPort })
      local = sock
      this.open.add(sock)

      sock.once('connect', () => {
        if (settled) {
          sock.destroy()
          this.open.delete(sock)
          return
        }
        this.localConnectFailures = 0
        // Accept cercevesi TAM BIR KEZ yazilir; sonrasinda bu akis HAM oyun
        // trafigidir. Cift yazim oyuncuya cop enjekte eder -> protokol
        // desync -> 30 sn sessizlik -> 'Timed out' (canida yasandi).
        acceptOnce(remote)
        this.pipeBidirectional(remote, sock)
        startObservability()
      })
      sock.on('error', (err: NodeJS.ErrnoException) => {
        if (settled) {
          this.open.delete(sock)
          return
        }
        sock.destroy()
        this.open.delete(sock)
        if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT') {
          if (Date.now() - startedAt > LOCAL_CONNECT_TIMEOUT_MS) {
            this.log('yerel sunucu hâlâ hazır değil; oyuncu bağlantısı zaman aşımına uğradı')
            teardown()
            return
          }
          this.localConnectFailures++
          if (this.localConnectFailures === 4) {
            this.status('Oyuncu geliyor; yerel sunucu hazır olunca baglanacak...')
          }
          setTimeout(connectLocal, LOCAL_CONNECT_RETRY_MS)
          return
        }
        this.log(`yerel sunucuya baglanirken hata: ${err.message}`)
        teardown()
      })
    }

    remote.once('connect', () => {
      connectLocal()
    })

    remote.on('close', () => {
      if (bridged) {
        const secs = ((Date.now() - startedAt) / 1000).toFixed(1)
        this.log(`bağlantı kapandı (${secs} sn, ⬆ ${fmtBytes(up)} / ⬇ ${fmtBytes(down)})`)
      }
      teardown()
    })
    remote.on('error', () => {
      // close olayi temizligi yapar
    })

    // Gözlemlenebilirlik: bayt sayaçları + takılma bekçisi. pipe()'ın kendi
    // iç dinleyicisine EK olarak ikinci 'data' dinleyicisi sadece sayar;
    // akisa mudahale etmez (flowing mode zaten açıktır).
    const startObservability = (): void => {
      bridged = true
      remote.on('data', (d: Buffer) => {
        up += d.length
        lastProgress = Date.now()
      })
      local!.on('data', (d: Buffer) => {
        down += d.length
        lastProgress = Date.now()
      })
      stallTimer = setInterval(() => {
        const idleMs = Date.now() - lastProgress
        if (idleMs > STALL_WARN_AFTER_MS) {
          this.log(
            `UYARI: akis ${Math.round(idleMs / 1000)} sn'dir veri akmıyor (⬆ ${fmtBytes(up)} / ⬇ ${fmtBytes(down)}) — oyuncu 'Timed out' alacak`
          )
        }
      }, STALL_CHECK_MS)
      stallTimer.unref()
    }
  }

  stop(): void {
    this.wantRunning = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ctrl) {
      this.ctrl.destroy()
      this.ctrl = null
    }
    for (const s of this.open) s.destroy()
    this.open.clear()
    this.localConnectFailures = 0
    this._address = null
    if (this._state !== 'stopped') this.setState('stopped')
  }
}
