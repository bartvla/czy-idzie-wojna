import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'

/**
 * Cloudflare Web Analytics: skrypt wstrzykiwany do index.html tylko przy buildzie produkcyjnym
 * i tylko gdy jest token. Lokalny `npm run dev` nie wysyła wizyt z localhost do statystyk.
 * Token celowo nie ma prefiksu VITE_, więc nie trafia do bundla JS, tylko do znacznika w HTML.
 */
function cloudflareWebAnalytics(token: string | undefined, isBuild: boolean): Plugin {
  return {
    name: 'cloudflare-web-analytics',
    transformIndexHtml() {
      if (!isBuild) return
      if (!token) {
        console.warn('[cloudflare-web-analytics] brak CLOUDFLARE_ANALYTICS_TOKEN – statystyki wyłączone w tym buildzie')
        return
      }
      if (!/^[0-9a-f]{32}$/i.test(token)) {
        console.warn('[cloudflare-web-analytics] CLOUDFLARE_ANALYTICS_TOKEN ma nieoczekiwany format – pomijam skrypt')
        return
      }
      return [
        {
          tag: 'script',
          attrs: {
            type: 'module',
            src: 'https://static.cloudflareinsights.com/beacon.min.js',
            'data-cf-beacon': JSON.stringify({ token }),
          },
          injectTo: 'body',
        },
      ]
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  // Prefiks '' wczytuje też zmienne bez VITE_ (z plików .env* i ze zmiennych środowiska CI).
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react(), cloudflareWebAnalytics(env.CLOUDFLARE_ANALYTICS_TOKEN, command === 'build')],
    // GitHub Pages bez własnej domeny serwuje stronę pod /<repo>/; workflow ustawia VITE_BASE.
    base: process.env.VITE_BASE ?? '/',
    build: {
      chunkSizeWarningLimit: 900,
    },
  }
})
