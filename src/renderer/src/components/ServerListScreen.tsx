// Sunucu Listesi ekrani — aktif sunucular (kendi + arkadaslarin) burada listelenir.
// Kullanici istegi: acik sunucular Oyna sayfasinda degil, ayri bir menude gorunsun;
// ust bardaki rozet acik sunucu sayisini gosterir. Katilma akisi (probe -> surum ->
// plugin senkronu -> kick/whitelist paneli) Oyna sayfasindan buraya tasindi.
import { useCallback, useEffect, useRef, useState } from 'react'
import { gameBridge } from '../lib/game'
import { subscribeLiveEvents } from '../lib/poller'
import type { AuthUser } from '../lib/api'
import {
  sendWhitelistRequest,
  fetchWhitelistRequests,
  type ActiveServer,
  type OutgoingWhitelistState
} from '../lib/friends'
import type { ProbeStatus } from '../lib/game'
import { processJoinLine, PHASE_LABEL, type JoinState } from '../../../shared/joinStatus'

interface Props {
  user: AuthUser
  /** App ust bardaki polling'den gelen guncel aktif sunucu listesi */
  servers: ActiveServer[]
  /** Liste tazeleme (kick raporu erken cekme vb. icin) */
  onRefresh: () => void
}

export default function ServerListScreen({ user, servers, onRefresh }: Props) {
  const bridge = gameBridge()
  // Bilinen surum id'leri — sunucu bilinmeyen bir surum kullanuyorsa uyari
  const knownVersionsRef = useRef<Set<string>>(new Set())
  const [probing, setProbing] = useState<string | null>(null)
  const [probeResult, setProbeResult] = useState<Record<string, boolean>>({})
  // Faz 15: canli sunucu durumu (SLP) — liste her yenilendiginde sorgulanir
  const [liveStatus, setLiveStatus] = useState<Record<string, ProbeStatus>>({})
  // ---- Katilma durumu izleyici (Faz 5b) ----
  const [joinState, setJoinState] = useState<JoinState>({ phase: 'idle', kick: null })
  const [joinLabel, setJoinLabel] = useState<string | null>(null)
  const joinActiveRef = useRef(false)
  const joinStateRef = useRef<JoinState>({ phase: 'idle', kick: null })
  const joinedHostIdRef = useRef<number | null>(null)
  const joinHoldTimerRef = useRef<number | null>(null)
  const joinStartedAtRef = useRef(0)
  // ---- Whitelist istegi (Faz 5c) ----
  const [wlReqBusy, setWlReqBusy] = useState(false)
  const [wlReqNote, setWlReqNote] = useState<string | null>(null)
  // Plugin senkron sonucu — ayri satir (joinLabel uzerine yazilip kaybolmasin)
  const [syncNote, setSyncNote] = useState<string | null>(null)
  const [wlOutgoing, setWlOutgoing] = useState<Map<number, OutgoingWhitelistState>>(new Map())

  const [playing, setPlaying] = useState(false)
  const [logLines, setLogLines] = useState<string[]>([])
  const logEndRef = useRef<HTMLDivElement | null>(null)

  // Surum manifestini bir kez yukle (bilinmeyen surum uyarisi icin yeterli)
  useEffect(() => {
    let alive = true
    bridge
      .listVersions()
      .then((r) => {
        if (alive) knownVersionsRef.current = new Set(r.versions.map((v) => v.id))
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [bridge])

  // Faz 15: listedeki her sunucuya SLP sorgusu (ping/oyuncu/MOTD/ikon).
  // servers degisince tetiklenir; paralel sorgu, hizli zaman asimi.
  useEffect(() => {
    let alive = true
    for (const srv of servers) {
      const key = String(srv.hostId)
      bridge
        .probeServerStatus(srv.address, srv.port)
        .then((st) => {
          if (alive) setLiveStatus((prev) => ({ ...prev, [key]: st }))
        })
        .catch(() => {})
    }
    return () => {
      alive = false
    }
  }, [bridge, servers])

  // Gonderdigim whitelist isteklerinin durumu: canli olay ile aninda tazelenir
  // (host onayladiginda "✅ eklendin" ~1 sn'de gorunur) + 60 sn yedek polling
  useEffect(() => {
    let alive = true
    const load = () => {
      fetchWhitelistRequests()
        .then((r) => {
          if (alive) {
            setWlOutgoing(
              new Map(
                r.outgoing.map((o) => [
                  o.hostId,
                  { status: o.status, respondedAt: o.respondedAt }
                ])
              )
            )
          }
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

  // Oyun event'leri — yalnizca katilma akisi icin (manuel Oyna, Oyna sekmesinde)
  useEffect(() => {
    const off = bridge.onGameEvent((ev) => {
      if (ev.type === 'status') {
        if (joinActiveRef.current && ev.message) setJoinLabel(ev.message)
      } else if (ev.type === 'progress') {
        if (joinActiveRef.current) setJoinLabel(`${ev.label ?? 'Indiriliyor'} — %${ev.percent ?? 0}`)
      } else if (ev.type === 'log') {
        if (ev.line) {
          setLogLines((l) => [...l.slice(-299), ev.line as string])
          if (joinActiveRef.current) {
            const prev = joinStateRef.current
            const next = processJoinLine(ev.line, prev)
            if (next !== prev) {
              joinStateRef.current = next
              setJoinState(next)
              if (next.phase === 'connected') {
                setJoinLabel(PHASE_LABEL.connected)
                joinActiveRef.current = false
              } else if (next.phase === 'failed' && next.kick) {
                setJoinLabel(next.kick.friendly)
                joinActiveRef.current = false
                setPlaying(false)
                // Host'un Paper log'undaki gercek sebeb hemen cekilsin
                onRefresh()
              } else {
                setJoinLabel(PHASE_LABEL[next.phase])
              }
            }
          }
        }
      } else if (ev.type === 'started') {
        setPlaying(true)
      } else if (ev.type === 'close') {
        setPlaying(false)
        // Oyun kapanirken kick sebebi HENUZ gelmemis olabilir — paneli kisaca
        // 'tut'; gelmezse 20 sn sonra temizle.
        if (joinActiveRef.current) {
          setJoinLabel('Oyun kapandı — bağlantı tamamlanamadı. Sebep alınıyor...')
          if (joinHoldTimerRef.current) window.clearTimeout(joinHoldTimerRef.current)
          joinHoldTimerRef.current = window.setTimeout(() => {
            joinActiveRef.current = false
            joinStateRef.current = { phase: 'idle', kick: null }
            setJoinState({ phase: 'idle', kick: null })
            setJoinLabel(null)
          }, 20_000)
        } else {
          joinActiveRef.current = false
          joinStateRef.current = { phase: 'idle', kick: null }
          setJoinState({ phase: 'idle', kick: null })
          setJoinLabel(null)
        }
      } else if (ev.type === 'error') {
        if (joinHoldTimerRef.current) window.clearTimeout(joinHoldTimerRef.current)
        joinActiveRef.current = false
        joinStateRef.current = { phase: 'idle', kick: null }
        setJoinState({ phase: 'idle', kick: null })
        setJoinLabel(null)
        setPlaying(false)
      }
    })
    return off
  }, [bridge, onRefresh])

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logLines])

  const handleWlRequest = useCallback(
    async (srv: ActiveServer) => {
      setWlReqBusy(true)
      setWlReqNote(null)
      try {
        await sendWhitelistRequest(srv.host)
        setWlReqNote(`${srv.host} icin whitelist istegi gonderildi. Onaylandiginda burada goreceksin.`)
        setWlOutgoing((prev) => new Map(prev).set(srv.hostId, { status: 'pending', respondedAt: null }))
      } catch (err) {
        setWlReqNote(`Istek gonderilemedi: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        setWlReqBusy(false)
      }
    },
    []
  )

  // Oyun acikken Katil'a basilmissa: acik oyunu kapat, quickPlay ile yeniden baslat
  const relaunchIfRunning = useCallback(async (): Promise<boolean> => {
    const running = await bridge.isRunning().catch(() => false)
    if (!running) return true
    setJoinLabel('Açık oyun kapatılıyor (yeni bağlantı için)...')
    try {
      await bridge.stopGame()
    } catch {
      /* kapatma hatasi: launch yine de denensin */
    }
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 250))
      if (!(await bridge.isRunning().catch(() => true))) return true
    }
    return false
  }, [bridge])

  const handleJoin = useCallback(
    async (srv: ActiveServer) => {
      const key = `${srv.hostId}`
      setProbing(key)
      setLogLines([])
      setJoinState({ phase: 'idle', kick: null })
      joinStateRef.current = { phase: 'idle', kick: null }
      joinedHostIdRef.current = null
      setJoinLabel(null)
      setWlReqNote(null)
      setSyncNote(null)
      if (joinHoldTimerRef.current) {
        window.clearTimeout(joinHoldTimerRef.current)
        joinHoldTimerRef.current = null
      }
      try {
        setJoinLabel('Sunucu kontrol ediliyor...')
        const probe = await bridge.probeServer(srv.address, srv.port)
        setProbeResult((prev) => ({ ...prev, [key]: probe.ok }))
        if (!probe.ok) {
          setJoinLabel(
            `Sunucuya ulasilamadi (${srv.address}:${srv.port}${probe.error ? ` — ${probe.error}` : ''}). Host'un sunucusu kapali olabilir.`
          )
          return
        }
        const known = knownVersionsRef.current.has(srv.mcVersion)
        if (!known) {
          setJoinLabel(
            `Sunucu bilinmeyen bir surum kullaniyor (${srv.mcVersion}); surum listesi guncel degil olabilir.`
          )
        }
        const closed = await relaunchIfRunning()
        if (!closed) {
          setJoinLabel('Açık oyun kapatılamadı — lütfen oyunu elle kapatıp tekrar Katıl\'a bas.')
          return
        }
        joinedHostIdRef.current = srv.hostId
        joinActiveRef.current = true
        joinStartedAtRef.current = Date.now()
        setPlaying(true)

        // Plugin senkronu (Faz 7) — basarisizlik katilmani engellemez
        setJoinLabel('Eklentiler kontrol ediliyor...')
        try {
          const sync = await bridge.pluginsSync(srv.host)
          if (sync.downloaded.length > 0) {
            const names = sync.downloaded
              .map((f) => f.replace(/\.jar$/i, ''))
              .slice(0, 3)
              .join(', ')
            setSyncNote(
              `🧩 ${sync.downloaded.length} eklenti indirildi: ${names}${sync.downloaded.length > 3 ? ' …' : ''}`
            )
          } else {
            setSyncNote('🧩 Eklentiler guncel ✓')
          }
        } catch {
          setSyncNote('🧩 Eklenti kontrolu atlandi (manifeste erisilemedi)')
        }

        // Faz 12: client mod senkronu + Fabric profil kurulumu — basarisizlik
        // katilmayi engellemez (host mod da dagitmis olabilir; uyari yeterli).
        // mods/ dizinini main process yonetir; renderer yalnizca host ister.
        let localVersionId: string | null = null
        setJoinLabel('Modlar kontrol ediliyor...')
        try {
          const plan = await bridge.modsPlanSync(srv.host)
          if (plan.manifestTotal > 0) {
            if (plan.toDownload.length > 0) {
              setJoinLabel(`Modlar indiriliyor (0/${plan.toDownload.length})...`)
              const result = await bridge.modsSync(srv.host)
              if (result.ok) {
                if (result.downloaded.length > 0) {
                  setSyncNote(
                    `🧱 ${result.downloaded.length} mod indirildi${result.downloaded.length > 2 ? ' (ve digerleri)' : ''}`
                  )
                }
              } else {
                setSyncNote(`🧱 Mod senkronu basarisiz: ${result.failed ?? 'bilinmeyen'}`)
              }
            } else {
              setSyncNote('🧱 Modlar guncel ✓')
            }
          }
          // Host profil yayinlamissa (Fabric) oyun o profilden acilir
          const prof = await bridge.hostProfile(srv.host)
          if (prof?.loader === 'fabric' && prof.loaderVersion) {
            setJoinLabel(`Fabric ${prof.loaderVersion} profili hazirlaniyor...`)
            const ensured = await bridge.fabricEnsure(prof.mcVersion, prof.loaderVersion)
            localVersionId = await bridge.localVersion(prof.mcVersion)
            // Faz 12.5: fabric-api otomatik kurulduysa kullaniciya bildir
            if (ensured.fabricApi?.installed) {
              setSyncNote(`🧱 Fabric API kuruldu (${ensured.fabricApi.installed})`)
            } else if (ensured.fabricApi && !ensured.fabricApi.ok && ensured.fabricApi.skipped) {
              const reason = ensured.fabricApi.skipped
              if (!/zaten kurulu/.test(reason)) {
                setSyncNote((prev) => prev ?? `🧱 Fabric API kurulamadi: ${reason}`)
              }
            }
            // Faz 12.6/12.7: genel bağımlılık çözümü sonucu — indirilenler ve
            // ÇÖZÜLEMEYENLER (oyun acilista crash edebilir) kullaniciya net bildirilir
            if (ensured.deps?.installed?.length) {
              setSyncNote(`🧱 Eksik bagimliliklar kuruldu (${ensured.deps.installed.length})`)
            }
            if (ensured.deps && !ensured.deps.ok && ensured.deps.failures.length > 0) {
              setSyncNote((prev) => prev ?? `🧱 Cozullemeyen bagimliliklar: ${ensured.deps!.failures.join('; ')}`)
            }
          }
        } catch {
          setSyncNote((prev) => prev ?? '🧱 Mod kontrolu atlandi (manifeste erisilemedi)')
        }
        // Kick raporu erken tazeleme (3s/8s/15s)
        for (const delay of [3_000, 8_000, 15_000]) {
          window.setTimeout(() => {
            if (joinActiveRef.current) onRefresh()
          }, delay)
        }
        setJoinLabel(
          known || localVersionId
            ? `${srv.host} sunucusuna baglaniliyor...`
            : `${srv.mcVersion} indiriliyor (ilk seferinde biraz surer)...`
        )
        await bridge.launch({
          versionId: srv.mcVersion,
          nickname: user.nickname,
          serverAddress: `${srv.address}:${srv.port}`,
          ...(localVersionId ? { localVersionId } : {})
        })
      } catch (err) {
        joinActiveRef.current = false
        setPlaying(false)
        setJoinLabel(`Katilma hatasi: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        setProbing(null)
      }
    },
    [bridge, user.nickname, relaunchIfRunning, onRefresh]
  )

  // HOST'un Paper log'undaki gercek kick sebebini panele tasi (bayatlik korumali)
  useEffect(() => {
    if (joinStateRef.current.phase === 'connected') return
    const kick = servers.find((s) => s.hostId === joinedHostIdRef.current)?.lastKick
    if (!kick?.reason) return
    const prevKick = joinStateRef.current.kick
    if (prevKick?.code === 'host_reported' && prevKick.at === kick.at) return
    if (joinStartedAtRef.current && new Date(kick.at).getTime() < joinStartedAtRef.current - 5000) {
      return
    }
    const enriched: JoinState = {
      phase: 'failed',
      kick: {
        code: 'host_reported',
        friendly: kick.reason,
        raw: kick.rawLine || prevKick?.raw || '',
        at: kick.at
      }
    }
    joinStateRef.current = enriched
    setJoinState(enriched)
    setJoinLabel(kick.reason)
    joinActiveRef.current = false
    setPlaying(false)
    if (joinHoldTimerRef.current) window.clearTimeout(joinHoldTimerRef.current)
    setWlReqNote(null)
  }, [servers, joinState.phase])

  return (
    <div className="play-screen">
      <div className="panel active-servers-panel">
        <h3>Aktif Sunucular</h3>
        {servers.length === 0 ? (
          <p className="setting-note">
            Şu an açık sunucu yok. Arkadaşın sunucuyu başlattığında (veya sen
            Sunucu sekmesinden başlattığında) burada listelenecek.
          </p>
        ) : (
          servers.map((srv) => {
            const reachable = probeResult[String(srv.hostId)]
            const live = liveStatus[String(srv.hostId)]
            return (
              <div key={srv.hostId} className="active-server-row">
                {/* Faz 15: sunucu ikonu (SLP favicon) */}
                {live?.favicon ? (
                  <img className="srv-icon" src={live.favicon} alt="" width={32} height={32} />
                ) : (
                  <span
                    className={`status-dot ${reachable === false ? 'offline' : ''}`}
                    title={reachable === false ? 'Son kontrolde ulasilamadi' : 'Aktif'}
                  />
                )}
                <div className="active-server-info">
                  <b>{srv.host}</b> sunucusu açık — <code>{srv.address}:{srv.port}</code>
                  <span className="active-server-ver"> (Paper {srv.mcVersion})</span>
                  {/* Faz 15: canli durum — ping, oyuncu, MOTD */}
                  {live && live.online && (
                    <span className="srv-live">
                      <span className="srv-ping" title="Ping">
                        {live.latencyMs != null ? `${live.latencyMs} ms` : '...'}
                      </span>
                      {live.players && (
                        <span className="srv-players" title="Oyuncular">
                          👥 {live.players.online}/{live.players.max}
                        </span>
                      )}
                      {live.motd && <span className="srv-motd" title={live.motd}>{live.motd.slice(0, 60)}</span>}
                    </span>
                  )}
                  {/* Faz 14: icerik rozetleri — sunucudaki mod/plugin sayilari */}
                  {(srv.clientMods ?? 0) > 0 && (
                    <span
                      className="badge content-badge"
                      title={`Host bu sunucuya ${srv.clientMods} client mod kurmus — Katil dediginde oyununa otomatik indirilir`}
                      style={{
                        marginLeft: 6,
                        fontSize: 11,
                        padding: '1px 8px',
                        borderRadius: 10,
                        background: 'var(--accent, #4f8cff)',
                        color: '#fff',
                        whiteSpace: 'nowrap'
                      }}
                    >
                      🧱 {srv.clientMods} mod
                    </span>
                  )}
                  {(srv.plugins ?? 0) > 0 && (
                    <span
                      className="badge content-badge"
                      title={`Host bu sunucuya ${srv.plugins} server plugin kurmus — Katil dediginde otomatik senkronlanir`}
                      style={{
                        marginLeft: 6,
                        fontSize: 11,
                        padding: '1px 8px',
                        borderRadius: 10,
                        background: '#2e9e5b',
                        color: '#fff',
                        whiteSpace: 'nowrap'
                      }}
                    >
                      🔌 {srv.plugins} plugin
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className="btn primary"
                  disabled={playing || probing !== null}
                  onClick={() => void handleJoin(srv)}
                >
                  {probing === String(srv.hostId) ? 'Kontrol ediliyor...' : 'Katıl'}
                </button>
              </div>
            )
          })
        )}
        <p className="setting-note">
          "Katıl" önce sunucunun ayakta olduğunu kontrol eder, sonra oyunu doğru
          sürümle açar, eklentileri senkronlar ve otomatik bağlanır.
        </p>
      </div>

      {joinLabel && (
        <div className={`panel join-status-panel ${joinState.phase === 'failed' ? 'join-failed' : ''}`}>
          <span className={`status-dot ${joinState.phase === 'failed' ? 'offline' : joinState.phase === 'connected' ? '' : 'pulse'}`} />
          <span>{joinLabel}</span>
          {joinState.phase === 'failed' && joinState.kick?.raw && (
            <code className="join-raw">{joinState.kick.raw}</code>
          )}
          {joinState.phase === 'failed' &&
            joinedHostIdRef.current !== null &&
            (() => {
              const kick = joinState.kick
              const isWhitelistKick =
                kick?.code === 'not_whitelisted' ||
                (kick?.code === 'host_reported' &&
                  (/whitelist/i.test(kick.raw) || /whitelist/i.test(kick.friendly)))
              if (!isWhitelistKick) return null
              const hostSrv = servers.find((s) => s.hostId === joinedHostIdRef.current)
              if (!hostSrv) return null
              const st = wlOutgoing.get(hostSrv.hostId)
              const refAt = kick?.at
                ? new Date(kick.at).getTime()
                : joinStartedAtRef.current
              const stale =
                !!st &&
                st.status !== 'pending' &&
                (!st.respondedAt || new Date(st.respondedAt).getTime() < refAt)
              const freshStatus = stale ? undefined : st?.status
              if (freshStatus === 'pending') {
                return (
                  <span className="wl-req-status-line">⏳ İstek iletildi — onay bekleniyor</span>
                )
              }
              if (freshStatus === 'accepted') {
                return (
                  <span className="wl-req-status-line ok">
                    ✅ Whitelist'e eklendin — tekrar Katıl'a basabilirsin
                  </span>
                )
              }
              if (freshStatus === 'declined') {
                return <span className="wl-req-status-line err">Host isteği reddetti</span>
              }
              return (
                <button
                  type="button"
                  className="btn small"
                  disabled={wlReqBusy}
                  onClick={() => void handleWlRequest(hostSrv)}
                >
                  {wlReqBusy ? 'Gönderiliyor...' : `${hostSrv.host} icin whitelist istegi gonder`}
                </button>
              )
            })()}
          {syncNote && <span className="wl-req-status-line">{syncNote}</span>}
          {wlReqNote && <span className="wl-req-status-line">{wlReqNote}</span>}
        </div>
      )}

      {logLines.length > 0 && (
        <div className="panel log-panel">
          <div className="log-head">Katilma cikti (son 300 satir)</div>
          <div className="log-body">
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
