// Java runtime yonetimi (game.ts ve server.ts ortak)
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, createWriteStream } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import extract from 'extract-zip'

export function detectSystemJava(): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false
    const finish = (v: string | null) => {
      if (!done) {
        done = true
        resolve(v)
      }
    }
    try {
      execFile('java', ['-version'], (err, _stdout, stderr) => {
        if (err) {
          finish(null)
          return
        }
        const m = stderr.match(/version "(\d+)/)
        finish(m ? m[1] : 'unknown')
      })
      setTimeout(() => finish(null), 5000).unref()
    } catch {
      finish(null)
    }
  })
}

export async function findJavaExecutable(dir: string): Promise<string | null> {
  if (!existsSync(dir)) return null
  const exe = process.platform === 'win32' ? 'java.exe' : 'java'
  const queue: { p: string; d: number }[] = [{ p: dir, d: 0 }]
  while (queue.length) {
    const { p, d } = queue.shift()!
    const entries = await readdir(p, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      const full = path.join(p, e.name)
      if (e.isDirectory()) {
        if (e.name === 'bin') {
          const candidate = path.join(full, exe)
          if (existsSync(candidate)) return candidate
        } else if (d < 4) {
          queue.push({ p: full, d: d + 1 })
        }
      }
    }
  }
  return null
}

export interface EnsureJavaCallbacks {
  javaPathOverride?: string
  onStatus?: (message: string) => void
  onProgress?: (percent: number, label: string) => void
}

// Uygun Java'yi garantile: override -> sistem -> onceden indirilen -> Adoptium indirmesi
export async function ensureJava(major: number, javaRoot: string, cb: EnsureJavaCallbacks = {}): Promise<string> {
  const { javaPathOverride, onStatus, onProgress } = cb

  if (javaPathOverride && existsSync(javaPathOverride)) return javaPathOverride

  const systemMajor = await detectSystemJava()
  if (systemMajor && systemMajor !== 'unknown' && parseInt(systemMajor, 10) >= major) {
    onStatus?.(`Sistem Java ${systemMajor} kullanilacak`)
    return 'java'
  }

  const javaDir = path.join(javaRoot, String(major))
  const existing = await findJavaExecutable(javaDir)
  if (existing) return existing

  onStatus?.(`Java ${major} bulunamadi, otomatik indirilecek...`)

  const os = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux'
  const ext = os === 'windows' ? 'zip' : 'tar.gz'
  const api = `https://api.adoptium.net/v3/assets/latest/${major}/hotspot?architecture=x64&image_type=jre&os=${os}&vendor=eclipse`

  onStatus?.(`Adoptium listesi aliniyor (Java ${major})...`)
  const res = await fetch(api)
  if (!res.ok) throw new Error(`Adoptium API hatasi (HTTP ${res.status})`)
  const assets = (await res.json()) as {
    binary: { package: { name: string; link: string; size?: number } }
  }[]
  const pkg = assets[0]?.binary?.package
  if (!pkg || !pkg.name.endsWith(ext)) {
    throw new Error(`Java ${major} icin uygun paket bulunamadi (${os}). Sistem Java kurun.`)
  }

  const archivePath = path.join(javaRoot, `jre-${major}.${ext}`)
  mkdirSync(javaRoot, { recursive: true })

  onStatus?.(`Java ${major} indiriliyor (${Math.round((pkg.size ?? 0) / 1e6)} MB)...`)
  const dl = await fetch(pkg.link)
  if (!dl.ok || !dl.body) throw new Error(`Java indirmesi basarisiz (HTTP ${dl.status})`)
  const total = Number(dl.headers.get('content-length') ?? pkg.size ?? 0)
  let received = 0
  let lastPercent = -1
  const nodeStream = Readable.fromWeb(dl.body as never)
  nodeStream.on('data', (chunk: Buffer) => {
    received += chunk.length
    if (total > 0) {
      const percent = Math.floor((received / total) * 100)
      if (percent !== lastPercent) {
        lastPercent = percent
        onProgress?.(percent, `Java ${major}`)
      }
    }
  })
  await pipeline(nodeStream, createWriteStream(archivePath))

  onStatus?.('Java cikariliyor...')
  if (ext === 'zip') {
    await extract(archivePath, { dir: javaDir })
  } else {
    throw new Error('Linux/macOS tar paketleri su surumde otomatik kurulmuyor; sistem Java kurun.')
  }
  await rm(archivePath, { force: true })

  const javaPath = await findJavaExecutable(javaDir)
  if (!javaPath) throw new Error('Java kuruldu ancak calistirilabilir bulunamadi.')
  onStatus?.(`Java ${major} hazir`)
  return javaPath
}
