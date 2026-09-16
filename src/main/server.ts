// Sunucu yoneticisi: Paper indirme/baslatici + whitelist + bore tunnel
import { EventEmitter } from 'node:events'
import { spawn, ChildProcess } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  createWriteStream,
  copyFileSync,
  readdirSync,
  statSync,
  rmSync
} from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fetchVersionManifest, resolveJavaMajor, estimateJavaMajor } from './mcmeta'
import { ensureJava } from './java'
import { BoreTunnel, type BoreState, type BoreEvent } from './bore'
import { fetchPublicIp, ensureFirewallRule, isPrivateIp } from './netinfo'
import { announceServer, withdrawServer } from './announce'
import { reportKick } from './kickReport'
import { isPlayerKickLine, extractKickedNickname, isNormalQuit } from '../shared/joinStatus'
import { getProcStats } from './procstats'
import { parseTps, parsePlayerList, parseJoinLeave } from './monitorParse'
import { parseProperties, normalizeProp, ALLOWED_PROP_KEYS, PROP_DEFAULTS } from './propsEdit'
import * as backups from './backup'
import * as pluginsMod from './plugins'
import * as worldsMod from './worlds'
import { publishPlugins } from './pluginSync'
import { publishClientMods, publishLoaderProfile } from './clientModSync'
import { getLocalProfile } from './fabric'
import {
  listProfiles,
  profileDir,
  getActiveProfile,
  setActiveProfile,
  createProfile,
  deleteProfile,
  backupDirFor,
  ProfileError
} from './profiles'
import { StatsTracker, statsFileFor } from './serverStats'

// ---- Tipler --------------------------------------------------------------
export type ServerEvent =
  | { type: 'status'; message: string }
  | { type: 'progress'; percent: number; label: string }
  | { type: 'log'; line: string }
  | { type: 'ready' }
  | { type: 'stopped'; code: number | null }
  | { type: 'error'; message: string }
  | { type: 'whitelist-changed' }
  | { type: 'direct-address'; address: string }
  | { type: 'tunnel-address'; address: string }
  | { type: 'tunnel-state'; state: BoreState }
  | { type: 'tunnel-error'; message: string }

export interface ServerStatus {
  running: boolean
  ready: boolean
  paperVersion: string | null
  paperBuild: number | null
  tunnel: BoreState
  tunnelAddress: string | null
  tunnelError: string | null
  directAddress: string | null
  directError: string | null
}

/** Faz 6: canli izleme verisi (TPS/RAM/CPU/oyuncular). */
export interface ServerMonitor {
  running: boolean
  ready: boolean
  tps: { tps1: number; tps5: number; tps15: number } | null
  tpsAt: string | null
  ramMB: number | null
  maxRamMB: number | null
  cpuPercent: number | null
  players: { name: string; since: string }[]
}

interface PaperBuildInfo {
  id: number
  channel: string
  downloads: Record<string, { name: string; url: string; sha256?: string } | undefined>
}

const FILL_API = 'https://fill.papermc.io/v3/projects/paper'

// ---- Yardimcilar ---------------------------------------------------------
// Offline mod UUID: md5("OfflinePlayer:" + name), v3 formati
function offlineUuid(name: string): string {
  const hash = crypto.createHash('md5').update(`OfflinePlayer:${name}`).digest()
  hash[6] = (hash[6] & 0x0f) | 0x30
  hash[8] = (hash[8] & 0x3f) | 0x80
  const hex = hash.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function patchProperties(existing: string, patch: Record<string, string>): string {
  const lines = existing.split(/\r?\n/)
  const patched = new Set<string>()
  const out = lines.map((line) => {
    const m = line.match(/^([a-zA-Z0-9_-]+)=/)
    if (!m) return line
    const k = m[1]
    if (k in patch) {
      patched.add(k)
      return `${k}=${patch[k]}`
    }
    return line
  })
  for (const [k, v] of Object.entries(patch)) {
    if (!patched.has(k)) out.push(`${k}=${v}`)
  }
  return out.join('\n') + '\n'
}

// ---- ServerManager -------------------------------------------------------
export class ServerManager extends EventEmitter {
  private child: ChildProcess | null = null
  private ready = false
  // Faz 8: aktif profil (varsayilan: legacy 'default'). Degisince klasorler
  // profile gore yonlendirilir; sunucu calisiyorsa gecis reddedilir.
  private profile = 'default'
  // Faz 8: profil basina istatistik takipci
  private stats: StatsTracker | null = null
  private statsTickTimer: NodeJS.Timeout | null = null
  // Faz 5a: API'ye duyuru icin renderer'dan inject edilen oturum bilgisi
  private apiToken: string | null = null
  private paperVersion: string | null = null
  // Faz 12: host'un sectigi Fabric loader surumu (bos = vanilla); ready'de
  // arkadaslara yayinlanir ve katilanlar ayni loader'la oyun acar.
  private hostLoaderVersion: string | null = null
  private directPort = 25565
  private bore: BoreTunnel | null = null
  private boreState: BoreState = 'stopped'
  private boreAddress: string | null = null
  private boreError: string | null = null
  private directAddress: string | null = null
  private directError: string | null = null
  // Faz 5b: kick sebebi isimsiz gelen satirlar icin son katilan oyuncu
  private lastJoiner: string | null = null
  private paperFamiliesCache: { at: number; families: Record<string, string[]> } | null = null
  // Faz 5a: duyuru TTL'i (10 dk) asmasin diye periyodik yeniden duyuru (heartbeat)
  private announceTimer: NodeJS.Timeout | null = null

  // ---- Faz 6: izleme + restart/cokme tespiti + yedek zamanlayici ----
  private lastStartOpts: { mcVersion: string; ramMaxMB?: number; autoRestart?: boolean } | null = null
  private stopIntent = false
  private restartIntent = false
  private crashTimes: number[] = []
  private crashTimer: NodeJS.Timeout | null = null
  private monitorTimer: NodeJS.Timeout | null = null
  private backupTimer: NodeJS.Timeout | null = null
  private tps: { tps1: number; tps5: number; tps15: number } | null = null
  private tpsAt: number | null = null
  private ramMB: number | null = null
  private cpuPercent: number | null = null
  private players = new Map<string, number>()
  // Sunucu kapaliyken kaydedilen props degisikliklerinden, bir sonraki
  // baslastirmada uygulanacak konsol komutlari (gamemode/difficulty canli
  // degistirilebilir anahtarlardir — level.dat'tan gucludur).
  private pendingApply: string[] = []

  constructor(private root: string) {
    super()
    // Fix (saha raporu): aktif profil diskten yuklenmeliydi — aksi halde yeni
    // oturum her zaman 'default' varsayiyor ve 'default' klasoru yoksa (kullanici
    // baska profil secip default'u silmisse) her arac cagrisi ProfileError
    // firlatiyordu. listProfiles ayrica legacy migrasyonu + bos kalmama
    // garantisini de saglar.
    try {
      const list = listProfiles(this.root)
      const active = getActiveProfile(this.root)
      this.profile = list.some((p) => p.name === active) ? active : (list[0]?.name ?? 'default')
    } catch {
      this.profile = 'default'
    }
  }

  private get serverDir(): string {
    try {
      return profileDir(this.root, this.profile)
    } catch {
      // Profil klasoru disaridan silinmisse ilk mevcut profile dus;
      // listProfiles bos kalmayi engeller (default'u yeniden olusturur).
      const list = listProfiles(this.root)
      this.profile = list[0]?.name ?? 'default'
      const dir = path.join(this.root, 'profiles', this.profile)
      mkdirSync(dir, { recursive: true })
      return dir
    }
  }

  private get jarPath(): string {
    return path.join(this.serverDir, 'paper.jar')
  }

  private get configPath(): string {
    return path.join(this.serverDir, 'ylauncher-server.json')
  }

  private get whitelistPath(): string {
    return path.join(this.serverDir, 'whitelist.json')
  }

  // ---- Faz 8: profil yonetimi ----
  getProfiles(): ReturnType<typeof listProfiles> {
    return listProfiles(this.root)
  }

  switchProfile(name: string): ReturnType<typeof listProfiles> {
    if (this.child) throw new Error('Sunucu calisiyor — profil degistirmeden once kapatın.')
    const list = setActiveProfile(this.root, name)
    this.profile = name
    this.loadStats()
    this.emitEvent({ type: 'status', message: `Aktif profil: "${name}".` })
    return list
  }

  addProfile(name: string): ReturnType<typeof listProfiles> {
    const list = createProfile(this.root, name)
    this.emitEvent({ type: 'status', message: `Profil "${name}" olusturuldu.` })
    return list
  }

  async removeProfile(name: string): Promise<ReturnType<typeof listProfiles>> {
    if (this.child) throw new Error('Sunucu calisiyor — profil silmeden once kapatın.')
    try {
      const list = await deleteProfile(this.root, name)
      if (this.profile === name) this.profile = listProfiles(this.root)[0]?.name ?? 'default'
      this.loadStats()
      return list
    } catch (err) {
      if (err instanceof ProfileError) throw new Error(err.message)
      throw err
    }
  }

  private loadStats(): void {
    this.stats = new StatsTracker(statsFileFor(path.join(this.root, 'profiles'), this.profile))
  }

  private emitEvent(ev: ServerEvent) {
    this.emit('server-event', ev)
  }

  // Renderer oturumundan API token'ini al (duyuru icin). Token yoksa duyuru sessizce atlanir.
  setApiToken(token: string | null): void {
    this.apiToken = token
  }

  /** Faz 7: plugin senkronu IPC'si icin oturum token'i. */
  getApiToken(): string | null {
    return this.apiToken
  }

  private loadConfig(): {
    paper?: { version: string; build: number }
    lastMcVersion?: string
    /** Faz 12: host'un sectigi Fabric loader surumu (yok = vanilla) */
    fabricLoader?: string
  } {
    try {
      return JSON.parse(readFileSync(this.configPath, 'utf8'))
    } catch {
      return {}
    }
  }

  private saveConfig(cfg: {
    paper?: { version: string; build: number }
    lastMcVersion?: string
    fabricLoader?: string
  }): void {
    mkdirSync(this.serverDir, { recursive: true })
    writeFileSync(this.configPath, JSON.stringify(cfg, null, 2), 'utf8')
  }

  /**
   * Profilde en son basarili baslatilan MC surumu (profil bazli hatirlama).
   * Profil degistirince sunucu surum secici dogru surume ayarlanir —
   * kullanici her seferinde elle secmek zorunda kalmaz.
   */
  getProfileLastVersion(): string | null {
    return this.loadConfig().lastMcVersion ?? this.loadConfig().paper?.version ?? null
  }

  // ---- Paper surumleri (fill v3) ----
  // API "family -> somut surumler" haritasi dondurur (orn. "1.21" -> ["1.21.11", ..., "1.21"]).
  private async fetchPaperFamilies(): Promise<Record<string, string[]>> {
    if (this.paperFamiliesCache && Date.now() - this.paperFamiliesCache.at < 10 * 60 * 1000) {
      return this.paperFamiliesCache.families
    }
    const res = await fetch(FILL_API)
    if (!res.ok) throw new Error(`Paper surum listesi alinamadi (HTTP ${res.status})`)
    const json = (await res.json()) as { versions: Record<string, string[]> }
    this.paperFamiliesCache = { at: Date.now(), families: json.versions ?? {} }
    return this.paperFamiliesCache.families
  }

  // UI icin: sadece gercek release'ler (rc/pre/snapshot haric), yeni -> eski
  async listPaperVersions(): Promise<string[]> {
    const families = await this.fetchPaperFamilies()
    const versions: string[] = []
    for (const familyVersions of Object.values(families)) {
      for (const v of familyVersions ?? []) {
        if (/^\d+\.\d+(\.\d+)?$/.test(v) && !versions.includes(v)) versions.push(v)
      }
    }
    return versions
  }

  // Isteklenen id bir AILE ise (orn. "1.21") o ailenin EN YENI release'ine cozulur;
  // aile id'si listenin sonunda ayri bir giris olarak da bulundugu icin once aile kontrolu sart.
  private async resolvePaperVersion(mcVersion: string): Promise<string> {
    const families = await this.fetchPaperFamilies()
    const releaseRe = /^\d+\.\d+(\.\d+)?$/

    if (Array.isArray(families[mcVersion])) {
      const newest = families[mcVersion].find((v) => releaseRe.test(v))
      if (newest) {
        if (newest !== mcVersion) {
          this.emitEvent({
            type: 'status',
            message: `Paper surumu ${mcVersion} -> ${newest} olarak cozumledi`
          })
        }
        return newest
      }
    }

    // Somut surum verildiyse dogrudan kullan
    const all = Object.values(families).flat()
    if (all.includes(mcVersion)) return mcVersion

    // onek eslesmesi (orn. "1.21.9" yazildi ama "1.21.9-rc1" ailesinde)
    const match = all.find((v) => v.startsWith(mcVersion + '.'))
    if (match) {
      this.emitEvent({ type: 'status', message: `Paper surumu ${mcVersion} -> ${match} olarak cozumledi` })
      return match
    }
    throw new Error(`Paper ${mcVersion} icin surum bulunamadi.`)
  }

  // ---- Paper jar indirme ----
  private async downloadPaper(mcVersion: string): Promise<void> {
    this.emitEvent({ type: 'status', message: `Paper ${mcVersion} surumu sorgulaniyor...` })
    const res = await fetch(`${FILL_API}/versions/${encodeURIComponent(mcVersion)}/builds/latest`)
    if (res.status === 404) {
      throw new Error(
        `Paper ${mcVersion} icin surum yok. Daha yeni bir MC surumu secin (orn. 1.21.x).`
      )
    }
    if (!res.ok) throw new Error(`Paper API hatasi (HTTP ${res.status})`)
    const build = (await res.json()) as PaperBuildInfo
    const dl = build.downloads['server:default']
    if (!dl) throw new Error('Paper indirme baglantisi bulunamadi.')

    this.emitEvent({
      type: 'status',
      message: `Paper ${mcVersion} (build ${build.id}) indiriliyor...`
    })
    const dres = await fetch(dl.url)
    if (!dres.ok || !dres.body) throw new Error(`Paper indirmesi basarisiz (HTTP ${dres.status})`)

    mkdirSync(this.serverDir, { recursive: true })
    const tmpPath = this.jarPath + '.tmp'
    const hash = crypto.createHash('sha256')
    const total = Number(dres.headers.get('content-length') ?? 0)
    let received = 0
    let lastPercent = -1
    const nodeStream = Readable.fromWeb(dres.body as never)
    nodeStream.on('data', (chunk: Buffer) => {
      hash.update(chunk)
      received += chunk.length
      if (total > 0) {
        const percent = Math.floor((received / total) * 100)
        if (percent !== lastPercent) {
          lastPercent = percent
          this.emitEvent({ type: 'progress', percent, label: 'Paper jar' })
        }
      }
    })
    await pipeline(nodeStream, createWriteStream(tmpPath))

    // Butunluk kontrolu
    if (dl.sha256) {
      const actual = hash.digest('hex')
      if (actual !== dl.sha256.toLowerCase()) {
        await rm(tmpPath, { force: true })
        throw new Error('Paper jar butunluk kontrolu basarisiz (sha256 uyusmadi).')
      }
    }
    await rm(this.jarPath, { force: true })
    const { renameSync } = await import('node:fs')
    renameSync(tmpPath, this.jarPath)

    this.saveConfig({ paper: { version: mcVersion, build: Number(build.id) } })
    this.emitEvent({ type: 'status', message: `Paper ${mcVersion} hazir` })
  }

  // ---- Whitelist ----
  private readWhitelist(): { uuid: string; name: string }[] {
    try {
      return JSON.parse(readFileSync(this.whitelistPath, 'utf8'))
    } catch {
      return []
    }
  }

  private writeWhitelist(entries: { uuid: string; name: string }[]): void {
    mkdirSync(this.serverDir, { recursive: true })
    writeFileSync(this.whitelistPath, JSON.stringify(entries, null, 2), 'utf8')
  }

  listWhitelist(): string[] {
    return this.readWhitelist().map((e) => e.name)
  }

  whitelistAdd(nickname: string): string[] {
    const nick = nickname.trim()
    const entries = this.readWhitelist()
    if (!entries.some((e) => e.name.toLowerCase() === nick.toLowerCase())) {
      entries.push({ uuid: offlineUuid(nick), name: nick })
      this.writeWhitelist(entries)
    }
    if (this.child && this.ready) {
      this.child.stdin?.write(`whitelist add ${nick}\nwhitelist reload\n`)
    }
    this.emitEvent({ type: 'whitelist-changed' })
    return entries.map((e) => e.name)
  }

  whitelistRemove(nickname: string): string[] {
    const nick = nickname.trim().toLowerCase()
    const entries = this.readWhitelist().filter((e) => e.name.toLowerCase() !== nick)
    this.writeWhitelist(entries)
    if (this.child && this.ready) {
      const name = nickname.trim()
      this.child.stdin?.write(`whitelist remove ${name}\nwhitelist reload\n`)
    }
    this.emitEvent({ type: 'whitelist-changed' })
    return entries.map((e) => e.name)
  }

  // ---- Sunucu baslat/durdur/yeniden baslat ----
  async start(opts: { mcVersion: string; ramMaxMB?: number; autoRestart?: boolean }): Promise<void> {
    if (this.child) throw new Error('Sunucu zaten calisiyor.')

    const version = await this.resolvePaperVersion(opts.mcVersion)
    this.paperVersion = version
    const cfg = this.loadConfig()

    // Surum degisimi: eski Paper global config'leri (versiyona bagli serileme)
    // yenisiyle uyumsuz olur -> temizle ki Paper yeniden uretsin. Dunyalar korunur.
    if (cfg.paper && cfg.paper.version !== version) {
      await rm(path.join(this.serverDir, 'config'), { recursive: true, force: true })
      this.emitEvent({
        type: 'status',
        message: `Paper surumu degisti (${cfg.paper.version} -> ${version}): eski config temizlendi`
      })
    }

    const needDownload = !existsSync(this.jarPath) || cfg.paper?.version !== version
    if (needDownload) {
      await this.downloadPaper(version)
    }

    // Java gereksinimi
    this.emitEvent({ type: 'status', message: 'Java gereksinimi kontrol ediliyor...' })
    let major: number
    try {
      const manifest = await fetchVersionManifest()
      const entry = manifest.versions.find((v) => v.id === version)
      major = entry ? await resolveJavaMajor(entry) : estimateJavaMajor(version)
    } catch {
      major = estimateJavaMajor(version)
    }
    const javaPath = await ensureJava(major, path.join(this.root, 'java'), {
      onStatus: (m) => this.emitEvent({ type: 'status', message: m }),
      onProgress: (percent, label) => this.emitEvent({ type: 'progress', percent, label })
    })

    // EULA + server.properties
    mkdirSync(this.serverDir, { recursive: true })
    writeFileSync(path.join(this.serverDir, 'eula.txt'), 'eula=true\n', 'utf8')

    const propsPath = path.join(this.serverDir, 'server.properties')
    const critical: Record<string, string> = {
      'online-mode': 'false',
      'white-list': 'true',
      'enforce-whitelist': 'true'
    }
    if (!existsSync(propsPath)) {
      const defaults = {
        'server-port': '25565',
        'motd': 'MC Friends Launcher sunucusu',
        'max-players': '20',
        'view-distance': '8',
        ...critical
      }
      writeFileSync(propsPath, Object.entries(defaults).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', 'utf8')
    } else {
      writeFileSync(propsPath, patchProperties(readFileSync(propsPath, 'utf8'), critical), 'utf8')
    }

    // Baslat
    this.ready = false
    this.stopIntent = false
    this.restartIntent = false
    this.hostLoaderVersion = this.loadConfig().fabricLoader ?? null
    this.lastStartOpts = {
      mcVersion: version,
      ramMaxMB: opts.ramMaxMB,
      autoRestart: opts.autoRestart ?? true
    }
    // Profil bazli surum hatirlama: profilin en son kullanilan surumunu kaydet
    // (profil degisiminde secici otomatik dogru surume donebilir)
    const curCfg = this.loadConfig()
    if (curCfg.lastMcVersion !== version) {
      this.saveConfig({ ...curCfg, lastMcVersion: version })
    }
    // Onceki oturumda kaydedilen canli ayarlar (gamemode/difficulty) ilk firsatta uygula
    const pending = this.pendingApply
    this.pendingApply = []
    this.emitEvent({ type: 'status', message: 'Sunucu baslatiliyor...' })
    // RAM/JVM: kullanici ayarli (varsayilan 2048M) + Paper'in onerdigi G1GC bayraklari
    const xmx = Math.max(1024, Math.min(32768, Math.round(opts.ramMaxMB ?? 2048)))
    const args = [
      `-Xms${Math.max(512, Math.floor(xmx / 2))}M`,
      `-Xmx${xmx}M`,
      '-XX:+UseG1GC',
      '-XX:+ParallelRefProcEnabled',
      '-XX:MaxGCPauseMillis=200',
      '-jar',
      'paper.jar',
      '--nogui'
    ]
    const child = spawn(javaPath, args, { cwd: this.serverDir, windowsHide: true })
    this.child = child

    // Izleme durumunu sifirla + periyodik TPS/RAM/CPU ornekleme + oto yedek
    this.players.clear()
    this.tps = null
    this.tpsAt = null
    this.ramMB = null
    this.cpuPercent = null
    this.startMonitorTimer()
    // Faz 5a: duyuru TTL yenileme — API kaydi 10 dk'da dustugu icin arkadaslarin
    // listesindeki uzun oturumlar kayboluyordu. 5 dk'da bir yeniden duyur.
    if (this.announceTimer) clearInterval(this.announceTimer)
    this.announceTimer = setInterval(() => {
      const addr = this.directAddress ?? this.boreAddress
      if (!addr || !this.child || !this.ready) return
      const [host, portStr] = addr.split(':')
      void announceServer({
        token: this.apiToken,
        address: host,
        port: Number(portStr ?? this.directPort),
        mcVersion: this.paperVersion ?? 'unknown',
        online: true,
        clientMods: this.countClientMods(),
        plugins: this.countPlugins()
      })
    }, 5 * 60_000)
    this.announceTimer.unref?.()
    // Faz 8: profil istatistikleri — oturum baslangici + 5 dk'lik tick
    if (!this.stats) this.loadStats()
    this.stats?.sessionStart_ts()
    if (this.statsTickTimer) clearInterval(this.statsTickTimer)
    this.statsTickTimer = setInterval(() => this.stats?.tick(), 5 * 60_000)
    this.statsTickTimer.unref?.()
    this.backupTimer = setInterval(() => {
      if (this.child && this.ready) void this.backupNow('auto').catch(() => {})
    }, 30 * 60_000)
    this.backupTimer.unref?.()
    // Tunnel'i paralel baslat (bore: hesap gerekmez, adres saniyeler icinde)
    this.startBore()
    // Dogrudan baglanti adresini de dene (VPS'te public IP + firewall aciksa
    // oyuncular daha dusuk ping ile vps-ip:25565'e baglanir)
    this.resolveDirectAddress()

    const handleLine = (lineRaw: string) => {
      const line = lineRaw.trimEnd()
      if (!line) return
      this.emitEvent({ type: 'log', line })

      if (!this.ready && /Done \([0-9.]+s\)!/i.test(line)) {
        this.ready = true
        this.emitEvent({ type: 'status', message: 'Sunucu hazir!' })
        this.emitEvent({ type: 'ready' })
        // Bekleyen canli ayar komutlarini gonder (gamemode/difficulty)
        for (const cmd of pending) {
          try {
            this.child?.stdin?.write(`${cmd}\n`)
            this.emitEvent({ type: 'log', line: `[komut] > ${cmd}` })
          } catch {
            /* onemsiz */
          }
        }
        // Faz 7: plugin manifestini arkadaslara yayinla (arka planda).
        // Sonuc log paneline yazilir — sessiz basarisizlik host'un fark etmeden
        // arkadaslarin hic plugin indirmemesine yol aciyordu.
        void publishPlugins({ token: this.apiToken, pluginsDir: path.join(this.serverDir, 'plugins') }).then(
          (r) => {
            if (r.ok) {
              if (r.count > 0) {
                this.emitEvent({ type: 'log', line: `[pluginsync] ${r.count} plugin arkadaslara yayinlandi` })
              }
            } else {
              this.emitEvent({ type: 'log', line: `[pluginsync] YAYINLAMADI: ${r.skipped ?? 'bilinmeyen'}` })
            }
          }
        )
        // Faz 12: client mod setini + loader profilini arkadaslara yayinla.
        // clientMods/ klasoru host'un GAME_ROOT altindadir; yoksa profil yine
        // de yayinlanir (vanilla/fabric bilgisi arkadaslarin surum secimini
        // yonlendirir).
        void (async () => {
          const loaderVersion = this.hostLoaderVersion
          const res = await publishClientMods({
            token: this.apiToken,
            clientModsDir: path.join(this.root, 'clientMods'),
            mcVersion: this.paperVersion ?? 'unknown'
          })
          if (res.ok) {
            if (res.count > 0) {
              this.emitEvent({ type: 'log', line: `[modsync] ${res.count} client mod arkadaslara yayinlandi` })
            }
          } else {
            this.emitEvent({ type: 'log', line: `[modsync] YAYINLAMADI: ${res.skipped ?? 'bilinmeyen'}` })
          }
          // Faz 12.7: yayimlama aninda uyumluluk taramasi — uyumsuz/manifestosuz
          // modlari host'a ONCE bildir (arkadas tarafinda crash etmeden).
          try {
            const { scanModCompatibility } = await import('./fabric')
            for (const w of scanModCompatibility(path.join(this.root, 'clientMods'), this.paperVersion ?? 'unknown')) {
              this.emitEvent({ type: 'log', line: `[modsync] UYARI ${w.jar}: ${w.problem}` })
            }
          } catch {
            /* tarama hatasi yayinlamayi engellemez */
          }
          const prof = await publishLoaderProfile({
            token: this.apiToken,
            loader: loaderVersion ? 'fabric' : 'vanilla',
            loaderVersion: loaderVersion ?? '',
            mcVersion: this.paperVersion ?? 'unknown'
          })
          if (prof.ok && loaderVersion) {
            this.emitEvent({ type: 'log', line: `[modsync] Fabric profili yayinlandi (${loaderVersion})` })
          }
        })()
        // Faz 5a: arkadaslarin listesinde gorunsun diye API'ye duyur.
        // Once dogrudan adres (VPS public IP), yoksa turel adresi.
        const addr = this.directAddress ?? this.boreAddress
        if (addr) {
          const [host, portStr] = addr.split(':')
          void announceServer({
            token: this.apiToken,
            address: host,
            port: Number(portStr ?? this.directPort),
            mcVersion: this.paperVersion ?? 'unknown',
            online: true,
            // Faz 14: rozet meta verisi — sunucu icerigi arkadas listesinde gosterilir
            clientMods: this.countClientMods(),
            plugins: this.countPlugins()
          })
        }
      }
      if (/Failed to bind to port/i.test(line)) {
        this.emitEvent({ type: 'error', message: 'Port 25565 kullanilamadi. Baska bir sunucu acik olabilir.' })
      }

      // Faz 5b: kick sebebini HOST log'undan yakala ve API'ye raporla.
      // Kick sebebini client log'una her zaman yazilmaz (canlida yasandi:
      // whitelist kick'i client'ta sadece "Connection reset" gorundu) ama
      // Paper'in log'unda sebep daima vardir. Son katilan oyuncuyu takip et —
      // isimsiz kick satirlari ("GameProfile@...: ...") ona aittir.
      if (isPlayerKickLine(line) && !isNormalQuit(line)) {
        const named = extractKickedNickname(line)
        const nick = named ?? this.lastJoiner
        if (nick) {
          if (named) {
            this.lastJoiner = null // kapandi; yenisi gelene kadar bos
          }
          void reportKick({ token: this.apiToken, nickname: nick, rawLine: line })
        }
      }
      const uuidJoin = /UUID of player (\S+) is/.exec(line)
      if (uuidJoin) this.lastJoiner = uuidJoin[1]

      // Izleme: TPS + oyuncu listesi + giris/cikis (Faz 6)
      const tpsSample = parseTps(line)
      if (tpsSample) {
        this.tps = tpsSample
        this.tpsAt = Date.now()
      }
      const listed = parsePlayerList(line)
      if (listed) {
        for (const name of listed.names) {
          if (!this.players.has(name)) this.players.set(name, Date.now())
        }
        for (const known of [...this.players.keys()]) {
          if (!listed.names.includes(known)) this.players.delete(known)
        }
      }
      const jl = parseJoinLeave(line)
      if (jl) {
        if (jl.kind === 'join') this.players.set(jl.name, Date.now())
        else this.players.delete(jl.name)
        // Faz 8: istatistik (oyuncu-dakikasi)
        this.stats?.playerEvent(jl.name, jl.kind)
      }
    }

    let stdoutBuf = ''
    child.stdout?.on('data', (d: Buffer) => {
      stdoutBuf += d.toString()
      const lines = stdoutBuf.split(/\r?\n/)
      stdoutBuf = lines.pop() ?? ''
      for (const l of lines) handleLine(l)
    })
    let stderrBuf = ''
    child.stderr?.on('data', (d: Buffer) => {
      stderrBuf += d.toString()
      const lines = stderrBuf.split(/\r?\n/)
      stderrBuf = lines.pop() ?? ''
      for (const l of lines) handleLine(l)
    })

    child.on('close', (code) => {
      const wasReady = this.ready
      this.child = null
      this.ready = false
      this.stopTimers()
      this.stats?.sessionEnd() // Faz 8: oturumu istatistiklere isle
      this.stopBore()
      // Faz 5a: duyuruyu geri cek (arkadaslarin listesinden duser)
      void withdrawServer(this.apiToken)
      this.directAddress = null
      this.directError = null

      // Bilincli restart: kullanicinin "Yeniden Baslat" istegi —
      // cokme sayilmaz, dogrudan ayni ayarlarla yeniden baslat.
      if (this.restartIntent) {
        this.restartIntent = false
        this.emitEvent({ type: 'status', message: 'Sunucu yeniden baslatiliyor...' })
        void this.start({ ...(this.lastStartOpts ?? { mcVersion: version }) }).catch((err) => {
          this.emitEvent({
            type: 'error',
            message: `Yeniden baslatma basarisiz: ${err instanceof Error ? err.message : String(err)}`
          })
        })
        return
      }
      this.emitEvent({ type: 'stopped', code })

      // Cokme tespiti + otomatik yeniden baslatma: hazir olan sunucu sifirdan
      // olmayan bir kodla kapandiysa (kullanici durdurmadiysa) 5 sn sonra
      // yeniden dene; 10 dk'da 5+ cokmede pes et (sonsuz cokme dongusune girme).
      if (wasReady && code !== 0 && !this.stopIntent && (this.lastStartOpts?.autoRestart ?? true)) {
        const now = Date.now()
        this.crashTimes = this.crashTimes.filter((t) => now - t < 10 * 60_000)
        this.crashTimes.push(now)
        if (this.crashTimes.length > 5) {
          this.emitEvent({
            type: 'error',
            message: 'Sunucu son 10 dakikada 5+ kez coktu — otomatik yeniden baslatma durduruldu. Loglari kontrol edin.'
          })
          return
        }
        this.emitEvent({
          type: 'status',
          message: `Cokme algilandi (cikis kodu ${code}); 5 sn sonra otomatik yeniden baslatilacak...`
        })
        this.crashTimer = setTimeout(() => {
          void this.start({ ...(this.lastStartOpts ?? { mcVersion: version }) }).catch((err) => {
            this.emitEvent({
              type: 'error',
              message: `Otomatik yeniden baslatma basarisiz: ${err instanceof Error ? err.message : String(err)}`
            })
          })
        }, 5000)
        this.crashTimer.unref?.()
      }
    })
    child.on('error', (err) => {
      this.emitEvent({ type: 'error', message: err.message })
    })
  }

  async stop(): Promise<void> {
    if (!this.child) return
    this.stopIntent = true // kullanici istegi: cokme sayma / oto-restart tetikleme
    this.emitEvent({ type: 'status', message: 'Sunucu kapatiliyor (dunya kaydediliyor)...' })
    try {
      this.child.stdin?.write('stop\n')
    } catch {
      // stdin kapaliysa zorla kapat
      this.forceKill()
      return
    }
    // 10 sn icinde kapanmazsa zorla
    const child = this.child
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        if (this.child === child) this.forceKill()
        resolve()
      }, 10_000)
      // child kapaninca temiz
      const onClose = () => { clearTimeout(t); resolve() }
      child.once('close', onClose)
      child.once('error', () => { clearTimeout(t); resolve() })
    })
  }

  /** Launcher kapanirken kullanilir: sunucuyu kapat + duyuruyu geri cek.
   * close isleyicisi withdraw'i beklemez (fire-and-forget fetch) — launcher
   * kapanirken fetch'in tamamlanmasi garanti edilmeli, yoksa API kaydi durur
   * ve arkadaslarin listesinde hayalet sunucu gorunur. withdraw idempotenttir
   * (kaydi siler), iki kez cagrilmasi zararsiz. */
  async shutdown(): Promise<void> {
    if (!this.child) return
    await this.stop()
    await withdrawServer(this.apiToken)
  }

  /** Renderer'a soz verilen canlilik bilgisi (yetim java sureci tespiti icin). */
  isRunning(): boolean {
    return !!this.child
  }

  private forceKill(): void {
    if (!this.child) return
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(this.child.pid), '/T', '/F'])
    } else {
      this.child.kill('SIGKILL')
    }
  }

  // ---- Faz 6: komut / restart / izleme / props / yedek / plugin API'leri ----

  /** Sunucu konsoluna komut yazar (kullanicinin komut kutusu). */
  sendCommand(cmd: string): void {
    const clean = cmd.trim().replace(/[\r\n]+/g, ' ')
    if (!clean) return
    if (!this.child || !this.ready) throw new Error('Sunucu calismiyor — komut gonderilemez.')
    this.child.stdin?.write(`${clean}\n`)
    this.emitEvent({ type: 'log', line: `[komut] > ${clean}` })
  }

  /** Bilincli restart: stdin'e stop yazar; close isleyicisi restartIntent'i gorur. */
  restart(): void {
    if (!this.child) throw new Error('Sunucu calismiyor.')
    this.restartIntent = true
    this.stopIntent = false
    this.emitEvent({ type: 'status', message: 'Sunucu yeniden baslatiliyor (dunya kaydediliyor)...' })
    try {
      this.child.stdin?.write('stop\n')
    } catch {
      this.restartIntent = false
      this.forceKill()
    }
    // 10 sn icinde kapanmazsa zorla (close isleyicisi restart'i yine tetikler)
    const child = this.child
    setTimeout(() => {
      if (this.child === child) this.forceKill()
    }, 10_000).unref()
  }

  private startMonitorTimer(): void {
    this.stopTimers()
    this.monitorTimer = setInterval(() => {
      const child = this.child
      if (!child?.pid) return
      // Yalnizca READY sonrasi: dunya yuklenmeden gonderilen 'tps'/'list'
      // Paper'da NullPointerException firlatiyor (sahada dogrulandi).
      if (!this.ready) return
      // Paper TPS'i periyodik yazmaz — 20 sn'de bir konsoldan iste.
      // (rapor komutu yalnizca konsola yazilir; oyunculara duyurmaz)
      try {
        child.stdin?.write('tps\n')
        child.stdin?.write('list\n')
      } catch {
        /* stdin kapaliysa duygunsuz */
      }
      void getProcStats(child.pid).then((s) => {
        this.ramMB = s.ramMB
        this.cpuPercent = s.cpuPercent
      })
    }, 20_000)
    this.monitorTimer.unref?.()
    // ilk orneklemeyi beklemeden yap
    setTimeout(() => {
      const child = this.child
      if (!child?.pid) return
      void getProcStats(child.pid).then((s) => {
        this.ramMB = s.ramMB
        this.cpuPercent = s.cpuPercent
      })
    }, 2000).unref?.()
  }

  private stopTimers(): void {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer)
      this.monitorTimer = null
    }
    if (this.crashTimer) {
      clearTimeout(this.crashTimer)
      this.crashTimer = null
    }
    if (this.backupTimer) {
      clearInterval(this.backupTimer)
      this.backupTimer = null
    }
    if (this.statsTickTimer) {
      clearInterval(this.statsTickTimer)
      this.statsTickTimer = null
    }
    if (this.announceTimer) {
      clearInterval(this.announceTimer)
      this.announceTimer = null
    }
  }

  /** Faz 8: profil istatistikleri. */
  getStats(): ReturnType<StatsTracker['getSnapshot']> {
    if (!this.stats) this.loadStats()
    return this.stats!.getSnapshot()
  }

  getMonitor(): ServerMonitor {
    return {
      running: !!this.child,
      ready: this.ready,
      tps: this.tps,
      tpsAt: this.tpsAt ? new Date(this.tpsAt).toISOString() : null,
      ramMB: this.ramMB,
      maxRamMB: this.lastStartOpts?.ramMaxMB ?? 2048,
      cpuPercent: this.cpuPercent === null ? null : Math.round(this.cpuPercent * 10) / 10,
      players: [...this.players.entries()].map(([name, since]) => ({ name, since: new Date(since).toISOString() }))
    }
  }

  /** Yetkili komutlari (op/deop/ban/kick/pardon/pardon-ip) arayuzden tek cagriyla. */
  adminAction(action: 'op' | 'deop' | 'ban' | 'kick' | 'pardon' | 'pardon-ip', target: string): void {
    const t = target.trim()
    if (action === 'pardon-ip') {
      if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(t)) throw new Error('Gecersiz IP adresi.')
    } else if (!/^[A-Za-z0-9_]{1,16}$/.test(t)) {
      throw new Error('Gecersiz nickname.')
    }
    this.sendCommand(`${action} ${t}`)
  }

  /** Ban listelerini okur (banned-players.json + banned-ips.json). */
  listBans(): {
    players: { name: string; reason?: string; created?: string }[]
    ips: { ip: string; reason?: string; created?: string }[]
  } {
    const readJson = (file: string): Record<string, unknown>[] => {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
        return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : []
      } catch {
        return []
      }
    }
    const players = readJson(path.join(this.serverDir, 'banned-players.json'))
      .filter((e) => typeof e['name'] === 'string')
      .map((e) => ({
        name: String(e['name']),
        reason: typeof e['reason'] === 'string' ? e['reason'] : undefined,
        created: typeof e['created'] === 'string' ? e['created'] : undefined
      }))
    const ips = readJson(path.join(this.serverDir, 'banned-ips.json'))
      .filter((e) => typeof e['ip'] === 'string')
      .map((e) => ({
        ip: String(e['ip']),
        reason: typeof e['reason'] === 'string' ? e['reason'] : undefined,
        created: typeof e['created'] === 'string' ? e['created'] : undefined
      }))
    return { players, ips }
  }

  // ---- server.properties GUI editoru ----
  readProps(): { key: string; value: string; editable: boolean }[] {
    const file = path.join(this.serverDir, 'server.properties')
    // Hic baslatilmamis profilde dosya yok — cokmek yerine varsayilanlari goster
    // (raporlanan handler hatasi). Ilk kaydetmede dosya olusur.
    const parsed = existsSync(file)
      ? parseProperties(readFileSync(file, 'utf8'))
      : ({} as Record<string, string>)
    const order = new Set(ALLOWED_PROP_KEYS)
    const rows: { key: string; value: string; editable: boolean }[] = []
    for (const k of ALLOWED_PROP_KEYS) {
      rows.push({ key: k, value: parsed[k] ?? PROP_DEFAULTS[k], editable: true })
    }
    for (const [k, v] of Object.entries(parsed)) {
      if (!order.has(k as never)) rows.push({ key: k, value: v, editable: false })
    }
    return rows
  }

  /** Beyaz listedeki anahtarlarin degerini guncelle (dogrulamali).
   * gamemode/difficulty gibi LEVEL.DAT TARAFINDAN EZILEBILIR anahtarlarda
   * degisiklik konsoldan da canli uygulanir; sunucu kapaliysa bir sonraki
   * baslastirma icin komut kuyruguna birakilir. */
  writeProps(patch: Record<string, string>): { key: string; value: string; appliedLive?: boolean }[] {
    const file = path.join(this.serverDir, 'server.properties')
    // Hic baslatilmamis profil: dosyayi varsayilanlarla olustur (cokmek yerine)
    if (!existsSync(file)) {
      const defaults = ALLOWED_PROP_KEYS.map((k) => `${k}=${PROP_DEFAULTS[k]}`).join('\n')
      writeFileSync(file, defaults + '\n', 'utf8')
    }
    const lines = readFileSync(file, 'utf8').split(/\r?\n/)
    const normal = new Map<string, string>()
    for (const [k, v] of Object.entries(patch)) {
      normal.set(k, normalizeProp(k, String(v)))
    }
    const seen = new Set<string>()
    const out = lines.map((line) => {
      const m = /^([a-zA-Z0-9_-]+)=/.exec(line)
      if (!m || !normal.has(m[1])) return line
      seen.add(m[1])
      return `${m[1]}=${normal.get(m[1])}`
    })
    for (const [k, v] of normal) {
      if (!seen.has(k)) out.push(`${k}=${v}`)
    }
    writeFileSync(file, out.join('\n') + '\n', 'utf8')

    // Canli uygulanabilir anahtarlar: konsol komutu level.dat'i gecer.
    const live: string[] = []
    if (normal.has('gamemode')) live.push(`defaultgamemode ${normal.get('gamemode')}`)
    if (normal.has('difficulty')) live.push(`difficulty ${normal.get('difficulty')}`)
    if (live.length > 0) {
      if (this.child && this.ready) {
        for (const cmd of live) this.sendCommand(cmd)
      } else {
        this.pendingApply.push(...live)
      }
    }
    return [...normal].map(([key, value]) => ({
      key,
      value,
      appliedLive: live.some((c) => c.startsWith(`${key} `) || c.includes(` ${normal.get(key)}`)) && live.length > 0
    }))
  }

  // ---- Yedekleme (profil bazli; default legacy konumunu korur) ----
  private get backupDir(): string {
    return backupDirFor(this.root, this.profile)
  }

  backupNow(label?: string): Promise<backups.BackupInfo> {
    return backups.createBackup(this.backupDir, this.serverDir, label)
  }

  listBackups(): Promise<backups.BackupInfo[]> {
    return backups.listBackups(this.backupDir)
  }

  deleteBackup(file: string): Promise<void> {
    return backups.deleteBackup(this.backupDir, file)
  }

  /** Geri yukleme: sunucu calisiyorsa REDDEDILIR (dunya bozulmasin). */
  async restoreBackup(file: string): Promise<string[]> {
    if (this.child) throw new Error('Sunucu calisiyor — once kapatın, sonra geri yukleyin.')
    return backups.restoreBackup(this.backupDir, this.serverDir, file)
  }

  // ---- Plugin / dunya / datapack kopruleri ----
  listPlugins(): Promise<pluginsMod.PluginInfo[]> {
    return pluginsMod.listPlugins(this.serverDir)
  }

  /** Faz 12 UI: jar dosyasi secip aktif profilin plugins/ klasorune kopyalar
   * (kullanici klasorlerle ugrasmasin). Sunucu calisirken de eklenebilir;
   * Paper yeni jar'i yeniden baslatmada yukler. */
  async addPluginFile(): Promise<{ added: string | null; dir: string }> {
    const dir = path.join(this.serverDir, 'plugins')
    mkdirSync(dir, { recursive: true })
    const { dialog } = await import('electron')
    const res = await dialog.showOpenDialog({
      title: 'Plugin jar dosyasini sec (Paper plugin)',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Plugin jar', extensions: ['jar'] }]
    })
    if (res.canceled || res.filePaths.length === 0) return { added: null, dir }
    for (const p of res.filePaths) {
      const base = path.basename(p)
      if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,120}\.jar$/i.test(base)) {
        throw new Error(`Gecersiz dosya adi: ${base}`)
      }
      copyFileSync(p, path.join(dir, base))
    }
    this.emitEvent({ type: 'status', message: `${res.filePaths.length} plugin eklendi — yeniden baslatmada yuklenir.` })
    return { added: res.filePaths.map((p) => path.basename(p)).join(', '), dir }
  }

  setPluginEnabled(file: string, enabled: boolean): Promise<void> {
    return enabled
      ? pluginsMod.enablePlugin(this.serverDir, file)
      : pluginsMod.disablePlugin(this.serverDir, file)
  }

  deletePlugin(file: string): Promise<void> {
    return pluginsMod.deletePlugin(this.serverDir, file)
  }

  listWorlds(): Promise<pluginsMod.WorldInfo[]> {
    const level = worldsMod.readLevelName(this.serverDir)
    return pluginsMod.listWorlds(this.serverDir, level)
  }

  /** Dunya silme: aktif dunya da silinebilir — once level-name baska dunyaya
   * cevrilir, sonra klasor kaldirilir (yeniden baslastirmada yeni dunya yuklenir). */
  async deleteWorld(name: string): Promise<{ newLevel: string }> {
    if (this.child) throw new Error('Sunucu calisiyor — dunya silmeden once kapatın.')
    const r = await worldsMod.deleteWorldSmart(this.serverDir, String(name))
    this.emitEvent({ type: 'status', message: `"${name}" silindi; aktif dunya artık "${r.newLevel}".` })
    return r
  }

  /** Yeni bos dunya: level-name'i ayirir; sunucu baslastirmada yaratarak acar. */
  async createWorld(requested?: string): Promise<{ level: string }> {
    if (this.child) throw new Error('Sunucu calisiyor — yeni dunya icin once kapatın.')
    const r = await worldsMod.createWorld(this.serverDir, requested)
    this.emitEvent({ type: 'status', message: `Yeni dunya "${r.level}" ayarlandı — Sunucuyu Başlat ile oluşacak.` })
    return r
  }

  /** Disaridan dunya ice aktarma: klasor veya zip yolu main process'ten secilir. */
  async importWorld(sourcePath: string, requestedName?: string): Promise<{ level: string }> {
    if (this.child) throw new Error('Sunucu calisiyor — dunya ice aktarmadan once kapatın.')
    const r = await worldsMod.importWorld(this.serverDir, String(sourcePath), requestedName)
    this.emitEvent({ type: 'status', message: `Dunya "${r.level}" olarak ice aktarıldı — Sunucuyu Başlat ile açılır.` })
    return r
  }

  /** Ice aktarma/olusturma diyalogu (main process dosya diyalogu). */
  async pickWorldSource(mode: 'zip' | 'folder'): Promise<{ canceled: boolean; path?: string }> {
    const { dialog } = await import('electron')
    const res = await dialog.showOpenDialog({
      title: mode === 'zip' ? 'Dunya zip sec' : 'Dunya klasoru sec (level.dat iceren)',
      properties: mode === 'zip' ? ['openFile'] : ['openDirectory'],
      filters: mode === 'zip' ? [{ name: 'Zip', extensions: ['zip'] }] : undefined
    })
    if (res.canceled || res.filePaths.length === 0) return { canceled: true }
    return { canceled: false, path: res.filePaths[0] }
  }

  listDatapacks(): Promise<pluginsMod.DatapackInfo[]> {
    const level = worldsMod.readLevelName(this.serverDir)
    return pluginsMod.listDatapacks(this.serverDir, level)
  }

  deleteDatapack(file: string): Promise<void> {
    const level = worldsMod.readLevelName(this.serverDir)
    return pluginsMod.deleteDatapack(this.serverDir, level, file)
  }

  // ---- bore tunnel (hesapsiz, tek binary; playit.gg'nin yerine) ----
  private handleBoreEvent(ev: BoreEvent): void {
    switch (ev.type) {
      case 'log':
        if (ev.line) this.emitEvent({ type: 'log', line: ev.line })
        break
      case 'status':
        if (ev.message) this.emitEvent({ type: 'status', message: ev.message })
        break
      case 'state':
        this.boreState = ev.state ?? 'stopped'
        if (this.boreState === 'live' || this.boreState === 'starting') this.boreError = null
        this.emitEvent({ type: 'tunnel-state', state: this.boreState })
        break
      case 'address':
        this.boreAddress = ev.address ?? null
        this.boreError = null
        this.emitEvent({ type: 'tunnel-address', address: ev.address! })
        break
      case 'error':
        this.boreError = ev.message ?? null
        if (this.boreError) this.emitEvent({ type: 'tunnel-error', message: this.boreError })
        break
    }
  }

  private startBore(): void {
    if (this.bore) {
      if (this.bore.state === 'live' || this.bore.state === 'starting') return
      this.stopBore()
    }
    const bore = new BoreTunnel(this.root, 25565, null, (ev) => this.handleBoreEvent(ev))
    this.bore = bore
    try {
      // Saf Node implementasyonu: dis exe yok, AV engelleyecek bir sey yok.
      // start() senkrondur; baglanti hatalari olaylarla gelir.
      bore.start()
    } catch (err) {
      this.boreError = err instanceof Error ? err.message : String(err)
      this.emitEvent({ type: 'tunnel-error', message: this.boreError })
    }
  }

  // Yeniden baslatma: mevcut bore surecini kapatip yeni adres al
  restartTunnel(): void {
    this.stopBore()
    this.boreState = 'stopped'
    this.boreAddress = null
    this.boreError = null
    this.emitEvent({ type: 'tunnel-state', state: 'stopped' })
    if (this.child) this.startBore()
  }

  private stopBore(): void {
    this.bore?.stop()
    this.bore = null
  }

  // ---- Dogrudan baglanti (VPS'te turelsiz mod) ----
  private async resolveDirectAddress(): Promise<void> {
    this.directAddress = null
    this.directError = null
    try {
      const ip = await fetchPublicIp()
      if (!isPrivateIp(ip)) {
        this.directAddress = `${ip}:25565`
        this.emitEvent({ type: 'direct-address', address: this.directAddress })
        try {
          await ensureFirewallRule(25565)
          this.emitEvent({ type: 'status', message: `Dogrudan baglanti hazir: ${this.directAddress}` })
        } catch (fwErr) {
          this.directError = fwErr instanceof Error ? fwErr.message : String(fwErr)
          this.emitEvent({ type: 'status', message: `Dogrudan baglanti: guvenlik duvari kurali eklenemedi (${this.directError})` })
        }
      } else {
        this.directError = 'Bu makine NAT arkasinda (ozel IP); dogrudan baglanti mumkun degil'
        this.emitEvent({ type: 'status', message: 'Dogrudan baglanti yok: makine NAT arkasinda, turel kullanilacak' })
      }
    } catch (err) {
      this.directError = err instanceof Error ? err.message : String(err)
      this.emitEvent({ type: 'status', message: `Dogrudan baglanti tespit edilemedi: ${this.directError}` })
    }
  }

  getStatus(): ServerStatus {
    const cfg = this.loadConfig()
    return {
      running: !!this.child,
      ready: this.ready,
      paperVersion: cfg.paper?.version ?? null,
      paperBuild: cfg.paper?.build ?? null,
      tunnel: this.boreState,
      tunnelAddress: this.boreAddress,
      tunnelError: this.boreError,
      directAddress: this.directAddress,
      directError: this.directError
    }
  }

  // ---- Faz 12: client mod / Fabric loader yonetimi ----

  /** Host'un sectigi loader surumunu ayarlar ('auto' = en yeni Fabric,
   * null = vanilla). */
  async setFabricLoader(version: string | null): Promise<void> {
    if (this.child) throw new Error('Sunucu calisiyor — loader degistirmeden once kapatın.')
    // Otomatik algilama: 'auto' secildiyse Fabric meta'daki EN YENI loader
    // cozulur ve somut surum olarak kaydedilir (profil yayini somut kalir).
    if (version === 'auto') {
      const { listFabricLoaders } = await import('./fabric')
      const loaders = await listFabricLoaders()
      if (loaders.length === 0) throw new Error('Fabric surumleri alinamadi — internet baglantisi gerekli.')
      version = loaders[0]
      this.emitEvent({ type: 'status', message: `Fabric ${version} (en yeni) otomatik secildi.` })
    }
    const cfg = this.loadConfig()
    if (version) {
      this.saveConfig({ ...cfg, fabricLoader: version })
      this.hostLoaderVersion = version
    } else {
      const rest = { ...cfg }
      delete rest.fabricLoader
      this.saveConfig(rest)
      this.hostLoaderVersion = null
    }
    this.emitEvent({
      type: 'status',
      message: version ? `Fabric loader ${version} secildi — arkadaslar ayni loader'la acacak.` : 'Vanilla moduna donuldu.'
    })
  }

  /** Sunucu ekraninin loader durum satiri icin. */
  getFabricStatus(): { loaderVersion: string | null; paperVersion: string | null } {
    return {
      loaderVersion: this.hostLoaderVersion ?? this.loadConfig().fabricLoader ?? null,
      paperVersion: this.paperVersion ?? this.loadConfig().paper?.version ?? null
  }
  }

  /** Faz 14: skin kurulumunun hedef dizini (aktif profilin plugins/ klasoru). */
  getServerPluginsDir(): string {
    return path.join(this.serverDir, 'plugins')
  }

  /** Faz 14: duyuru rozetleri icin clientMods jar sayisi (hata -> 0). */
  private countClientMods(): number {
    try {
      const dir = path.join(this.root, 'clientMods')
      if (!existsSync(dir)) return 0
      return readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.jar')).length
    } catch {
      return 0
    }
  }

  /** Faz 14: duyuru rozetleri icin aktif profilin plugin sayisi (hata -> 0). */
  private countPlugins(): number {
    try {
      const dir = path.join(this.serverDir, 'plugins')
      if (!existsSync(dir)) return 0
      return readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.jar')).length
    } catch {
      return 0
    }
  }

  /** ready aninda beklemeden publish tetikleme (Yenile butonu). */
  async publishClientModsNow(): Promise<{ ok: boolean; count: number; skipped?: string }> {
    const res = await publishClientMods({
      token: this.apiToken,
      clientModsDir: path.join(this.root, 'clientMods'),
      mcVersion: this.paperVersion ?? 'unknown'
    })
    // Uyumluluk uyarilarini ServerTools konsoluna/panele log olarak ver
    try {
      const { scanModCompatibility } = await import('./fabric')
      for (const w of scanModCompatibility(path.join(this.root, 'clientMods'), this.paperVersion ?? 'unknown')) {
        this.emitEvent({ type: 'log', line: `[modsync] UYARI ${w.jar}: ${w.problem}` })
      }
    } catch {
      /* tarama hatasi sonucu etkilemez */
    }
    return res
  }

  /** Faz 12 UI: clientMods/ klasorunun tam yolunu dondurur (kopyala-yapistir icin).
   * Klasor yoksa olusturur — kullanici dogru yeri aramasin. */
  getClientModsDir(): string {
    const dir = path.join(this.root, 'clientMods')
    mkdirSync(dir, { recursive: true })
    return dir
  }

  /** Faz 12 UI: mod jar dosyasi secip clientMods/ klasorune kopyalar. */
  async addClientModFile(): Promise<{ added: string | null; dir: string }> {
    const dir = this.getClientModsDir()
    const { dialog } = await import('electron')
    const res = await dialog.showOpenDialog({
      title: 'Client mod jar dosyasini sec (Sodium, Iris vb.)',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Fabric mod jar', extensions: ['jar'] }]
    })
    if (res.canceled || res.filePaths.length === 0) return { added: null, dir }
    for (const p of res.filePaths) {
      const base = path.basename(p)
      if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,120}\.jar$/i.test(base)) {
        throw new Error(`Gecersiz dosya adi: ${base}`)
      }
      copyFileSync(p, path.join(dir, base))
    }
    this.emitEvent({ type: 'status', message: `${res.filePaths.length} mod clientMods/ klasorune eklendi.` })
    return { added: res.filePaths.map((p) => path.basename(p)).join(', '), dir }
  }

  /** clientMods/ icindeki jar'lari listeler (UI tablosu icin) + uyumluluk uyarilari. */
  listClientMods(): { file: string; sizeMB: number; warning?: string }[] {
    const dir = path.join(this.root, 'clientMods')
    if (!existsSync(dir)) return []
    // Uyumluluk taramasi bir kez yapilip dosya adina indekslenir (tarama hatasi listeyi bozmaz)
    let warnMap = new Map<string, string>()
    try {
      // Dinamik import ile dongsu bagimlilik onlenir; tarama hizlidir (manifesto okuma)
      const { scanModCompatibility } = require('./fabric') as typeof import('./fabric')
      warnMap = new Map(scanModCompatibility(dir, this.paperVersion ?? 'unknown').map((w) => [w.jar, w.problem]))
    } catch {
      /* tarama yok -> rozetsiz liste */
    }
    return readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.jar'))
      .map((f) => ({
        file: f,
        sizeMB: Math.round((statSync(path.join(dir, f)).size / (1024 * 1024)) * 10) / 10,
        warning: warnMap.get(f)
      }))
      .sort((a, b) => a.file.localeCompare(b.file))
  }

  /** clientMods/'tan mod siler. */
  deleteClientMod(file: string): void {
    const base = path.basename(file)
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,120}\.jar$/i.test(base)) throw new Error('Gecersiz dosya adi.')
    rmSync(path.join(this.root, 'clientMods', base), { force: true })
  }

  /** Katilan tarafin baslatacagi yerel surum id (vanilla'da null). */
  getLocalVersionId(mcVersion: string): string | null {
    return getLocalProfile(this.root, mcVersion)?.localVersionId ?? null
  }
}
