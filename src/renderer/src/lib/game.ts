export interface VersionEntry {
  id: string
  type: string
}

export interface LaunchOptions {
  versionId: string
  nickname: string
  minRamMB?: number
  maxRamMB?: number
  serverAddress?: string
  javaPathOverride?: string
  /** Faz 12: yerel Fabric profil id — verildiginde manifest'te aranmaz. */
  localVersionId?: string
}

export interface GameSettings {
  minRamMB: number
  maxRamMB: number
  javaPathOverride?: string
  /** Faz 8: kurulum sihirbazi gorundu mu */
  wizardDone?: boolean
  /** Faz 8: 'dark' | 'light' */
  theme?: 'dark' | 'light'
  /** Faz 12.5: VPS'e yonlendirme — bos/undefined = varsayilan adres */
  apiBaseOverride?: string
}

export type GameEvent = {
  type:
    | 'status'
    | 'progress'
    | 'log'
    | 'started'
    | 'close'
    | 'error'
    | 'ready'
    | 'stopped'
    | 'whitelist-changed'
    | 'direct-address'
    | 'tunnel-address'
    | 'tunnel-state'
    | 'tunnel-error'
  message?: string
  percent?: number
  label?: string
  line?: string
  code?: number | null
  state?: TunnelState
  address?: string
}

export interface ApiHealth {
  online: boolean
  db: boolean
}

export type TunnelState = 'stopped' | 'starting' | 'live'

export interface ServerStatusInfo {
  running: boolean
  ready: boolean
  paperVersion: string | null
  paperBuild: number | null
  tunnel: TunnelState
  tunnelAddress: string | null
  tunnelError: string | null
  directAddress: string | null
  directError: string | null
}

// ---- Faz 6: izleme + yedek + plugin/world tipleri ----
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

export interface PropRow {
  key: string
  value: string
  editable: boolean
}

export interface BackupInfo {
  file: string
  sizeMB: number
  createdAt: string
}

export interface PluginInfo {
  file: string
  enabled: boolean
  sizeMB: number
}

export interface WorldInfo {
  name: string
  sizeMB: number
  active: boolean
}

export interface DatapackInfo {
  file: string
  kind: 'folder' | 'zip'
  enabled: boolean
}

export interface ServerStatsInfo2 {
  version: 1
  totalPlayMs: number
  totalPlayerMs: number
  sessions: number
  firstStart: string | null
  lastStart: string | null
  hourlyPlayerMs: number[]
  peakPlayers: number
  sessionActive: boolean
  sessionMinutes: number
}

// ---- Faz 11: otomatik guncelleme tipleri shared/appUpdate.ts'te yasar ----
import type { AppUpdateInfo, AppUpdateEvent } from '../../../shared/appUpdate'
export type { AppUpdateStatus, AppUpdateInfo, AppUpdateEvent } from '../../../shared/appUpdate'

export interface GameBridge {
  listVersions: () => Promise<{ latestRelease: string; versions: VersionEntry[] }>
  listInstalledVersions: () => Promise<string[]>
  launch: (opts: LaunchOptions) => Promise<void>
  stopGame: () => Promise<void>
  isRunning: () => Promise<boolean>
  getSettings: () => Promise<GameSettings>
  saveSettings: (s: GameSettings) => Promise<void>
  getInfo: () => Promise<{ gameRoot: string; apiBase: string; version: string; build: string; ramCapMB: number }>
  apiHealth: () => Promise<ApiHealth>

  // ---- Faz 11: otomatik guncelleme ----
  appUpdateInfo: () => Promise<AppUpdateInfo>
  appUpdateDownload: () => Promise<boolean>
  appUpdateInstall: () => Promise<void>
  onAppUpdateEvent: (cb: (ev: AppUpdateEvent) => void) => () => void

  listPaperVersions: () => Promise<string[]>
  restartTunnel: () => Promise<void>
  setApiToken: (token: string | null) => Promise<void>
  probeServer: (host: string, port: number) => Promise<{ ok: boolean; error?: string }>
  startServer: (opts: { mcVersion: string; ramMaxMB?: number }) => Promise<void>
  stopServer: () => Promise<void>
  restartServer: () => Promise<void>
  serverStatus: () => Promise<ServerStatusInfo>

  serverMonitor: () => Promise<ServerMonitor>
  serverCommand: (cmd: string) => Promise<void>
  adminAction: (
    action: 'op' | 'deop' | 'ban' | 'kick' | 'pardon' | 'pardon-ip',
    nickname: string
  ) => Promise<void>
  bansList: () => Promise<{
    players: { name: string; reason?: string; created?: string }[]
    ips: { ip: string; reason?: string; created?: string }[]
  }>
  readProps: () => Promise<PropRow[]>
  writeProps: (patch: Record<string, string>) => Promise<{ key: string; value: string }[]>
  backupCreate: (label?: string) => Promise<BackupInfo>
  backupList: () => Promise<BackupInfo[]>
  backupDelete: (file: string) => Promise<void>
  backupRestore: (file: string) => Promise<string[]>
  pluginsList: () => Promise<PluginInfo[]>
  pluginSetEnabled: (file: string, enabled: boolean) => Promise<void>
  pluginDelete: (file: string) => Promise<void>
  worldsList: () => Promise<WorldInfo[]>
  worldDelete: (name: string) => Promise<{ newLevel: string }>
  /** Yeni bos dunya ayarla (sunucu baslastirmada yaratir). */
  worldCreate: (name?: string) => Promise<{ level: string }>
  /** Disaridan dunya ice aktar — dosya diyalogu main process'te acilir. */
  worldImport: (mode: 'zip' | 'folder', name?: string) => Promise<{ canceled: boolean; level?: string }>
  datapacksList: () => Promise<DatapackInfo[]>
  datapackDelete: (file: string) => Promise<void>

  // ---- Faz 12: client mod / Fabric loader ----
  fabricLoaders: () => Promise<string[]>
  fabricStatus: () => Promise<{ loaderVersion: string | null; paperVersion: string | null }>
  fabricSet: (version: string | null) => Promise<void>
  clientModsPublishNow: () => Promise<{ ok: boolean; count: number; skipped?: string }>
  /** clientMods/ klasorunun tam yolu (kopyala-yapistir icin gosterilir). */
  clientModsDir: () => Promise<string>
  /** Dosya diyaloğu ile mod jar ekle (multi-select). */
  clientModsAdd: () => Promise<{ added: string | null; dir: string }>
  clientModsList: () => Promise<{ file: string; sizeMB: number }[]>
  clientModsDelete: (file: string) => Promise<void>
  /** Dosya diyaloğu ile plugin jar ekle (multi-select). */
  pluginsAdd: () => Promise<{ added: string | null; dir: string }>
  /** MC surumu icin kurulu yerel Fabric profil id (vanilla'da null). */
  localVersion: (mcVersion: string) => Promise<string | null>
  /** Host'un client mod plani (indirilecekler). */
  modsPlanSync: (host: string) => Promise<{
    host: string
    toDownload: { filename: string; sha256: string; sizeBytes: number }[]
    upToDate: string[]
    manifestTotal: number
  }>
  /** Plandaki modlari indirir; basarisizlik katilmayi engellemez. */
  modsSync: (host: string) => Promise<{ ok: boolean; downloaded: string[]; failed?: string }>
  /** Host'un yayinladigi loader profili (yoksa null). */
  hostProfile: (host: string) => Promise<{
    loader: string
    loaderVersion: string
    mcVersion: string
    publishedAt: string
  } | null>
  /** Fabric profilini saglar (yerelde yoksa meta'dan ceker) + fabric-api ve genel mod bagimliliklarini otomatik kurar. */
  fabricEnsure: (mcVersion: string, loaderVersion: string) => Promise<{
    localVersionId: string
    fabricApi?: { ok: boolean; installed?: string; skipped?: string }
    deps?: { ok: boolean; installed: string[]; failures: string[]; skipped?: string }
  }>

  /** Faz 7: host'un plugin manifestini kontrol eder (indirmez). */
  pluginsPlanSync: (host: string) => Promise<{
    host: string
    toDownload: { filename: string; sha256: string; sizeBytes: number }[]
    upToDate: string[]
    manifestTotal: number
  }>
  /** Eksik/farkli jar'lari indirir; basarisizlikta hata firlatir. */
  pluginsSync: (host: string) => Promise<{ ok: boolean; downloaded: string[] }>

  // ---- Faz 8: profiller + istatistikler ----
  profilesList: () => Promise<{ name: string; paperVersion: string | null; active: boolean }[]>
  profileSwitch: (name: string) => Promise<{ name: string; paperVersion: string | null; active: boolean }[]>
  profileCreate: (name: string) => Promise<{ name: string; paperVersion: string | null; active: boolean }[]>
  profileDelete: (name: string) => Promise<{ name: string; paperVersion: string | null; active: boolean }[]>
  /** Profilin en son basarili baslatilan surumu (surum secici buna ayarlanir). */
  profileLastVersion: () => Promise<string | null>
  serverStats: () => Promise<ServerStatsInfo2>
  getWhitelist: () => Promise<string[]>
  whitelistAdd: (nick: string) => Promise<string[]>
  whitelistRemove: (nick: string) => Promise<string[]>
  /** Faz 5c: onaylanan istekte whitelist'e ekle (zaten varsa dokunmaz). */
  whitelistEnsure: (nick: string) => Promise<string[]>

  onGameEvent: (cb: (ev: GameEvent) => void) => () => void
}

declare global {
  interface Window {
    launcher?: GameBridge & { apiBase: string; platform: string }
  }
}

export const gameBridge = (): GameBridge => {
  if (!window.launcher) {
    throw new Error('Launcher koprusu yuklenmedi (preload calismiyor olabilir).')
  }
  return window.launcher
}
