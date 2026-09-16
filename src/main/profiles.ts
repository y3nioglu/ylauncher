// Faz 8: coklu sunucu profilleri. Her profil kendi world/ayar/plugin setine
// sahiptir (root/profiles/<ad>/). Eski tek-klasor kurulumu (root/server)
// bozulmadan "default" profili olarak kullanilmaya devam eder; root/backups
// da default icin eski konumunda kalir. Yeni profiller kendi klasorlerini alir.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'

export interface ProfileInfo {
  name: string
  /** server.properties'te kayitli Paper surumu (varsa) */
  paperVersion: string | null
  /** aktif profil mi (son kullanilan) */
  active: boolean
}

const PROFILE_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/

export class ProfileError extends Error {}

function readActiveName(root: string): string {
  try {
    const raw = JSON.parse(readFileSync(path.join(root, 'profiles.json'), 'utf8')) as {
      active?: string
    }
    return raw.active ?? 'default'
  } catch {
    return 'default'
  }
}

function writeActiveName(root: string, name: string): void {
  writeFileSync(path.join(root, 'profiles.json'), JSON.stringify({ active: name }, null, 2), 'utf8')
}

function paperVersionOf(profileDir: string): string | null {
  try {
    const cfg = JSON.parse(readFileSync(path.join(profileDir, 'ylauncher-server.json'), 'utf8')) as {
      paper?: { version?: string }
    }
    return cfg.paper?.version ?? null
  } catch {
    return null
  }
}

/**
 * Profilleri listeler. Ilk cagride eski kurulum varsa (root/server) hicbir
 * dosya tasinarak "default" profili olarak kaydedilir (legacy uyumluluk).
 */
export function listProfiles(root: string): ProfileInfo[] {
  mkdirSync(root, { recursive: true })
  const legacyDir = path.join(root, 'server')
  const profilesDir = path.join(root, 'profiles')

  if (existsSync(legacyDir) && !existsSync(path.join(profilesDir, 'default'))) {
    mkdirSync(profilesDir, { recursive: true })
    try {
      renameSync(legacyDir, path.join(profilesDir, 'default'))
    } catch {
      // rename basarisiz (dosya kilitli) -> legacy yerinde kaldi, default yine de goster
    }
  }

  const active = readActiveName(root)
  const out: ProfileInfo[] = []
  if (!existsSync(profilesDir)) mkdirSync(profilesDir, { recursive: true })
  for (const e of readdirSync(profilesDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    if (!PROFILE_NAME_RE.test(e.name)) continue
    out.push({
      name: e.name,
      paperVersion: paperVersionOf(path.join(profilesDir, e.name)),
      active: e.name === active
    })
  }
  // legacy rename edilemediyse yine de listele
  if (existsSync(legacyDir) && !out.some((p) => p.name === 'default')) {
    out.push({ name: 'default', paperVersion: paperVersionOf(legacyDir), active: active === 'default' })
  }
  if (out.length === 0) {
    // hic profil yoksa default'u olustur (bos)
    mkdirSync(path.join(profilesDir, 'default'), { recursive: true })
    out.push({ name: 'default', paperVersion: null, active: true })
  }
  // aktif en ustte, sonra isim sirasi
  return out.sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name))
}

export function profileDir(root: string, name: string): string {
  if (!PROFILE_NAME_RE.test(name)) throw new ProfileError('Gecersiz profil adi.')
  const dir = path.join(root, 'profiles', name)
  if (!existsSync(dir)) throw new ProfileError(`Profil "${name}" bulunamadi.`)
  return dir
}

export function getActiveProfile(root: string): string {
  return readActiveName(root)
}

export function setActiveProfile(root: string, name: string): ProfileInfo[] {
  const dir = profileDir(root, name) // varlik kontrolu
  mkdirSync(dir, { recursive: true })
  writeActiveName(root, name)
  return listProfiles(root)
}

export function createProfile(root: string, requested: string): ProfileInfo[] {
  const name = requested.trim()
  if (!PROFILE_NAME_RE.test(name)) {
    throw new ProfileError('Profil adi: harf/rakam/altcizgi/tire, max 32 karakter.')
  }
  if (name === 'default' && existsSync(path.join(root, 'profiles', 'default'))) {
    throw new ProfileError('"default" profili zaten var.')
  }
  const dir = path.join(root, 'profiles', name)
  if (existsSync(dir)) throw new ProfileError(`"${name}" profili zaten var.`)
  mkdirSync(dir, { recursive: true })
  return listProfiles(root)
}

export async function deleteProfile(root: string, name: string): Promise<ProfileInfo[]> {
  const dir = profileDir(root, name)
  const active = readActiveName(root)
  if (name === active) {
    const others = listProfiles(root).filter((p) => p.name !== name)
    if (others.length === 0) throw new ProfileError('Tek profil silinemez — en az bir profil gerekli.')
    writeActiveName(root, others[0].name)
  }
  await rm(dir, { recursive: true, force: true })
  return listProfiles(root)
}

/** Profilin yedek klasoru (default = legacy konum). */
export function backupDirFor(root: string, profile: string): string {
  return profile === 'default' ? path.join(root, 'backups') : path.join(root, 'backups', profile)
}
