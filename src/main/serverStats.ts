// Faz 8: sunucu istatistikleri (profil basina JSON dosyasinda).
// Toplam oynanma suresi, oyuncu-dakikasi, oturum sayisi ve saatlik dagilim
// tutulur; sunucu her durdugunda/5 dakikada bir diske yazilir (cokmede en
// fazla son 5 dk kayip). join/leave event'leri server.ts'ten beslenir.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export interface ServerStats {
  version: 1
  totalPlayMs: number
  totalPlayerMs: number
  sessions: number
  firstStart: string | null
  lastStart: string | null
  /** 24 saat kovasi: saat 0-23 -> oyuncu-dakikasi (toplam) */
  hourlyPlayerMs: number[]
  peakPlayers: number
}

const EMPTY: ServerStats = {
  version: 1,
  totalPlayMs: 0,
  totalPlayerMs: 0,
  sessions: 0,
  firstStart: null,
  lastStart: null,
  hourlyPlayerMs: Array<number>(24).fill(0),
  peakPlayers: 0
}

export class StatsTracker {
  private stats: ServerStats = { ...EMPTY, hourlyPlayerMs: [...EMPTY.hourlyPlayerMs] }
  private sessionStart = 0
  private playerMsAccum = 0
  private players = new Map<string, number>()
  private lastFlush = 0

  constructor(private file: string) {}

  private load(): void {
    if (existsSync(this.file)) {
      try {
        const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<ServerStats>
        if (raw.version === 1) {
          this.stats = {
            ...EMPTY,
            ...raw,
            hourlyPlayerMs:
              Array.isArray(raw.hourlyPlayerMs) && raw.hourlyPlayerMs.length === 24
                ? raw.hourlyPlayerMs.map((n) => Number(n) || 0)
                : Array<number>(24).fill(0)
          }
        }
      } catch {
        /* bozuk dosya: sifirdan basla */
      }
    }
  }

  private flush(): void {
    mkdirSync(path.dirname(this.file), { recursive: true })
    // canli oturum verisini anlik duruma yansit
    const snap: ServerStats = {
      ...this.stats,
      totalPlayMs: this.stats.totalPlayMs + (this.sessionStart > 0 ? Date.now() - this.sessionStart : 0),
      totalPlayerMs: this.stats.totalPlayerMs + this.playerMsAccum
    }
    writeFileSync(this.file, JSON.stringify(snap, null, 2), 'utf8')
    this.lastFlush = Date.now()
  }

  sessionStart_ts(): void {
    this.load()
    this.sessionStart = Date.now()
    this.playerMsAccum = 0
    this.stats.sessions += 1
    this.stats.lastStart = new Date().toISOString()
    if (!this.stats.firstStart) this.stats.firstStart = this.stats.lastStart
    this.flush()
  }

  /** Oyuncu giris/cikis olaylari (server.ts join/leave parser'indan). */
  playerEvent(name: string, kind: 'join' | 'leave'): void {
    if (this.sessionStart === 0) return // sunucu kapali
    if (kind === 'join') {
      if (!this.players.has(name)) this.players.set(name, Date.now())
      if (this.players.size > this.stats.peakPlayers) {
        this.stats.peakPlayers = this.players.size
      }
    } else {
      const since = this.players.get(name)
      if (since !== undefined) {
        this.playerMsAccum += Math.max(0, Date.now() - since)
        this.players.delete(name)
      }
    }
  }

  /** 5 dk'da bir cagrilir: birikmis oyuncu-dakikasini saat kovalarina isler. */
  tick(): void {
    if (this.sessionStart === 0) return
    const now = Date.now()
    for (const [, since] of this.players) {
      const delta = now - since
      if (delta > 0) {
        this.playerMsAccum += delta
        const hour = new Date().getHours()
        this.stats.hourlyPlayerMs[hour] += delta
        // zaman damgalarini sifirla (toplam birikti)
        for (const key of this.players.keys()) this.players.set(key, now)
        break
      }
    }
    if (now - this.lastFlush > 60_000) this.flush()
  }

  /** Sunucu durdugunda: oturumu kapat ve diske yaz. */
  sessionEnd(): void {
    if (this.sessionStart === 0) return
    const now = Date.now()
    // acik oyuncularin suresini kapat
    for (const [, since] of this.players) {
      const delta = now - since
      if (delta > 0) {
        this.playerMsAccum += delta
        this.stats.hourlyPlayerMs[new Date().getHours()] += delta
      }
    }
    this.players.clear()
    if (this.sessionStart > 0) {
      this.stats.totalPlayMs += now - this.sessionStart
    }
    this.stats.totalPlayerMs += this.playerMsAccum
    this.playerMsAccum = 0
    this.sessionStart = 0
    this.flush()
  }

  getSnapshot(): ServerStats & { sessionActive: boolean; sessionMinutes: number } {
    return {
      ...this.stats,
      sessionActive: this.sessionStart > 0,
      sessionMinutes: this.sessionStart > 0 ? Math.round((Date.now() - this.sessionStart) / 60_000) : 0
    }
  }
}

export function statsFileFor(profilesRoot: string, profile: string): string {
  return path.join(profilesRoot, 'stats', `${profile}.json`)
}
