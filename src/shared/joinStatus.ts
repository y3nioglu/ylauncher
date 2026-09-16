// Faz 5b: oyun cikti satirlarindan katilma durumunu cozen SAF modul.
// Amac: "Katil" akisinda oyuncuya baglanti ilerlemesini gosterme ve kick
// sebeplerini anlasilir Turkce hata mesajlarina cevirme.
//
// Minecraft (client) log ornekleri:
//   [Render thread/INFO]: Connecting to 45.155.125.146, 25565
//   [Render thread/INFO]: Connected to [45.155.125.146:25565]   (eski surumler)
//   [Render thread/INFO]: Logged in with entity id ... (dunyaya girildi)
// Kick ornekleri (client logunda gorunen metinler):
//   You are not white-listed on this server!
//   The server is full!
//   Outdated client! Please use 1.21.11 / Outdated server! I'm still on ...
//   Failed to verify username / Connection refused / Timed out / Connection reset
export type JoinPhase =
  | 'idle'
  | 'connecting'
  | 'authenticating'
  | 'joining-world'
  | 'connected'
  | 'failed'

export interface JoinKickInfo {
  code: string
  friendly: string
  raw: string
  /** Host raporlu kicklerde raporun olusma zamani (ISO) — bayatlik kontrolu icin. */
  at?: string
}

export interface JoinState {
  phase: JoinPhase
  kick: JoinKickInfo | null
}

const KICK_PATTERNS: { re: RegExp; code: string; friendly: string }[] = [
  {
    re: /white-?list/i,
    code: 'not_whitelisted',
    friendly:
      "Bu sunucunun whitelist listesinde değilsin. Host'tan seni listeye eklemesini iste."
  },
  {
    re: /not\s+whitelisted/i,
    code: 'not_whitelisted',
    friendly:
      "Bu sunucunun whitelist listesinde değilsin. Host'tan seni listeye eklemesini iste."
  },
  {
    re: /server\s+is\s+full/i,
    code: 'server_full',
    friendly: 'Sunucu dolu! Biraz bekle, birisi çıkınca tekrar dene.'
  },
  {
    re: /kicked\s+by\s+an?\s+operator|(?:you|were|have|has)\s+been\s+kicked|you\s+were\s+kicked/i,
    code: 'kicked',
    friendly: 'Sunucudan atıldın. Host ile konuşman iyi olur.'
  },
  {
    re: /banned/i,
    code: 'banned',
    friendly: 'Bu sunucudan banlandın.'
  },
  {
    re: /outdated\s+client/i,
    code: 'outdated_client',
    friendly: 'Sürümün sunucudan daha yeni. Sunucunun istediği sürümü seç.'
  },
  {
    re: /outdated\s+server/i,
    code: 'outdated_server',
    friendly: 'Sunucu daha eski bir sürüm kullanıyor. Oyuncu sürümünü düşürmen gerekiyor.'
  },
  {
    re: /invalid\s+session|failed\s+to\s+verify\s+username|bad\s+login/i,
    code: 'invalid_session',
    friendly: "Oturum doğrulanamadı. Launcher'a tekrar giriş yapmayı dene."
  },
  {
    re: /connection\s+refused/i,
    code: 'connection_refused',
    friendly:
      'Sunucuya ulaşılamadı (bağlantı reddedildi). Muhtemelen kapalı ya da port erişilemez.'
  },
  {
    re: /timed?\s+out/i,
    code: 'timed_out',
    friendly: 'Bağlantı zaman aşımına uğradı. Sunucu ayakta ama cevap vermiyor olabilir.'
  },
  {
    re: /connection\s+reset/i,
    code: 'connection_reset',
    friendly: 'Bağlantı sıfırlandı. Sunucu ya da ağ ile ilgili geçici bir sorun olabilir.'
  },
  {
    re: /unknown\s+host|name\s+or\s+service\s+not\s+known/i,
    code: 'unknown_host',
    friendly: 'Sunucu adresi çözümlenemedi. Adresi doğru girdiğinden emin ol.'
  },
  // --- Genel yakalayicilar (EN SONDA): sebep belirtilmemis disconnect'ler.
  // Minecraft bazen kick sebebini client stdout'a hic yazmaz; ekran yalnizca
  // "Internal Exception: ..." gosterir. En azindan "baglanti koptu" diyip
  // ham satiri panelde gosteriyoruz.
  {
    re: /lost\s+connection|disconnec(?:ted|ting)|failed\s+to\s+connect|internal\s+exception/i,
    code: 'generic_disconnect',
    friendly:
      'Bağlantı koptu. Oyun net bir sebep vermedi; paneldeki ham mesajı host ile paylaşabilirsin.'
  }
]

export function translateKickLine(line: string): JoinKickInfo | null {
  for (const p of KICK_PATTERNS) {
    if (p.re.test(line)) {
      return { code: p.code, friendly: p.friendly, raw: line.trim() }
    }
  }
  return null
}

// Bir log satirini isleyip yeni durumu dondurur. Kick bulunursa failed'e gecer
// ve failed/connected durumlarina bir daha geri donulmez (sonuc kesinlesmistir).
export function processJoinLine(line: string, current: JoinState): JoinState {
  if (current.phase === 'failed' || current.phase === 'connected') return current

  const kick = translateKickLine(line)
  if (kick) return { phase: 'failed', kick }

  if (/Connecting to\s+.+,\s*\d+/i.test(line)) {
    return { ...current, phase: 'connecting' }
  }
  if (/Connected to\s+\[?.+:\d+/i.test(line)) {
    return { ...current, phase: 'joining-world' }
  }
  if (/logged\s+in\s+with\s+entity\s+id|joined\s+the\s+game|spawn(ed)?(ing)?\s+player/i.test(line)) {
    return { phase: 'connected', kick: null }
  }
  if (/Auth:|logged\s+in\s+as\s+user|session\s+token/i.test(line)) {
    return { ...current, phase: 'authenticating' }
  }
  if (/Loading\s+advancements|Loading\s+recipes|Preparing\s+spawn|Loading\s+dimension/i.test(line)) {
    return current.phase === 'connecting' || current.phase === 'authenticating'
      ? { ...current, phase: 'joining-world' }
      : current
  }
  return current
}

export const PHASE_LABEL: Record<JoinPhase, string> = {
  idle: 'Bağlanmadı',
  connecting: 'Sunucuya bağlanılıyor...',
  authenticating: 'Kimlik doğrulanıyor...',
  'joining-world': 'Dünya yükleniyor...',
  connected: 'Sunucuya girdin! İyi oyunlar.',
  failed: 'Bağlantı başarısız'
}

// ---------------------------------------------------------------------------
// Faz 5b (devam): HOST tarafindan kick sebebi yakalama.
//
// Kick sebebi client log'una her zaman yazilmaz — canlida yasandi: whitelist
// kick'i client'ta yalnizca "Internal Exception: Connection reset" olarak
// gorundu. Ama Paper'in KENDI log'una sebep her zaman yazilir:
//   Disconnecting com.mojang.authlib.GameProfile@5ab: You are not white-listed on this server!
//   maykil [/31.155.x.x:8088] lost connection: Disconnected
// Host bu satirlari yakalayip API'ye raporlar; katilan taraf sunucu listesinde
// bu bilgiyi gorup panelde gercek sebebi gosterir.

// Bu kalip "oyuncuyla ilgili kopma" satirlarini isaretler (spesifik sebep
// ayrimi translateKickLine ile yapilir; burada sadece tarama filtresi).
// Canlida gorulen gercek Paper bicimleri:
//   Disconnecting trevir (/31.155.x.x:9059): You are not whitelisted on this server!
//   trevir (/31.155.x.x:9059) lost connection: You are not whitelisted on this server!
//   Disconnecting com.mojang.authlib.GameProfile@5ab: You are not white-listed...
export function isPlayerKickLine(line: string): boolean {
  return /\bdisconnecting\s+[^:]|lost\s+connection|kicked\s+from\s+the\s+game|\bkicked\b.*\bserver\b/i.test(
    line
  )
}

// Kick satirindan oyuncu adini cikarmaya calisir. Cikamazsa null: host bunu
// bastaki "UUID of player <ad> is ..." satirindan tuttugu son katilanla
// tamamlar (whitelist kick, UUID satirindan saniyeler sonra gelir).
export function extractKickedNickname(line: string): string | null {
  // Paper iki bicim yazar: "maykil (/31.155.x.x:8088) lost connection: ..."
  // ve "Disconnecting GameProfile@.. (maykil): ..."
  const m =
    /([A-Za-z0-9_]{3,16})(?:\s*\[[^\]]*\]|\s*\([^)]*\))?\s+lost\s+connection/.exec(line) ??
    /disconnecting\s+com\.mojang\.authlib\.gameprofile@\w+\s*\(([^)]+)\)/i.exec(line) ??
    /\bdisconnecting\s+(?!com\.mojang)([A-Za-z0-9_]{3,16})(?:\s*\([^)]*\))?\s*:/i.exec(line) ??
    /\bkicked\s+([A-Za-z0-9_]{3,16})/i.exec(line)
  return m ? m[1] : null
}

// Oyuncunun KENDI cikisi kick degildir — host bunu raporlarsa bir sonraki
// Katil denemesinde gecersiz sebep gosterilir. Guvenli kural: sadece o oyuncu
// adina olan lost connection satiri "Disconnected" ile bitiyorsa cikis say
// (Disconnecting ... satirlarina dokunma; oyuncu quit edince o form yazilmaz).
export function isNormalQuit(line: string): boolean {
  if (!/lost\s+connection:/i.test(line)) return false
  const reason = line.replace(/^.*lost\s+connection:\s*/i, '').trim()
  return /^disconnected$/i.test(reason)
}
