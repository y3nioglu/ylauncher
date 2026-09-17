// Faz 5a: aktif sunucu duyurusu (host tarafi).
// Paper "Done" yazinca API'ye duyurulur; sunucu kapaninca geri cekilir.
// Basarisizlik sessizce loglanir — duyuru, sunucunun calismasini etkilemez.
import { getApiBase } from '../shared/apiBase'

const apiBase = () => getApiBase()

interface AnnounceOpts {
  token: string | null
  address: string
  port: number
  mcVersion: string
  online: boolean
  /** Faz 14: rozet meta verisi (arkadas listesinde gosterilir). */
  clientMods?: number
  plugins?: number
  /** Cift adres: dogrudan adres erisilemezse katilan taraf bunu dener. */
  tunnelAddress?: string | null
  tunnelPort?: number | null
}

async function post(path: string, token: string | null, body: unknown): Promise<void> {
  const controller = new AbortController()
  const to = setTimeout(() => controller.abort(), 6000)
  try {
    const res = await fetch(`${apiBase()}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify(body),
      signal: controller.signal
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status} ${text.slice(0, 120)}`)
    }
  } finally {
    clearTimeout(to)
  }
}

export async function announceServer(opts: AnnounceOpts): Promise<void> {
  if (!opts.token) {
    console.log('[announce] API token yok; duyuru atlandi (offline host modu)')
    return
  }
  try {
    await post('/api/servers/announce', opts.token, {
      address: opts.address,
      port: opts.port,
      mcVersion: opts.mcVersion,
      online: opts.online,
      clientMods: opts.clientMods ?? 0,
      plugins: opts.plugins ?? 0,
      ...(opts.tunnelAddress
        ? { tunnelAddress: opts.tunnelAddress, tunnelPort: opts.tunnelPort ?? null }
        : {})
    })
    console.log(
      `[announce] sunucu duyuruldu: ${opts.address}:${opts.port}${opts.tunnelAddress ? ` (turel: ${opts.tunnelAddress}:${opts.tunnelPort ?? '?'})` : ''} (${opts.mcVersion}) mod:${opts.clientMods ?? 0} plugin:${opts.plugins ?? 0}`
    )
  } catch (err) {
    console.log(
      `[announce] duyuru basarisiz (sunucu etkilenmedi): ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

export async function withdrawServer(token: string | null): Promise<void> {
  if (!token) return
  try {
    await post('/api/servers/withdraw', token, {})
    console.log('[announce] duyuru geri cekildi')
  } catch (err) {
    console.log(
      `[announce] geri cekme basarisiz (kayit zaman asimiyla dusecek): ${err instanceof Error ? err.message : String(err)}`
    )
  }
}
