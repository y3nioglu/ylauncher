// Faz 18: ekran goruntusu galerisi — oyun icinde F2 ile alinan goruntuler.
import { useCallback, useEffect, useState } from 'react'
import { gameBridge, type ScreenshotInfo } from '../lib/game'

export default function ScreenshotGallery() {
  const bridge = gameBridge()
  const [shots, setShots] = useState<ScreenshotInfo[] | null>(null)
  const [zoom, setZoom] = useState<ScreenshotInfo | null>(null)

  const load = useCallback(() => {
    bridge.galleryList().then(setShots).catch(() => setShots([]))
  }, [bridge])

  useEffect(load, [load])

  const remove = useCallback(
    (file: string) => {
      void bridge.galleryDelete(file).then((ok) => {
        if (ok) {
          setZoom(null)
          load()
        }
      })
    },
    [bridge, load]
  )

  if (shots === null) return <p className="setting-note">Galeri yukleniyor...</p>
  if (shots.length === 0)
    return (
      <p className="setting-note">
        Henüz ekran görüntüsü yok. Oyun içinde <b>F2</b> ile görüntü al; burada görünür.
      </p>
    )

  return (
    <div className="gallery">
      <div className="gallery-grid">
        {shots.map((s) => (
          <button
            key={s.file}
            type="button"
            className="gallery-item"
            title={`${s.file} — ${new Date(s.takenAt).toLocaleString('tr-TR')}`}
            onClick={() => setZoom(s)}
          >
            <img src={s.dataUri} alt={s.file} loading="lazy" />
          </button>
        ))}
      </div>
      {zoom && (
        <div className="modal-backdrop" onClick={() => setZoom(null)} role="presentation">
          <div className="panel gallery-zoom" onClick={(e) => e.stopPropagation()} role="dialog">
            <img src={zoom.dataUri} alt={zoom.file} />
            <div className="setting-actions">
              <span className="setting-note">
                {zoom.file} — {new Date(zoom.takenAt).toLocaleString('tr-TR')}
              </span>
              <button type="button" className="btn danger small" onClick={() => remove(zoom.file)}>
                Sil
              </button>
              <button type="button" className="btn ghost small" onClick={() => setZoom(null)}>
                Kapat
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
