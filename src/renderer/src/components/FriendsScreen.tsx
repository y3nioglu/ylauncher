import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fetchFriends,
  fetchSuggestions,
  sendFriendRequest,
  respondFriendRequest,
  removeFriend,
  type FriendsPayload,
  type FriendRequestDto,
  type NickSuggestion
} from '../lib/friends'

interface Props {
  onDataChange?: () => void
}

export default function FriendsScreen({ onDataChange }: Props) {
  const [data, setData] = useState<FriendsPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [addNick, setAddNick] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // Otomatik tamamlama durumu
  const [sugs, setSugs] = useState<NickSuggestion[]>([])
  const [sugOpen, setSugOpen] = useState(false)
  const [hl, setHl] = useState(-1)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(async () => {
    try {
      const payload = await fetchFriends()
      setData(payload)
      setLoadError(null)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
    // Topbardaki rozetin de guncellenmesi icin ust bileteni haber ver
    onDataChange?.()
  }, [onDataChange])

  useEffect(() => {
    void refresh()
    const t = setInterval(() => void refresh(), 20_000) // online durumlar icin hafif polling
    return () => clearInterval(t)
  }, [refresh])

  const relLabel = (r: NickSuggestion['relation']): string => {
    switch (r) {
      case 'self':
        return 'bu sen'
      case 'friends':
        return 'zaten arkadas'
      case 'pending_out':
        return 'istek gonderildi'
      case 'pending_in':
        return 'sana istek gonderdi'
      default:
        return ''
    }
  }

  const chooseSug = useCallback((s: NickSuggestion) => {
    setAddNick(s.nickname)
    setSugOpen(false)
    setSugs([])
    setHl(-1)
  }, [])

  const onNickChange = useCallback((v: string) => {
    setAddNick(v)
    setActionError(null)
    setNotice(null)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const q = v.trim()
    if (q.length < 2) {
      setSugs([])
      setSugOpen(false)
      setHl(-1)
      return
    }
    debounceRef.current = setTimeout(() => {
      fetchSuggestions(q)
        .then((s) => {
          setSugs(s)
          setSugOpen(s.length > 0)
          setHl(-1)
        })
        .catch(() => {
          setSugs([])
          setSugOpen(false)
        })
    }, 250)
  }, [])

  const onNickKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (!sugOpen || sugs.length === 0) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setHl((h) => (h + 1) % sugs.length)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setHl((h) => (h <= 0 ? sugs.length - 1 : h - 1))
      } else if (e.key === 'Enter' && hl >= 0) {
        e.preventDefault()
        chooseSug(sugs[hl])
      } else if (e.key === 'Escape') {
        setSugOpen(false)
      }
    },
    [sugOpen, sugs, hl, chooseSug]
  )

  const handleAdd = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      const nick = addNick.trim()
      if (!nick) return
      setBusy(true)
      setActionError(null)
      setNotice(null)
      try {
        const result = await sendFriendRequest(nick)
        if (result.accepted) {
          setNotice(`${nick} ile artik arkadassiniz!`)
        } else {
          setNotice(`${nick} kullancisina arkadaslik istegi gonderildi.`)
        }
        setAddNick('')
        await refresh()
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [addNick, refresh]
  )

  const handleRespond = useCallback(
    async (r: FriendRequestDto, accept: boolean) => {
      setActionError(null)
      setNotice(null)
      try {
        await respondFriendRequest(r.requestId, accept)
        setNotice(accept ? `${r.nickname} arkadaslik istegi kabul edildi.` : `${r.nickname} istegi reddedildi.`)
        await refresh()
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err))
      }
    },
    [refresh]
  )

  const handleRemove = useCallback(
    async (nickname: string) => {
      setActionError(null)
      setNotice(null)
      try {
        await removeFriend(nickname)
        setNotice(`${nickname} arkadas listesinden cikarildi.`)
        await refresh()
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err))
      }
    },
    [refresh]
  )

  return (
    <div className="panel friends-panel">
      <h2>Arkadaslar</h2>

      <form onSubmit={handleAdd} className="friend-add">
        <div className="suggest-wrap">
          <input
            value={addNick}
            onChange={(e) => onNickChange(e.target.value)}
            onKeyDown={onNickKeyDown}
            onBlur={() => setTimeout(() => setSugOpen(false), 150)}
            onFocus={() => {
              if (sugs.length > 0) setSugOpen(true)
            }}
            placeholder="Arkadas nickname..."
            maxLength={16}
            autoComplete="off"
          />
          {sugOpen && sugs.length > 0 && (
            <div className="suggest-list">
              {sugs.map((s, i) => (
                <div
                  key={s.id}
                  className={`suggest-item rel-${s.relation} ${i === hl ? 'hl' : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    chooseSug(s)
                  }}
                  onMouseEnter={() => setHl(i)}
                >
                  <span className="suggest-nick">{s.nickname}</span>
                  {relLabel(s.relation) && <span className="suggest-rel">{relLabel(s.relation)}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
        <button type="submit" className="btn primary" disabled={busy || !addNick.trim()}>
          {busy ? '...' : 'Istek Gonder'}
        </button>
      </form>

      {actionError && <div className="msg error">{actionError}</div>}
      {notice && <div className="msg ok">{notice}</div>}
      {loadError && <div className="msg error">Liste alinamadi: {loadError}</div>}

      {loading && !data ? (
        <div className="friends-empty">Yukleniyor...</div>
      ) : (
        <>
          {data && data.incoming.length > 0 && (
            <section className="friend-section">
              <h3>Gelen Istekler ({data.incoming.length})</h3>
              {data.incoming.map((r) => (
                <div key={r.requestId} className="friend-row request">
                  <span className="friend-name">{r.nickname}</span>
                  <div className="friend-actions">
                    <button type="button" className="btn primary small" onClick={() => handleRespond(r, true)}>
                      Kabul Et
                    </button>
                    <button type="button" className="btn ghost small" onClick={() => handleRespond(r, false)}>
                      Reddet
                    </button>
                  </div>
                </div>
              ))}
            </section>
          )}

          <section className="friend-section">
            <h3>
              Arkadas Listesi{' '}
              {data && <span className="count">({data.friends.length})</span>}
            </h3>
            {!data || data.friends.length === 0 ? (
              <div className="friends-empty">
                Henuz arkadin yok. Yukarıdan nickname ile istek gonder.
              </div>
            ) : (
              data.friends.map((f) => (
                <div key={f.id} className="friend-row">
                  <span className="friend-identity">
                    <span className={`dot ${f.online ? 'online' : 'offline'}`} />
                    <span className="friend-name">{f.nickname}</span>
                    <span className="friend-status">{f.online ? 'Cevrimici' : 'Cevrimdisi'}</span>
                  </span>
                  <div className="friend-actions">
                    <button type="button" className="btn ghost small" onClick={() => handleRemove(f.nickname)}>
                      Cikar
                    </button>
                  </div>
                </div>
              ))
            )}
          </section>

          {data && data.outgoing.length > 0 && (
            <section className="friend-section">
              <h3>Gonderilen Istekler ({data.outgoing.length})</h3>
              {data.outgoing.map((r) => (
                <div key={r.requestId} className="friend-row pending">
                  <span className="friend-name">{r.nickname}</span>
                  <span className="friend-status">Yanit bekleniyor...</span>
                </div>
              ))}
            </section>
          )}
        </>
      )}
    </div>
  )
}
