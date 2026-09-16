import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import path from 'node:path'

const root = path.dirname(fileURLToPath(import.meta.url))
const pkgVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  .version as string

// Her build'de degisen damga: VPS'te "guncel paket mi calisiyor?" sorusunun
// ekrandan cevabi. Tarih/saat UTC, git varsa kisa SHA da eklenir.
const gitSha = (() => {
  try {
    return execSync('git rev-parse --short HEAD', {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore']
    })
      .toString()
      .trim()
  } catch {
    return ''
  }
})()
const buildStamp = `${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC${gitSha ? ` ${gitSha}` : ''}`

export default defineConfig({
  // main ve preload'daki agir bagimliliklari (minecraft-launcher-core vb.)
  // bundle edilmek yerine calisma aninda require edilsin
  main: {
    plugins: [externalizeDepsPlugin()],
    define: {
      __APP_VERSION__: JSON.stringify(pkgVersion),
      __APP_BUILD__: JSON.stringify(buildStamp)
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    define: {
      __APP_VERSION__: JSON.stringify(pkgVersion),
      __APP_BUILD__: JSON.stringify(buildStamp)
    }
  },
  renderer: {
    plugins: [react()],
    define: {
      __APP_VERSION__: JSON.stringify(pkgVersion),
      __APP_BUILD__: JSON.stringify(buildStamp)
    }
  }
})
