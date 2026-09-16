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

function readVarInt(buf: Buffer, offset: number): { value: number; bytes: number } | null {
  let result = 0
  let shift = 0
  for (let i = offset; i < Math.min(buf.length, offset + 5); i++) {
    const b = buf[i]
    result |= (b & 0x7f) << shift
    if ((b & 0x80) === 0) return { value: result, bytes: i - offset + 1 }
    shift += 7
  }
  return null
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
 * SLP sorgusu. Handshake (status next state) + status request gonderir,
 * response JSON'unu bekler; ping/pong turuna girmeden kapanir (sunucu icin zararsiz).
 */
export function probeServer(host: string, port: number, timeoutMs = 3000): Promise<ServerStatus> {
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
        writeVarInt(-1),
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
      const lenInfo = readVarInt(buf, 0)
      if (!lenInfo) return
      if (buf.length < lenInfo.bytes + lenInfo.value) return // paket tamamlanmadi
      const body = buf.subarray(lenInfo.bytes, lenInfo.bytes + lenInfo.value)
      // Response paketi: id(0x00) + strLen varint + JSON
      const strInfo = readVarInt(body, 1)
      if (!strInfo) return finish(offline)
      const json = body.subarray(1 + strInfo.bytes, 1 + strInfo.bytes + strInfo.value).toString('utf8')
      try {
        const s = JSON.parse(json) as {
          version?: { name?: string }
          players?: { online?: number; max?: number }
          description?: unknown
          favicon?: string
        }
        finish({
          online: true,
          latencyMs: Date.now() - started,
          players: s.players ? { online: s.players.online ?? 0, max: s.players.max ?? 0 } : null,
          motd: extractMotd(s.description),
          version: s.version?.name ?? null,
          favicon: s.favicon?.startsWith('data:image/png;base64,') ? s.favicon : null
        })
      } catch {
        finish(offline)
      }
    })

    socket.on('timeout', () => finish(offline))
    socket.on('error', () => finish(offline))
    socket.on('close', () => finish(offline))
  })
}
