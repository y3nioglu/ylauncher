// Cift adres duyurusunun canli API uyumlulugu: yeni alanlarla duyuru
// eski API'de de hatasiz karsilanmali (zod bilinmeyen alanlari kirpar).
const API = 'https://ylauncher-api.onrender.com'

async function main() {
  const email = `probe-test-${Date.now()}@test.local`
  const reg = await fetch(`${API}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'TestPass123!', nickname: 'ProbeTest' })
  })
  const regBody = await reg.json().catch(() => ({}))
  const token = regBody.token ?? regBody.accessToken
  if (!token) {
    console.log('register basarisiz:', reg.status, JSON.stringify(regBody).slice(0, 200))
    process.exit(1)
  }
  // Yeni alanlarla duyuru (eski API bunlari kirmaidan yok saymali)
  const ann = await fetch(`${API}/api/servers/announce`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      address: '45.155.125.146',
      port: 25565,
      mcVersion: '1.21.11',
      online: true,
      clientMods: 2,
      plugins: 2,
      tunnelAddress: 'bore.pub',
      tunnelPort: 7835
    })
  })
  console.log('announce:', ann.status)
  const act = await fetch(`${API}/api/servers/active`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  const actBody = await act.json().catch(() => ({}))
  const mine = (actBody.servers ?? []).find((s) => s.host === 'ProbeTest')
  console.log('active-announce alani tunnel:', JSON.stringify(mine))
}

main()
