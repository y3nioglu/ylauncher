// Faz 8 birim testleri: profiller + istatistik takibi.
//   npx tsx scripts/smoke-phase8.ts
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  listProfiles,
  createProfile,
  setActiveProfile,
  deleteProfile,
  backupDirFor
} from '../src/main/profiles'
import { StatsTracker } from '../src/main/serverStats'

let failures = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  OK  ${name}`)
  } else {
    failures++
    console.error(`  FAIL ${name} ${detail}`)
  }
}

function throws(fn: () => unknown): boolean {
  try {
    fn()
    return false
  } catch {
    return true
  }
}

function bestEffortRm(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* kilitliyse gec */
  }
}

async function main(): Promise<void> {
  console.log('--- profiles ---')
  const root = mkdtempSync(path.join(os.tmpdir(), 'ylprof-'))
  try {
    // bos root -> otomatik default
    let list = listProfiles(root)
    check('bos root -> default olusur', list.length === 1 && list[0].name === 'default' && list[0].active)

    // legacy migration: root/server varsa default'a donusur
    const legacyRoot = mkdtempSync(path.join(os.tmpdir(), 'yllegacy-'))
    mkdirSync(path.join(legacyRoot, 'server'), { recursive: true })
    writeFileSync(
      path.join(legacyRoot, 'server', 'ylauncher-server.json'),
      JSON.stringify({ paper: { version: '1.21.11', build: 132 } })
    )
    list = listProfiles(legacyRoot)
    check(
      'legacy root/server -> default profili',
      list.some((p) => p.name === 'default' && p.paperVersion === '1.21.11'),
      JSON.stringify(list)
    )
    check('legacy klasor tasindi', !existsSync(path.join(legacyRoot, 'server')) && existsSync(path.join(legacyRoot, 'profiles', 'default')))
    bestEffortRm(legacyRoot)

    // olusturma + gecis
    list = createProfile(root, 'survival')
    check('profil olusturuldu', list.some((p) => p.name === 'survival' && !p.active))
    list = setActiveProfile(root, 'survival')
    check('profil gecisi', list.find((p) => p.name === 'survival')?.active === true && !list.find((p) => p.name === 'default')?.active)
    check('backupDirFor yeni profil', backupDirFor(root, 'survival') === path.join(root, 'backups', 'survival'))
    check('backupDirFor default legacy', backupDirFor(root, 'default') === path.join(root, 'backups'))

    // gecersiz isimler
    check('gecersiz profil adi reddedilir', throws(() => createProfile(root, '../evil')))
    check('cift profil reddedilir', throws(() => createProfile(root, 'survival')))

    // silme: aktif profil silinirse digerine gecer
    list = await deleteProfile(root, 'survival')
    check('profil silindi + default aktif', !list.some((p) => p.name === 'survival') && list.find((p) => p.name === 'default')?.active === true)
    check('silinen klasor yok', !existsSync(path.join(root, 'profiles', 'survival')))

    // son profili silme engellenir (async reject)
    let rejected = false
    try {
      await deleteProfile(root, 'default')
    } catch {
      rejected = true
    }
    check('tek profil silinemez', rejected && existsSync(path.join(root, 'profiles', 'default')))
  } finally {
    bestEffortRm(root)
  }

  console.log('--- serverStats ---')
  const statsRoot = mkdtempSync(path.join(os.tmpdir(), 'ylstats-'))
  try {
    const file = path.join(statsRoot, 'stats', 'p1.json')
    const t = new StatsTracker(file)
    t.sessionStart_ts()
    t.playerEvent('alice', 'join')
    t.playerEvent('bob', 'join')
    t.playerEvent('bob', 'leave')
    // tick + sessionEnd sureleri biriktirir
    await new Promise((r) => setTimeout(r, 30))
    t.tick()
    await new Promise((r) => setTimeout(r, 30))
    t.sessionEnd()

    const snap = t.getSnapshot()
    check('oturum sayisi 1', snap.sessions === 1, JSON.stringify(snap))
    check('toplam sure > 0', snap.totalPlayMs > 0)
    check('oyuncu suresi > 0', snap.totalPlayerMs > 0)
    check('saat kovasina yazildi', snap.hourlyPlayerMs[new Date().getHours()] > 0, JSON.stringify(snap.hourlyPlayerMs))
    check('zirve oyuncu 2', snap.peakPlayers === 2)
    check('oturum kapali', snap.sessionActive === false)

    // yeniden yukleme: diskten devam
    const t2 = new StatsTracker(file)
    t2.sessionStart_ts()
    t2.sessionEnd()
    const snap2 = t2.getSnapshot()
    check('ikinci oturum sayildi', snap2.sessions === 2, JSON.stringify(snap2))
    check('sure kumulatif', snap2.totalPlayMs >= snap.totalPlayMs)
    check('firstStart korundu', !!snap2.firstStart && snap2.firstStart === snap.firstStart)
  } finally {
    bestEffortRm(statsRoot)
  }

  console.log(failures === 0 ? '=== PHASE 8 TESTLERI BASARILI ===' : `=== ${failures} HATA ===`)
  process.exit(failures === 0 ? 0 : 1)
}

void main().catch((e) => {
  console.error('TEST HATASI:', e)
  process.exit(1)
})
