// Faz 15: performans on ayarlari — kullanici dostu JVM presetleri.
// main (game:launch) ve renderer (Ayarlar UI) ayni tanimi kullanir.
export type PerfPresetId = 'low' | 'balanced' | 'high'

export interface PerfPreset {
  id: PerfPresetId
  label: string
  description: string
  /** JVM argumanlari (MCLC customArgs kanaliyla eklenir) */
  args: string[]
}

export const PERF_PRESETS: PerfPreset[] = [
  {
    id: 'low',
    label: 'Dusuk (zayif PC)',
    description: 'Gecikmeyi azaltir; zayif GPU / entegre grafikler icin. Gölge kalitesi düser.',
    // Surum 8: kucuk heap + agresif islemci tasarrufu
    args: [
      '-XX:+UseSerialGC',
      '-XX:MaxGCPauseMillis=200',
      '-Dsun.rmi.dgc.server.gcInterval=2147483646'
    ]
  },
  {
    id: 'balanced',
    label: 'Dengeli (one cikan)',
    description: 'Cogu bilgisayar icin ideal. Yukleme hizi ve FPS dengesi.',
    args: [
      '-XX:+UseG1GC',
      '-XX:MaxGCPauseMillis=130',
      '-XX:G1NewSizePercent=28',
      '-XX:G1ReservePercent=20'
    ]
  },
  {
    id: 'high',
    label: 'Yuksek (guclu PC)',
    description: 'Cok modlu / yüksek FPS. 8 GB+ RAM ve iyi islemci gerektirir.',
    args: [
      '-XX:+UseG1GC',
      '-XX:MaxGCPauseMillis=100',
      '-XX:G1NewSizePercent=40',
      '-XX:G1ReservePercent=20',
      '-XX:InitiatingHeapOccupancyPercent=15'
    ]
  }
]

export function getPreset(id: PerfPresetId | undefined | null): PerfPreset {
  return PERF_PRESETS.find((p) => p.id === id) ?? PERF_PRESETS[1] // balanced default
}
