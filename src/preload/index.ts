import { contextBridge, ipcRenderer } from 'electron'
import { getApiBase } from '../shared/apiBase'
import type { AppUpdateInfo, AppUpdateEvent } from '../shared/appUpdate'

// Baslangic anindaki deger (fallback). Canli deger app:get-info ile sorgulanir;
// Ayarlar'dan API adresi degistirilirse App.tsx yeni degeri setApiBase ile alir.
const API_BASE = getApiBase()

export interface GameEventBridge {
  type: string
  message?: string
  percent?: number
  label?: string
  line?: string
  code?: number | null
}

contextBridge.exposeInMainWorld('launcher', {
  apiBase: API_BASE,
  platform: process.platform,

  // Oyun kontrolu
  listVersions: () => ipcRenderer.invoke('game:list-versions'),
  launch: (opts: unknown) => ipcRenderer.invoke('game:launch', opts),
  stopGame: () => ipcRenderer.invoke('game:stop'),
  isRunning: () => ipcRenderer.invoke('game:is-running'),
  listInstalledVersions: () => ipcRenderer.invoke('game:list-installed'),

  // Ayarlar
  getSettings: () => ipcRenderer.invoke('game:get-settings'),
  saveSettings: (s: unknown) => ipcRenderer.invoke('game:save-settings', s),

  // Uygulama bilgisi + API saglik kontrolu (renderer dogrudan fetch de yapabilir
  // ancak CORS/kimlik bilgisi derdi olmadan main uzerinden sormak daha temiz)
  getInfo: () => ipcRenderer.invoke('app:get-info'),
  apiHealth: () => ipcRenderer.invoke('app:api-health'),

  // Faz 11: otomatik guncelleme
  appUpdateInfo: () => ipcRenderer.invoke('app:update-info') as Promise<AppUpdateInfo>,
  appUpdateDownload: () => ipcRenderer.invoke('app:update-download') as Promise<boolean>,
  appUpdateInstall: () => ipcRenderer.invoke('app:update-install') as Promise<void>,

  // Sunucu yonetimi (Faz 4) + bore tunnel
  listPaperVersions: () => ipcRenderer.invoke('server:list-paper-versions'),
  restartTunnel: () => ipcRenderer.invoke('server:tunnel-restart'),
  setApiToken: (token: string | null) => ipcRenderer.invoke('server:set-api-token', token),
  probeServer: (host: string, port: number) => ipcRenderer.invoke('server:probe', { host, port }),
  startServer: (opts: { mcVersion: string; ramMaxMB?: number }) =>
    ipcRenderer.invoke('server:start', opts),
  stopServer: () => ipcRenderer.invoke('server:stop'),
  restartServer: () => ipcRenderer.invoke('server:restart'),
  serverStatus: () => ipcRenderer.invoke('server:status'),

  // Faz 6: izleme + komut + admin + props + yedek + plugin/world
  serverMonitor: () => ipcRenderer.invoke('server:monitor'),
  serverCommand: (cmd: string) => ipcRenderer.invoke('server:command', cmd),
  adminAction: (action: 'op' | 'deop' | 'ban' | 'kick' | 'pardon' | 'pardon-ip', nickname: string) =>
    ipcRenderer.invoke('server:admin-action', { action, nickname }),
  bansList: () => ipcRenderer.invoke('server:bans-list'),
  readProps: () => ipcRenderer.invoke('server:props-read'),
  writeProps: (patch: Record<string, string>) => ipcRenderer.invoke('server:props-write', patch),
  backupCreate: (label?: string) => ipcRenderer.invoke('server:backup-create', label),
  backupList: () => ipcRenderer.invoke('server:backup-list'),
  backupDelete: (file: string) => ipcRenderer.invoke('server:backup-delete', file),
  backupRestore: (file: string) => ipcRenderer.invoke('server:backup-restore', file),
  pluginsList: () => ipcRenderer.invoke('server:plugins-list'),
  pluginSetEnabled: (file: string, enabled: boolean) =>
    ipcRenderer.invoke('server:plugins-set', { file, enabled }),
  pluginDelete: (file: string) => ipcRenderer.invoke('server:plugins-delete', file),
  worldsList: () => ipcRenderer.invoke('server:worlds-list'),
  worldDelete: (name: string) => ipcRenderer.invoke('server:worlds-delete', name),
  worldCreate: (name?: string) => ipcRenderer.invoke('server:world-create', name),
  worldImport: (mode: 'zip' | 'folder', name?: string) =>
    ipcRenderer.invoke('server:world-import', { mode, name }),
  datapacksList: () => ipcRenderer.invoke('server:datapacks-list'),
  datapackDelete: (file: string) => ipcRenderer.invoke('server:datapacks-delete', file),

  // Faz 12: client mod / Fabric loader
  fabricLoaders: () => ipcRenderer.invoke('server:fabric-loaders') as Promise<string[]>,
  fabricStatus: () =>
    ipcRenderer.invoke('server:fabric-status') as Promise<{
      loaderVersion: string | null
      paperVersion: string | null
    }>,
  fabricSet: (version: string | null) =>
    ipcRenderer.invoke('server:fabric-set', version) as Promise<void>,
  clientModsPublishNow: () =>
    ipcRenderer.invoke('server:clientmods-publish-now') as Promise<{
      ok: boolean
      count: number
      skipped?: string
    }>,
  clientModsDir: () => ipcRenderer.invoke('server:clientmods-dir') as Promise<string>,
  clientModsAdd: () =>
    ipcRenderer.invoke('server:clientmods-add') as Promise<{ added: string | null; dir: string }>,
  clientModsList: () =>
    ipcRenderer.invoke('server:clientmods-list') as Promise<{ file: string; sizeMB: number; warning?: string }[]>,
  // Faz 14: offline skin destegi (SkinsRestorer)
  skinStatus: () => ipcRenderer.invoke('server:skin-status') as Promise<{ installed: string | null }>,
  skinInstall: () =>
    ipcRenderer.invoke('server:skin-install') as Promise<{ ok: boolean; installed?: string; skipped?: string }>,
  clientModsDelete: (file: string) =>
    ipcRenderer.invoke('server:clientmods-delete', file) as Promise<void>,
  pluginsAdd: () => ipcRenderer.invoke('server:plugins-add') as Promise<{ added: string | null; dir: string }>,
  localVersion: (mcVersion: string) =>
    ipcRenderer.invoke('server:local-version', mcVersion) as Promise<string | null>,
  modsPlanSync: (host: string) =>
    ipcRenderer.invoke('mods:plan-sync', { host }) as Promise<{
      host: string
      toDownload: { filename: string; sha256: string; sizeBytes: number }[]
      upToDate: string[]
      manifestTotal: number
    }>,
  modsSync: (host: string) =>
    ipcRenderer.invoke('mods:sync', { host }) as Promise<{ ok: boolean; downloaded: string[]; failed?: string }>,
  hostProfile: (host: string) =>
    ipcRenderer.invoke('mods:host-profile', { host }) as Promise<{
      loader: string
      loaderVersion: string
      mcVersion: string
      publishedAt: string
    } | null>,
  fabricEnsure: (mcVersion: string, loaderVersion: string) =>
    ipcRenderer.invoke('mods:fabric-ensure', { mcVersion, loaderVersion }) as Promise<{
      localVersionId: string
      fabricApi?: { ok: boolean; installed?: string; skipped?: string }
    }>,

  // Faz 7: plugin senkronizasyonu (arkadas tarafi)
  pluginsPlanSync: (host: string) => ipcRenderer.invoke('plugins:plan-sync', { host }),
  pluginsSync: (host: string) => ipcRenderer.invoke('plugins:sync', { host }),

  // Faz 8: profiller + istatistikler
  profilesList: () => ipcRenderer.invoke('server:profiles-list'),
  profileSwitch: (name: string) => ipcRenderer.invoke('server:profiles-switch', name),
  profileCreate: (name: string) => ipcRenderer.invoke('server:profiles-create', name),
  profileDelete: (name: string) => ipcRenderer.invoke('server:profiles-delete', name),
  /** Profilin en son basarili baslatilan surumu (secici otomatik ayar). */
  profileLastVersion: () => ipcRenderer.invoke('server:profile-last-version') as Promise<string | null>,
  serverStats: () => ipcRenderer.invoke('server:stats'),
  getWhitelist: () => ipcRenderer.invoke('server:whitelist'),
  whitelistAdd: (nick: string) => ipcRenderer.invoke('server:whitelist-add', nick),
  whitelistRemove: (nick: string) => ipcRenderer.invoke('server:whitelist-remove', nick),
  whitelistEnsure: (nick: string) => ipcRenderer.invoke('server:whitelist-ensure', nick),

  // Oyun event'leri (main -> renderer)
  onGameEvent: (cb: (ev: GameEventBridge) => void) => {
    const listener = (_e: unknown, ev: GameEventBridge) => cb(ev)
    ipcRenderer.on('game:event', listener)
    return () => ipcRenderer.removeListener('game:event', listener)
  },

  // Faz 11: guncelleme olaylari (main -> renderer)
  onAppUpdateEvent: (cb: (ev: AppUpdateEvent) => void) => {
    const listener = (_e: unknown, ev: AppUpdateEvent) => cb(ev)
    ipcRenderer.on('app:update-event', listener)
    return () => ipcRenderer.removeListener('app:update-event', listener)
  }
})
