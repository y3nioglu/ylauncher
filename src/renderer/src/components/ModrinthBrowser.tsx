// Faz 17: Modrinth tarayicisi — modpack ve resource pack arama + kurulum.
// Modpack: .mrpack olarak indirilir (server tarafinda kurulum ileride).
// Resource pack: dogrudan oyunun resourcepacks klasorune iner.
import { useCallback, useEffect, useState } from 'react'
import { gameBridge, type ModrinthResult } from '../lib/game'

interface Props {
  kind: 'modpack' | 'resourcepack'
  gameRoot: string
  /** Uyumlu dosya secimi icin hedef MC surumu */
  mcVersion: string
}

interface DownloadState {
  busy: boolean
  note: string | null
}

export default function ModrinthBrowser({ kind, gameRoot, mcVersion }: Props) {
  const bridge = gameBridge()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ModrinthResult[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [dl, setDl] = useState<Record<string, DownloadState>>({})

  const search = useCallback(
    (q: string) => {
      setLoading(true)
      setErr(null)
      const fn = kind === 'modpack' ? bridge.searchModpacks : bridge.searchResourcePacks
      fn(q)
        .then((r) => setResults(r))
        .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
        .finally(() => setLoading(false))
    },
    [bridge, kind]
  )

  // Ilk acilista populerleri getir
  useEffect(() => {
    search('')
  }, [search])

  const download = useCallback(
    async (r: ModrinthResult) => {
      setDl((p) => ({ ...p, [r.projectId]: { busy: true, note: 'Indiriliyor...' } }))
      try {
        const res =
          kind === 'modpack'
            ? await bridge.modrinthDownloadModpack({ projectId: r.projectId, mcVersion, gameRoot })
            : await bridge.modrinthDownloadResourcepack({ projectId: r.projectId, mcVersion, gameRoot })
        if (!res.ok) throw new Error(res.error ?? 'Indirme basarisiz')
        setDl((p) => ({ ...p, [r.projectId]: { busy: false, note: `İndirildi: ${res.file}` } }))
      } catch (e) {
        setDl((p) => ({
          ...p,
          [r.projectId]: { busy: false, note: e instanceof Error ? e.message : String(e) }
        }))
      }
    },
    [bridge, kind, gameRoot, mcVersion]
  )

  return (
    <div className="modrinth-browser">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          search(query)
        }}
      >
        <input
          placeholder={kind === 'modpack' ? 'Modpack ara...' : 'Resource pack ara...'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="submit" className="btn primary small">
          Ara
        </button>
      </form>
      {loading && <p className="setting-note">Aranıyor...</p>}
      {err && <p className="setting-note error">{err}</p>}
      <div className="modrinth-list">
        {results.map((r) => (
          <div key={r.projectId} className="modrinth-row">
            {r.iconUrl && (
              <img src={r.iconUrl} alt="" width={40} height={40} className="modrinth-icon" />
            )}
            <div className="modrinth-info">
              <b>{r.title}</b>
              <span className="modrinth-desc">{r.description.slice(0, 120)}</span>
              <span className="modrinth-meta">
                ⬇ {r.downloads.toLocaleString('tr-TR')} ·{' '}
                <a href={r.pageUrl} target="_blank" rel="noreferrer">
                  Modrinth sayfası
                </a>
              </span>
            </div>
            <div className="modrinth-actions">
              <button
                type="button"
                className="btn primary small"
                disabled={dl[r.projectId]?.busy}
                onClick={() => void download(r)}
              >
                {dl[r.projectId]?.busy ? '...' : kind === 'modpack' ? 'İndir (.mrpack)' : 'İndir'}
              </button>
              {dl[r.projectId]?.note && (
                <span className="setting-note">{dl[r.projectId]?.note}</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
