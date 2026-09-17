// Faz 15: Minecraft sunucu durumu sorgulama (Server List Ping).
// Uygulama: handshake paketi -> status response -> JSON. Soket tabanli,
// harici kutuphane yok; 3 sn zaman asimiyla "ulasilamiyor" hizli doner.
import net from 'node:net'

export interface ServerStatus {
  online: boolean
  latencyMs: number | null
  players: { online: number; max: number } | null
  motd: string | null
  version: string | null
  /** base64 data URI (image/png) — API favicon alanindan uretilir */
  favicon: string | null
}

/** VarInt (protocol buffer tarzi) uretir. */
function writeVarInt(value: number): Buffer {
  const bytes: number[] = []
  let v = value
  while (true) {
    if ((v & ~0x7f) === 0) {
      bytes.push(v)
      return Buffer.from(bytes)
    }
    bytes.push((v & 0x7f) | 0x80)
    v >>>= 7
  }
}

/** Paketi uzunluk on ekiyle sarmalar. */
function packet(data: Buffer): Buffer[] {
  return [writeVarInt(data.length), data]
}

/** MOTD'yi JSON'dan duz metne indirger (legacy renk kodlari temizlenir). */
function extractMotd(desc: unknown): string | null {
  if (typeof desc === 'string') return desc.replace(/§./g, '').trim() || null
  if (desc && typeof desc === 'object') {
    const obj = desc as { text?: string; extra?: unknown[] }
    let out = obj.text ?? ''
    const walk = (items: unknown[]): void => {
      for (const it of items) {
        if (typeof it === 'string') out += it
        else if (it && typeof it === 'object') {
          const o = it as { text?: string; extra?: unknown[] }
          out += o.text ?? ''
          if (Array.isArray(o.extra)) walk(o.extra)
        }
      }
    }
    if (Array.isArray(obj.extra)) walk(obj.extra)
    return out.replace(/§./g, '').trim() || null
  }
  return null
}

/**
 * Esnek JSON cikarimi: status JSON, tamponun herhangi bir konumunda baslayabilir
 * (bore/relay benzeri tüneller oyuncu akisina kontrol cerceveleri ekleyebilir:
 * or. {"Accept":...} — katı varint cercevelemesi bunu paket sanip yanlis okur).
 * Aday '{' konumlarindan JSON.parse dener; status sekline uymayan objeyi
 * (or. relay kontrol frame'i) atlar. 'wait' = daha fazla veri gelmeli.
 */
function extractStatusJson(buf: Buffer): Record<string, unknown> | null | 'wait' {
  if (buf.length === 0) return 'wait'
  if (buf.length > 8192) return null // makul bir yanit bu kadar buyuk olamaz
  const text = buf.toString('latin1')
  let tried = 0
  for (let i = text.indexOf('{'); i >= 0 && tried < 16; i = text.indexOf('{', i + 1)) {
    tried++
    try {
      const parsed = JSON.parse(text.slice(i)) as unknown
      if (parsed && typeof parsed === 'object') {
        const o = parsed as Record<string, unknown>
        // Status yaniti sekli: version / players / description alanlarindan en az biri
        if ('version' in o || 'players' in o || 'description' in o) return o
        // Sekil uymuyor (kontrol frame'i) — sonraki '{' adayina bak
      }
    } catch {
      /* bu konumda tamamlanmis JSON yok — ya bekleyecegiz ya diger aday */
    }
  }
  // Hicbir aday parse olmadı: JSON henüz tamamlanmamış olabilir
  return 'wait'
}

/**
 * Tek SLP denemesi: handshake (status next state) + status request gonderir,
 * response JSON'unu bekler; ping/pong turuna girmeden kapanir (sunucu icin zararsiz).
 */
function tryOnce(host: string, port: number, protocolVersion: number, timeoutMs: number): Promise<ServerStatus> {
  const started = Date.now()
  return new Promise((resolve) => {
    const offline: ServerStatus = {
      online: false,
      latencyMs: null,
      players: null,
      motd: null,
      version: null,
      favicon: null
    }
    const socket = net.createConnection({ host, port })
    socket.setTimeout(timeoutMs)

    let buf = Buffer.alloc(0)
    let done = false

    const finish = (status: ServerStatus): void => {
      if (done) return
      done = true
      socket.destroy()
      resolve(status)
    }

    socket.on('connect', () => {
      // Handshake: protocol version -1 (status), host, port, next state 1
      const hostBuf = Buffer.from(host, 'utf8')
      const hs = Buffer.concat([
        writeVarInt(0x00),
        writeVarInt(protocolVersion),
        writeVarInt(hostBuf.length),
        hostBuf,
        Buffer.from([0, (port >> 8) & 0xff, port & 0xff]),
        writeVarInt(1)
      ])
      // handshake + status request tek yazimda
      socket.write(Buffer.concat([...packet(hs), ...packet(Buffer.from([0x00]))]))
    })

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      const s = extractStatusJson(buf)
      if (s === 'wait') return // paket tamamlanmadi / JSON yarim
      if (!s) return finish(offline)
      finish({
        online: true,
        latencyMs: Date.now() - started,
        players: s.players ? { online: (s.players as { online?: number }).online ?? 0, max: (s.players as { max?: number }).max ?? 0 } : null,
        motd: extractMotd(s.description),
        version: (s.version as { name?: string } | undefined)?.name ?? null,
        favicon: typeof s.favicon === 'string' && s.favicon.startsWith('data:image/png;base64,') ? s.favicon : null
      })
    })

    socket.on('timeout', () => finish(offline))
    socket.on('error', () => finish(offline))
    socket.on('close', () => finish(offline))
  })
}

/**
 * SLP sorgusu — iki denemeli: once protokol -1 (eski davranis, cogu sunucu kabul eder),
 * yanit gelmezse modern surum numarasiyla (1.20.5+ bazi kurulumlarda -1'i reddeder).
 * Toplam sure ~2*timeout ile sinirlidir; ilk basarili deneme kazanir.
 */
export async function probeServer(host: string, port: number, timeoutMs = 3000): Promise<ServerStatus> {
  const first = await tryOnce(host, port, -1, timeoutMs)
  if (first.online) return first
  return tryOnce(host, port, 767, timeoutMs)
}
