// Paper log satirlarindan izleme verisi cozen SAF fonksiyonlar (test edilebilir).
// Ornek satirlar:
//   [14:20:30 INFO]: TPS from last 1m, 5m, 15m: 19.98, 20.0, 20.0
//   [14:20:33 INFO]: There are 2 of a max of 20 players online: trevir, berat
//   [14:21:00 INFO]: trevir joined the game
//   [14:25:10 INFO]: trevir left the game

export interface TpsSample {
  tps1: number
  tps5: number
  tps15: number
}

export function parseTps(line: string): TpsSample | null {
  const m = /TPS from last 1m, 5m, 15m:\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(line)
  if (!m) return null
  const tps1 = Number(m[1])
  const tps5 = Number(m[2])
  const tps15 = Number(m[3])
  if (![tps1, tps5, tps15].every(Number.isFinite)) return null
  return { tps1, tps5, tps15 }
}

export interface ListSample {
  online: number
  max: number
  names: string[]
}

export function parsePlayerList(line: string): ListSample | null {
  const m = /There are (\d+) of a max of (\d+) players online:?(.*)/.exec(line)
  if (!m) return null
  const online = Number(m[1])
  const max = Number(m[2])
  if (!Number.isFinite(online) || !Number.isFinite(max)) return null
  const names = m[3]
    .trim()
    ? m[3]
        .trim()
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : []
  return { online, max, names }
}

export interface JoinLeave {
  name: string
  kind: 'join' | 'leave'
}

export function parseJoinLeave(line: string): JoinLeave | null {
  const join = /^(\S+) joined the game$/.exec(line.trim())
  if (join) return { name: join[1], kind: 'join' }
  const leave = /^(\S+) left the game$/.exec(line.trim())
  if (leave) return { name: leave[1], kind: 'leave' }
  return null
}
