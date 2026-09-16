import { useCallback, useEffect, useRef, useState } from 'react'
import {
  gameBridge,
  type ServerStatusInfo,
  type ServerMonitor,
  type TunnelState
} from '../lib/game'
import type { AuthUser } from '../lib/api'
import { subscribeLiveEvents } from '../lib/poller'
import {
  fetchWhitelistRequests,
  respondWhitelistRequest,
  type WhitelistRequestDto
} from '../lib/friends'
import ServerTools from './ServerTools'

interface Props {
  user: AuthUser
}

const TUNNEL_LABEL: Record<TunnelState, string> = {
  stopped: 'Kapalı',
  starting: 'Başlatılıyor...',
  live: 'Aktif'
}

export default function ServerScreen({ user }: Props) {
  const bridge = gameBridge()
  const [paperVersions, setPaperVersions] = useState<string[]>([])
  const [selected, setSelected] = useState('')
  const [loadingVersions, setLoadingVersions] = useState(true)
  const [versionsError, setVersionsError] = useState<string | null>(null)

  const [status, setStatus] = useState<ServerStatusInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [statusText, setStatusText] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ percent: number; label: string } | null>(null)
  const [logLines, setLogLines] = useState<string[]>([])
  const [copied, setCopied] = useState<'direct' | 'tunnel' | false>(false)

  // ---- Faz 6: izleme + konsol + RAM secimi ----
  const [monitor, setMonitor] = useState<ServerMonitor | null>(null)
  const [cmdInput, setCmdInput] = useState('')
  const [ramMaxMB, setRamMaxMB] = useState(2048)
  const [ramOptions, setRamOptions] = useState<number[]>([1024, 2048, 4096, 8192])
  const [showTools, setShowTools] = useState(false)
  // ---- Faz 8: profiller ----
  const [profiles, setProfiles] = useState<{ name: string; paperVersion: string | null; active: boolean }[]>([])
  const [profileNote, setProfileNote] = useState<string | null>(null)
  // Yeni profil adi — Electron'da window.prompt calismadigi icin satir ici girdi
  const [newProfileName, setNewProfileName] = useState('')

  const [whitelist, setWhitelist] = useState<string[]>([])
  const [wlInput, setWlInput] = useState('')

  // ---- Faz 5c: whitelist'e ekleme istekleri (host tarafi bildirim paneli) ----
  const [wlReqs, setWlReqs] = useState<WhitelistRequestDto[]>([])
  const [reqBusy, setReqBusy] = useState<number | null>(null)
  const [reqNote, setReqNote] = useState<string | null>(null)
  const noteTimerRef = useRef<number | null>(null)

  // Bildirim notlari 8 sn sonra kendiliginden kaybolsun — "trevir whitelist'e
  // eklendi" gibi eski bilgiler panelde sonsuza kadar asili kalmasin (nick
  // daha sonra whitelist'ten cikarilsa bile yalnistrici bayat bilgi olur).
  const flashNote = useCallback((msg: string) => {
    setReqNote(msg)
    if (noteTimerRef.current) window.clearTimeout(noteTimerRef.current)
    noteTimerRef.current = window.setTimeout(() => setReqNote(null), 8000)
  }, [])

  const logEndRef = useRef<HTMLDivElement | null>(null)

  // Paper surumleri — acilista profilin HATIRLANAN surumune ayarla (profil
  // degistirmede kullanici her seferinde elle secmek zorunda kalmasin)
  useEffect(() => {
    let alive = true
    Promise.all([bridge.listPaperVersions(), bridge.profileLastVersion().catch(() => null)])
      .then(([vs, last]) => {
        if (!alive) return
        setPaperVersions(vs)
        setSelected((prev) => prev || (last && vs.includes(last) ? last : vs[0]) || '')
      })
      .catch((e: unknown) => {
        if (alive) setVersionsError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (alive) setLoadingVersions(false)
      })
    return () => {
      alive = false
    }
  }, [bridge])

  // Durum + whitelist + profiller
  useEffect(() => {
    bridge.serverStatus().then(setStatus).catch(() => {})
    bridge.getWhitelist().then(setWhitelist).catch(() => {})
    bridge.profilesList().then(setProfiles).catch(() => {})
    // RAM seceneklerini sistem sinirina gore kirp (12 GB'lik makinede 16 GB
    // secenegi gorunmesin) — bilgi getInfo.ramCapMB'den gelir.
    bridge.getInfo().then((i) => {
      const cap = i.ramCapMB ?? 8192
      setRamOptions([1024, 2048, 4096, 8192, 16384].filter((mb) => mb <= cap))
      setRamMaxMB((prev) => (prev > cap ? (cap >= 4096 ? 4096 : cap) : prev))
    }).catch(() => {})
  }, [bridge])

  const activeProfile = profiles.find((p) => p.active)?.name ?? 'default'

  // Faz 6: canli izleme — 10 sn'de bir TPS/RAM/CPU/oyuncu tazele
  useEffect(() => {
    let alive = true
    const load = () => {
      bridge.serverMonitor().then((m) => alive && setMonitor(m)).catch(() => {})
    }
    load()
    const t = setInterval(load, 10_000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [bridge])

  // Whitelist istekleri: canli olay ile aninda tazelenir (Faz 9) + 60 sn yedek
  useEffect(() => {
    let alive = true
    const load = () => {
      fetchWhitelistRequests()
        .then((r) => {
          if (alive) setWlReqs(r.incoming)
        })
        .catch(() => {})
    }
    load()
    const off = subscribeLiveEvents((kind) => {
      if (kind === 'wl_request') load()
    })
    const t = setInterval(load, 60_000)
    return () => {
      alive = false
      off()
      clearInterval(t)
    }
  }, [])

  // Event'ler
  useEffect(() => {
    const off = bridge.onGameEvent((ev) => {
      if (ev.type === 'status') setStatusText(ev.message ?? null)
      else if (ev.type === 'progress') setProgress({ percent: ev.percent ?? 0, label: ev.label ?? '' })
      else if (ev.type === 'log') {
        if (ev.line) setLogLines((l) => [...l.slice(-299), ev.line as string])
      } else if (ev.type === 'ready') {
        setProgress(null)
        bridge.serverStatus().then(setStatus).catch(() => {})
      } else if (ev.type === 'stopped') {
        setProgress(null)
        setStatusText(`Sunucu kapatildi (kod: ${ev.code ?? 0}).`)
        bridge.serverStatus().then(setStatus).catch(() => {})
      } else if (
        ev.type === 'tunnel-address' ||
        ev.type === 'tunnel-state' ||
        ev.type === 'tunnel-error' ||
        ev.type === 'direct-address'
      ) {
        bridge.serverStatus().then(setStatus).catch(() => {})
      } else if (ev.type === 'whitelist-changed') {
        bridge.getWhitelist().then(setWhitelist).catch(() => {})
      } else if (ev.type === 'error') {
        setProgress(null)
      }
    })
    return off
  }, [bridge])

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logLines])

  const startServer = useCallback(async () => {
    if (!selected) return
    setBusy(true)
    setLogLines([])
    setStatusText('Hazirlaniyor...')
    try {
      await bridge.startServer({ mcVersion: selected, ramMaxMB })
      bridge.serverStatus().then(setStatus).catch(() => {})
    } catch (err) {
      setStatusText(`Hata: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }, [bridge, selected, ramMaxMB])

  const stopServer = useCallback(async () => {
    setBusy(true)
    try {
      await bridge.stopServer()
    } finally {
      setBusy(false)
    }
  }, [bridge])

  // Faz 6: tek tikla yeniden baslat (dunyayi kaydeder, ayni ayarlarla acar)
  const restartServer = useCallback(async () => {
    setBusy(true)
    try {
      await bridge.restartServer()
      setStatusText('Sunucu yeniden baslatiliyor...')
    } catch (err) {
      setStatusText(`Hata: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }, [bridge])

  // Faz 6: konsol komutu gonder
  const sendCmd = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault()
      const cmd = cmdInput.trim()
      if (!cmd) return
      try {
        bridge.serverCommand(cmd)
        setCmdInput('')
      } catch (err) {
        setStatusText(`Komut hatasi: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [bridge, cmdInput]
  )

  // ---- Faz 8: profil islemleri ----
  const switchProfile = useCallback(
    (name: string) => {
      bridge
        .profileSwitch(name)
        .then((list) => {
          setProfiles(list)
          setProfileNote(`Aktif profil: "${name}".`)
          // Her profilin KENDI whitelist.json'i var — eskisini gostermemek icin
          // tazele (raporlanan bug: onceki profilin kullanici listesi kalıyordu)
          bridge.getWhitelist().then(setWhitelist).catch(() => {})
          bridge.serverStatus().then(setStatus).catch(() => {})
          // Profil degisince surum secicini o profilin son surumune ayarla —
          // kullanici her seferinde surum secmek zorunda kalmasin (profil
          // basina hatirlanan surum; listeleye yoksa ilk surume dus).
          bridge
            .profileLastVersion()
            .then((v) => {
              if (v) setSelected((prev) => (paperVersions.includes(v) ? v : prev))
            })
            .catch(() => {})
        })
        .catch((err) => setProfileNote(`Hata: ${err instanceof Error ? err.message : String(err)}`))
    },
    [bridge, paperVersions]
  )

  const addProfile = useCallback(() => {
    // Electron window.prompt() DESTEKLEMEZ — satir ici girdi kullan
    const name = newProfileName.trim()
    if (!name) {
      setProfileNote('Once yeni profil adini yaz.')
      return
    }
    bridge
      .profileCreate(name)
      .then((list) => {
        setProfiles(list)
        setProfileNote(`Profil "${name}" olusturuldu.`)
        setNewProfileName('')
      })
      .catch((err) => setProfileNote(`Hata: ${err instanceof Error ? err.message : String(err)}`))
  }, [bridge, newProfileName])

  const removeProfile = useCallback(
    (name: string) => {
      if (!window.confirm(`"${name}" profili ve TUM dünyası/ayarları silinsin mi? Bu islem geri alinamaz!`)) return
      bridge
        .profileDelete(name)
        .then((list) => {
          setProfiles(list)
          setProfileNote(`Profil "${name}" silindi.`)
          bridge.serverStatus().then(setStatus).catch(() => {})
        })
        .catch((err) => setProfileNote(`Hata: ${err instanceof Error ? err.message : String(err)}`))
    },
    [bridge]
  )

  const restartTunnel = useCallback(async () => {
    setBusy(true)
    try {
      await bridge.restartTunnel()
      bridge.serverStatus().then(setStatus).catch(() => {})
    } finally {
      setBusy(false)
    }
  }, [bridge])

  // Iki ayri satirin Kopyala butonlari KENDI adresini kopyalamali — tek handler
  // 'direct ?? tunnel' ile tünel satırında bile dogrudan adresi kopyaliyordu.
  const copyDirect = useCallback(() => {
    if (!status?.directAddress) return
    void navigator.clipboard.writeText(status.directAddress)
    setCopied('direct')
    setTimeout(() => setCopied(false), 2000)
  }, [status?.directAddress])

  const copyTunnel = useCallback(() => {
    if (!status?.tunnelAddress) return
    void navigator.clipboard.writeText(status.tunnelAddress)
    setCopied('tunnel')
    setTimeout(() => setCopied(false), 2000)
  }, [status?.tunnelAddress])

  const addWhitelist = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      const nick = wlInput.trim()
      if (!nick) return
      try {
        setWhitelist(await bridge.whitelistAdd(nick))
        setWlInput('')
      } catch (err) {
        setStatusText(`Whitelist hatasi: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [bridge, wlInput]
  )

  const removeWhitelist = useCallback(
    async (nick: string) => {
      try {
        setWhitelist(await bridge.whitelistRemove(nick))
        // Cikarilan nick'e ait eski istek notu panelde kalmasin (bayat bilgi)
        setReqNote((prev) =>
          prev && prev.toLowerCase().includes(nick.toLowerCase()) ? null : prev
        )
      } catch (err) {
        setStatusText(`Whitelist hatasi: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [bridge]
  )

  // ---- Faz 5c: istegi onayla/reddet. Onayda API yaniti + lokal whitelist
  // ekleme birlikte yapilir; API basarili ama lokal ekleme basarisizsa
  // kullanici uyariilir (whitelist.json yazilamadiysa server konsolunda da
  // hata gorunur).
  const respondWlReq = useCallback(
    async (req: WhitelistRequestDto, accept: boolean) => {
      setReqBusy(req.id)
      setReqNote(null)
      try {
        const r = await respondWhitelistRequest(req.id, accept)
        if (accept) {
          const list = await bridge.whitelistEnsure(r.nickname)
          setWhitelist(list)
          flashNote(`${r.nickname} whitelist'e eklendi.`)
        } else {
          flashNote(`${r.nickname} icin istek reddedildi.`)
        }
        // Islenen istek panelisten DUSURULUR: "kabul edildi" satirlari birikip
        // bayat bilgi olusturmasin (nick sonradan whitelist'ten cikarilsa bile
        // eski "kabul edildi" gorunumu yalnistriciydi).
        setWlReqs((prev) => prev.filter((x) => x.id !== req.id))
      } catch (err) {
        flashNote(`Islem basarisiz: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        setReqBusy(null)
      }
    },
    [bridge, flashNote]
  )

  // Panelde yalnizca BEKLEYEN istekler gosterilir — API gecmis accepted/
  // declined kayitlarini da dondurdugu icin bunlar render edilmemeli
  // (yoksa cikarilan oyuncunun eski "kabul edildi" bilgisi ekranda kalir).
  const pendingReqs = wlReqs.filter((r) => r.status === 'pending')

  const tunnelBadgeClass = !status
    ? 'checking'
    : status.tunnel === 'live'
      ? 'online'
      : status.tunnel === 'starting'
        ? 'checking'
        : 'offline'

  return (
    <div className="server-screen">
      <div className="panel server-panel">
        <div className="server-top">
          <div className="server-state">
            <div className="server-title-row">
              <h2>Sunucu</h2>
              <span className={`api-badge ${tunnelBadgeClass}`} title="Tünel durumu">
                <span className="api-dot" />
                Tünel: {TUNNEL_LABEL[status?.tunnel ?? 'stopped']}
              </span>
            </div>
            {/* Faz 8: profil secici */}
            <div className="profile-row">
              <span className="muted">Profil:</span>
              <select
                className="version-select slim"
                value={activeProfile}
                disabled={!!status?.running}
                title={status?.running ? 'Profil degistirmek icin sunucuyu kapatın' : 'Her profilin kendi dünyası, ayarları ve pluginleri vardır'}
                onChange={(e) => switchProfile(e.target.value)}
              >
                {profiles.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                    {p.paperVersion ? ` — Paper ${p.paperVersion}` : ''}
                    {p.active ? ' ✓' : ''}
                  </option>
                ))}
              </select>
              <input
                className="console-input"
                style={{ maxWidth: 140 }}
                value={newProfileName}
                onChange={(e) => setNewProfileName(e.target.value)}
                placeholder="yeni profil adi"
                maxLength={32}
                spellCheck={false}
              />
              <button type="button" className="btn small" onClick={addProfile} title="Yeni profil olustur (adi once yukarıya yaz)">
                + Profil
              </button>
              <button
                type="button"
                className="btn small danger"
                disabled={profiles.length <= 1 || !!status?.running}
                onClick={() => removeProfile(activeProfile)}
                title={profiles.length <= 1 ? 'En az bir profil gerekli' : 'Aktif profili sil'}
              >
                Sil
              </button>
            </div>
            {profileNote && <div className="setting-note">{profileNote}</div>}
            {status?.running ? (
              <div className="server-info">
                Paper {status.paperVersion} (build {status.paperBuild}) —{' '}
                {status.ready ? 'Hazir' : 'Basliyor...'}
              </div>
            ) : (
              <div className="server-info muted">Sunucu kapalı</div>
            )}
          </div>

          <div className="server-actions">
            {!status?.running ? (
              <>
                <select
                  className="version-select slim"
                  value={selected}
                  onChange={(e) => setSelected(e.target.value)}
                  disabled={loadingVersions || paperVersions.length === 0}
                >
                  {paperVersions.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
                <select
                  className="version-select slim"
                  value={ramMaxMB}
                  onChange={(e) => setRamMaxMB(Number(e.target.value))}
                  title="Sunucuya ayrilacak RAM (Java -Xmx)"
                >
                  {ramOptions.map((mb) => (
                    <option key={mb} value={mb}>
                      {mb >= 1024 ? `${mb / 1024} GB RAM` : `${mb} MB`}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn primary"
                  disabled={busy || !selected || loadingVersions}
                  onClick={startServer}
                >
                  {busy ? '...' : 'Sunucuyu Başlat'}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="btn"
                  onClick={restartServer}
                  disabled={busy || !status.ready}
                  title="Dunyayi kaydeder ve ayni ayarlarla yeniden baslatır"
                >
                  Yeniden Başlat
                </button>
                <button
                  type="button"
                  className="btn danger"
                  onClick={stopServer}
                  disabled={busy}
                >
                  Sunucuyu Kapat
                </button>
              </>
            )}
          </div>
        </div>

        {versionsError && <div className="msg error">{versionsError}</div>}
        {progress && (
          <div className="progress-wrap">
            <div className="progress-label">
              {progress.label} — %{progress.percent}
            </div>
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${progress.percent}%` }} />
            </div>
          </div>
        )}
        {statusText && <div className="play-status">{statusText}</div>}

        {status?.running && (
          <div className="join-box">
            {status.ready && status.directAddress ? (
              <div className="address-row">
                <span className="address-label">Katılma adresi (doğrudan, düşük ping):</span>
                <code className="address-value">{status.directAddress}</code>
                <button type="button" className="btn small" onClick={copyDirect}>
                  {copied === 'direct' ? 'Kopyalandi' : 'Kopyala'}
                </button>
              </div>
            ) : null}
            {status.tunnel === 'live' && status.tunnelAddress && status.ready ? (
              <div className="address-row">
                <span className="address-label">Katılma adresi (tünel):</span>
                <code className="address-value">{status.tunnelAddress}</code>
                <button type="button" className="btn small" onClick={copyTunnel}>
                  {copied === 'tunnel' ? 'Kopyalandi' : 'Kopyala'}
                </button>
                <button
                  type="button"
                  className="btn small"
                  onClick={restartTunnel}
                  disabled={busy}
                  title="Yeni bir tünel adresi al (adres her başlatmada değişir)"
                >
                  Yenile
                </button>
              </div>
            ) : (
              <div className="address-row muted">
                {status.tunnelError
                  ? `Tünel kurulamadı: ${status.tunnelError}`
                  : !status.ready
                    ? 'Sunucu açılıyor (dünya hazırlanıyor); adres hazir olunca burada görünecek...'
                    : 'Tünel adresi bekleniyor... (genellikle 5-20 saniye)'}
              </div>
            )}

            <p className="setting-note">
              Not: Tünel adresi her sunucu başlatmada değişebilir; arkadaşlarına güncel adresi
              gönder. Sabit adres istersen kendi sunucunda bore barındırabilirsin.
            </p>
          </div>
        )}

        {/* Faz 6: canli izleme (TPS/RAM/CPU + oyuncular) */}
        {monitor?.running && (
          <div className="monitor-row">
            <span className="mon-chip" title="Saniyedeki tik sayisi (20 = ideal)">
              TPS <b className={monitor.tps && monitor.tps.tps1 < 18 ? 'mon-bad' : 'mon-good'}>
                {monitor.tps ? monitor.tps.tps1.toFixed(1) : '...'}
              </b>
            </span>
            <span className="mon-chip" title="Java sürecinin RAM kullanımı">
              RAM <b>{monitor.ramMB !== null ? `${monitor.ramMB} MB` : '...'}</b>
              <span className="muted"> / {monitor.maxRamMB} MB</span>
            </span>
            <span className="mon-chip" title="Java sürecinin CPU kullanımı">
              CPU <b>{monitor.cpuPercent !== null ? `%${monitor.cpuPercent}` : '...'}</b>
            </span>
            <span className="mon-chip" title="Şu an bağlı oyuncular">
              Oyuncular <b>{monitor.players.length}</b>
              {monitor.players.length > 0 && (
                <span className="mon-players">
                  {' '}({monitor.players.map((p) => p.name).join(', ')})
                </span>
              )}
            </span>
          </div>
        )}

        {/* Faz 6: konsol komut gönderme */}
        {status?.running && status.ready && (
          <form className="console-row" onSubmit={sendCmd}>
            <span className="console-prefix">&gt;</span>
            <input
              className="console-input"
              value={cmdInput}
              onChange={(e) => setCmdInput(e.target.value)}
              placeholder="Komut yaz (örn. time set day, weather clear, say merhaba)..."
              spellCheck={false}
            />
            <button type="submit" className="btn small" disabled={!cmdInput.trim()}>
              Gönder
            </button>
          </form>
        )}
      </div>

      {/* Faz 6: gelişmiş araçlar (props/yedek/plugin/world/admin) */}
      <div className="tools-toggle">
        <button type="button" className="btn" onClick={() => setShowTools((s) => !s)}>
          {showTools ? 'Araçları Gizle' : 'Gelişmiş Araçlar (ayarlar, yedek, plugin, dünya...)'}
        </button>
      </div>
      {showTools && <ServerTools bridge={bridge} running={!!status?.running} onNotify={setStatusText} />}

      {pendingReqs.length > 0 && (
        <div className="panel wl-req-panel">
          <h3>Whitelist İstekleri</h3>
          {pendingReqs.map((r) => (
            <div key={r.id} className="wl-req-row">
              <span className="wl-req-info">
                <b>{r.nickname}</b>
                <span className={`wl-req-status st-${r.status}`}>
                  {r.status === 'pending'
                    ? 'bekliyor'
                    : r.status === 'accepted'
                      ? 'kabul edildi'
                      : 'reddedildi'}
                </span>
              </span>
              {r.status === 'pending' ? (
                <span className="wl-req-actions">
                  <button
                    type="button"
                    className="btn primary small"
                    disabled={reqBusy === r.id}
                    onClick={() => void respondWlReq(r, true)}
                  >
                    Ekle
                  </button>
                  <button
                    type="button"
                    className="btn small"
                    disabled={reqBusy === r.id}
                    onClick={() => void respondWlReq(r, false)}
                  >
                    Reddet
                  </button>
                </span>
              ) : null}
            </div>
          ))}
          {reqNote && <p className="setting-note ok">{reqNote}</p>}
          <p className="setting-note">
            "Ekle" hem isteği onaylar hem de nick'i whitelist'e ekler — arkadaşın
            tekrar Katıl'a basarak sunucuya girebilir.
          </p>
        </div>
      )}

      <div className="panel wl-panel">
        <h3>Whitelist (girebilecek nick'ler)</h3>
        <form onSubmit={addWhitelist} className="friend-add">
          <input
            value={wlInput}
            onChange={(e) => setWlInput(e.target.value)}
            placeholder="Nickname ekle..."
            maxLength={16}
          />
          <button type="submit" className="btn primary" disabled={!wlInput.trim()}>
            Ekle
          </button>
        </form>
        <div className="wl-list">
          {whitelist.length === 0 ? (
            <div className="friends-empty">
              Bos. Arkadaslarinin launcher nick'lerini ekleyin — sadece onlar girebilir.
            </div>
          ) : (
            whitelist.map((nick) => (
              <span key={nick} className="wl-chip">
                {nick}
                <button
                  type="button"
                  className="wl-x"
                  onClick={() => removeWhitelist(nick)}
                  title="Cikar"
                >
                  x
                </button>
              </span>
            ))
          )}
        </div>
        <p className="setting-note">
          Not: {user.nickname} olarak oyuna girmek icin kendi nick'inizi de listeye ekleyin.
        </p>
      </div>

      {logLines.length > 0 && (
        <div className="panel log-panel">
          <div className="log-head">Sunucu cikti (son 300 satir)</div>
          <div className="log-body tall">
            {logLines.map((l, i) => (
              <div key={i} className="log-line">
                {l}
              </div>
            ))}
            <div ref={logEndRef} />
          </div>
        </div>
      )}
    </div>
  )
}
