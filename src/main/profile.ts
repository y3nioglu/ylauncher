// Faz 15: profil karti — kullanicinin oyunculuk istatistikleri.
// Iki veri kaynagini birlestirir:
//  1) playtime.json (GAME_ROOT): istemci tarafindaki oyun oturumlari
//     (recordPlayStart/End game.ts'ten beslenir)
//  2) profiles/stats/*.json: sunucu oturum istatistikleri (StatsTracker)
// Kart verisi: toplam sure, oturum sayisi, ilk/son giris, son sunucu.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

export interface ProfileCardData {
  nickname: string
  /** Toplam oynama suresi (saat, 1 ondalik) — istemci + sunucu oturumlari */
  totalHours: number
  /** Toplam oturum sayisi */
  sessions: number
  /** Ilk oturum tarihi (ISO) */
  firstPlayed: string | null
  /** Son oturum tarihi (ISO) */
  lastPlayed: string | null
  /** Sunucu tarafindan kaydedilen toplam oyuncu-dakikasi (arkadaslarla) */
  multiplayerMinutes: number
  /** En yuksek es zamanli oyuncu sayisi (sunucu) */
  peakPlayers: number
}

interface PlaytimeFile {
  sessions?: Array<{ start: string; end?: string; server?: string }>
  totalMs?: number
  lastServer?: string | null
}

interface ServerStatsFile {
  totalPlayMs?: number
  totalPlayerMs?: number
  sessions?: number
  firstStart?: string | null
  lastStart?: string | null
  peakPlayers?: number
}

function sumPlaytime(root: string): { ms: number; sessions: number; first: string | null; last: string | null; lastServer: string | null } {
  let ms = 0
  let sessions = 0
  let first: string | null = null
  let last: string | null = null
  let lastServer: string | null = null
  const file = path.join(root, 'playtime.json')
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as PlaytimeFile
      ms = raw.totalMs ?? 0
      sessions = raw.sessions?.length ?? 0
      first = raw.sessions?.[0]?.start ?? null
      last = raw.sessions?.at(-1)?.end ?? raw.sessions?.at(-1)?.start ?? null
      lastServer = raw.lastServer ?? null
    } catch {
      /* bozuk dosya: sifirla */
    }
  }
  return { ms, sessions, first, last, lastServer }
}

function sumServerStats(root: string): {
  ms: number
  playerMs: number
  sessions: number
  first: string | null
  last: string | null
  peak: number
} {
  let ms = 0
  let playerMs = 0
  let sessions = 0
  let first: string | null = null
  let last: string | null = null
  let peak = 0
  const statsDir = path.join(root, 'profiles', 'stats')
  if (existsSync(statsDir)) {
    try {
      for (const f of readdirSync(statsDir)) {
        if (!f.endsWith('.json')) continue
        try {
          const raw = JSON.parse(readFileSync(path.join(statsDir, f), 'utf8')) as ServerStatsFile
          ms += raw.totalPlayMs ?? 0
          playerMs += raw.totalPlayerMs ?? 0
          sessions += raw.sessions ?? 0
          if (raw.firstStart && (!first || raw.firstStart < first)) first = raw.firstStart
          if (raw.lastStart && (!last || raw.lastStart > last)) last = raw.lastStart
          peak = Math.max(peak, raw.peakPlayers ?? 0)
        } catch {
          /* tek dosya bozuksa digerlerine devam */
        }
      }
    } catch {
      /* dizin okunamadi */
    }
  }
  return { ms, playerMs, sessions, first, last, peak }
}

export function buildProfileCard(root: string, nickname: string): ProfileCardData {
  const pt = sumPlaytime(root)
  const ss = sumServerStats(root)
  const totalMs = pt.ms + ss.ms
  return {
    nickname,
    totalHours: Math.round((totalMs / 3_600_000) * 10) / 10,
    sessions: pt.sessions + ss.sessions,
    firstPlayed: [pt.first, ss.first].filter(Boolean).sort()?.[0] ?? null,
    lastPlayed: [pt.last, ss.last].filter(Boolean).sort()?.at(-1) ?? null,
    multiplayerMinutes: Math.round(ss.playerMs / 60_000),
    peakPlayers: ss.peak
  }
}
