// Yedekleme motoru: sunucu klasorunu tar.gz'e alir/geri yukler.
// Windows'ta PATH'teki GNU tar (Git/MSYS) surucu harfli yollari uzak makine
// sanar; Windows 10+ ile gelen System32\tar.exe (bsdtar) sorunsuzdur. O yuzden
// varsa acikca System32 ikilisi kullanilir.
const TAR_BIN =
  process.platform === 'win32' && existsSync('C:\\Windows\\System32\\tar.exe')
    ? 'C:\\Windows\\System32\\tar.exe'
    : 'tar'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'

export interface BackupInfo {
  file: string
  sizeMB: number
  createdAt: string
}

const BACKUP_RE = /^ylserver-\d{4}-\d{2}-\d{2}-\d{6}(?:-[a-z0-9-]{1,24})?\.tar\.gz$/i

const FIXED_FILES = [
  'server.properties',
  'whitelist.json',
  'ops.json',
  'banned-players.json',
  'banned-ips.json',
  'usercache.json',
  'eula.txt',
  'ylauncher-server.json',
  'bukkit.yml',
  'spigot.yml',
  'paper-global.yml',
  'paper-world-defaults.yml',
  'commands.yml',
  'permissions.yml'
]

function runTar(args: string[], timeoutMs = 10 * 60_000, cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // NOT: tar'in -C bayragi Windows'ta bazi ikililerle sorunlu (chdir); bunun
    // yerine Node'un cwd secenegi kullanilir — arsiv adi ve kaynaklar goreceli.
    execFile(TAR_BIN, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, cwd }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`tar basarisiz: ${err.message}${stderr ? ` — ${String(stderr).slice(0, 200)}` : ''}`))
      else resolve()
    })
  })
}

function safeBackupName(file: string): string {
  const base = path.basename(file)
  if (!BACKUP_RE.test(base)) throw new Error('Gecersiz yedek dosya adi.')
  return base
}

export async function listBackups(backupDir: string): Promise<BackupInfo[]> {
  if (!existsSync(backupDir)) return []
  const entries = await readdir(backupDir, { withFileTypes: true }).catch(() => [])
  const out: BackupInfo[] = []
  for (const e of entries) {
    if (!e.isFile() || !BACKUP_RE.test(e.name)) continue
    const st = await stat(path.join(backupDir, e.name)).catch(() => null)
    if (!st) continue
    out.push({ file: e.name, sizeMB: Math.round((st.size / (1024 * 1024)) * 10) / 10, createdAt: st.mtime.toISOString() })
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** Sunucu klasorunu yedekler; yeni yedegin bilgisini dondurur. */
export async function createBackup(backupDir: string, serverDir: string, label?: string): Promise<BackupInfo> {
  if (!existsSync(serverDir)) throw new Error('Sunucu klasoru yok — once sunucuyu bir kez baslatin.')
  const cleanLabel = label ? label.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24) : ''
  const now = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  const name = `ylserver-${stamp}${cleanLabel ? `-${cleanLabel}` : ''}.tar.gz`

  // Icerik kesfi: level.dat iceren klasorler (dunyalar) + config/plugins + sabit dosyalar
  const includes: string[] = []
  for (const e of await readdir(serverDir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (existsSync(path.join(serverDir, e.name, 'level.dat'))) includes.push(e.name)
      else if (e.name === 'config' || e.name === 'plugins') includes.push(e.name)
    } else if (FIXED_FILES.includes(e.name)) {
      includes.push(e.name)
    }
  }
  if (includes.length === 0) {
    throw new Error('Yedeklenecek icerik bulunamadi (dunya/ayar dosyalari yok).')
  }

  const { mkdirSync } = await import('node:fs')
  mkdirSync(backupDir, { recursive: true })
  // cwd=serverDir ile GORECELI dosya adlari arsivlenir; arsiv absolute yola
  // yazilir (bsdtar Windows native yol yazar, sorun yok).
  const dest = path.join(backupDir, name)
  await runTar(['-czf', dest, ...includes], 10 * 60_000, serverDir)

  const st = await stat(dest)
  return { file: name, sizeMB: Math.round((st.size / (1024 * 1024)) * 10) / 10, createdAt: st.mtime.toISOString() }
}

export async function deleteBackup(backupDir: string, file: string): Promise<void> {
  const base = safeBackupName(file)
  await rm(path.join(backupDir, base), { force: true })
}

/** Yedegi sunucu klasorune geri acar (mevcut dosyalarin uzerine yazar). */
export async function restoreBackup(backupDir: string, serverDir: string, file: string): Promise<string[]> {
  const base = safeBackupName(file)
  const src = path.join(backupDir, base)
  if (!existsSync(src)) throw new Error('Yedek dosyasi bulunamadi.')
  // once arsiv icerigini listele (neler geri donecek — UI'da gostermek icin)
  const listing = await new Promise<string>((resolve, reject) => {
    execFile(TAR_BIN, ['-tzf', src], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err)
      else resolve(String(stdout))
    })
  })
  await runTar(['-xzf', src], 10 * 60_000, serverDir)
  return [...new Set(listing.split(/\r?\n/).filter(Boolean).map((l) => l.split('/')[0]))].filter(Boolean)
}
