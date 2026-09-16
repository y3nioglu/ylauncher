// Faz 4 smoke test: gercek Paper sunucusu baslatir, ready olur, whitelist ekler, kapatir
import path from 'node:path'
import { ServerManager } from '../src/main/server'

const root = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'ylauncher')
  : path.join(process.cwd(), 'server', 'data', 'srvroot')

const MC_VERSION = process.argv[2] ?? '1.21.11'

async function main() {
  const mgr = new ServerManager(root)
  let ready = false
  let stopped = false

  mgr.on('server-event', (ev: { type: string; message?: string; line?: string; percent?: number; label?: string }) => {
    if (ev.type === 'log') {
      console.log('  |', ev.line)
    } else if (ev.type === 'status') {
      console.log('[status]', ev.message)
    } else if (ev.type === 'progress') {
      if (ev.percent % 25 === 0) console.log(`[progress] ${ev.label} %${ev.percent}`)
    } else if (ev.type === 'ready') {
      ready = true
    } else if (ev.type === 'error') {
      console.log('[error]', ev.message)
    } else if (ev.type === 'stopped') {
      stopped = true
      console.log('=== STOPPED EVENT ALINDI ===')
    } else if (ev.type === 'tunnel-state') {
      console.log('[tunnel]', ev.state)
    }
  })

  const hardTimeout = setTimeout(() => {
    console.error('ZAMAN ASIMI: sunucu 3 dakikada hazir olmadi')
    mgr.stop()
    setTimeout(() => process.exit(2), 12_000)
  }, 180_000)
  // process kapanmasin diye
  hardTimeout.unref()

  try {
    await mgr.start({ mcVersion: MC_VERSION })
  } catch (err) {
    console.error('BASLATMA HATASI:', err instanceof Error ? err.message : err)
    process.exit(1)
  }

  // ready olmasini bekle
  while (!ready && !stopped) {
    await new Promise((r) => setTimeout(r, 1000))
  }
  if (!ready) {
    console.error('Sunucu hazir olmadan kapandi')
    process.exit(2)
  }
  clearTimeout(hardTimeout)

  console.log('=== SUNUCU HAZIR ===')
  console.log('whitelist (baslangic):', mgr.listWhitelist())
  mgr.whitelistAdd('ali_test')
  const wl = mgr.whitelistAdd('veli_test')
  console.log('whitelist sonrasi:', wl)
  console.log('durum:', JSON.stringify(mgr.getStatus()))

  mgr.stop()
  const stopDeadline = Date.now() + 20_000
  while (!stopped && Date.now() < stopDeadline) {
    await new Promise((r) => setTimeout(r, 500))
  }
  console.log(stopped ? '=== DURDURMA TAMAM (graceful) ===' : '=== DURDURMA ZAMAN ASIMI ===')
  mgr.stopTunnel()
  setTimeout(() => process.exit(stopped ? 0 : 3), 500)
}

void main()
