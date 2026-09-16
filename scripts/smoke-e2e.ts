// Uctan uca test: Paper baslar -> tunnel adresi uretilir -> turel uzerinden TCP baglantisi
import path from 'node:path'
import net from 'node:net'
import { ServerManager } from '../src/main/server'

const root = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'ylauncher')
  : process.cwd()

function tcpProbe(host: string, port: number, timeoutMs = 10_000): Promise<{ ok: boolean; err?: string }> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port })
    const done = (r: { ok: boolean; err?: string }) => {
      s.destroy()
      resolve(r)
    }
    s.setTimeout(timeoutMs, () => done({ ok: false, err: 'timeout' }))
    s.once('connect', () => done({ ok: true }))
    s.once('error', (e) => done({ ok: false, err: e.message }))
  })
}

async function main() {
  const mgr = new ServerManager(root)
  let ready = false
  mgr.on('server-event', (ev: { type: string; message?: string; state?: string }) => {
    if (ev.type === 'ready') ready = true
    else if (ev.type === 'status') console.log('[status]', ev.message)
    else if (ev.type === 'tunnel-state') console.log('[tunnel]', ev.state)
    else if (ev.type === 'error') console.log('[error]', ev.message)
  })

  const hardTimeout = setTimeout(() => {
    console.error('ZAMAN ASIMI')
    mgr.stop()
    setTimeout(() => process.exit(2), 12_000)
  }, 240_000)
  hardTimeout.unref()

  await mgr.start({ mcVersion: '1.21.11' })
  while (!ready) await new Promise((r) => setTimeout(r, 1000))

  const st = mgr.getStatus()
  console.log('=== DURUM ===', JSON.stringify(st))
  if (!st.tunnelAddress) {
    console.error('Tunnel adresi yok!')
    mgr.stop()
    setTimeout(() => process.exit(1), 12_000)
    return
  }

  const [host, portStr] = st.tunnelAddress.split(':')
  console.log(`=== TUNNEL PROBE: ${host}:${portStr} ===`)
  const r = await tcpProbe(host, Number(portStr))
  console.log(r.ok ? '=== TUNNEL UZERINDEN BAGLANTI BASARILI ===' : `=== PROBE HATASI: ${r.err} ===`)

  mgr.stop()
  const stopDeadline = Date.now() + 20_000
  while (mgr.getStatus().running && Date.now() < stopDeadline) {
    await new Promise((res) => setTimeout(res, 500))
  }
  mgr.stopTunnel()
  setTimeout(() => process.exit(r.ok ? 0 : 3), 500)
}

void main()
