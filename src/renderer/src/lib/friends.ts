import { getApiBaseUrl } from './api'
import { getStoredAuth } from './api'

export interface FriendDto {
  id: number
  nickname: string
  online: boolean
}

export interface FriendRequestDto extends FriendDto {
  requestId: number
}

export interface FriendsPayload {
  friends: FriendDto[]
  incoming: FriendRequestDto[]
  outgoing: FriendRequestDto[]
}

export class FriendsError extends Error {}

async function friendsRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const stored = getStoredAuth()
  if (!stored) throw new FriendsError('Oturum bulunamadi, lutfen tekrar giris yapin.')

  const res = await fetch(`${getApiBaseUrl()}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${stored.token}`,
      ...(options.headers as Record<string, string> | undefined)
    }
  })

  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    // JSON olmayan cevap
  }
  if (!res.ok) {
    const message = (body as { error?: string } | null)?.error ?? `Istek basarisiz (HTTP ${res.status})`
    throw new FriendsError(message)
  }
  return body as T
}

export function fetchFriends(): Promise<FriendsPayload> {
  return friendsRequest<FriendsPayload>('/api/friends')
}

export function sendFriendRequest(nickname: string): Promise<{ sent?: boolean; accepted?: boolean }> {
  return friendsRequest('/api/friends/request', {
    method: 'POST',
    body: JSON.stringify({ nickname })
  })
}

export function respondFriendRequest(requestId: number, accept: boolean): Promise<{ accepted: boolean }> {
  return friendsRequest('/api/friends/respond', {
    method: 'POST',
    body: JSON.stringify({ requestId, accept })
  })
}

export function removeFriend(nickname: string): Promise<{ removed: boolean }> {
  return friendsRequest(`/api/friends/${encodeURIComponent(nickname)}`, { method: 'DELETE' })
}

export interface NickSuggestion {
  id: number
  nickname: string
  relation: 'self' | 'friends' | 'pending_out' | 'pending_in' | 'none'
}

export function fetchSuggestions(query: string): Promise<NickSuggestion[]> {
  return friendsRequest<{ suggestions: NickSuggestion[] }>(
    `/api/friends/suggest?q=${encodeURIComponent(query)}`
  ).then((r) => r.suggestions)
}

// ---- Faz 5a: aktif sunucular ----
export interface ActiveServerKick {
  reason: string
  rawLine: string
  at: string
}

export interface ActiveServer {
  hostId: number
  host: string
  address: string
  port: number
  mcVersion: string
  announcedAt: string
  /** Faz 14: duyuruyla gelen icerik meta verisi (rozetler). */
  clientMods?: number
  plugins?: number
  /** Faz 5b: host'un Paper log'undan yakaladigi son kick (2 dk omurlu). */
  lastKick?: ActiveServerKick | null
}

export function fetchActiveServers(): Promise<ActiveServer[]> {
  return friendsRequest<{ servers: ActiveServer[] }>('/api/servers/active').then(
    (r) => r.servers
  )
}

export function announceServerActive(opts: {
  address: string
  port: number
  mcVersion: string
  online: boolean
}): Promise<{ announced?: boolean; withdrawn?: boolean }> {
  return friendsRequest('/api/servers/announce', {
    method: 'POST',
    body: JSON.stringify(opts)
  })
}

export function withdrawServerActive(): Promise<{ withdrawn: boolean }> {
  return friendsRequest('/api/servers/withdraw', { method: 'POST', body: '{}' })
}

// ---- Faz 5c: whitelist'e ekleme istekleri ----
export interface WhitelistRequestDto {
  id: number
  hostId: number
  requesterId: number
  nickname: string
  status: 'pending' | 'accepted' | 'declined'
  createdAt: string
  respondedAt: string | null
}

export function sendWhitelistRequest(hostNickname: string): Promise<{ sent: boolean }> {
  return friendsRequest('/api/whitelist/requests', {
    method: 'POST',
    body: JSON.stringify({ nickname: hostNickname })
  })
}

export function fetchWhitelistRequests(): Promise<{
  incoming: WhitelistRequestDto[]
  outgoing: WhitelistRequestDto[]
}> {
  return friendsRequest('/api/whitelist/requests')
}

/** hostId -> istek durumu + yanit zamani (bayatlik kontrolu icin). */
export interface OutgoingWhitelistState {
  status: 'pending' | 'accepted' | 'declined'
  respondedAt: string | null
}

export function respondWhitelistRequest(
  id: number,
  accept: boolean
): Promise<{ responded: boolean; status: string; nickname: string }> {
  return friendsRequest(`/api/whitelist/requests/${id}/respond`, {
    method: 'POST',
    body: JSON.stringify({ accept })
  })
}
