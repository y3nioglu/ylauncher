// Faz 11: API adresi tek yerden yönetilir. Üretim adresini buraya yazın —
// launcher dağıtım paketlerine yakılır; API_BASE env değişkeni bunu geçersiz
// kılabilir (geliştirme / kendi VPS'ine yönlendirme için).
//
// Faz 12.5: Ayrıca Ayarlar > API adresi alanından KULLANICI override'u
// gelebilir (settings.json'da apiBaseOverride). Öncelik:
//   1. API_BASE env (geliştirme/test)
//   2. settings.json apiBaseOverride (Ayarlar'dan girilir — paket kurulumları)
//   3. DEFAULT_API_BASE (kaynak koda yakılan adres)
// Canlılık: setApiBaseOverride ile değişince getApiBase() çağıran tüm modüller
// bir sonraki istekte yeni adresi kullanır (restart gerektirmez).
// DAGITIM ADRESI (Faz 12.5): Render ucretsiz planinda calisan API'nin adresi.
// Render'da servisi "ylauncher-api" adiyla olusturursan bu adres birebir eslesir;
// baska bir isim sectiysen yalnizca bu satiri guncelle ve `npm run dist` al.
// Not: gelistirme sirasinda `npm run dev:server` localhost'ta dinler; launcher'da
// Ayarlar > Sunucu adresi alanindan http://localhost:8787 yazarak test edebilirsin.
export const DEFAULT_API_BASE = 'https://ylauncher-api.onrender.com'

/** process.env erişimi hem main hem preload'da çalışır; renderer'da yok. */
export function resolveApiBase(env?: NodeJS.ProcessEnv): string {
  const fromEnv = env?.['API_BASE']
  return typeof fromEnv === 'string' && fromEnv.trim() ? fromEnv.trim().replace(/\/$/, '') : DEFAULT_API_BASE
}

// ---- Canlı API base ------------------------------------------------------
// Varsayılan: env ya da DEFAULT_API_BASE. Main process'te Ayarlar'dan override
// gelirse setApiBaseOverride ile güncellenir; tüm istekler getApiBase() ile
// her seferinde güncel değeri okur.
let currentApiBase = resolveApiBase(typeof process !== 'undefined' ? process.env : undefined)
let overrideActive = false

export function getApiBase(): string {
  return currentApiBase
}

/** Ayarlar'dan gelen override uygular (boş/undefined = varsayılana dön). */
export function setApiBaseOverride(base: string | undefined | null): void {
  const trimmed = typeof base === 'string' ? base.trim().replace(/\/$/, '') : ''
  overrideActive = Boolean(trimmed)
  if (overrideActive) {
    currentApiBase = trimmed
  } else {
    currentApiBase = resolveApiBase(typeof process !== 'undefined' ? process.env : undefined)
  }
}

export function isApiBaseOverridden(): boolean {
  return overrideActive
}
