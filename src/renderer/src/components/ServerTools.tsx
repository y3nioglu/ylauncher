// Faz 6: gelismis sunucu araclari — server.properties editoru, op/ban/kick,
// yedekleme (manuel + zamanlanmis otomatik + geri yukleme), plugin yonetimi
// (ac/kapat/sil) ve dunya/datapack yonetimi.
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  GameBridge,
  PropRow,
  BackupInfo,
  PluginInfo,
  WorldInfo,
  DatapackInfo,
  ServerStatsInfo2
} from '../lib/game'

interface Props {
  bridge: GameBridge
  running: boolean
  onNotify: (msg: string | null) => void
}

const GAMEMODES = ['survival', 'creative', 'adventure', 'spectator']
const DIFFICULTIES = ['peaceful', 'easy', 'normal', 'hard']

export default function ServerTools({ bridge, running, onNotify }: Props) {
  const [tab, setTab] = useState<'props' | 'admin' | 'backup' | 'plugins' | 'world' | 'stats' | 'mods'>('props')

  // ---- istatistikler (Faz 8) ----
  const [stats, setStats] = useState<ServerStatsInfo2 | null>(null)
  useEffect(() => {
    const load = () => bridge.serverStats().then(setStats).catch(() => {})
    load()
    const t = setInterval(load, 30_000)
    return () => clearInterval(t)
  }, [bridge])

  // ---- props ----
  const [props, setProps] = useState<PropRow[]>([])
  const [propsDraft, setPropsDraft] = useState<Record<string, string>>({})
  const [propsNote, setPropsNote] = useState<string | null>(null)

  // ---- admin ----
  const [adminNick, setAdminNick] = useState('')
  const [bans, setBans] = useState<{
    players: { name: string; reason?: string; created?: string }[]
    ips: { ip: string; reason?: string; created?: string }[]
  }>({ players: [], ips: [] })

  // ---- world: yeni dunya adi girisi (Electron window.prompt DESTEKLEMEZ —
  // satir ici girdi kullanilir) ----
  const [newWorldName, setNewWorldName] = useState('')
  const [worldBusy, setWorldBusy] = useState(false)

  // ---- backup ----
  const [backups, setBackups] = useState<BackupInfo[]>([])
  const [backupBusy, setBackupBusy] = useState(false)

  // ---- plugins ----
  const [plugins, setPlugins] = useState<PluginInfo[]>([])

  // ---- Faz 14: offline skin destegi (SkinsRestorer) ----
  const [skinInstalled, setSkinInstalled] = useState<string | null>(null)
  const [skinBusy, setSkinBusy] = useState(false)

  // ---- Faz 12: modlar (clientMods/ + Fabric loader) ----
  const [fabricLoaders, setFabricLoaders] = useState<string[]>([])
  const [fabricStatus, setFabricStatus] = useState<{ loaderVersion: string | null; paperVersion: string | null } | null>(null)
  const [modsNote, setModsNote] = useState<string | null>(null)
  const [modsBusy, setModsBusy] = useState(false)
  const [clientMods, setClientMods] = useState<{ file: string; sizeMB: number; warning?: string }[]>([])
  const [modsDir, setModsDir] = useState<string | null>(null)

  const loadMods = useCallback(() => {
    bridge.fabricStatus().then(setFabricStatus).catch(() => {})
    bridge.clientModsList().then(setClientMods).catch(() => {})
    bridge.clientModsDir().then(setModsDir).catch(() => {})
  }, [bridge])

  // Loader listesi yalnizca ilk acilista cekilir (Fabric meta API)
  useEffect(() => {
    if (tab === 'mods' && fabricLoaders.length === 0) {
      bridge.fabricLoaders().then(setFabricLoaders).catch(() => setModsNote('Fabric surumleri alinamadi — internet baglantisi gerekli.'))
    }
  }, [tab, bridge, fabricLoaders.length])

  // ---- world ----
  const [worlds, setWorlds] = useState<WorldInfo[]>([])
  const [datapacks, setDatapacks] = useState<DatapackInfo[]>([])

  const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

  const loadProps = useCallback(() => {
    bridge
      .readProps()
      .then((rows) => {
        setProps(rows)
        setPropsDraft(Object.fromEntries(rows.filter((r) => r.editable).map((r) => [r.key, r.value])))
      })
      .catch((e) => setPropsNote(errText(e)))
  }, [bridge])

  const loadBackups = useCallback(() => {
    bridge.backupList().then(setBackups).catch(() => {})
  }, [bridge])

  const loadPlugins = useCallback(() => {
    bridge.pluginsList().then(setPlugins).catch(() => {})
  }, [bridge])

  const loadBans = useCallback(() => {
    bridge.bansList().then(setBans).catch(() => {})
  }, [bridge])

  const loadWorlds = useCallback(() => {
    bridge.worldsList().then(setWorlds).catch(() => {})
    bridge.datapacksList().then(setDatapacks).catch(() => {})
  }, [bridge])

  // Agir yuklemeleri acilan sekmeye gore yap (hantallik fix'i: panel acilir
  // acilmaz 5 kaynagi birden sorgulamak yerine yalnizca aktif sekme yuklenir).
  useEffect(() => {
    if (tab === 'props') loadProps()
    else if (tab === 'backup') loadBackups()
    else if (tab === 'plugins') {
      loadPlugins()
      bridge.skinStatus().then((s) => setSkinInstalled(s.installed)).catch(() => {})
    }
    else if (tab === 'world') loadWorlds()
    else if (tab === 'admin') loadBans()
  }, [tab, loadProps, loadBackups, loadPlugins, loadWorlds, loadBans, bridge])

  // Sunucu durumu degisince (baslat/durdur) listeler bayatlamasin
  const prevRunning = useRef(running)
  useEffect(() => {
    if (prevRunning.current !== running) {
      prevRunning.current = running
      loadProps()
      loadWorlds()
      loadPlugins()
    }
  }, [running, loadProps, loadWorlds, loadPlugins])

  const saveProps = useCallback(async () => {
    setPropsNote(null)
    try {
      // Canli uygulanabilir anahtarlar (gamemode/difficulty) konsoldan da
      // gonderilir; kalanlar server.properties'e yazilir (restart gerektirir).
      const changed: Record<string, string> = {}
      for (const row of props) {
        if (!row.editable) continue
        const next = propsDraft[row.key] ?? row.value
        if (next !== row.value) changed[row.key] = next
      }
      if (Object.keys(changed).length === 0) {
        setPropsNote('Değişiklik yok.')
        return
      }
      const serverRunning = running
      await bridge.writeProps(changed)
      const liveKeys = ['gamemode', 'difficulty'].filter((k) => k in changed)
      const restartKeys = Object.keys(changed).filter((k) => !liveKeys.includes(k))
      const parts: string[] = []
      if (liveKeys.length > 0) {
        parts.push(
          serverRunning
            ? `${liveKeys.join(', ')} canlı uygulandı`
            : `${liveKeys.join(', ')} sunucu açılışında uygulanacak`
        )
      }
      if (restartKeys.length > 0) parts.push(`${restartKeys.join(', ')} için Yeniden Başlat gerekir`)
      setPropsNote(`Kaydedildi: ${parts.join('; ')}.`)
      loadProps()
    } catch (e) {
      setPropsNote(`Kaydedilemedi: ${errText(e)}`)
    }
  }, [bridge, props, propsDraft, loadProps, running])

  const doAdmin = useCallback(
    async (action: 'op' | 'deop' | 'ban' | 'kick' | 'pardon' | 'pardon-ip') => {
      const nick = adminNick.trim()
      if (!nick) return
      try {
        await bridge.adminAction(action, nick)
        onNotify(`${nick} -> ${action} komutu gönderildi.`)
        setTimeout(loadBans, 500) // ban listesi hafif gecikmeyle tazelensin
      } catch (e) {
        onNotify(`Hata: ${errText(e)}`)
      }
    },
    [bridge, adminNick, onNotify, loadBans]
  )

  const createBackup = useCallback(async () => {
    setBackupBusy(true)
    onNotify('Yedek alınıyor...')
    try {
      const b = await bridge.backupCreate('manual')
      onNotify(`Yedek alındı: ${b.file} (${b.sizeMB} MB)`)
      loadBackups()
    } catch (e) {
      onNotify(`Yedek alınamadı: ${errText(e)}`)
    } finally {
      setBackupBusy(false)
    }
  }, [bridge, loadBackups, onNotify])

  const restoreBackup = useCallback(
    async (file: string) => {
      if (running) {
        onNotify('Sunucu çalışıyor — geri yüklemeden önce sunucuyu kapatın.')
        return
      }
      if (!window.confirm(`${file} geri yüklenecek. Mevcut dünya/ayar dosyaları üzerine yazılacak. Emin misiniz?`)) return
      onNotify('Geri yükleniyor...')
      try {
        const parts = await bridge.backupRestore(file)
        onNotify(`Geri yükleme tamam: ${parts.join(', ')}`)
      } catch (e) {
        onNotify(`Geri yükleme başarısız: ${errText(e)}`)
      }
    },
    [bridge, running, onNotify]
  )

  const TABS: { id: typeof tab; label: string }[] = [
    { id: 'props', label: 'Ayarlar (properties)' },
    { id: 'admin', label: 'Yetki / Ban' },
    { id: 'backup', label: 'Yedekler' },
    { id: 'plugins', label: 'Pluginler' },
    { id: 'world', label: 'Dünya / Datapack' },
    { id: 'stats', label: 'İstatistikler' },
    { id: 'mods', label: 'Modlar' }
  ]

  return (
    <div className="panel tools-panel">
      <div className="tools-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`tools-tab ${tab === t.id ? 'active' : ''}`}
            onClick={() => {
              setTab(t.id)
              // Sekme degisince veriyi tazele — baska ekrandan yapilan
              // degisikliklerin (plugin kopyalama, sunucu baslatma) gorunmesi icin
              if (t.id === 'plugins') loadPlugins()
              else if (t.id === 'world') loadWorlds()
              else if (t.id === 'backup') loadBackups()
              else if (t.id === 'props') loadProps()
              else if (t.id === 'admin') loadBans()
              else if (t.id === 'mods') loadMods()
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'props' && (
        <div className="props-grid">
          {props.length === 0 && <p className="setting-note">server.properties bulunamadı — sunucuyu bir kez başlatın.</p>}
          {props.map((row) =>
            row.editable ? (
              <label key={row.key} className="prop-row">
                <span className="prop-key">{row.key}</span>
                {['gamemode', 'difficulty'].includes(row.key) ? (
                  <select
                    value={propsDraft[row.key] ?? ''}
                    onChange={(e) => setPropsDraft((d) => ({ ...d, [row.key]: e.target.value }))}
                  >
                    {(row.key === 'gamemode' ? GAMEMODES : DIFFICULTIES).map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                ) : row.value === 'true' || row.value === 'false' ? (
                  <select
                    value={propsDraft[row.key] ?? ''}
                    onChange={(e) => setPropsDraft((d) => ({ ...d, [row.key]: e.target.value }))}
                  >
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </select>
                ) : (
                  <input
                    value={propsDraft[row.key] ?? ''}
                    onChange={(e) => setPropsDraft((d) => ({ ...d, [row.key]: e.target.value }))}
                    spellCheck={false}
                  />
                )}
              </label>
            ) : (
              <label key={row.key} className="prop-row readonly" title="Bu anahtar editörle düzenlenmez (güvenlik)">
                <span className="prop-key">{row.key}</span>
                <input value={row.value} readOnly disabled />
              </label>
            )
          )}
          {props.some((r) => r.editable) && (
            <div className="props-actions">
              <button type="button" className="btn primary" onClick={() => void saveProps()}>
                Ayarları Kaydet
              </button>
              {propsNote && <span className="setting-note">{propsNote}</span>}
            </div>
          )}
        </div>
      )}

      {tab === 'admin' && (
        <div className="admin-box">
          <p className="setting-note">
            Komut doğrudan sunucu konsoluna yazılır (op/deop/ban/kick). Sunucu çalışırken kullanılabilir.
          </p>
          <div className="console-row">
            <input
              className="console-input"
              value={adminNick}
              onChange={(e) => setAdminNick(e.target.value)}
              placeholder="Nickname..."
              maxLength={16}
              spellCheck={false}
            />
            <button type="button" className="btn small primary" disabled={!running || !adminNick.trim()} onClick={() => void doAdmin('op')}>
              Op Ver
            </button>
            <button type="button" className="btn small" disabled={!running || !adminNick.trim()} onClick={() => void doAdmin('deop')}>
              Op Al
            </button>
            <button type="button" className="btn small" disabled={!running || !adminNick.trim()} onClick={() => void doAdmin('kick')}>
              Kick
            </button>
            <button type="button" className="btn small danger" disabled={!running || !adminNick.trim()} onClick={() => void doAdmin('ban')}>
              Ban
            </button>
            <button
              type="button"
              className="btn small"
              disabled={!adminNick.trim()}
              title="Yasaklı listeden çıkar (sunucu kapalıyken de çalışır — açılışta geçerli)"
              onClick={() => void doAdmin('pardon')}
            >
              Ban Kaldır
            </button>
          </div>

          <h4 className="tools-h4">Yasaklı Oyuncular</h4>
          {bans.players.length === 0 ? (
            <p className="setting-note">Yasaklı oyuncu yok.</p>
          ) : (
            bans.players.map((b) => (
              <div key={b.name} className="plugin-row">
                <span className="status-dot offline" />
                <span className="plugin-name">
                  {b.name}
                  {b.reason && <span className="muted"> — {b.reason}</span>}
                </span>
                <button
                  type="button"
                  className="btn small"
                  onClick={() => {
                    void bridge
                      .adminAction('pardon', b.name)
                      .then(() => {
                        onNotify(`${b.name} için ban kaldırıldı.`)
                        setTimeout(loadBans, 500)
                      })
                      .catch((e) => onNotify(`Hata: ${errText(e)}`))
                  }}
                >
                  Ban Kaldır
                </button>
              </div>
            ))
          )}
          {bans.ips.length > 0 && (
            <>
              <h4 className="tools-h4">Yasaklı IP'ler</h4>
              {bans.ips.map((b) => (
                <div key={b.ip} className="plugin-row">
                  <span className="status-dot offline" />
                  <span className="plugin-name">{b.ip}</span>
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => {
                      void bridge
                        .adminAction('pardon-ip', b.ip)
                        .then(() => {
                          onNotify(`${b.ip} için ban kaldırıldı.`)
                          setTimeout(loadBans, 500)
                        })
                        .catch((e) => onNotify(`Hata: ${errText(e)}`))
                    }}
                  >
                    Ban Kaldır
                  </button>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {tab === 'backup' && (
        <div className="backup-box">
          <div className="props-actions">
            <button type="button" className="btn primary" disabled={backupBusy} onClick={() => void createBackup()}>
              Şimdi Yedekle
            </button>
            <span className="setting-note">Sunucu açıkken her 30 dakikada bir otomatik yedek de alınır (world + configler).</span>
          </div>
          {backups.length === 0 ? (
            <p className="setting-note">Henüz yedek yok.</p>
          ) : (
            <div className="wl-list backup-list">
              {backups.map((b) => (
                <span key={b.file} className="wl-chip backup-chip" title={b.file}>
                  <b>{new Date(b.createdAt).toLocaleString('tr-TR')}</b> — {b.sizeMB} MB
                  <button
                    type="button"
                    className="wl-x"
                    title="Geri yükle"
                    onClick={() => void restoreBackup(b.file)}
                  >
                    ⟲
                  </button>
                  <button
                    type="button"
                    className="wl-x"
                    title="Sil"
                    onClick={() => {
                      void bridge.backupDelete(b.file).then(loadBackups).catch(() => {})
                    }}
                  >
                    x
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'plugins' && (
        <div className="backup-box">
          {/* Faz 14: offline skin destegi (SkinsRestorer) — tek tikla kurulum */}
          <div className="version-box">
            <div className="version-line">
              <b>Skin desteği (offline sunucularda skinner görünmez):</b>{' '}
              {skinInstalled ? (
                <span className="msg ok inline">Kurulu — {skinInstalled}</span>
              ) : (
                <span className="muted">Kurulu değil</span>
              )}
            </div>
            <p className="setting-note">
              SkinsRestorer kurar: oyuncular oyunda <code>/skin url &lt;link&gt;</code> ile skin set eder.
              Sunucu offline modda çalıştığı için Mojang skinleri görünmez — bu plugin onu çözer.
            </p>
            <div className="setting-actions">
              <button
                type="button"
                className="btn small primary"
                disabled={skinBusy}
                onClick={() => {
                  setSkinBusy(true)
                  void bridge
                    .skinInstall()
                    .then((r) => {
                      onNotify(r.ok ? (r.installed ? `Kuruldu: ${r.installed} — yeniden başlatmada yüklenir.` : r.skipped ?? 'Zaten kurulu.') : `Kurulamadı: ${r.skipped}`)
                      return bridge.skinStatus().then((s) => setSkinInstalled(s.installed))
                    })
                    .catch((e) => onNotify(`Hata: ${errText(e)}`))
                    .finally(() => setSkinBusy(false))
                }}
              >
                {skinBusy ? 'İndiriliyor...' : skinInstalled ? 'En yeni sürüme güncelle' : 'SkinsRestorer Kur'}
              </button>
            </div>
          </div>
          <p className="setting-note">
            plugins/ klasöründeki .jar'lar. "Kapat" dosyayı silmez — .disabled.jar yapar. Değişiklikler
            yeniden başlatmada geçerli olur.
          </p>
          <div className="props-actions">
            <button
              type="button"
              className="btn small primary"
              title="Bilgisayarından plugin jar dosyası seç — plugins/ klasörüne otomatik kopyalanır"
              onClick={() => {
                void bridge
                  .pluginsAdd()
                  .then((r) => {
                    if (r.added) onNotify(`Eklendi: ${r.added} — yeniden başlatmada yüklenir.`)
                    loadPlugins()
                  })
                  .catch((e) => onNotify(`Hata: ${errText(e)}`))
              }}
            >
              + Plugin Ekle
            </button>
            <button type="button" className="btn small" onClick={loadPlugins} title="plugins/ klasörünü yeniden oku">
              Yenile
            </button>
            <span className="setting-note">Aynı plugin'in iki kopyası (örn. "isim (1).jar") Paper'ın yüklemesini bozar — Yenile sonrası uyarı burada görünür.</span>
          </div>
          {(() => {
            const dup = plugins.filter((p) => p.enabled).filter((p, _i, arr) =>
              arr.some((q) => q !== p && q.file.replace(/\s+\(\d+\)(?=\.jar$)/i, '').toLowerCase() === p.file.replace(/\s+\(\d+\)(?=\.jar$)/i, '').toLowerCase())
            )
            if (dup.length === 0) return null
            return (
              <p className="setting-note" style={{ color: 'var(--err, #ff6b6b)' }}>
                ⚠ Çakışma: {dup.map((d) => d.file).join(' + ')} — aynı plugin'in kopyaları. Birini silin, aksi halde Paper İKİSİNİ DE yüklemez.
              </p>
            )
          })()}
          {plugins.length === 0 ? (
            <p className="setting-note">Plugin yok. plugins/ klasörüne .jar koyup sunucuyu yeniden başlatın.</p>
          ) : (
            plugins.map((p) => (
              <div key={p.file} className="plugin-row">
                <span className={`status-dot ${p.enabled ? '' : 'offline'}`} title={p.enabled ? 'Aktif' : 'Kapalı'} />
                <span className="plugin-name">{p.file}</span>
                <span className="muted">{p.sizeMB} MB</span>
                <button
                  type="button"
                  className="btn small"
                  onClick={() =>
                    void bridge
                      .pluginSetEnabled(p.file, !p.enabled)
                      .then(loadPlugins)
                      .catch((e) => onNotify(`Hata: ${errText(e)}`))
                  }
                >
                  {p.enabled ? 'Kapat' : 'Aç'}
                </button>
                <button
                  type="button"
                  className="btn small danger"
                  onClick={() => {
                    if (window.confirm(`${p.file} kalıcı olarak silinsin mi?`)) {
                      void bridge.pluginDelete(p.file).then(loadPlugins).catch((e) => onNotify(`Hata: ${errText(e)}`))
                    }
                  }}
                >
                  Sil
                </button>
              </div>
            ))
          )}
        </div>
      )}

      {tab === 'stats' && stats && (
        <div className="backup-box stats-box">
          <div className="stat-cards">
            <div className="stat-card">
              <span className="stat-value">{Math.round(stats.totalPlayMs / 3600_000 * 10) / 10} sa</span>
              <span className="stat-label">Toplam sunucu süresi</span>
            </div>
            <div className="stat-card">
              <span className="stat-value">{Math.round(stats.totalPlayerMs / 3600_000 * 10) / 10} sa</span>
              <span className="stat-label">Toplam oyuncu süresi</span>
            </div>
            <div className="stat-card">
              <span className="stat-value">{stats.sessions}</span>
              <span className="stat-label">Başlatma sayısı</span>
            </div>
            <div className="stat-card">
              <span className="stat-value">{stats.peakPlayers}</span>
              <span className="stat-label">En yoğun an (oyuncu)</span>
            </div>
          </div>
          {stats.sessionActive && (
            <p className="setting-note ok">
              Şu an açık — bu oturum: {stats.sessionMinutes} dakika.
            </p>
          )}
          {stats.firstStart && (
            <p className="setting-note">
              İlk başlatma: {new Date(stats.firstStart).toLocaleDateString('tr-TR')} — son:
              {stats.lastStart ? ` ${new Date(stats.lastStart).toLocaleString('tr-TR')}` : ' -'}
            </p>
          )}
          <h4 className="tools-h4">Saatlik yoğunluk (oyuncu-dakikası)</h4>
          <div className="hour-bars">
            {stats.hourlyPlayerMs.map((ms, hour) => {
              const max = Math.max(...stats.hourlyPlayerMs, 1)
              const h = Math.max(2, Math.round((ms / max) * 64))
              return (
                <div key={hour} className="hour-bar-col" title={`${hour}:00 — ${Math.round(ms / 60_000)} dk oyuncu`}
                >
                  <div className="hour-bar" style={{ height: h }} />
                  <span className="hour-label">{hour}</span>
                </div>
              )
            })}
          </div>
          {!stats.firstStart && <p className="setting-note">İstatistik ilk sunucu başlatmasıyla birikmeye başlar.</p>}
        </div>
      )}

      {tab === 'mods' && (
        <div className="backup-box">
          <p className="setting-note">
            <b>Client modları:</b> <code>clientMods/</code> klasörüne koyduğun .jar'lar (Sodium, minimap vb.)
            sunucu hazır olunca arkadaşların launcher'ına otomatik iner ve oyunu <code>mods/</code> ile açar.
            Sunucu tarafına yükleme YAPILMAZ — bunlar yalnızca istemci modlarıdır.
          </p>
          <div className="props-actions">
            <select
              className="version-select slim"
              value={fabricStatus?.loaderVersion ?? ''}
              disabled={modsBusy}
              title="Fabric loader surumu — 'Otomatik' en yeni surumu secer, 'Vanilla' mod yuklemez"
              onChange={(e) => {
                const raw = e.target.value
                const v = raw === '' ? null : raw
                setModsBusy(true)
                void bridge
                  .fabricSet(v)
                  .then(() => loadMods())
                  .catch((err) => setModsNote(`Hata: ${errText(err)}`))
                  .finally(() => setModsBusy(false))
              }}
            >
              <option value="">Vanilla (mod yok)</option>
              <option value="auto">Fabric — otomatik (en yeni)</option>
              {fabricLoaders.map((v) => (
                <option key={v} value={v}>
                  Fabric {v}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn small primary"
              disabled={modsBusy}
              title="Bilgisayarından mod jar dosyası seç — clientMods/ klasörüne otomatik kopyalanır"
              onClick={() => {
                setModsBusy(true)
                void bridge
                  .clientModsAdd()
                  .then((r) => {
                    if (r.added) setModsNote(`Eklendi: ${r.added}`)
                    loadMods()
                  })
                  .catch((err) => setModsNote(`Hata: ${errText(err)}`))
                  .finally(() => setModsBusy(false))
              }}
            >
              + Mod Ekle
            </button>
            <button
              type="button"
              className="btn small"
              disabled={modsBusy}
              title="clientMods/ klasorunu simdi API'ye yayinla (sunucu calisirken de kullanilabilir)"
              onClick={() => {
                setModsBusy(true)
                void bridge
                  .clientModsPublishNow()
                  .then((r) => {
                    if (r.ok) setModsNote(r.count > 0 ? `${r.count} mod yayınlandı.` : 'clientMods klasörü boş — yayınlanacak mod yok.')
                    else setModsNote(`Yayınlamadi: ${r.skipped ?? 'bilinmeyen'}`)
                  })
                  .catch((err) => setModsNote(`Hata: ${errText(err)}`))
                  .finally(() => setModsBusy(false))
              }}
            >
              Modları Yayımla
            </button>
            <button type="button" className="btn small" onClick={loadMods} title="Durumu tazele">
              Yenile
            </button>
          </div>
          {modsNote && <p className="setting-note">{modsNote}</p>}
          {fabricStatus && (
            <p className="setting-note">
              Aktif profil: <b>{fabricStatus.loaderVersion ? `Fabric ${fabricStatus.loaderVersion}` : 'Vanilla'}</b>
              {fabricStatus.paperVersion ? ` — Paper ${fabricStatus.paperVersion}` : ''}
            </p>
          )}
          <h4 className="tools-h4">Yüklü client modları ({clientMods.length})</h4>
          {modsDir && (
            <p className="setting-note">
              Klasör: <code>{modsDir}</code> — elle jar kopyalamak istersen bu yolu kullan.
            </p>
          )}
          {clientMods.length === 0 ? (
            <p className="setting-note">Henüz mod yok — "+ Mod Ekle" ile jar seç veya klasöre elle kopyala.</p>
          ) : (
            clientMods.map((m) => (
              <div key={m.file} className="plugin-row" style={m.warning ? { borderLeft: '3px solid var(--danger, #e5484d)', paddingLeft: 8 } : undefined}>
                <span className="plugin-name" title={m.warning}>{m.file}</span>
                {m.warning && (
                  <span
                    className="badge warn"
                    title={m.warning}
                    style={{
                      color: '#fff',
                      background: '#e5484d',
                      borderRadius: 10,
                      fontSize: 11,
                      padding: '1px 8px',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      maxWidth: 260
                    }}
                  >
                    ⚠ {m.warning}
                  </span>
                )}
                <span className="muted">{m.sizeMB} MB</span>
                <button
                  type="button"
                  className="btn small danger"
                  onClick={() => {
                    void bridge.clientModsDelete(m.file).then(loadMods).catch((e) => setModsNote(`Hata: ${errText(e)}`))
                  }}
                >
                  Sil
                </button>
              </div>
            ))
          )}
          <p className="setting-note">
            Not: Fabric seçersen arkadaşların oyunu otomatik olarak Fabric loader profilinden açılır;
            profil ilk Katil'de otomatik kurulur (internet gerektirir). Vanilla seçersen modlar
            indirilmez — herkes standart oyunla girer.
          </p>
        </div>
      )}

      {tab === 'world' && (
        <div className="backup-box">
          <div className="props-actions">
            {/* NOT: Electron window.prompt() DESTEKLEMEZ — satır içi girdi kullanılır. */}
            <input
              className="console-input"
              style={{ maxWidth: 220 }}
              value={newWorldName}
              onChange={(e) => setNewWorldName(e.target.value)}
              placeholder="Yeni dünya adı (boş = otomatik)"
              maxLength={64}
              spellCheck={false}
            />
            <button
              type="button"
              className="btn primary"
              disabled={running || worldBusy}
              title={running ? 'Önce sunucuyu kapatın' : 'Yeni bir dünya adı ayırır; Sunucuyu Başlat deyince oluşur'}
              onClick={() => {
                setWorldBusy(true)
                void bridge
                  .worldCreate(newWorldName.trim() || undefined)
                  .then((r) => {
                    onNotify(`Yeni dünya "${r.level}" ayarlandı — Sunucuyu Başlat ile oluşacak.`)
                    setNewWorldName('')
                    loadWorlds()
                  })
                  .catch((e) => onNotify(`Hata: ${errText(e)}`))
                  .finally(() => setWorldBusy(false))
              }}
            >
              + Yeni Dünya
            </button>
            <button
              type="button"
              className="btn"
              disabled={running || worldBusy}
              title={running ? 'Önce sunucuyu kapatın' : 'Dünyanın .zip dosyasını seç'}
              onClick={() => {
                setWorldBusy(true)
                void bridge
                  .worldImport('zip')
                  .then((r) => {
                    if (!r.canceled && r.level) {
                      onNotify(`Dünya "${r.level}" olarak içe aktarıldı — Sunucuyu Başlat ile açılır.`)
                      loadWorlds()
                    }
                  })
                  .catch((e) => onNotify(`Hata: ${errText(e)}`))
                  .finally(() => setWorldBusy(false))
              }}
            >
              Zip'den Yükle
            </button>
            <button
              type="button"
              className="btn"
              disabled={running || worldBusy}
              title={running ? 'Önce sunucuyu kapatın' : 'level.dat içeren dünya klasörünü seç'}
              onClick={() => {
                setWorldBusy(true)
                void bridge
                  .worldImport('folder')
                  .then((r) => {
                    if (!r.canceled && r.level) {
                      onNotify(`Dünya "${r.level}" olarak içe aktarıldı — Sunucuyu Başlat ile açılır.`)
                      loadWorlds()
                    }
                  })
                  .catch((e) => onNotify(`Hata: ${errText(e)}`))
                  .finally(() => setWorldBusy(false))
              }}
            >
              Klasörden Yükle
            </button>
            <button type="button" className="btn small" onClick={loadWorlds} title="Klasörleri yeniden oku — sunucu klasöre elle dünya kopyaladıysan bunu kullan">
              Yenile
            </button>
            <span className="setting-note">Dünya değişiklikleri sunucu kapalıyken yapılabilir. Klasöre elle kopyaladığın dünya "Yenile" ile listeye düşer.</span>
          </div>
          <h4 className="tools-h4">Dünyalar</h4>
          {worlds.length === 0 ? (
            <p className="setting-note">Dünya yok — sunucuyu bir kez başlatın.</p>
          ) : (
            worlds.map((w) => (
              <div key={w.name} className="plugin-row">
                <span className="plugin-name">
                  {w.name} {w.active && <span className="wl-req-status-line ok">(aktif)</span>}
                </span>
                <span className="muted">{w.sizeMB} MB</span>
                <button
                  type="button"
                  className="btn small danger"
                  disabled={running}
                  title={
                    running
                      ? 'Önce sunucuyu kapatın'
                      : w.active
                        ? 'Aktif dünya silinebilir: önce aktif dünya başka bir dünyaya çevrilir'
                        : 'Dünyayı sil'
                  }
                  onClick={() => {
                    const msg = w.active
                      ? `${w.name} AKTİF dünya. Silinirse sunucu başka bir dünyayla (yoksa yepyeni bir "world" ile) açılacak. Devam?`
                      : `${w.name} dünyası silinsin mi? Bu işlem geri alınamaz!`
                    if (window.confirm(msg)) {
                      void bridge
                        .worldDelete(w.name)
                        .then((r) => {
                          onNotify(`"${w.name}" silindi; aktif dünya artık "${r.newLevel}". Sunucuyu Başlat ile açın.`)
                          loadWorlds()
                        })
                        .catch((e) => onNotify(`Hata: ${errText(e)}`))
                    }
                  }}
                >
                  Sil
                </button>
              </div>
            ))
          )}
          <h4 className="tools-h4">Datapack'ler (aktif dünya)</h4>
          {datapacks.length === 0 ? (
            <p className="setting-note">Datapack yok. world/datapacks/ klasörüne zip koyup sunucuyu yeniden başlatın.</p>
          ) : (
            datapacks.map((d) => (
              <div key={d.file} className="plugin-row">
                <span className="plugin-name">{d.file}</span>
                <span className="muted">{d.kind === 'zip' ? 'zip' : 'klasör'}{d.enabled ? '' : ' — pack.mcmeta eksik'}</span>
                <button
                  type="button"
                  className="btn small danger"
                  onClick={() => {
                    void bridge.datapackDelete(d.file).then(loadWorlds).catch((e) => onNotify(`Hata: ${errText(e)}`))
                  }}
                >
                  Sil
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
