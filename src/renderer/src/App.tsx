import { useCallback, useEffect, useRef, useState } from 'react'
import {
  apiLogin,
  apiMe,
  apiRegister,
  clearAuth,
  getStoredAuth,
  storeAuth,
  setApiBaseUrl,
  type AuthUser
} from './lib/api'
import { gameBridge, type GameSettings, type ApiHealth, type AppUpdateInfo } from './lib/game'
import { PERF_PRESETS, getPreset } from '../../shared/perfPresets'
import ModrinthBrowser from './components/ModrinthBrowser'
import ScreenshotGallery from './components/ScreenshotGallery'
import PlayScreen from './components/PlayScreen'
import ServerListScreen from './components/ServerListScreen'
import FriendsScreen from './components/FriendsScreen'
import ServerScreen from './components/ServerScreen'
import { fetchFriends, fetchActiveServers, type ActiveServer } from './lib/friends'
import { subscribeLiveEvents, resetLiveEvents } from './lib/poller'

type Mode = 'login' | 'register'
type Tab = 'play' | 'servers' | 'server' | 'content' | 'friends' | 'settings'

interface RequestToast {
  id: number
  nickname: string
}

export default function App() {
  const [booting, setBooting] = useState(true)
  const [user, setUser] = useState<AuthUser | null>(null)
  const bridge = gameBridge()
  const [mode, setMode] = useState<Mode>('login')
  const [nickname, setNickname] = useState('')
  const [password, setPassword] = useState('')
  const [password2, setPassword2] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // Faz 8: tema
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  // Faz 12.5: API adresi pakete gömülü (DEFAULT_API_BASE) — kullanıcıya
  // adres sorma/degistirme arayüzü YOK (giriş ekranında da Ayarlar'da da).

  // Acilista main surecin canli API adresini renderer istemcisine besle
  // (settings.json override'i main baslangicta uygulanir; preload anlik
  // goruntusu onu bilmez).
  useEffect(() => {
    bridge
      .getInfo()
      .then((info) => {
        setApiBaseUrl(info.apiBase)
      })
      .catch(() => {})
  }, [bridge])

  // Tema kayitli tercihi yukle + <html> class'iyla uygula
  useEffect(() => {
    bridge
      .getSettings()
      .then((s) => {
        const t = s.theme === 'light' ? 'light' : 'dark'
        setTheme(t)
        document.documentElement.classList.toggle('light', t === 'light')
      })
      .catch(() => {})
  }, [bridge])

  const changeTheme = useCallback(
    (t: 'dark' | 'light') => {
      setTheme(t)
      document.documentElement.classList.toggle('light', t === 'light')
      // Aninda kaydet — Ayarlar panelindeki "Kaydet" butonunun bayat state'i
      // temayi geri almasi (raporlanan tema bugi) bu sekilde imkansizlasir.
      bridge
        .getSettings()
        .then((s) => bridge.saveSettings({ ...s, theme: t, wizardDone: true }))
        .catch(() => {})
    },
    [bridge]
  )

  // Acilista kayitli oturumu dogrula
  useEffect(() => {
    const stored = getStoredAuth()
    if (!stored) {
      setBooting(false)
      return
    }
    // Faz 5a: host isleminin duyuru yapabilmesi icin token'i main surecine gecir
    void bridge.setApiToken(stored.token).catch(() => {})
    apiMe(stored.token)
      .then(({ user: u }) => {
        setUser(u)
      })
      .catch(() => clearAuth())
      .finally(() => setBooting(false))
  }, [bridge])

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      setError(null)
      setNotice(null)

      if (mode === 'register' && password !== password2) {
        setError('Sifreler eslesmiyor.')
        return
      }

      setBusy(true)
      try {
        const result =
          mode === 'login'
            ? await apiLogin(nickname.trim(), password)
            : await apiRegister(nickname.trim(), password)
      storeAuth(result)
      // KRITIK: token'i main surecine de gecir — duyuru, mod/plugin yayini ve
      // katilma akisi main'de saklanan token ile calisir. (Sadece acilistaki
      // oturum geri yukleme bu cagriyi yapiyordu; taze giris sonrasi main
      // token'siz kaliyordu -> "yayinlamadi: token yok" + duyuru yok.)
      await bridge.setApiToken(result.token).catch(() => {})
      resetLiveEvents() // yeni token ile canli baglanti tazelensin
      setUser(result.user)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Beklenmeyen bir hata olustu.')
      } finally {
        setBusy(false)
      }
    },
    [mode, nickname, password, password2, bridge]
  )

  const logout = useCallback(() => {
    void bridge.setApiToken(null).catch(() => {})
    resetLiveEvents()
    clearAuth()
    setUser(null)
    setMode('login')
    setPassword('')
    setPassword2('')
  }, [bridge])

  if (booting) {
    return <div className="boot">Baglaniyor...</div>
  }

  if (!user) {
    return (
      <div className="auth-wrap">
        <div className="auth-card">
          <h1 className="brand">
            MC <span>Friends</span>
          </h1>
          <div className="tabs">
            <button
              type="button"
              className={mode === 'login' ? 'tab active' : 'tab'}
              onClick={() => {
                setMode('login')
                setError(null)
                setNotice(null)
              }}
            >
              Giris Yap
            </button>
            <button
              type="button"
              className={mode === 'register' ? 'tab active' : 'tab'}
              onClick={() => {
                setMode('register')
                setError(null)
                setNotice(null)
              }}
            >
              Kayit Ol
            </button>
          </div>

          <form onSubmit={submit} className="auth-form">
            <label>
              Nickname
              <input
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                placeholder="Orn: steve_tr"
                autoComplete="username"
                autoFocus
                maxLength={16}
              />
            </label>
            <label>
              Sifre
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="En az 6 karakter"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              />
            </label>
            {mode === 'register' && (
              <label>
                Sifre (tekrar)
                <input
                  type="password"
                  value={password2}
                  onChange={(e) => setPassword2(e.target.value)}
                  autoComplete="new-password"
                />
              </label>
            )}

            {error && <div className="msg error">{error}</div>}
            {notice && <div className="msg ok">{notice}</div>}

            <button type="submit" className="btn primary" disabled={busy}>
              {busy ? 'Bekle...' : mode === 'login' ? 'Giris Yap' : 'Hesap Olustur'}
            </button>
          </form>
          <p className="hint">Offline hesap sistemi — bu launcher yalnizca arkadas grubu icindir.</p>
        </div>
      </div>
    )
  }

  return (
    <>
      <HomeView user={user} onLogout={logout} theme={theme} onTheme={changeTheme} />
    </>
  )
}

function HomeView({
  user,
  onLogout,
  theme,
  onTheme
}: {
  user: AuthUser
  onLogout: () => void
  theme: 'dark' | 'light'
  onTheme: (t: 'dark' | 'light') => void
}) {
  const [tab, setTab] = useState<Tab>('play')
  const [health, setHealth] = useState<ApiHealth | null>(null)
  // Faz 17: gameRoot (icerik tarayicisi indirme hedefi icin)
  const [appInfo, setAppInfo] = useState<{ gameRoot: string } | null>(null)
  const [incomingCount, setIncomingCount] = useState(0)
  const [toasts, setToasts] = useState<RequestToast[]>([])
  const seenRequests = useRef<Set<number> | null>(null)
  const toastSeq = useRef(0)
  // Sunucu Listesi: aktif sunucular ust barda polling ile izlenir; acik
  // sunucu sayisi tab rozeti olarak gosterilir.
  const [activeServers, setActiveServers] = useState<ActiveServer[]>([])
  // Faz 11: otomatik guncelleme durumu (Ayarlar panelinde gosterilir)
  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null)
  // Faz 15: profil karti acik mi
  const [profileOpen, setProfileOpen] = useState(false)

  // Aktif sunuculari tazele
  const refreshServers = useCallback(() => {
    fetchActiveServers()
      .then((list) => setActiveServers(list))
      .catch(() => {})
  }, [])

  // Faz 11: guncelleme durumu — baslangicta sor + push event'lerle tazele
  useEffect(() => {
    const bridge = gameBridge()
    bridge.appUpdateInfo().then(setUpdateInfo).catch(() => {})
    const off = bridge.onAppUpdateEvent((ev) => setUpdateInfo(ev))
    return off
  }, [])

  // ---- Anlik guncelleme (Faz 9) ----
  // Push: degisiklik ~1 sn'de ulasir (SSE long-poll). Polling artık yalnizca
  // yedek: 60 sn'de bir (disconnect/edge-case emniyeti) + pencere odaklandiginda.
  useEffect(() => {
    refreshServers()
    const t = setInterval(refreshServers, 60_000)
    const onVis = () => {
      if (document.visibilityState === 'visible') refreshServers()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [refreshServers])

  // API durumunu periyodik kontrol et (15 sn)
  useEffect(() => {
    const bridge = gameBridge()
    const check = () => bridge.apiHealth().then(setHealth).catch(() => setHealth({ online: false, db: false }))
    check()
    const t = setInterval(check, 15_000)
    return () => clearInterval(t)
  }, [])

  // Faz 17: gameRoot'u bir kez al
  useEffect(() => {
    const bridge = gameBridge()
    bridge.getInfo().then((i) => setAppInfo({ gameRoot: i.gameRoot })).catch(() => {})
  }, [])

  const pushToasts = useCallback((items: { requestId: number; nickname: string }[]) => {
    if (items.length === 0) return
    const newToasts = items.map((r) => ({
      id: ++toastSeq.current,
      nickname: r.nickname
    }))
    setToasts((prev) => [...prev, ...newToasts])
    for (const nt of newToasts) {
      setTimeout(() => {
        setToasts((prev) => prev.filter((x) => x.id !== nt.id))
      }, 12_000)
    }
  }, [])

  // Gelen arkadaslik isteklerini kontrol et (20 sn) -> rozet + toast
  const checkRequests = useCallback(async () => {
    try {
      const payload = await fetchFriends()
      setIncomingCount(payload.incoming.length)

      const seen = seenRequests.current
      if (seen === null) {
        // Oturum basi: bekleyen istekler icin de bildirim goster,
        // sonra hepsini 'gorulmus' isaretle (polling tekrar bildirmesin)
        seenRequests.current = new Set(payload.incoming.map((r) => r.requestId))
        pushToasts(payload.incoming)
        return
      }
      const fresh = payload.incoming.filter((r) => !seen.has(r.requestId))
      for (const r of fresh) seen.add(r.requestId)
      pushToasts(fresh)
    } catch {
      // API'ye ulasilamiyor: sessiz gec (rozet zaten cevrimdisi gorunecek)
    }
  }, [pushToasts])

  useEffect(() => {
    void checkRequests()
    const t = setInterval(() => void checkRequests(), 60_000)
    return () => clearInterval(t)
  }, [checkRequests])

  // Canli olay aboneligi — checkRequests tanimlandiktan sonra (TDZ)
  useEffect(() => {
    const off = subscribeLiveEvents((kind) => {
      if (kind === 'servers' || kind === 'kick') refreshServers()
      if (kind === 'friend_request' || kind === 'friend_update') void checkRequests()
    })
    return off
  }, [refreshServers, checkRequests])

  const healthLabel = !health
    ? 'Kontrol ediliyor'
    : health.online && health.db
      ? 'Cevrimici'
      : health.online
        ? 'DB sorunu'
        : 'Cevrimdisi'

  return (
    <div className="home-wrap">
      {/* Faz 15: animasyonlu arka plan (saf CSS, GPU dostu) */}
      <div className="bg-scene" aria-hidden="true">
        <div className="bg-stars" />
        <div className="bg-clouds" />
        <div className="bg-hills" />
      </div>
      <header className="topbar">
        <div className="brand small">
          MC <span>Friends</span>
        </div>
        <div className={`api-badge ${!health ? 'checking' : health.online && health.db ? 'online' : health.online ? 'degraded' : 'offline'}`}>
          <span className="api-dot" />
          API: {healthLabel}
        </div>
        <nav className="nav-tabs">
          <button
            type="button"
            className={tab === 'play' ? 'tab active' : 'tab'}
            onClick={() => setTab('play')}
          >
            Oyna
          </button>
          <button
            type="button"
            className={tab === 'servers' ? 'tab active' : 'tab'}
            onClick={() => setTab('servers')}
          >
            Sunucu Listesi
            {activeServers.length > 0 && <span className="badge">{activeServers.length}</span>}
          </button>
          <button
            type="button"
            className={tab === 'server' ? 'tab active' : 'tab'}
            onClick={() => setTab('server')}
          >
            Sunucu
          </button>
          <button
            type="button"
            className={tab === 'content' ? 'tab active' : 'tab'}
            onClick={() => setTab('content')}
          >
            İçerik
          </button>
          <button
            type="button"
            className={tab === 'friends' ? 'tab active' : 'tab'}
            onClick={() => setTab('friends')}
          >
            Arkadaslar
            {incomingCount > 0 && <span className="badge">{incomingCount}</span>}
          </button>
          <button
            type="button"
            className={tab === 'settings' ? 'tab active' : 'tab'}
            onClick={() => setTab('settings')}
          >
            Ayarlar
          </button>
        </nav>
        <div className="userbox">
          <span className="dot online" title="Cevrimici" />
          <b
            className="profile-card-trigger"
            title="Profil kartini goster"
            style={{ cursor: 'pointer' }}
            onClick={() => setProfileOpen(true)}
          >
            {user.nickname}
          </b>
          <button type="button" className="btn ghost" onClick={onLogout}>
            Cikis
          </button>
        </div>
      </header>

      <main className="home-main">
        {tab === 'play' && <PlayScreen user={user} />}
        {tab === 'servers' && (
          <ServerListScreen user={user} servers={activeServers} onRefresh={refreshServers} />
        )}
        {tab === 'server' && <ServerScreen user={user} />}
        {tab === 'content' && <ContentScreen gameRoot={appInfo?.gameRoot ?? ''} />}
        {tab === 'friends' && <FriendsScreen onDataChange={checkRequests} />}
        {tab === 'settings' && (
          <SettingsPanel theme={theme} onTheme={onTheme} updateInfo={updateInfo} />
        )}
      </main>

      {profileOpen && <ProfileCardModal nickname={user.nickname} onClose={() => setProfileOpen(false)} />}

      <div className="toast-stack">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            <span className="toast-text">
              <b>{t.nickname}</b> sana arkadaslik istegi gonderdi!
            </span>
            <button
              type="button"
              className="btn primary small"
              onClick={() => {
                setToasts((prev) => prev.filter((x) => x.id !== t.id))
                setTab('friends')
              }}
            >
              Ac
            </button>
            <button
              type="button"
              className="btn ghost small"
              onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
            >
              X
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

// Faz 17: icerik tarayicisi — modpack + resource pack (Modrinth)
function ContentScreen({ gameRoot }: { gameRoot: string }) {
  const bridge = gameBridge()
  const [mcVersion, setMcVersion] = useState('')
  const [sub, setSub] = useState<'modpack' | 'resourcepack'>('modpack')

  useEffect(() => {
    // Hedef MC surumu: kullanıcının en son oynadığı surum (yoksa en yeni release)
    bridge
      .profileLastVersion()
      .catch(() => null)
      .then((v) => v || bridge.listVersions().then((r) => r.latestRelease))
      .then((v) => setMcVersion(v || '1.21.11'))
      .catch(() => setMcVersion('1.21.11'))
  }, [bridge])

  if (!gameRoot) return <div className="boot">Yukleniyor...</div>

  return (
    <div className="play-screen">
      <div className="panel">
        <h2>İçerik Tarayıcısı</h2>
        <p className="setting-note">
          Modrinth'ten arama ve indirme — hedef sürüm: <b>{mcVersion || '...'}</b>
        </p>
        <div className="tabs" style={{ marginBottom: 12 }}>
          <button
            type="button"
            className={sub === 'modpack' ? 'tab active' : 'tab'}
            onClick={() => setSub('modpack')}
          >
            Modpack'ler
          </button>
          <button
            type="button"
            className={sub === 'resourcepack' ? 'tab active' : 'tab'}
            onClick={() => setSub('resourcepack')}
          >
            Resource Pack'ler
          </button>
        </div>
        <ModrinthBrowser kind={sub} gameRoot={gameRoot} mcVersion={mcVersion} />
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        <h3>📸 Ekran Görüntüleri</h3>
        <ScreenshotGallery />
      </div>
    </div>
  )
}

// Faz 15: profil karti — oyunculuk istatistikleri (kullanici adina tiklayinca)
function ProfileCardModal({ nickname, onClose }: { nickname: string; onClose: () => void }) {
  const bridge = gameBridge()
  const [card, setCard] = useState<import('./lib/game').ProfileCard | null>(null)

  useEffect(() => {
    bridge.profileCard(nickname).then(setCard).catch(() => {})
  }, [bridge, nickname])

  const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short' }) : '—')

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div className="panel profile-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Profil karti">
        <h3>🎮 {nickname}</h3>
        {!card ? (
          <p className="setting-note">Yukleniyor...</p>
        ) : (
          <>
            <div className="profile-grid">
              <div className="profile-stat">
                <span className="profile-num">{card.totalHours}</span>
                <span className="profile-lbl">saat oynandi</span>
              </div>
              <div className="profile-stat">
                <span className="profile-num">{card.sessions}</span>
                <span className="profile-lbl">oturum</span>
              </div>
              <div className="profile-stat">
                <span className="profile-num">{card.multiplayerMinutes}</span>
                <span className="profile-lbl">dk arkadaslarla</span>
              </div>
              <div className="profile-stat">
                <span className="profile-num">{card.peakPlayers}</span>
                <span className="profile-lbl">en kalabalik</span>
              </div>
            </div>
            <p className="setting-note">
              İlk giriş: {fmtDate(card.firstPlayed)}
              <br />
              Son giriş: {fmtDate(card.lastPlayed)}
            </p>
          </>
        )}
        <div className="setting-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Kapat
          </button>
        </div>
      </div>
    </div>
  )
}

function SettingsPanel({
  theme,
  onTheme,
  updateInfo
}: {
  theme: 'dark' | 'light'
  onTheme: (t: 'dark' | 'light') => void
  updateInfo: AppUpdateInfo | null
}) {
  const bridge = gameBridge()
  const [settings, setSettings] = useState<GameSettings | null>(null)
  const [saved, setSaved] = useState(false)
  const [info, setInfo] = useState<{ gameRoot: string; apiBase: string; version: string; build: string; ramCapMB: number } | null>(null)

  useEffect(() => {
    bridge.getSettings().then(setSettings).catch(() => {})
    bridge
      .getInfo()
      .then(setInfo)
      .catch(() => {})
  }, [bridge])

  if (!settings) return <div className="boot">Ayarlar yukleniyor...</div>

  const ramCap = info?.ramCapMB ?? 16384

  const update = (patch: Partial<GameSettings>) => {
    setSettings({ ...settings, ...patch })
    setSaved(false)
  }

  const save = async () => {
    // Tema global App state'inden geliyor (changeTheme ile aninda kaydedilir);
    // local 'settings' state'i tema degistiysde BAYAT kalir — dogrudan yazmak
    // secili temayi geri aliyordu (raporlanan bug). Taze tema ile birlestir.
    await bridge.saveSettings({ ...settings, theme })
    setSaved(true)
  }

  return (
    <div className="panel settings-panel">
      <h2>Ayarlar</h2>

      <div className="setting-row">
        <label>
          Minimum RAM (MB)
          <input
            type="number"
            min={512}
            max={ramCap}
            step={256}
            value={settings.minRamMB}
            onChange={(e) => update({ minRamMB: Number(e.target.value) })}
          />
        </label>
        <label>
          Maksimum RAM (MB)
          <input
            type="number"
            min={1024}
            max={ramCap}
            step={512}
            value={settings.maxRamMB}
            onChange={(e) => update({ maxRamMB: Number(e.target.value) })}
          />
        </label>
      </div>
      <p className="setting-note">
        Sistemdeki toplam RAM'in en fazla %75'i ayrılabilir (bu makinede üst sınır:{' '}
        <b>{ramCap} MB</b>). Daha yüksek değer kaydedilirse otomatik olarak kırpılır.
      </p>

      <label className="setting-wide">
        Java yolu (bos = otomatik)
        <input
          value={settings.javaPathOverride ?? ''}
          onChange={(e) => update({ javaPathOverride: e.target.value })}
          placeholder="Orn: C:\Program Files\Java\bin\javaw.exe"
        />
      </label>

      <div className="setting-row">
        <label>
          Tema (anında kaydedilir)
          <select value={theme} onChange={(e) => onTheme(e.target.value === 'light' ? 'light' : 'dark')}>
            <option value="dark">Koyu (varsayılan)</option>
            <option value="light">Açık</option>
          </select>
        </label>
      </div>

      {/* Faz 15: performans on ayarlari */}
      <label className="setting-wide">
        Performans ön ayarı (JVM)
        <select
          value={settings.perfPreset ?? 'balanced'}
          onChange={(e) => update({ perfPreset: e.target.value as GameSettings['perfPreset'] })}
        >
          {PERF_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <p className="setting-note">
        {getPreset(settings.perfPreset).description} Bir sonraki oyun açılışında geçerli olur.
      </p>

      <div className="setting-actions">
        <button type="button" className="btn primary" onClick={save}>
          Kaydet
        </button>
        {saved && <span className="msg ok inline">Kaydedildi</span>}
      </div>

      {/* Faz 11: otomatik guncelleme */}
      <div className="version-box">
        <div className="version-line">
          <b>Güncellemeler:</b>{' '}
          {!updateInfo || updateInfo.status === 'idle' || updateInfo.status === 'checking'
            ? 'Kontrol ediliyor...'
            : updateInfo.status === 'available'
              ? `Yeni sürüm var: v${updateInfo.availableVersion} (şu an v${updateInfo.currentVersion})`
              : updateInfo.status === 'downloading'
                ? `İndiriliyor — %${updateInfo.progress ?? 0}`
                : updateInfo.status === 'downloaded'
                  ? `Yeni sürüm (${updateInfo.availableVersion}) hazır — yeniden başlatınca kurulacak`
                  : updateInfo.status === 'not-available'
                    ? 'Güncel sürümü kullanıyorsun ✓'
                    : 'Kontrol edilemedi (sunucuya erişilemiyor olabilir)'}
        </div>
        {updateInfo?.status === 'available' && (
          <div className="setting-actions">
            <button type="button" className="btn primary" onClick={() => void bridge.appUpdateDownload()}>
              v{updateInfo.availableVersion} sürümünü indir
            </button>
          </div>
        )}
        {updateInfo?.status === 'downloaded' && (
          <div className="setting-actions">
            <button type="button" className="btn primary" onClick={() => void bridge.appUpdateInstall()}>
              Şimdi Yeniden Başlat ve Kur
            </button>
          </div>
        )}
        {updateInfo?.status === 'error' && updateInfo.error && (
          <p className="setting-note">Hata: {updateInfo.error}</p>
        )}
        <p className="setting-note">
          Güncellemeler launcher açılışında otomatik kontrol edilir; indirme Ayarlar'dan
          elle başlatılabilir. İndirilen sürüm launcher kapatılınca da kurulur.
        </p>
      </div>

      {info && (
        <div className="version-box">
          <div className="version-line">
            <b>Surum:</b> v{info.version}
            <span className="version-build"> (build: {info.build})</span>
          </div>
          <p className="setting-note">
            VPS testinde guncel paketin calistigini dogrulamak icin bu damgayi kontrol et.
            Build damgasi her derlemede degisir.
          </p>
          <p className="setting-note">
            Oyun dosyalari ve Java su klasore indirilir: <code>{info.gameRoot}</code>
          </p>
        </div>
      )}
    </div>
  )
}
