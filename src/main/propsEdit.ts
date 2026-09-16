// server.properties icin SAF parse + dogrulama (GUI editorun arkasi).
// Yalnizca BEYAZ LISTEdki anahtarlar duzenlenebilir — bozuk deger sunucuyu
// acilmaz yapmasin diye her anahtar icin form ve aralik kontrolu yapilir.

export const ALLOWED_PROP_KEYS = [
  'server-port',
  'motd',
  'gamemode',
  'difficulty',
  'force-gamemode',
  'max-players',
  'view-distance',
  'simulation-distance',
  'spawn-protection',
  'pvp',
  'allow-nether',
  'allow-flight',
  'hardcore',
  'level-name',
  'max-world-size',
  'player-idle-timeout',
  'enforce-secure-profile',
  'require-resource-pack'
] as const

export type AllowedPropKey = (typeof ALLOWED_PROP_KEYS)[number]

/** Dosyada olmayan anahtarlar icin editorde gosterilecek varsayilanlar —
 * boylece host, dosyada hic yazilmamis ayarlari (orn. force-gamemode) da gorebilir. */
export const PROP_DEFAULTS: Record<AllowedPropKey, string> = {
  'server-port': '25565',
  motd: 'A Minecraft Server',
  gamemode: 'survival',
  difficulty: 'easy',
  'force-gamemode': 'false',
  'max-players': '20',
  'view-distance': '10',
  'simulation-distance': '10',
  'spawn-protection': '16',
  pvp: 'true',
  'allow-nether': 'true',
  'allow-flight': 'false',
  hardcore: 'false',
  'level-name': 'world',
  'max-world-size': '29999984',
  'player-idle-timeout': '0',
  'enforce-secure-profile': 'true',
  'require-resource-pack': 'false'
}

/** Dosya icerigini { anahtar: deger } haritasina cevirir (yorumlar atilir). */
export function parseProperties(content: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    out[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return out
}

export class PropError extends Error {}

function num(key: string, value: string, min: number, max: number): string {
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new PropError(`${key}: ${min}-${max} arasi bir sayi olmali (aldigi: "${value}")`)
  }
  return String(n)
}

function bool(value: string): string {
  if (value === 'true' || value === 'false') return value
  throw new PropError(`Bu anahtar yalnizca true/false olabilir (aldigi: "${value}")`)
}

/**
 * Degeri anahtara gore dogrular/normalize eder. Gecersizse PropError firlatir.
 * Bilinmeyen anahtar reddedilir (beyaz liste disi).
 */
export function normalizeProp(key: string, rawValue: string): string {
  if (!(ALLOWED_PROP_KEYS as readonly string[]).includes(key)) {
    throw new PropError(`Bu anahtar editor ile duzenlenemez: ${key}`)
  }
  // TS: anahtar beyaz listede; asagidaki switch tum olasi anahtarleri kusar.
  const _exhaustive: AllowedPropKey = key as AllowedPropKey
  void _exhaustive
  const value = String(rawValue).trim().replace(/[\r\n\0]/g, '')
  switch (key) {
    case 'server-port':
      return num(key, value, 1024, 65535)
    case 'max-players':
      return num(key, value, 1, 200)
    case 'view-distance':
      return num(key, value, 2, 32)
    case 'simulation-distance':
      return num(key, value, 2, 32)
    case 'max-world-size':
      return num(key, value, 1, 29999984)
    case 'player-idle-timeout':
      return num(key, value, 0, 1440)
    case 'spawn-protection':
      return num(key, value, 0, 256)
    case 'gamemode': {
      if (!['survival', 'creative', 'adventure', 'spectator'].includes(value)) {
        throw new PropError(`gamemode: survival|creative|adventure|spectator olmali (aldigi: "${value}")`)
      }
      return value
    }
    case 'difficulty': {
      if (!['peaceful', 'easy', 'normal', 'hard'].includes(value)) {
        throw new PropError(`difficulty: peaceful|easy|normal|hard olmali (aldigi: "${value}")`)
      }
      return value
    }
    case 'pvp':
    case 'allow-nether':
    case 'allow-flight':
    case 'hardcore':
    case 'force-gamemode':
    case 'enforce-secure-profile':
    case 'require-resource-pack':
      return bool(value)
    case 'motd': {
      if (value.length === 0 || value.length > 100) {
        throw new PropError('motd: 1-100 karakter olmali')
      }
      return value
    }
    case 'level-name': {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
        throw new PropError('level-name: harf/rakam/altcizgi/tire, max 64 karakter olmali')
      }
      return value
    }
  }
  // Ulasilamaz: yukaridaki switch tum beyaz liste anahtarlarini kusar.
  throw new PropError(`Desteklenmeyen anahtar: ${key}`)
}
