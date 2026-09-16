// Faz 11: otomatik guncelleme (electron-updater).
//
// Kurulum: electron-builder, yayin paketini (NSIS installer + latest.yml)
// sunucunun /downloads dizinine kopyalar; electron-updater baslangicta
// <API_BASE>/downloads/latest.yml dosyasini okuyup yeni surum varsa indirir.
// Kod imzalama olmadigi (arkadas grubu icin sertifika maliyeti gereksiz)
// icin Windows'ta SmartScreen uyarisi normaldir.
import { app, BrowserWindow } from 'electron'
import electronUpdater from 'electron-updater'
import { getApiBase } from '../shared/apiBase'
import type { AppUpdateInfo, AppUpdateStatus } from '../shared/appUpdate'

const { autoUpdater } = electronUpdater

export type { AppUpdateInfo, AppUpdateStatus }

let status: AppUpdateStatus = 'idle'
let availableVersion: string | null = null
let progress: number | null = null
let lastError: string | null = null

function broadcast(): void {
  const ev = getInfo()
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('app:update-event', ev)
  }
}

export function getInfo(): AppUpdateInfo {
  return {
    status,
    currentVersion: app.getVersion(),
    availableVersion,
    progress,
    error: lastError
  }
}

export function initUpdater(): void {
  // Gelistirme modunda (paketlenmemis) updater calismaz — kurulacak uygulama
  // yolu yoktur; karisik hata durumlarini onlemek icin sessizce devre disi.
  if (!app.isPackaged) {
    status = 'not-available'
    return
  }
  // Sunucunun /downloads dizinini guncelleme kaynagi olarak kullan:
  // <API_BASE>/downloads/latest.yml
  autoUpdater.setFeedURL({
    provider: 'generic',
    url: `${getApiBase()}/downloads` // canli okur: Ayarlar'dan API degisirse sonraki kontrol oraya bakar
  })
  autoUpdater.autoDownload = false // indirme kararini UI'ya birak
  autoUpdater.autoInstallOnAppQuit = true // indiyse cikista da kurulur

  autoUpdater.on('checking-for-update', () => {
    status = 'checking'
    lastError = null
    broadcast()
  })
  autoUpdater.on('update-available', (info) => {
    status = 'available'
    availableVersion = info.version ?? null
    broadcast()
  })
  autoUpdater.on('update-not-available', () => {
    status = 'not-available'
    availableVersion = null
    progress = null
    broadcast()
  })
  autoUpdater.on('download-progress', (p) => {
    status = 'downloading'
    progress = Math.round(p.percent ?? 0)
    broadcast()
  })
  autoUpdater.on('update-downloaded', (info) => {
    status = 'downloaded'
    availableVersion = info.version ?? availableVersion
    progress = 100
    broadcast()
  })
  autoUpdater.on('error', (err) => {
    // Sunucuya ulasilamama (offline/VPS kapali) dogal bir durum: sadece durumda
    // tut, UI sessizce gosterir. Uygulamayi etkilemez.
    status = 'error'
    lastError = err instanceof Error ? err.message : String(err)
    broadcast()
  })

  // Baslangicta sessiz kontrol; app ready olmadan cagrilmasin.
  if (app.isReady()) void checkForUpdates()
  else app.once('ready', () => void checkForUpdates())
}

export async function checkForUpdates(): Promise<void> {
  try {
    await autoUpdater.checkForUpdates()
  } catch {
    /* error event'i zaten broadcast eder */
  }
}

export async function downloadAppUpdate(): Promise<boolean> {
  try {
    await autoUpdater.downloadUpdate()
    return true
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err)
    broadcast()
    return false
  }
}

export function installAppUpdate(): void {
  // Uygulamayi kapatip kurulumu calistirir; kapanis akisi (sunucu stop +
  // duyuru geri cekme) index.ts'teki before-quit handler'iyla ayni sekilde isler.
  autoUpdater.quitAndInstall(false, true)
}
