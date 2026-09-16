// joinStatus cozumleyicisi birim testleri (gercek log ornekleriyle)
import {
  processJoinLine,
  translateKickLine,
  isPlayerKickLine,
  extractKickedNickname,
  isNormalQuit,
  PHASE_LABEL,
  type JoinState
} from '../src/shared/joinStatus'

let failures = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  OK  ${name}`)
  else {
    failures++
    console.error(`  FAIL ${name} ${detail}`)
  }
}

const IDLE: JoinState = { phase: 'idle', kick: null }

function run(lines: string[]): JoinState {
  let st = IDLE
  for (const l of lines) st = processJoinLine(l, st)
  return st
}

// ---- Kick cevirileri ----
const kicks: [string, string][] = [
  ['You are not white-listed on this server!', 'not_whitelisted'],
  // whitelist deseni once yakalar — kullaniciya daha net sebep
  ['User NotWhitelisted has been kicked from the server', 'not_whitelisted'],
  ['The server is full! (20/20)', 'server_full'],
  ['Outdated client! Please use 1.21.11', 'outdated_client'],
  ['Outdated server! I\'m still on 1.21.11', 'outdated_server'],
  ['Failed to verify username', 'invalid_session'],
  ['java.net.ConnectException: Connection refused: no further information', 'connection_refused'],
  ['Timed out', 'timed_out'],
  ['java.net.SocketException: Connection reset', 'connection_reset'],
  ['Unknown host: bore.pub', 'unknown_host'],
  // --- Bug raporu: whitelist kick client log'a hic dusmuyordu; farkli
  //     bicimler de yakalanmali ---
  ['You are not whitelisted on this server.', 'not_whitelisted'],
  ['Disconnecting com.mojang.authlib.GameProfile@6f2b958e: You are not white-listed on this server!', 'not_whitelisted'],
  ['com.mojang.authlib.GameProfile@: is not whitelisted', 'not_whitelisted'],
  ['[Server thread/INFO]: maykil is not on the whitelist', 'not_whitelisted'],
  // --- Genel yakalayicilar: sebep verilmemis disconnect'ler ---
  ['maykil lost connection: Disconnected', 'generic_disconnect'],
  ['Failed to connect to the server: Internal Exception: java.net.SocketException: Connection reset', 'connection_reset'],
  ['Disconnected from server: unknown reason', 'generic_disconnect']
]
for (const [line, expectedCode] of kicks) {
  const k = translateKickLine(line)
  check(`kick: ${line.slice(0, 40)}`, k?.code === expectedCode, `got=${k?.code}`)
  if (k) check(`kick mesaji Turkce: ${line.slice(0, 30)}`, k.friendly.length > 10)
}

// ---- Faz gecisleri: mutlu yol ----
const happy = run([
  '[Render thread/INFO]: Scanning for games...',
  '[Render thread/INFO]: Connecting to 45.155.125.146, 25565',
  '[Render thread/INFO]: Auth: logged in as user maykil',
  '[Render thread/INFO]: Logged in with entity id 7 at ([world]-61.5, 64.0, 43.5)',
  '[Render thread/INFO]: Loading advancements for maykil'
])
check('mutlu yol -> connected', happy.phase === 'connected', happy.phase)
check('connected etiketi', PHASE_LABEL[happy.phase].includes('İyi oyunlar') || PHASE_LABEL[happy.phase].includes('Iyi oyunlar'))

// ---- Faz gecisleri: whitelist kick ----
const wl = run([
  '[Render thread/INFO]: Connecting to 45.155.125.146, 25565',
  '[Render thread/INFO]: Disconnecting com.mojang.authlib.GameProfile@: You are not white-listed on this server!',
  '[Render thread/INFO]: Connecting to 45.155.125.146, 25565'
])
check('whitelist kick -> failed', wl.phase === 'failed')
check('kick kodu not_whitelisted', wl.kick?.code === 'not_whitelisted')
check('kick sonrasi faz GERI donmez', wl.phase === 'failed' && !PHASE_LABEL[wl.phase].includes('Iyi oyunlar'))

// ---- Bug: kick sebepsiz ise de failed'e gecmeli (panel asili kalmamali) ----
const nork = run([
  '[Render thread/INFO]: Connecting to 45.155.125.146, 25565',
  '[Render thread/INFO]: maykil lost connection: Disconnected'
])
check('sebepsiz disconnect -> failed', nork.phase === 'failed', nork.phase)
check('sebepsiz disconnect kodu generic', nork.kick?.code === 'generic_disconnect', nork.kick?.code)
check('generic ham satir korunur', (nork.kick?.raw ?? '').includes('lost connection'))

// ---- Spesifik desenler genel yakalayicidan once degerlendirilmeli ----
const ban = translateKickLine('Disconnected: You are banned from this server!')
check('spesifik (ban) genel yakalayiciyi gecmeli', ban?.code === 'banned', ban?.code)
const wlFirst = translateKickLine('You lost connection: You are not white-listed!')
check('whitelist kaybi kayip-oncecaligi gecmeli', wlFirst?.code === 'not_whitelisted', wlFirst?.code)

// ---- Faz gecisleri: timeout ----
const to = run([
  '[Render thread/INFO]: Connecting to bore.pub, 24785',
  '[Render thread/INFO]:lost connection: Timed out'
])
check('timeout -> failed', to.phase === 'failed' && to.kick?.code === 'timed_out', `${to.phase}/${to.kick?.code}`)

// ---- Kapatma/kick olmayan satirlar durumu bozmaz ----
const neutral = run([
  '[Render thread/INFO]: Reloading ResourceManager: vanilla',
  '[Render thread/INFO]: Sound engine started'
])
check('notr satirlar idle birakir', neutral.phase === 'idle')

// ---- Notr satirlarda generic yakalayici yanlis alarm vermemeli ----
const neutral2 = run([
  '[Render thread/INFO]: Reloading ResourceManager: vanilla',
  '[Render thread/INFO]: Created: 2048x2048x4 minecraft:textures/atlas/blocks.png-atlas',
  '[Render thread/INFO]: OpenAL initialized on device OpenAL Soft on Kulakliklar'
])
check('notr satirlarda yanlis alarm yok', neutral2.phase === 'idle', neutral2.phase)

// ---- HOST tarafi: kick satiri taramasi + normal cikis ayrimi ----
// Gercek Paper log ornekleri (canlida yakalanan bicimler, 2026-09-12 dahil):
const hostLines: [string, boolean][] = [
  // kick degil: taranmamali
  ['[00:50:19 INFO]: UUID of player maykil is c5f588c9-a608-3457-8b8c-fdfdd57705e8', false],
  ['[00:51:41 INFO]: maykil left the game', false],
  ['[15:17:35 INFO]: Done (13.925s)! For help, type "help"', false],
  // kick: taranmali
  ['maykil (/127.0.0.1:65248) lost connection: Timed out', true],
  ['Disconnecting com.mojang.authlib.GameProfile@5ab: You are not white-listed on this server!', true],
  ['maykil was kicked from the server by an operator', true],
  // CANLIDA YASANAN BICIM (2026-09-12): "Disconnecting <nick> (...): <sebep>"
  ['[15:18:35 INFO]: Disconnecting trevir (/31.155.247.178:9059): You are not whitelisted on this server!', true],
  ['[15:18:35 INFO]: trevir (/31.155.247.178:9059) lost connection: You are not whitelisted on this server!', true],
  ['[15:18:35 INFO]: Disconnecting maykil: You are not whitelisted on this server!', true]
]
for (const [line, expectedScan] of hostLines) {
  check(`host tarama: ${line.slice(11, 62)}`, isPlayerKickLine(line) === expectedScan, `got=${isPlayerKickLine(line)}`)
}
// Sebep cevirileri — canlida gorulen iki bicim de whitelist olarak cozulmeli
check('sebep: not whitelisted (yeni bicim)', translateKickLine('Disconnecting trevir (/31.155.247.178:9059): You are not whitelisted on this server!')?.code === 'not_whitelisted')
check('sebep: lost connection bicimi', translateKickLine('trevir (/31.155.247.178:9059) lost connection: You are not whitelisted on this server!')?.code === 'not_whitelisted')
check('sebep: white-listed (eski bicim)', translateKickLine('Disconnecting com.mojang.authlib.GameProfile@5ab: You are not white-listed on this server!')?.code === 'not_whitelisted')

// normal cikis ayrimi
check('normal cikis: lost connection: Disconnected', isNormalQuit('maykil lost connection: Disconnected') === true)
check('normal cikis: timeout DEGIL', isNormalQuit('maykil lost connection: Timed out') === false)
check('normal cikis: Disconnecting satiri asla cikis degil', isNormalQuit('Disconnecting trevir: You are not whitelisted on this server!') === false)
check('normal cikis: sebep ayrintili ise cikis degil', isNormalQuit('maykil lost connection: Disconnected: You are banned') === false)
check(
  'kick filtresi: whitelist kick rapor edilir (cikis DEGIL)',
  isPlayerKickLine('Disconnecting trevir (/31.155.247.178:9059): You are not whitelisted on this server!') &&
    !isNormalQuit('Disconnecting trevir (/31.155.247.178:9059): You are not whitelisted on this server!')
)
check(
  'kick filtresi: Disconnected ile biten lost connection RAPOR EDILMEZ',
  !(isPlayerKickLine('maykil lost connection: Disconnected') && !isNormalQuit('maykil lost connection: Disconnected'))
)
check('nickname cikarma: named lost connection', extractKickedNickname('maykil (/31.155.x.x:8088) lost connection: Timed out') === 'maykil')
check('nickname cikarma: Disconnecting <nick> (...)', extractKickedNickname('Disconnecting trevir (/31.155.247.178:9059): You are not whitelisted') === 'trevir')
check('nickname cikarma: GameProfile', extractKickedNickname('Disconnecting com.mojang.authlib.GameProfile@5ab (maykil): not whitelisted') === 'maykil')

console.log(failures === 0 ? '=== JOIN STATUS TESTLERI BASARILI ===' : `=== ${failures} HATA ===`)
process.exit(failures === 0 ? 0 : 1)
