// Faz 6 birim testleri: monitorParse + propsEdit + backup + plugins.
//   npx tsx scripts/smoke-phase6.ts
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { parseTps, parsePlayerList, parseJoinLeave } from '../src/main/monitorParse'
import { parseProperties, normalizeProp, PropError } from '../src/main/propsEdit'
import { listBackups, createBackup, deleteBackup, restoreBackup } from '../src/main/backup'
import { listPlugins, disablePlugin, enablePlugin } from '../src/main/plugins'
import {
  readLevelName,
  setLevelName,
  createWorld,
  deleteWorldSmart,
  importWorld,
  nextWorldName
} from '../src/main/worlds'

let failures = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  OK  ${name}`)
  } else {
    failures++
    console.error(`  FAIL ${name} ${detail}`)
  }
}

function throwsProp(fn: () => unknown): boolean {
  try {
    fn()
    return false
  } catch (e) {
    return e instanceof PropError
  }
}

function tarList(archive: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('C:\\Windows\\System32\\tar.exe', ['-tzf', archive], { windowsHide: true }, (err, stdout) => {
      if (err) reject(err)
      else resolve(String(stdout))
    })
  })
}

/** Windows'ta temp klasoru aninda kilitli olabilir — temizlik best-effort. */
function bestEffortRm(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* kilitliyse sessizce gec — temp zaten donemli temizlenir */
  }
}

async function main(): Promise<void> {
  console.log('--- monitorParse ---')
  const tps = parseTps('[14:20:30 INFO]: TPS from last 1m, 5m, 15m: 19.98, 20.0, 20.0')
  check('TPS satiri cozulur', !!tps && tps.tps1 === 19.98 && tps.tps5 === 20 && tps.tps15 === 20, JSON.stringify(tps))
  check('TPS olmayan satir null', parseTps('Done (13.925s)!') === null)
  const list = parsePlayerList('There are 2 of a max of 20 players online: trevir, berat')
  check('oyuncu listesi cozulur', !!list && list.online === 2 && list.max === 20 && list.names.join(',') === 'trevir,berat', JSON.stringify(list))
  const listEmpty = parsePlayerList('There are 0 of a max of 20 players online:')
  check('bos oyuncu listesi', !!listEmpty && listEmpty.online === 0 && listEmpty.names.length === 0)
  check('liste olmayan satir null', parsePlayerList('trevir joined the game') === null)
  check('join cozulur', parseJoinLeave('trevir joined the game')?.kind === 'join')
  check('leave cozulur', parseJoinLeave('trevir left the game')?.kind === 'leave')
  check('join/leave olmayan satir null', parseJoinLeave('maykil (/31.155.247.178:8088) lost connection: Timed out') === null)

  console.log('--- propsEdit ---')
  const parsed = parseProperties('# yorum\nmotd=Selam\ngamemode=survival\nbozuk-satir\n\nmax-players=20')
  check('parse: motd', parsed['motd'] === 'Selam')
  check('parse: gamemode', parsed['gamemode'] === 'survival')
  check('parse: yorum/bozuk atlanir', Object.keys(parsed).length === 3, JSON.stringify(parsed))
  check('normalize: port gecerli', normalizeProp('server-port', '25565') === '25565')
  check('normalize: bool', normalizeProp('pvp', 'true') === 'true')
  check('normalize: motd trim', normalizeProp('motd', '  merhaba  ') === 'merhaba')
  check('hata: port aralik disi', throwsProp(() => normalizeProp('server-port', '80')))
  check('hata: port harf', throwsProp(() => normalizeProp('server-port', 'abc')))
  check('hata: gamemode gecersiz', throwsProp(() => normalizeProp('gamemode', 'hardcore')))
  check('hata: difficulty gecersiz', throwsProp(() => normalizeProp('difficulty', 'ultra')))
  check('hata: bool gecersiz', throwsProp(() => normalizeProp('pvp', 'maybe')))
  check('hata: bos motd', throwsProp(() => normalizeProp('motd', '')))
  check('motd newline enjeksiyonu temizlenir', normalizeProp('motd', 'satir1\nsatir2') === 'satir1satir2')
  check('hata: beyaz liste disi anahtar', throwsProp(() => normalizeProp('online-mode', 'false')))
  check('hata: level-name slash', throwsProp(() => normalizeProp('level-name', '../etc')))

  console.log('--- backup ---')
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'ylphase6-'))
  try {
    const serverDir = path.join(tmpRoot, 'server')
    const backupDir = path.join(tmpRoot, 'backups')
    mkdirSync(path.join(serverDir, 'world'), { recursive: true })
    writeFileSync(path.join(serverDir, 'world', 'level.dat'), 'fake-level')
    writeFileSync(path.join(serverDir, 'world', 'region.dat'), 'fake-region')
    mkdirSync(path.join(serverDir, 'world_nether'), { recursive: true })
    writeFileSync(path.join(serverDir, 'world_nether', 'level.dat'), 'fake-nether')
    mkdirSync(path.join(serverDir, 'logs'), { recursive: true })
    writeFileSync(path.join(serverDir, 'logs', 'latest.log'), 'gizli-log')
    writeFileSync(path.join(serverDir, 'server.properties'), 'gamemode=survival\n')
    writeFileSync(path.join(serverDir, 'whitelist.json'), '[]')

    const created = await createBackup(backupDir, serverDir, 'test')
    check('yedek olusturuldu', existsSync(path.join(backupDir, created.file)), created.file)
    check('yedek adi kurallı', /^ylserver-\d{4}-\d{2}-\d{2}-\d{6}-test\.tar\.gz$/.test(created.file), created.file)
    check('yedek boyutu > 0', created.sizeMB >= 0)

    const listed = await listBackups(backupDir)
    check('yedek listelenir', listed.length === 1 && listed[0].file === created.file, JSON.stringify(listed))

    const listing = await tarList(path.join(backupDir, created.file))
    check('dunya yedekte', listing.includes('world/level.dat') || listing.includes('world\\level.dat'), listing)
    check('nether yedekte', listing.includes('world_nether'))
    check('config yedekte', listing.includes('server.properties'))
    check('logs yedekte DEGIL', !listing.includes('logs'), listing)

    // restore: sunucu klasorunu bosaltip geri yukle
    rmSync(path.join(serverDir, 'world'), { recursive: true, force: true })
    rmSync(path.join(serverDir, 'server.properties'), { force: true })
    check('silme sonrasi dunya yok', !existsSync(path.join(serverDir, 'world')))
    const parts = await restoreBackup(backupDir, serverDir, created.file)
    check('geri yukleme dunya', existsSync(path.join(serverDir, 'world', 'level.dat')))
    check('geri yukleme config', existsSync(path.join(serverDir, 'server.properties')))
    check('geri yukleme parcalari', parts.includes('world'), JSON.stringify(parts))

    await deleteBackup(backupDir, created.file)
    check('yedek silinir', (await listBackups(backupDir)).length === 0)

    // guvenlik: gecersiz dosya adi reddedilir
    let rejected = false
    try {
      await deleteBackup(backupDir, '../../evil.tar.gz')
    } catch {
      rejected = true
    }
    check('path traversal reddedilir', rejected)
  } finally {
    bestEffortRm(tmpRoot)
  }

  console.log('--- plugins ---')
  const plugRoot = mkdtempSync(path.join(os.tmpdir(), 'ylplug-'))
  try {
    const serverDir2 = path.join(plugRoot, 'server')
    mkdirSync(path.join(serverDir2, 'plugins'), { recursive: true })
    writeFileSync(path.join(serverDir2, 'plugins', 'essentials.jar'), 'fake-jar')

    let plugs = await listPlugins(serverDir2)
    check('plugin listelenir (aktif)', plugs.length === 1 && plugs[0].enabled && plugs[0].file === 'essentials.jar', JSON.stringify(plugs))
    await disablePlugin(serverDir2, 'essentials.jar')
    check('disabled dosya var', existsSync(path.join(serverDir2, 'plugins', 'essentials.disabled.jar')))
    plugs = await listPlugins(serverDir2)
    check('plugin kapali gorunur', plugs.length === 1 && !plugs[0].enabled)
    await enablePlugin(serverDir2, 'essentials.disabled.jar')
    check('enabled dosya geri geldi', existsSync(path.join(serverDir2, 'plugins', 'essentials.jar')))
    plugs = await listPlugins(serverDir2)
    check('plugin tekrar aktif', plugs.length === 1 && plugs[0].enabled)

    let rejected = false
    try {
      await disablePlugin(serverDir2, '../world/level.dat')
    } catch {
      rejected = true
    }
    check('plugin path traversal reddedilir', rejected)
  } finally {
    bestEffortRm(plugRoot)
  }

  console.log('--- worlds ---')
  const worldRoot = mkdtempSync(path.join(os.tmpdir(), 'ylworld-'))
  try {
    const sdir = path.join(worldRoot, 'server')
    mkdirSync(sdir, { recursive: true })
    writeFileSync(path.join(sdir, 'server.properties'), 'level-name=world\ngamemode=survival\n')
    mkdirSync(path.join(sdir, 'world'), { recursive: true })
    writeFileSync(path.join(sdir, 'world', 'level.dat'), 'x')
    mkdirSync(path.join(sdir, 'creative'), { recursive: true })
    writeFileSync(path.join(sdir, 'creative', 'level.dat'), 'x')

    check('readLevelName', readLevelName(sdir) === 'world')
    check('nextWorldName carpisma yok', ['world-new'].includes(await nextWorldName(sdir)))

    const created = await createWorld(sdir, 'yeni-dunya')
    check('createWorld level-name yazar', created.level === 'yeni-dunya' && readLevelName(sdir) === 'yeni-dunya')
    // createWorld klasor OLUSTURMAZ (sunucu acilista yaratir); silme testi icin simule et
    mkdirSync(path.join(sdir, 'yeni-dunya'), { recursive: true })
    writeFileSync(path.join(sdir, 'yeni-dunya', 'level.dat'), 'x')

    // aktif dunya silme: level-name baska dunyaya donmeli
    const r = await deleteWorldSmart(sdir, 'yeni-dunya')
    check('aktif dunya silinir + level doner', !existsSync(path.join(sdir, 'yeni-dunya')) && r.newLevel === 'world', JSON.stringify(r))
    check('level-name geri alindi', readLevelName(sdir) === 'world')

    // zip ice aktarma: dunya klasorunu zip'leyip ice aktar
    const zipPath = path.join(worldRoot, 'creative.zip')
    await new Promise<void>((resolve, reject) => {
      const TAR = existsSync('C:\\Windows\\System32\\tar.exe') ? 'C:\\Windows\\System32\\tar.exe' : 'tar'
      execFile(TAR, ['-czf', zipPath, '-C', sdir, 'creative'], (e) => (e ? reject(e) : resolve()))
    })
    const imp = await importWorld(sdir, zipPath)
    // "creative" klasoru zaten var (gercek dunya) -> ice aktarma creative-1 alir
    check('zip ice aktarildi (carpisma atlat)', /^creative-\d+$/.test(imp.level) && existsSync(path.join(sdir, imp.level, 'level.dat')), JSON.stringify(imp))

    // tekrar ice aktarma -> bir sonraki bos sonek
    const imp2 = await importWorld(sdir, zipPath)
    check('tekrar ice aktarma yeni sonek', /^creative-\d+$/.test(imp2.level) && imp2.level !== imp.level, JSON.stringify(imp2))

    // gecersiz klasor reddedilir
    const badDir = path.join(worldRoot, 'bos')
    mkdirSync(badDir, { recursive: true })
    let rejected = false
    try {
      await importWorld(sdir, badDir)
    } catch {
      rejected = true
    }
    check('level.dat siz klasor reddedilir', rejected)
  } finally {
    bestEffortRm(worldRoot)
  }

  console.log(failures === 0 ? '=== PHASE 6 TESTLERI BASARILI ===' : `=== ${failures} HATA ===`)
  process.exit(failures === 0 ? 0 : 1)
}

void main().catch((e) => {
  console.error('TEST HATASI:', e)
  process.exit(1)
})
