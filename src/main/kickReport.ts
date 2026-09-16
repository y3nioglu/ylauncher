// Faz 5b (devam): host tarafinda yakalanan kick sebeplerini API'ye raporlar.
// Katilan oyuncunun launcher'i bu bilgiyi okuyup panelde gercek sebebi
// gosterir (kick sebebi client log'una her zaman yazilmadigi icin gerekli).
// Basarisizlik sessizce loglanir — raporlama sunucuyu etkilemez.
import { translateKickLine } from '../shared/joinStatus'

import { getApiBase } from '../shared/apiBase'

const apiBase = () => getApiBase()

interface ReportOpts {
  token: string | null
  nickname: string
  rawLine: string
}

export async function reportKick(opts: ReportOpts): Promise<void> {
  if (!opts.token) return // offline host modu: raporlanacak hedef yok
  const kick = translateKickLine(opts.rawLine)
  if (!kick) return

  const controller = new AbortController()
  const to = setTimeout(() => controller.abort(), 6000)
  try {
    const res = await fetch(`${apiBase()}/api/servers/kick`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.token}`
      },
      body: JSON.stringify({
        nickname: opts.nickname,
        reason: kick.friendly,
        rawLine: opts.rawLine.slice(0, 500)
      }),
      signal: controller.signal
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status} ${text.slice(0, 120)}`)
    }
    console.log(`[kick] raporlandi: ${opts.nickname} -> ${kick.code}`)
  } catch (err) {
    console.log(
      `[kick] raporlama basarisiz (onemsiz): ${err instanceof Error ? err.message : String(err)}`
    )
  } finally {
    clearTimeout(to)
  }
}
