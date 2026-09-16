// Windows "Bu uygulama baglantisini acmak icin 'ms-gamingoverlay' edinin"
// uyarisini bastirir.
//
// Kok neden: Minecraft, Windows GameDVR'a "oyun" olarak kaydedilir; oyun
// acilirken Windows Xbox Game Bar overlay'ini (ms-gamingoverlay) acmak ister.
// Xbox Game Bar uygulamasi silinmis/bozuksa Windows her oyun acilisinda
// "Microsoft Store'dan edinin" diyalogu gosterir.
//
// Cozum: GameDVR + GameBar Auto Game Mode'u kayit defterinden kapatmak —
// diyalog bir daha cikmaz. Anahtarlar HKCU altinda oldugu icin yukseltilmis
// izin GEREKMEZ.
//   HKCU\Software\Microsoft\Windows\CurrentVersion\GameDVR -> AppCaptureEnabled = 0
//   HKCU\System\GameConfigStore -> GameDVR_Enabled = 0
//   HKCU\Software\Microsoft\GameBar -> AutoGameModeEnabled = 0
// (AutoGameModeEnabled=1 kalirsa Auto Game Mode da eksik overlay'i cagiriyor —
// sahada dogrulandi: GameDVR kapaliyken pop-up yine de cikti.)
import { execFile } from 'node:child_process'

function regAddDwordZero(key: string, value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'reg',
      ['add', key, '/v', value, '/t', 'REG_DWORD', '/d', '0', '/f'],
      { windowsHide: true },
      (err) => (err ? reject(err) : resolve())
    )
  })
}

/** Uygulama acilisinda bir kez cagrilir; basarisizlik onemsizdir (sessiz log). */
export async function suppressGamingOverlayPopup(): Promise<void> {
  if (process.platform !== 'win32') return
  const targets: ReadonlyArray<readonly [string, string]> = [
    ['HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\GameDVR', 'AppCaptureEnabled'],
    ['HKCU\\System\\GameConfigStore', 'GameDVR_Enabled'],
    ['HKCU\\Software\\Microsoft\\GameBar', 'AutoGameModeEnabled'],
    ['HKCU\\Software\\Microsoft\\GameBar', 'ShowStartupPanel']
  ]
  for (const [key, value] of targets) {
    try {
      await regAddDwordZero(key, value)
      console.log(`[gamedvr] ${value}=0 yazildi (${key}) — ms-gamingoverlay uyarisi bastirildi`)
    } catch (err) {
      console.log(
        `[gamedvr] ${value} ayarlanamadi (onemsiz): ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }
}
