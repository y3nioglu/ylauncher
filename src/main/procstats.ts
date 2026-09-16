// Sunucu (java) sureci icin RAM/CPÙ olcumu.
// Windows: tasklist (RAM) + PowerShell TotalProcessorTime (CPU delta).
// Linux:   /proc/<pid>/status (RSS) + /proc/<pid>/stat (utime+stime).
// Basarisizlik null doner — olcum asla sunucuyu etkilemez.
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import os from 'node:os'

export interface ProcStats {
  ramMB: number | null
  cpuPercent: number | null
}

function run(cmd: string, args: string[], timeoutMs = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err)
      else resolve(String(stdout))
    })
  })
}

let lastCpu: { at: number; cpuMs: number } | null = null

async function windowsStats(pid: number, cores: number): Promise<ProcStats> {
  const [tasklistOut, psOut] = await Promise.allSettled([
    run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']),
    run('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).TotalProcessorTime.TotalMilliseconds`])
  ])

  let ramMB: number | null = null
  if (tasklistOut.status === 'fulfilled') {
    // "java.exe","1234","Console","1","1.234.567 K"  (binlik ayirici yerel degisir)
    const m = /"([^"]*K)"\s*$/.exec(tasklistOut.value.trim())
    if (m) {
      const kb = Number(m[1].replace(/[^0-9]/g, ''))
      if (Number.isFinite(kb) && kb > 0) ramMB = Math.round(kb / 1024)
    }
  }

  let cpuPercent: number | null = null
  if (psOut.status === 'fulfilled') {
    const cpuMs = Number(psOut.value.trim())
    if (Number.isFinite(cpuMs) && cpuMs > 0) {
      const now = Date.now()
      if (lastCpu) {
        const wallMs = Math.max(1, now - lastCpu.at)
        const delta = Math.max(0, cpuMs - lastCpu.cpuMs)
        cpuPercent = Math.min(cores * 100, (delta / (wallMs * cores)) * 100)
      }
      lastCpu = { at: now, cpuMs }
    }
  }
  return { ramMB, cpuPercent }
}

async function linuxStats(pid: number, cores: number): Promise<ProcStats> {
  let ramMB: number | null = null
  let cpuMs = 0
  try {
    const status = await readFile(`/proc/${pid}/status`, 'utf8')
    const m = /^VmRSS:\s+(\d+)\s+kB/m.exec(status)
    if (m) ramMB = Math.round(Number(m[1]) / 1024)
  } catch {
    /* sureci yok */
  }
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    // comm alanindan sonrasi: fields[0]=state; utime=fields[11], stime=fields[12]
    const parts = stat.substring(stat.indexOf(')') + 2).split(' ')
    const ticks = Number(parts[11]) + Number(parts[12])
    if (Number.isFinite(ticks)) cpuMs = ticks * 10 // CLK_TCK=100 varsayimi
  } catch {
    /* sureci yok */
  }

  let cpuPercent: number | null = null
  if (cpuMs > 0) {
    const now = Date.now()
    if (lastCpu) {
      const wallMs = Math.max(1, now - lastCpu.at)
      const delta = Math.max(0, cpuMs - lastCpu.cpuMs)
      cpuPercent = Math.min(cores * 100, (delta / (wallMs * cores)) * 100)
    }
    lastCpu = { at: now, cpuMs }
  }
  return { ramMB, cpuPercent }
}

/** Surecin anlik RAM (MB) ve CPU (%) kullanimi. Sureci yoksa null'lar doner. */
export async function getProcStats(pid: number, cores = os.cpus().length): Promise<ProcStats> {
  try {
    if (process.platform === 'win32') return await windowsStats(pid, cores)
    if (process.platform === 'linux') return await linuxStats(pid, cores)
    return { ramMB: null, cpuPercent: null }
  } catch {
    return { ramMB: null, cpuPercent: null }
  }
}
