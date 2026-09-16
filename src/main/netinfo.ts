// Ag yardimcilari: public IP tespiti + Windows guvenlik duvari kurali
// (VPS'te makinenin gercek public IP'si varsa turelsiz dogrudan baglanti
// mumkun; NAT arkasindaki ev makinelerinde bu dusuk ihtimalli).
import { execFile } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import { networkInterfaces } from 'node:os'

export async function fetchPublicIp(): Promise<string> {
  const controller = new AbortController()
  const to = setTimeout(() => controller.abort(), 5000)
  try {
    const r = await fetch('https://api.ipify.org', { signal: controller.signal })
    if (!r.ok) throw new Error(`ipify ${r.status}`)
    const ip = (await r.text()).trim()
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) throw new Error('gecersiz IP formati')
    return ip
  } finally {
    clearTimeout(to)
  }
}

// Makinenin kendi arayuzlerinde bu IP var mi? (VPS'te true, NAT arkasinda false)
export function hasLocalInterfaceIp(ip: string): boolean {
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.address === ip) return true
    }
  }
  return false
}

// Yerel agdaki diger makinelere benzeyen IP'ler (RFC1918, link-local, loopback)
export function isPrivateIp(ip: string): boolean {
  if (ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('127.')) return true
  const m = /^172\.(\d+)\./.exec(ip)
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true
  if (ip.startsWith('169.254.')) return true
  return false
}

// Windows guvenlik duvarinda 25565 (TCP) gelen trafik icin kural var mi/ekle.
// Hata atarsa cagiran taraf status mesajiyla gosterir (kural olmadan da
// oyuncular dis IP'ye erisemeyebilir ama kullanici bilgilendirilmis olur).
export async function ensureFirewallRule(port: number): Promise<void> {
  if (process.platform !== 'win32') return
  const name = 'MC Friends Launcher (TCP bu yondan)'
  const exists = await new Promise<boolean>((resolve) => {
    execFile('netsh', ['advfirewall', 'firewall', 'show', 'rule', `name=${name}`], (err) =>
      resolve(!err)
    )
  })
  if (exists) return
  await new Promise<void>((resolve, reject) => {
    execFile(
      'netsh',
      [
        'advfirewall',
        'firewall',
        'add',
        'rule',
        `name=${name}`,
        'dir=in',
        'action=allow',
        'protocol=TCP',
        `localport=${port}`
      ],
      (err, _stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message))
        else resolve()
      }
    )
  })
}

// DNS ile hostname cozumleme (ileride dinamik DNS destegi icin hazir)
export async function resolveHost(host: string): Promise<string> {
  const r = await lookup(host)
  return r.address
}
