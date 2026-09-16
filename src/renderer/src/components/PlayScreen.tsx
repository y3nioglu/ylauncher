// Oyna ekrani — manuel surum secimi + oyun baslatma. Aktif sunucularin
// listesi ve tek tikla katilma akisi ayri Sunucu Listesi ekranina tasindi
// (kullanici istegi: acik sunucular Oyna sayfasinda gosterilmesin).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { gameBridge, type VersionEntry } from '../lib/game'
import type { AuthUser } from '../lib/api'

interface Props {
  user: AuthUser
}

export default function PlayScreen({ user }: Props) {
  const bridge = gameBridge()
  const [versions, setVersions] = useState<VersionEntry[]>([])
  const [latestRelease, setLatestRelease] = useState('')
  const [installed, setInstalled] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState('')
  const [loadingVersions, setLoadingVersions] = useState(true)
  const [versionsError, setVersionsError] = useState<string | null>(null)

  const [playing, setPlaying] = useState(false)
  const [statusText, setStatusText] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ percent: number; label: string } | null>(null)
  const [logLines, setLogLines] = useState<string[]>([])
  const logEndRef = useRef<HTMLDivElement | null>(null)

  // Surum listesini ve indirilmis surumleri getir
  useEffect(() => {
    let alive = true
    bridge
      .listVersions()
      .then((r) => {
        if (!alive) return
        setVersions(r.versions)
        setLatestRelease(r.latestRelease)
        setSelected(r.latestRelease)
      })
      .catch((e: unknown) => {
        if (alive) setVersionsError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (alive) setLoadingVersions(false)
      })
    bridge
      .listInstalledVersions()
      .then((ids) => alive && setInstalled(new Set(ids)))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [bridge])

  // Oyun event'lerini dinle — manuel Oyna akisi (katilma akisi Sunucu Listesi'nde)
  useEffect(() => {
    const off = bridge.onGameEvent((ev) => {
      if (ev.type === 'status') {
        setStatusText(ev.message ?? null)
      } else if (ev.type === 'progress') {
        setProgress({ percent: ev.percent ?? 0, label: ev.label ?? '' })
      } else if (ev.type === 'started') {
        setPlaying(true)
        setStatusText('Oyun basladi. Iyi oyunlar!')
        setProgress(null)
      } else if (ev.type === 'close') {
        setPlaying(false)
        setStatusText(`Oyun kapatildi (kod: ${ev.code ?? 0}).`)
        setProgress(null)
        // Oyun kapaninca indirilen yeni surumleri yakalamak icin listeyi tazele
        bridge
          .listInstalledVersions()
          .then((ids) => setInstalled(new Set(ids)))
          .catch(() => {})
      } else if (ev.type === 'error') {
        setStatusText(`Hata: ${ev.message ?? 'bilinmeyen'}`)
        setProgress(null)
        setPlaying(false)
      }
    })
    return off
  }, [bridge])

  // Log panelini otomatik kaydir
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logLines])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const matches = versions.filter(
      (v) => v.type === 'release' && (!q || v.id.toLowerCase().includes(q))
    )
    // Indirilmis surumler en ustte (manifest'teki yeni->eski sirasi korunur),
    // ardindan indirilmemisler gelir
    return [
      ...matches.filter((v) => installed.has(v.id)),
      ...matches.filter((v) => !installed.has(v.id))
    ]
  }, [versions, search, installed])

  // Arama sonucunda secili surum listede yoksa ilk esleseni otomatik sec —
  // boylece kullanici arama kutusuna yazip direkt Oyna'ya basinca eski secim gitmez
  const handleSearch = useCallback(
    (q: string) => {
      setSearch(q)
      const s = q.trim().toLowerCase()
      if (!s) return
      const matches = versions.filter(
        (v) => v.type === 'release' && v.id.toLowerCase().includes(s)
      )
      if (matches.length > 0 && !matches.some((v) => v.id === selected)) {
        setSelected(matches[0].id)
      }
    },
    [versions, selected]
  )

  const handlePlay = useCallback(() => {
    if (!selected) return
    setPlaying(true)
    setLogLines([])
    setStatusText('Hazirlaniyor...')
    bridge
      .launch({ versionId: selected, nickname: user.nickname })
      .catch((err: unknown) => {
        setPlaying(false)
        setStatusText(null)
        setLogLines((l) => [...l, `[hata] ${err instanceof Error ? err.message : String(err)}`])
      })
  }, [bridge, selected, user.nickname])

  const handleStop = useCallback(() => {
    void bridge.stopGame().catch(() => {})
  }, [bridge])

  return (
    <div className="play-screen">
      <div className="panel play-panel">
        <div className="play-row">
          <div className="version-picker">
            <input
              className="version-search"
              placeholder="Surum ara..."
              value={search}
              onChange={(e) => handleSearch(e.target.value)}
            />
            {loadingVersions ? (
              <div className="version-status">Surumler yukleniyor...</div>
            ) : versionsError ? (
              <div className="version-status error">{versionsError}</div>
            ) : (
              <select
                className="version-select"
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
                size={8}
              >
                {filtered.map((v) => (
                  <option key={v.id} value={v.id}>
                    {installed.has(v.id) ? '✓ ' : ''}
                    {v.id}
                    {v.id === latestRelease ? '  (en yeni)' : ''}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="play-side">
            <div className="selected-version">
              Secili surum: <b>{selected || '-'}</b>
            </div>
            <button
              type="button"
              className="btn primary play-btn"
              disabled={playing || !selected || loadingVersions}
              onClick={handlePlay}
            >
              {playing ? 'Calisiyor...' : `Oyna · ${selected || '?'}`}
            </button>
            {playing && (
              <button type="button" className="btn danger" onClick={handleStop}>
                Oyunu Kapat
              </button>
            )}
            <div className="play-note">
              Oyun icinde gorunecek isim: <b>{user.nickname}</b>
              <br />
              ✓ isaretli surumler bilgisayarinda hazir; digerleri ilk Oyna'da
              otomatik indirilir (Java dahil). Sonraki acilislar hizlidir.
            </div>
          </div>
        </div>

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
      </div>

      {logLines.length > 0 && (
        <div className="panel log-panel">
          <div className="log-head">Oyun cikti (son 300 satir)</div>
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
