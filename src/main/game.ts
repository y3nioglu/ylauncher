import { EventEmitter } from 'node:events'
import { spawn, ChildProcess } from 'node:child_process'
import path from 'node:path'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { Client, Authenticator } from 'minecraft-launcher-core'
import {
  fetchVersionManifest,
  resolveJavaMajor,
  estimateJavaMajor,
  type ManifestEntry
} from './mcmeta'
import { ensureJava } from './java'

export interface VersionEntry extends ManifestEntry {}

export interface LaunchOptions {
  versionId: string
  nickname: string
  minRamMB: number
  maxRamMB: number
  serverAddress?: string
  javaPathOverride?: string
  /** Faz 12: yerel ozel surum id (orn. fabric-loader-0.16.14-1.21.1) —
   * verildiginde manifest'te ARANMAZ, dogrudan versions/<id>/ profilinden
   * baslatilir (Fabric kutuphanelerini launcher-core indirir). */
  localVersionId?: string
  /** Faz 15: ek JVM argumanlari (performans on ayarlari GC bayraklari). */
  customArgs?: string[]
}

export type GameEvent =
  | { type: 'status'; message: string }
  | { type: 'progress'; percent: number; label: string }
  | { type: 'log'; line: string }
  | { type: 'started' }
  | { type: 'close'; code: number | null }
  | { type: 'error'; message: string }

export class GameLauncher extends EventEmitter {
  private child: ChildProcess | null = null
  private busy = false
  /** Faz 15: acik oyun oturumunun baslangic ts'i (playtime takibi). */
  private playStartTs = 0

  constructor(private root: string) {
    super()
    mkdirSync(this.root, { recursive: true })
    mkdirSync(path.join(this.root, 'java'), { recursive: true })
  }

  private emitEvent(ev: GameEvent) {
    this.emit('game-event', ev)
  }

  // ---- Surum listesi ----
  async listVersions(): Promise<{ latestRelease: string; versions: VersionEntry[] }> {
    return fetchVersionManifest()
  }

  // ---- Bilgisayara indirilmis surumler ----
  async listInstalledVersions(): Promise<string[]> {
    const { existsSync } = await import('node:fs')
    const { readdir } = await import('node:fs/promises')
    const versionsDir = path.join(this.root, 'versions')
    if (!existsSync(versionsDir)) return []
    const entries = await readdir(versionsDir, { withFileTypes: true }).catch(() => [])
    const installed: string[] = []
    for (const e of entries) {
      if (!e.isDirectory()) continue
      if (existsSync(path.join(versionsDir, e.name, `${e.name}.jar`))) {
        installed.push(e.name)
      }
    }
    return installed
  }

  // ---- Oyunu baslat ----
  async launch(opts: LaunchOptions): Promise<void> {
    if (this.busy || this.child) {
      throw new Error('Zaten bir oyun calisiyor veya hazirlaniyor.')
    }
    this.busy = true

    try {
      // Faz 12: yerel ozel surum (Fabric) — manifest'te yok, versions/ altindaki
      // profil JSON'uyla baslatilir. Java major'u vanilla es-surumden tahmin edilir.
      let entry: ManifestEntry | undefined
      if (opts.localVersionId) {
        const { getLocalProfile } = await import('./fabric')
        const prof = getLocalProfile(this.root, opts.versionId)
        if (!prof || prof.localVersionId !== opts.localVersionId) {
          throw new Error(`Yerel profil bulunamadi: ${opts.localVersionId}`)
        }
        try {
          const manifest = await this.listVersions()
          entry = manifest.versions.find((v) => v.id === opts.versionId)
        } catch {
          entry = undefined
        }
      } else {
        const manifest = await this.listVersions()
        entry = manifest.versions.find((v) => v.id === opts.versionId)
        if (!entry) throw new Error(`${opts.versionId} surumu bulunamadi.`)
      }

      const javaMajor = entry
        ? await resolveJavaMajor(entry)
        : estimateJavaMajor(opts.versionId)
      this.emitEvent({ type: 'status', message: `Java ${javaMajor} gerekiyor` })
      const javaPath = await ensureJava(javaMajor, path.join(this.root, 'java'), {
        javaPathOverride: opts.javaPathOverride,
        onStatus: (m) => this.emitEvent({ type: 'status', message: m }),
        onProgress: (percent, label) => this.emitEvent({ type: 'progress', percent, label })
      })

      const authorization = await Authenticator.getAuth(opts.nickname) // offline auth
      const launcher = new Client()

      launcher.on('debug', (e: string) => this.emitEvent({ type: 'log', line: `[debug] ${e}` }))
      launcher.on('data', (e: string) => this.emitEvent({ type: 'log', line: String(e).trimEnd() }))
      launcher.on('progress', (e: { type?: string; task?: number; total?: number }) => {
        if (e.total) {
          this.emitEvent({
            type: 'progress',
            percent: Math.min(100, Math.round((e.task! / e.total) * 100)),
            label: 'Oyun dosyalari'
          })
        }
      })
      launcher.on('download-status', (e: { name?: string; type?: string; current?: number; total?: number }) => {
        if (e.total) {
          this.emitEvent({
            type: 'progress',
            percent: Math.min(100, Math.round((e.current! / e.total) * 100)),
            label: `Indiriliyor: ${path.basename(String(e.name ?? ''))}`
          })
        }
      })

      this.emitEvent({ type: 'status', message: 'Minecraft baslatiliyor (ilk indirme surebilir)...' })
      // Sunucuya otomatik baglanti: 1.20+ icin QuickPlay (--quickPlayMultiplayer).
      // Eski --server argumani modern surumlerde TAMAMEN YOK SAYILIR (canlida yasandi:
      // "Completely ignored arguments: [--server, ...]").
      // Yerel cok oyunculu son kullanicinin son sunucusunu ezmesin diye profile yazmiyoruz.
      const quickPlay = opts.serverAddress ? [`--quickPlayMultiplayer`, opts.serverAddress] : []
      // Faz 12: MCLC sozlesmesi — number: VANILLA surum (Mojang manifest'inde
      // aranir; vanilla kutuphane/arguman kaynagi), custom: yerel profil klasoru
      // (versions/<custom>/<custom>.json). MCLC custom JSON kutuphanelerini
      // vanilla ile otomatik birlestirir ve mainClass olarak Fabric Knot'u
      // kullanir; vanilla jar'i versions/<custom>/ altina kendisi indirir.
      let overrides: { minecraftJar?: string } | undefined
      if (opts.localVersionId) {
        const profJson = path.join(this.root, 'versions', opts.localVersionId, `${opts.localVersionId}.json`)
        if (!existsSync(profJson)) {
          throw new Error('Fabric profil dosyasi yok — Sunucu Listesi\u0027nden tekrar Katil deneyin.')
        }
        // Vanilla jar zaten indirildiyse override ile gec — MCLC ~25 MB'lik
        // vanilla client'i tekrar indirmesin.
        const vanillaJar = path.join(this.root, 'versions', opts.versionId, `${opts.versionId}.jar`)
        if (existsSync(vanillaJar)) overrides = { minecraftJar: vanillaJar }
      }
      const child = await launcher.launch({
        root: this.root,
        version: {
          number: opts.versionId,
          type: entry?.type ?? 'release',
          custom: opts.localVersionId
        },
        memory: { min: opts.minRamMB, max: opts.maxRamMB },
        javaPath,
        authorization,
        customLaunchArgs: quickPlay,
        ...(opts.customArgs?.length ? { customArgs: opts.customArgs } : {}),
        ...(overrides ? { overrides } : {})
      })

      if (!child) throw new Error('Oyun sureci baslatilamadi.')
      this.child = child
      this.playStartTs = Date.now()
      this.emitEvent({ type: 'started' })

      child.on('close', (code) => {
        this.child = null
        this.busy = false
        this.recordPlaySessionEnd()
        this.emitEvent({ type: 'close', code })
      })
      child.on('error', (err) => {
        this.emitEvent({ type: 'error', message: err.message })
      })
    } catch (err) {
      this.busy = false
      const message = err instanceof Error ? err.message : String(err)
      this.emitEvent({ type: 'error', message })
      throw err
    }
  }

  stop(): void {
    if (!this.child) return
    this.recordPlaySessionEnd()
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(this.child.pid), '/T', '/F'])
    } else {
      this.child.kill('SIGTERM')
    }
  }

  /**
   * Faz 15: oturum sonunda playtime.json'a sure yazar (profil karti verisi).
   * Hata sessizce yutulur — istatistik kaybi oyunu etkilemez.
   */
  private recordPlaySessionEnd(): void {
    if (!this.playStartTs) return
    const durationMs = Math.max(0, Date.now() - this.playStartTs)
    this.playStartTs = 0
    try {
      const file = path.join(this.root, 'playtime.json')
      let data: { totalMs?: number; sessions?: Array<{ start: string; end: string }> } = {}
      if (existsSync(file)) {
        try {
          data = JSON.parse(readFileSync(file, 'utf8'))
        } catch {
          /* bozuk dosya: sifirla */
        }
      }
      data.totalMs = (data.totalMs ?? 0) + durationMs
      data.sessions = [...(data.sessions ?? []), { start: new Date().toISOString(), end: new Date().toISOString() }].slice(-500)
      writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
    } catch {
      /* disk hatasi: yut */
    }
  }

  isRunning(): boolean {
    return !!this.child
  }
}
