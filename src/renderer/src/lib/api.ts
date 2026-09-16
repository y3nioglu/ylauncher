export interface AuthUser {
  id: number
  nickname: string
}

export interface AuthResult {
  token: string
  user: AuthUser
}

// Window.launcher tipi lib/game.ts icinde GameBridge ile tanimlidir
// Faz 12.5: API adresi canli — Ayarlar'dan degistirilebilir (VPS'e yonlendirme).
// Baslangic degeri preload anlik goruntusudur; setApiBaseUrl ile guncellenir.
let currentApiBase = window.launcher?.apiBase ?? 'http://localhost:8787'

export function getApiBaseUrl(): string {
  return currentApiBase
}

export function setApiBaseUrl(base: string): void {
  currentApiBase = base.replace(/\/$/, '')
}

const TOKEN_KEY = 'mcf_token'
const USER_KEY = 'mcf_user'

export function getStoredAuth(): { token: string; user: AuthUser } | null {
  try {
    const token = localStorage.getItem(TOKEN_KEY)
    const rawUser = localStorage.getItem(USER_KEY)
    if (!token || !rawUser) return null
    return { token, user: JSON.parse(rawUser) as AuthUser }
  } catch {
    return null
  }
}

export function storeAuth(result: AuthResult): void {
  localStorage.setItem(TOKEN_KEY, result.token)
  localStorage.setItem(USER_KEY, JSON.stringify(result.user))
}

export function clearAuth(): void {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(USER_KEY)
}

async function apiRequest<T>(
  path: string,
  options: RequestInit & { token?: string } = {}
): Promise<T> {
  const { token, ...fetchOptions } = options
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(fetchOptions.headers as Record<string, string> | undefined)
  }
  if (token) headers.Authorization = `Bearer ${token}`

  const res = await fetch(`${getApiBaseUrl()}${path}`, { ...fetchOptions, headers })
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    // JSON olmayan cevap
  }
  if (!res.ok) {
    const message =
      (body as { error?: string } | null)?.error ?? `Istek basarisiz (HTTP ${res.status})`
    throw new Error(message)
  }
  return body as T
}

export function apiRegister(nickname: string, password: string): Promise<AuthResult> {
  return apiRequest<AuthResult>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ nickname, password })
  })
}

export function apiLogin(nickname: string, password: string): Promise<AuthResult> {
  return apiRequest<AuthResult>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ nickname, password })
  })
}

export function apiMe(token: string): Promise<{ user: AuthUser }> {
  return apiRequest<{ user: AuthUser }>('/api/auth/me', { token })
}
