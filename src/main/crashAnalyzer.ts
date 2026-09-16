// Faz 16: crash log analizi — oyun ciktisini okunabilir taniya cevirir.
// Kurallar ilk eslesen kazanir; eslesme yoksa genel tuye doner.
// Main-side'da calisir (renderer IPC ile kullanir); yeni desenler kolayca eklenir.

export interface CrashDiagnosis {
  /** Insan-okur baslik (orn: "Eksik mod bagimliligi") */
  title: string
  /** Cozum onerisi (kullaniciya gosterilecek) */
  fix: string
  /** Kirmizi (crash) / sari (uyari) ayrimi */
  severity: 'error' | 'warning'
}

interface Rule {
  pattern: RegExp
  title: string
  fix: string
  severity?: 'error' | 'warning'
  /** Eslesme varsa log'dan ayiklanan detay (orn: mod adi) */
  detail?: (m: RegExpMatchArray) => string | undefined
}

const RULES: Rule[] = [
  {
    // Fabric: eksik bagimlilik (fabric-api, fabric-language-kotlin vb.)
    // orn: "requires version 0.43.1 or later of fabric-api, which is missing!"
    // orn: "requires any version of fabric-language-kotlin, which is missing!"
    pattern: /requires (?:any version|version [\d.]+ or later) of ([\w-]+), which is missing/,
    title: 'Eksik mod bagimliligi',
    fix: 'Bagimli oldugu mod otomatik indirilemedi. Launcher\'da oyuna tekrar "Katil" dene (bagimlilik zinciri otomatik kurulur); hata surerse modun gerektirdigi paketi host\'un clientMods klasorune eklemesi gerekiyor.',
    detail: (m) => m[1] ?? undefined
  },
  {
    // Fabric: uyumsuz mod versiyonu
    pattern: /Mod '([^']+)' ([\d.]+) is incompatible with/,
    title: 'Uyumsuz mod surumu',
    fix: 'Mod surumu bu Minecraft surumuyle uyumsuz. Modun MC surumune uygun versiyonunu host\'un degistirmesi gerekiyor.'
  },
  {
    // Java surumu: class file version hatasi
    pattern: /UnsupportedClassVersionError|has been compiled by a more recent version of the Java Runtime/,
    title: 'Java surumu cok eski',
    fix: 'Mod/sunucu daha yeni Java istiyor. Ayarlar\'dan Java surumunu yukselt ya da daha eski mod surumu kullan.'
  },
  {
    // Bellek yetersizligi
    pattern: /OutOfMemoryError|Could not reserve enough space for object heap/,
    title: 'Yetersiz bellek (RAM)',
    fix: 'Oyuna ayrilan RAM doldu. Ayarlar > Bellek degerini artir (8GB RAM icin 4096MB uygundur) ya da az mod kullan.'
  },
  {
    // LWJGL / grafik karti
    pattern: /Cannot get pointer address|Failed to locate the GLFW window|GLX|OpenGL [error]|Unsupported OpenGL version/i,
    title: 'Grafik/OpenGL sorunu',
    fix: 'Ekran karti surucusunu guncelle. Dusek performans modunda baslatmayi dene; hata surerse VSync/kapali modda dene.'
  },
  {
    // Mixin hatasi (mod cakismasi)
    pattern: /Mixin apply failed|MixinTransformationHandler|Compatibility level/,
    title: 'Mod cakismasi (Mixin)',
    fix: 'Iki mod ayni kod parcagina mudahale ediyor. Son eklenen modu cikarip hangisinin sebep oldugunu bul; host\'a bildir.'
  },
  {
    // Bozuk jar
    pattern: /ZipException|invalid loc header|error in opening zip file/i,
    title: 'Bozuk mod dosyasi',
    fix: 'Bir mod dosyasi hasarli indirilmis. Launcher\'in mods klasorunden son eklenen modu silip "Katil" ile yeniden indir.'
  },
  {
    // Fabric + yanlis MC surumu
    pattern: /This version of Fabric Loader .* requires Minecraft/,
    title: 'Loader/MC surumu uyumsuz',
    fix: 'Fabric Loader surumu bu MC surumunu desteklemiyor. Host\'un fabric profilini guncellemesi gerekiyor.'
  },
  {
    // Surum eslesmesi (vanilla vs fabric jar)
    pattern: /Failed to fetch user properties|InvalidCredentialsException|Status: 401/,
    title: 'Kimlik dogrulama uyarisi (offline mod)',
    fix: 'Offline modda normaldir — oyun acilir ve sunucuya baglanir. Sadece Mojang servisleri (Realms vs.) kullanilamaz.',
    severity: 'warning'
  },
  {
    // Klasik "fabric-api which is missing" olmayan ama benzer: kural seti genisledikce eklenir
    pattern: /Caused by: java\.lang\.ClassNotFoundException: net\.fabricmc/,
    title: 'Fabric yuklenemedi',
    fix: 'Fabric loader dosyalari bozuk/exik. Launcher\'da Fabric profilini yeniden kur.'
  }
]

/**
 * Crash/oyun ciktisindan tani uretir. Coklu satir iletilebilir;
 * ilk eslesen kural kazanir, eslesme yoksa null doner.
 */
export function analyzeCrashLog(log: string): CrashDiagnosis | null {
  if (!log || !log.trim()) return null

  // Oncelik sirasi: crash kurallari once, uyari kurallari sonra
  const ordered = [...RULES].sort((a, b) => {
    const av = a.severity === 'warning' ? 1 : 0
    const bv = b.severity === 'warning' ? 1 : 0
    return av - bv
  })

  for (const rule of ordered) {
    const m = log.match(rule.pattern)
    if (m) {
      const detail = rule.detail?.(m)
      const title = detail ? `${rule.title}: ${detail}` : rule.title
      return {
        title,
        fix: rule.fix,
        severity: rule.severity ?? 'error'
      }
    }
  }

  // "Incompatible mods found" genel Fabric crash'i — detayli kural tutmadiysa
  if (/Incompatible mods found|FormattedException/.test(log)) {
    return {
      title: 'Mod uyumsuzlugu',
      fix: 'Modlardan biri bu MC surumunu desteklemiyor ya da eksik bagimliligi var. Launcher yeniden bagimlilik kurmaya calisacak; olmazsa host\'a mod adlarini bildir.',
      severity: 'error'
    }
  }

  // Genel JVM crash (hs_err / EXCEPTION_ACCESS_VIOLATION)
  if (/EXCEPTION_ACCESS_VIOLATION|SIGSEGV|hs_err_pid/.test(log)) {
    return {
      title: 'Oyun beklenmedik sekilde coktu (bellek/surucu)',
      fix: 'Ekran karti surucusunu guncelle, RAM tahsisini dusur (bazi sistemlerde 4096MB ustunde kararsizlik olur) ve tekrar dene.',
      severity: 'error'
    }
  }

  return null
}
