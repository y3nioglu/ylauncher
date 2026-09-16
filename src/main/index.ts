import { app, BrowserWindow, shell, ipcMain } from 'electron'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GameLauncher } from './game'
import { ServerManager, type ServerStatus } from './server'
import { suppressGamingOverlayPopup } from './gamingOverlay'
import { initUpdater, getInfo, downloadAppUpdate, installAppUpdate } from './updater'
import { listFabricLoaders } from './fabric'
import { getApiBase, setApiBaseOverride } from '../shared/apiBase'

interface GameSettings {
  minRamMB: number
  maxRamMB: number
  javaPathOverride?: string
  wizardDone?: boolean
  theme?: 'dark' | 'light'
  apiBaseOverride?: string
}

// Canli API adresi: varsayilan paylasilan modulden gelir; asagida Ayarlar'dan
// gelen override yuklenir (paket kurulumlarinda localhost yerine VPS adresi).
const apiBase = () => getApiBase()
const GAME_ROOT = path.join(app.getPath('appData'), 'ylauncher')
const SETTINGS_FILE = path.join(GAME_ROOT, 'settings.json')

const DEFAULT_SETTINGS: GameSettings = { minRamMB: 1024, maxRamMB: 4096 }

// ---- RAM siniri ----------------------------------------------------------
// Kullanici, sisteminin kaldiramayacagi RAM degeri secemesin: ust sinir
// toplam fiziksel RAM'in %75'i (JS/OS payi birakilir), en az 1 GB, GB'ya
// yuvarlanir. Ornek: 12 GB'lik makinede ust sinir 9 GB -> 16 GB secim reddedilir.
function systemRamCapMB(): number {
  const totalMB = Math.round(os.totalmem() / (1024 * 1024))
  const cap = Math.floor((totalMB * 0.75) / 1024) * 1024
  return Math.max(1024, cap)
}

function clampRam(mb: number): number {
  const cap = systemRamCapMB()
  return Math.max(512, Math.min(cap, Math.round(mb)))
}

function loadSettings(): GameSettings {
  try {
    if (existsSync(SETTINGS_FILE)) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) }
    }
  } catch {
    // bozuk ayar dosyasi -> varsayilanlara don
  }
  return DEFAULT_SETTINGS
}

function saveSettings(s: GameSettings): void {
  writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2), 'utf8')
}

// Ayar dosyasindaki API override'unu canli cozumleyiciye uygular (acilista).
setApiBaseOverride(loadSettings().apiBaseOverride)

/** Kullanicinin girdigi adresi http(s):// ekleyip sondaki /'u temizleyerek normalize eder. */
function normalizeApiBaseInput(input: string): string {
  let v = input.trim().replace(/\/$/, '')
  if (v && !/^https?:\/\//i.test(v)) v = `http://${v}`
  return v
}

const game = new GameLauncher(GAME_ROOT)
const serverManager = new ServerManager(GAME_ROOT)

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1080,
    height: 700,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // Dis linkleri varsayilan tarayiciyla ac
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // Oyun + sunucu event'lerini acik olan tum pencerelere ile
  const forward = (ev: unknown) => {
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send('game:event', ev)
    }
  }
  game.on('game-event', forward)
  serverManager.on('server-event', forward)

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

// ---- IPC ---------------------------------------------------------------
ipcMain.handle('game:list-versions', () => game.listVersions())

ipcMain.handle('game:launch', async (_e, opts: Parameters<GameLauncher['launch']>[0]) => {
  const settings = loadSettings()
  await game.launch({
    ...opts,
    minRamMB: opts.minRamMB ?? settings.minRamMB,
    maxRamMB: opts.maxRamMB ?? settings.maxRamMB,
    javaPathOverride: opts.javaPathOverride ?? settings.javaPathOverride
  })
})

ipcMain.handle('game:stop', () => game.stop())
ipcMain.handle('game:is-running', () => game.isRunning())
ipcMain.handle('game:list-installed', () => game.listInstalledVersions())

ipcMain.handle('game:get-settings', () => loadSettings())
ipcMain.handle('game:save-settings', (_e, s: GameSettings) => {
  // wizardDone: kurulum sihirbazi kaldirildi — bayrak geriye uyumluluk icin
  // her zaman true yazilir (eski ayar dosyalarindaki false de temizlenir).
  // apiBaseOverride: renderer gondermiyorsa mevcut deger korunur.
  const prev = loadSettings()
  const nextOverride =
    s.apiBaseOverride !== undefined ? normalizeApiBaseInput(s.apiBaseOverride) || undefined : prev.apiBaseOverride
  setApiBaseOverride(nextOverride)
  saveSettings({
    minRamMB: clampRam(Number(s.minRamMB) || 1024),
    maxRamMB: clampRam(Number(s.maxRamMB) || 4096),
    javaPathOverride: s.javaPathOverride?.trim() || undefined,
    wizardDone: true,
    theme: s.theme === 'light' ? 'light' : 'dark',
    apiBaseOverride: nextOverride
  })
})

// Faz 12.5: API adresini calisma aninda degistirme (paket kurulumlari VPS'e
// yonlendirme). null/'' = varsayilana don. Yeni adresi dondurur.
ipcMain.handle('app:set-api-base', (_e, base: string | null) => {
  const normalized = typeof base === 'string' ? normalizeApiBaseInput(base) : ''
  setApiBaseOverride(normalized || null)
  const s = loadSettings()
  const { apiBaseOverride: _ignored, ...rest } = s
  saveSettings(normalized ? { ...rest, apiBaseOverride: normalized } : rest)
  return getApiBase()
})

ipcMain.handle('app:get-info', () => ({
  gameRoot: GAME_ROOT,
  apiBase: getApiBase(),
  version: __APP_VERSION__,
  build: __APP_BUILD__,
  ramCapMB: systemRamCapMB()
}))

ipcMain.handle('app:api-health', async () => {
  try {
    const res = await fetch(`${apiBase()}/api/health`, { signal: AbortSignal.timeout(4000) })
    if (!res.ok) return { online: false, db: false }
    const body = (await res.json()) as { ok?: boolean; db?: string }
    return { online: true, db: body.db === 'up' }
  } catch {
    return { online: false, db: false }
  }
})

// ---- Sunucu (Faz 4) --------------------------------------------------
ipcMain.handle('server:list-paper-versions', () => serverManager.listPaperVersions())
ipcMain.handle('server:tunnel-restart', () => serverManager.restartTunnel())
ipcMain.handle('server:set-api-token', (_e, token: string | null) => {
  serverManager.setApiToken(typeof token === 'string' && token ? token : null)
})
// Faz 5a: TCP canlilik kontrolu (Minecraft status ping'iyle ayni fikir, daha basit)
ipcMain.handle('server:probe', async (_e, p: { host: string; port: number }) => {
  const net = await import('node:net')
  return new Promise<{ ok: boolean; error?: string }>((resolve) => {
    const sock = new net.Socket()
    const done = (r: { ok: boolean; error?: string }) => {
      sock.destroy()
      resolve(r)
    }
    sock.setTimeout(4000)
    sock.once('connect', () => done({ ok: true }))
    sock.once('timeout', () => done({ ok: false, error: 'zaman asimi' }))
    sock.once('error', (err) => done({ ok: false, error: err.message }))
    sock.connect(p.port, p.host)
  })
})
ipcMain.handle('server:start', (_e, opts: { mcVersion: string; ramMaxMB?: number }) =>
  serverManager.start({ ...opts, ramMaxMB: opts.ramMaxMB ? clampRam(opts.ramMaxMB) : undefined })
)
ipcMain.handle('server:stop', () => serverManager.stop())
ipcMain.handle('server:restart', () => serverManager.restart())
ipcMain.handle('server:status', (): ServerStatus => serverManager.getStatus())
// ---- Faz 6: izleme + komut + admin + props + yedek + plugin/world ----
ipcMain.handle('server:monitor', () => serverManager.getMonitor())
ipcMain.handle('server:command', (_e, cmd: string) => serverManager.sendCommand(String(cmd ?? '')))
ipcMain.handle(
  'server:admin-action',
  (_e, p: { action: 'op' | 'deop' | 'ban' | 'kick' | 'pardon' | 'pardon-ip'; nickname: string }) =>
    serverManager.adminAction(p.action, String(p.nickname ?? ''))
)
ipcMain.handle('server:bans-list', () => serverManager.listBans())
ipcMain.handle('server:props-read', () => serverManager.readProps())
ipcMain.handle('server:props-write', (_e, patch: Record<string, string>) => serverManager.writeProps(patch ?? {}))
// ---- Faz 8: profiller + istatistikler ----
ipcMain.handle('server:profiles-list', () => serverManager.getProfiles())
  // Profil bazli surum hatirlama: secici dogru surume otomatik ayarlansin
  ipcMain.handle('server:profile-last-version', () => serverManager.getProfileLastVersion())
ipcMain.handle('server:profiles-switch', (_e, name: string) => serverManager.switchProfile(String(name)))
ipcMain.handle('server:profiles-create', (_e, name: string) => serverManager.addProfile(String(name)))
ipcMain.handle('server:profiles-delete', (_e, name: string) => serverManager.removeProfile(String(name)))
ipcMain.handle('server:stats', () => serverManager.getStats())
ipcMain.handle('server:backup-create', (_e, label?: string) => serverManager.backupNow(label))
ipcMain.handle('server:backup-list', () => serverManager.listBackups())
ipcMain.handle('server:backup-delete', (_e, file: string) => serverManager.deleteBackup(String(file)))
ipcMain.handle('server:backup-restore', (_e, file: string) => serverManager.restoreBackup(String(file)))
ipcMain.handle('server:plugins-list', () => serverManager.listPlugins())
ipcMain.handle('server:plugins-set', (_e, p: { file: string; enabled: boolean }) =>
  serverManager.setPluginEnabled(String(p.file), !!p.enabled)
)
ipcMain.handle('server:plugins-delete', (_e, file: string) => serverManager.deletePlugin(String(file)))
ipcMain.handle('server:worlds-list', () => serverManager.listWorlds())
ipcMain.handle('server:worlds-delete', (_e, name: string) => serverManager.deleteWorld(String(name)))
ipcMain.handle('server:world-create', (_e, name?: string) => serverManager.createWorld(name))
ipcMain.handle('server:world-import', async (_e, p: { mode: 'zip' | 'folder'; name?: string }) => {
  const picked = await serverManager.pickWorldSource(p.mode)
  if (picked.canceled || !picked.path) return { canceled: true }
  const r = await serverManager.importWorld(picked.path, p.name)
  return { canceled: false, ...r }
})
ipcMain.handle('server:datapacks-list', () => serverManager.listDatapacks())
ipcMain.handle('server:datapacks-delete', (_e, file: string) => serverManager.deleteDatapack(String(file)))
// ---- Faz 12: client mod senkronizasyonu ----
ipcMain.handle('server:fabric-loaders', () => listFabricLoaders())
ipcMain.handle('server:fabric-status', () =>
  serverManager.getFabricStatus()
)
ipcMain.handle('server:fabric-set', (_e, version: string | null) =>
  serverManager.setFabricLoader(version)
)
ipcMain.handle('server:clientmods-publish-now', () => serverManager.publishClientModsNow())
ipcMain.handle('server:clientmods-dir', () => serverManager.getClientModsDir())
ipcMain.handle('server:clientmods-add', () => serverManager.addClientModFile())
ipcMain.handle('server:clientmods-list', () => serverManager.listClientMods())
ipcMain.handle('server:clientmods-delete', (_e, file: string) => serverManager.deleteClientMod(String(file)))
ipcMain.handle('server:plugins-add', () => serverManager.addPluginFile())
ipcMain.handle('server:local-version', (_e, mcVersion: string) => serverManager.getLocalVersionId(mcVersion))
ipcMain.handle('mods:plan-sync', async (_e, p: { host: string }) => {
  const token = serverManager.getApiToken()
  if (!token) throw new Error('Oturum bulunamadi — mod senkronu icin giris gerekli.')
  const { planModsSync } = await import('./downloadMods')
  return planModsSync({ token, host: String(p.host), modsDir: path.join(GAME_ROOT, 'mods') })
})
ipcMain.handle('mods:sync', async (_e, p: { host: string }) => {
  const token = serverManager.getApiToken()
  if (!token) throw new Error('Oturum bulunamadi — mod senkronu icin giris gerekli.')
  const { planModsSync, syncMods } = await import('./downloadMods')
  const plan = await planModsSync({ token, host: String(p.host), modsDir: path.join(GAME_ROOT, 'mods') })
  const result = await syncMods({ token, plan, modsDir: path.join(GAME_ROOT, 'mods') })
  if (!result.ok) throw new Error(result.failed ?? 'Mod senkronu basarisiz.')
  return result
})
ipcMain.handle('mods:host-profile', async (_e, p: { host: string }) => {
  const token = serverManager.getApiToken()
  if (!token) throw new Error('Oturum bulunamadi — profil icin giris gerekli.')
  const res = await fetch(`${apiBase()}/api/clientmods/profile?host=${encodeURIComponent(String(p.host))}`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  if (!res.ok) return null
  const body = (await res.json()) as { profile?: {
    loader: string
    loaderVersion: string
    mcVersion: string
    publishedAt: string
  } | null }
  return body.profile ?? null
})
ipcMain.handle('mods:fabric-ensure', async (_e, p: { mcVersion: string; loaderVersion: string }) => {
  const { ensureFabricProfile, ensureFabricApi } = await import('./fabric')
  const prof = await ensureFabricProfile({
    gameRoot: GAME_ROOT,
    mcVersion: String(p.mcVersion),
    loaderVersion: String(p.loaderVersion),
    onStatus: (m) => {
      for (const w of BrowserWindow.getAllWindows()) {
        w.webContents.send('game:event', { type: 'status', message: m })
      }
    }
  })
  // Faz 12.5: Fabric modlarinin cogu fabric-api ister — eksikse Modrinth'ten
  // otomatik indirilir. Basarisizlik katilmayi engellemez (host modu yine de
  // oyunu crash ettirebilir; durum notu UI'da gorunur).
  const api = await ensureFabricApi({
    gameRoot: GAME_ROOT,
    mcVersion: String(p.mcVersion),
    onStatus: (m) => {
      for (const w of BrowserWindow.getAllWindows()) {
        w.webContents.send('game:event', { type: 'status', message: m })
      }
    }
  })
  return { localVersionId: prof.localVersionId, fabricApi: api }
})
// ---- Faz 7: plugin senkronizasyonu (arkadas tarafi) ----
ipcMain.handle(
  'plugins:plan-sync',
  async (_e, p: { host: string }) => {
    const token = serverManager.getApiToken()
    if (!token) throw new Error('Oturum bulunamadi — plugin senkronu icin giris gerekli.')
    const { planPluginSync } = await import('./downloadPlugins')
    return planPluginSync({
      token,
      host: String(p.host),
      pluginsDir: path.join(GAME_ROOT, 'plugins')
    })
  }
)
ipcMain.handle(
  'plugins:sync',
  async (_e, p: { host: string }) => {
    const token = serverManager.getApiToken()
    if (!token) throw new Error('Oturum bulunamadi — plugin senkronu icin giris gerekli.')
    const { planPluginSync, syncPlugins } = await import('./downloadPlugins')
    const plan = await planPluginSync({
      token,
      host: String(p.host),
      pluginsDir: path.join(GAME_ROOT, 'plugins')
    })
    const result = await syncPlugins({
      token,
      plan,
      pluginsDir: path.join(GAME_ROOT, 'plugins')
    })
    if (!result.ok) throw new Error(result.failed ?? 'Plugin senkronu basarisiz.')
    return result
  }
)
ipcMain.handle('server:whitelist', () => serverManager.listWhitelist())
ipcMain.handle('server:whitelist-add', (_e, nick: string) => serverManager.whitelistAdd(nick))
ipcMain.handle('server:whitelist-remove', (_e, nick: string) => serverManager.whitelistRemove(nick))
// Faz 5c: onaylanan whitelist isteginde tek cagri ile whitelist'e ekle
ipcMain.handle('server:whitelist-ensure', (_e, nick: string) => serverManager.whitelistAdd(nick))

// ---- Faz 11: otomatik guncelleme ----
initUpdater()
ipcMain.handle('app:update-info', () => getInfo())
ipcMain.handle('app:update-download', () => downloadAppUpdate())
ipcMain.handle('app:update-install', () => installAppUpdate())

console.log(`[app] MC Friends Launcher v${__APP_VERSION__} (build: ${__APP_BUILD__})`)

// ---- Uygulama omru ------------------------------------------------------
app.whenReady().then(() => {
  // Windows "ms-gamingoverlay edinin" pop-up'ini bastir (HKCU, admin gerekmez)
  void suppressGamingOverlayPopup()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Launcher kapanirken oyunu ve sunucuyu da kapat.
// Electron before-quit'te async is beklemez; preventDefault ile quit'i durdurup
// temizligi (stop + duyuru geri cekme) bitirince app.exit() ile cikiyoruz.
let quitting = false
app.on('before-quit', (event) => {
  if (quitting) return
  quitting = true
  event.preventDefault()
  game.stop()
  void serverManager
    .shutdown()
    .catch(() => {})
    .finally(() => {
      // app.quit() yerine app.exit(): quit tekrar before-quit tetikler,
      // app.exit() dogrudan cikar (SSE/fetch pollleri event loop'u tutabilir).
      app.exit(0)
    })
})
