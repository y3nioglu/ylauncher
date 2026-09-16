// Push-tabanli guncelleme: tek SSE long-poll baglantisiyla sunucu listesi,
// arkadaslik istekleri ve whitelist istekleri degisimlerini dinler.
//
// Neden polling degil: 15-20 sn'lik polling isteklerin kullaniciya gec
// ulasmasina neden oluyordu; cok sik polling ise sistemi yorar ve API
// rate limit'lerine takilir. Long-poll'da sunucu degisiklik olasana kadar
// bekletir (~25 sn'de bir sessiz "hala bagli" yaniti) — degisiklik ~1 sn'de
// ulasir, bos zamanlarda istek akisi olmaz.
//
// Tek shared EventSource: tum bilesenler (App, ServerScreen, ServerListScreen)
// ayni baglantidan beslenir; token degisince (login/logout) baglanti tazelenir.
import { getApiBaseUrl, getStoredAuth } from './api'

export type LiveEventKind =
  | 'friend_request'
  | 'friend_update'
  | 'wl_request'
  | 'servers'
  | 'kick'

type Listener = (kind: LiveEventKind) => void

interface State {
  es: EventSource | null
  lastEventId: number
  listeners: Set<Listener>
  backoffMs: number
  reconnectTimer: number | null
  kindsKey: string
}

const state: State = {
  es: null,
  lastEventId: 0,
  listeners: new Set(),
  backoffMs: 1000,
  reconnectTimer: null,
  kindsKey: ''
}

const MAX_BACKOFF_MS = 30_000

function allKinds(): string {
  return 'friend_request,friend_update,wl_request,servers,kick'
}

function connect(): void {
  if (state.es) return
  const stored = getStoredAuth()
  if (!stored) return // cikis yapildi; login'de tekrar baglanir

  const url =
    `${getApiBaseUrl()}/api/events/stream?kinds=${allKinds()}&token=${encodeURIComponent(stored.token)}` +
    (state.lastEventId > 0 ? `&lastEventId=${state.lastEventId}` : '')
  const es = new EventSource(url)
  state.es = es

  es.onmessage = (ev) => {
    // Yeniden baglanmayi sifirla: baglanti saglikli
    state.backoffMs = 1000
    try {
      const payload = JSON.parse(ev.data) as { lastEventId?: number; kinds?: string[] }
      if (typeof payload.lastEventId === 'number' && payload.lastEventId > 0) {
        state.lastEventId = payload.lastEventId
      }
      const kinds = payload.kinds ?? []
      for (const k of kinds) {
        for (const l of state.listeners) {
          try {
            l(k as LiveEventKind)
          } catch {
            /* bir dinleyici patlasa digerleri etkilenmesin */
          }
        }
      }
    } catch {
      /* bozuk payload: yok say */
    }
  }

  es.onerror = () => {
    // EventSource kendi de yeniden dener; biz de ustel geri cekilmeli
    // kapatiyoruz (retry storms'u onlemek icin) ve timer ile yeniden
    // baglaniyoruz. Offline'da 30 sn'de bir sessiz deneme.
    es.close()
    state.es = null
    if (state.reconnectTimer !== null) return
    state.reconnectTimer = window.setTimeout(() => {
      state.reconnectTimer = null
      connect()
    }, state.backoffMs)
    state.backoffMs = Math.min(state.backoffMs * 2, MAX_BACKOFF_MS)
  }
}

/** Degisiklik dinleyicisi ekle; unsubscribe fonksiyonu doner. */
export function subscribeLiveEvents(listener: Listener): () => void {
  state.listeners.add(listener)
  connect()
  return () => {
    state.listeners.delete(listener)
  }
}

/** Login sonrasi (token degistiginde) baglantiyi sifirla. */
export function resetLiveEvents(): void {
  state.es?.close()
  state.es = null
  state.lastEventId = 0
  state.backoffMs = 1000
  if (state.reconnectTimer !== null) {
    window.clearTimeout(state.reconnectTimer)
    state.reconnectTimer = null
  }
  if (state.listeners.size > 0) connect()
}
