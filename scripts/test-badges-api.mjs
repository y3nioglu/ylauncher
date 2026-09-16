#!/usr/bin/env node
// Rozet zinciri canlı testi: announce -> /active -> alanlar.
const BASE = 'https://ylauncher-api.onrender.com/api'
const NICK = 'badge_test_user'
const PASS = 'test1234'

async function j(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  try { return { status: res.status, data: JSON.parse(text) } } catch { return { status: res.status, data: text.slice(0, 200) } }
}

let r = await j('POST', '/auth/register', { nickname: NICK, password: PASS })
if (r.status !== 200 || !r.data?.token) r = await j('POST', '/auth/login', { nickname: NICK, password: PASS })
const token = r.data?.token
console.log('auth:', r.status, token ? 'token alindi' : JSON.stringify(r.data).slice(0, 120))
if (!token) process.exit(1)

r = await j('POST', '/servers/announce', {
  name: 'BadgeTestSunucu',
  address: '1.2.3.4',
  port: 25565,
  players: 0,
  maxPlayers: 20,
  mcVersion: '1.21.11',
  plugins: 2,
  clientMods: 3,
}, token)
console.log('announce:', r.status, JSON.stringify(r.data).slice(0, 200))

r = await j('GET', '/servers/active', undefined, token)
const servers = Array.isArray(r.data) ? r.data : r.data?.servers
const mine = (servers || []).find((s) => s.name === 'BadgeTestSunucu')
if (!mine) {
  console.log('active: BENIM SUNUCU YOK. toplam:', (servers || []).length)
  console.log('ilk sunucu ornegi:', JSON.stringify((servers || [])[0], null, 1)?.slice(0, 400))
} else {
  console.log('active satiri:', JSON.stringify(mine, null, 1))
  const ok = mine.pluginCount === 2 && mine.clientModCount === 3
  console.log(ok ? 'ROZET ALANLARI TAM :)' : 'ROZET ALANLARI EKSIK/HATALI :(')
}

// Temizlik: duyuruyu geri çek
await j('POST', '/servers/withdraw', { address: '1.2.3.4:25565' }, token)
console.log('withdraw gonderildi (temizlik)')
