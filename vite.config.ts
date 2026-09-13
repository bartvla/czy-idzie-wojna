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

/**
 * Content-Security-Policy jako <meta> (GitHub Pages nie pozwala ustawiać nagłówków HTTP).
 * Tylko w buildzie: w `npm run dev` Vite wstrzykuje inline skrypty HMR, których polityka by nie przepuściła.
 * Lista źródeł jest jawna: własne pliki, kafle map (Esri, CARTO), Worker z danymi na żywo, analityka Cloudflare.
 */
function contentSecurityPolicy(liveApiUrl: string | undefined, isBuild: boolean): Plugin {
  return {
    name: 'content-security-policy',
    transformIndexHtml() {
      if (!isBuild) return
      let liveOrigin = ''
      try {
        if (liveApiUrl) liveOrigin = new URL(liveApiUrl).origin
      } catch {
        console.warn('[csp] VITE_LIVE_API_URL nie jest poprawnym URL – pomijam w connect-src')
      }
      const directives = [
        "default-src 'self'",
        "script-src 'self' https://static.cloudflareinsights.com",
        // 'unsafe-inline' dla stylów: React, Recharts i Leaflet ustawiają atrybuty style; nie dotyczy skryptów.
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: https://server.arcgisonline.com https://*.basemaps.cartocdn.com",
        `connect-src 'self' https://cloudflareinsights.com${liveOrigin ? ` ${liveOrigin}` : ''}`,
        "font-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'none'",
        'upgrade-insecure-requests',
      ]
      return [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: directives.join('; ') }, injectTo: 'head-prepend' }]
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  // Prefiks '' wczytuje też zmienne bez VITE_ (z plików .env* i ze zmiennych środowiska CI).
  const env = loadEnv(mode, process.cwd(), '')
  const isBuild = command === 'build'
  return {
    plugins: [
      react(),
      contentSecurityPolicy(env.VITE_LIVE_API_URL, isBuild),
      cloudflareWebAnalytics(env.CLOUDFLARE_ANALYTICS_TOKEN, isBuild),
    ],
    // GitHub Pages bez własnej domeny serwuje stronę pod /<repo>/; workflow ustawia VITE_BASE.
    base: process.env.VITE_BASE ?? '/',
    build: {
      chunkSizeWarningLimit: 900,
    },
  }
})
