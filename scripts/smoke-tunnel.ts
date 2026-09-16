// Tünel smoke testi: PlayitTunnel.start -> adres -> stop
import path from 'node:path'
import { PlayitTunnel } from '../src/main/playit'

const root = process.env.APPDATA ? path.join(process.env.APPDATA, 'ylauncher') : process.cwd()

async function main() {
  const t = new PlayitTunnel(root, 25565, (ev) => {
    if (ev.type === 'log') console.log('  |', ev.line)
    else if (ev.type === 'status') console.log('[status]', ev.message)
    else if (ev.type === 'state') console.log('[state]', ev.state)
    else if (ev.type === 'claim') console.log('[claim]', ev.url)
    else if (ev.type === 'address') console.log('[ADDRESS]', ev.address)
  })

  // Not: 25565'te sunucu yok; tünel yine de adres uretir (baglanti denemeleri
  // ajan logunda gorunur ama bu test icin onemli degil).
  const hardTimeout = setTimeout(() => {
    console.error('ZAMAN ASIMI: tünel 2 dakikada hazir olmadi')
    t.stop()
    setTimeout(() => process.exit(2), 500)
  }, 120_000)
  hardTimeout.unref()

  try {
    await t.start()
  } catch (err) {
    console.error('TUNEL HATASI:', err instanceof Error ? err.message : err)
    t.stop()
    setTimeout(() => process.exit(1), 500)
    return
  }

  console.log('=== TUNEL DURUMU ===')
  console.log('state:', t.state)
  console.log('address:', t.address)
  console.log('claimUrl:', t.claimUrl)

  const ok = t.state === 'live' && !!t.address
  t.stop()
  setTimeout(() => process.exit(ok ? 0 : 3), 500)
}

void main()
