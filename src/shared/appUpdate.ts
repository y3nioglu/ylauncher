// Faz 11: guncelleme tipleri — main, preload ve renderer'in ortak kullandigi
// sozlesme (renderer'a kopya tanim yazmamak icin burada yasar).
export type AppUpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'not-available'
  | 'error'

export interface AppUpdateInfo {
  status: AppUpdateStatus
  currentVersion: string
  availableVersion: string | null
  progress: number | null
  error: string | null
}

/** main -> renderer push event payload'u (info ile ayni sekil). */
export type AppUpdateEvent = AppUpdateInfo
