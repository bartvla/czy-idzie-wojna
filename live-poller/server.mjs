/**
 * Poller lotnictwa wojskowego "na żywo" – do uruchomienia POZA Cloudflare
 * (VPS, Raspberry Pi, stary laptop), bo adsb.fi / adsb.lol blokują adresy Workerów.
 *
 * Co robi: co POLL_MS pobiera /v2/mil z adsb.fi (zapas: adsb.lol), filtruje do regionu
 * i trzyma wynik w pamięci. Serwuje go pod GET /mil. Cloudflare Worker odpytuje ten
 * endpoint z nagłówkiem X-Live-Key i oddaje przeglądarkom.
 *
 * Uruchomienie:  LIVE_KEY=dlugi-losowy-sekret node live-poller/server.mjs
 * Zmienne:       PORT (domyślnie 8790), POLL_MS (domyślnie 15000, nie mniej niż 5000),
 *                LIVE_KEY (wymagany; ten sam co `wrangler secret put LIVE_SOURCE_KEY`)
 * Bez zależności npm; wymaga Node 23+ (natywne uruchamianie TypeScript, importuje shared/aircraft.ts).
 * Wystaw przez Cloudflare Tunnel albo reverse proxy z HTTPS; nasłuchuje tylko na 127.0.0.1.
 */
import { createServer } from 'node:http'
import { fetchMilUpstreams } from '../shared/aircraft.ts'

const PORT = Number(process.env.PORT ?? 8790)
const POLL_MS = Math.max(5000, Number(process.env.POLL_MS ?? 15000))
const LIVE_KEY = process.env.LIVE_KEY
const UA = 'czyidziewojna.pl/0.1 (+https://czyidziewojna.pl/kontakt)'

if (!LIVE_KEY || LIVE_KEY.length < 16) {
  console.error('Ustaw LIVE_KEY (min. 16 znaków), np. LIVE_KEY=$(openssl rand -hex 24)')
  process.exit(1)
}

let latest = null // string JSON
let latestAt = 0
let lastError = ''

async function poll() {
  try {
    const traffic = await fetchMilUpstreams(async (url) => {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    })
    latest = JSON.stringify(traffic)
    latestAt = Date.now()
    lastError = ''
  } catch (e) {
    lastError = e.message
    console.warn(new Date().toISOString(), 'poll:', e.message)
  }
}

const timingSafeEqual = (a, b) => {
  if (typeof a !== 'string' || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (req.method !== 'GET') return res.writeHead(405).end()
  if (url.pathname === '/health') return res.writeHead(200, { 'Content-Type': 'text/plain' }).end(latest ? 'ok' : 'no data yet')
  if (url.pathname !== '/mil') return res.writeHead(404).end()
  if (!timingSafeEqual(req.headers['x-live-key'], LIVE_KEY)) return res.writeHead(401).end()
  if (!latest) return res.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: lastError || 'no data yet' }))
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Data-Age-Seconds': String(Math.round((Date.now() - latestAt) / 1000)),
  })
  res.end(latest)
}).listen(PORT, '127.0.0.1', () => console.log(`live-poller: http://127.0.0.1:${PORT}/mil, odpytywanie co ${POLL_MS / 1000} s`))

void poll()
setInterval(poll, POLL_MS)
