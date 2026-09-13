/**
 * Cloudflare Worker: serwuje przeglądarkom aktualne pozycje lotnictwa wojskowego.
 *
 *   GET /mil     -> AirTraffic (ten sam kształt co w snapshotcie), cache 20 s,
 *                   przy awarii źródła ostatnia dobra odpowiedź do 10 min (X-Cache: STALE)
 *   GET /health  -> "ok"
 *
 * Skąd dane: z gałęzi `data` repozytorium GitHub, gdzie workflow aircraft.yml zapisuje
 * co 5 minut plik aircraft.json (a deploy.yml co godzinę snapshot.json). Worker NIE pyta
 * API ADS-B bezpośrednio, bo adsb.fi, adsb.lol, airplanes.live i OpenSky blokują adresy
 * wychodzące Cloudflare (403/429/522, sprawdzone z brzegu we wrześniu 2026), a serwery
 * GitHub Actions nie są blokowane.
 *
 * Uruchomienie lokalne: cd worker && npm run dev   (http://localhost:8787)
 * Wdrożenie:            cd worker && npm run deploy (wymaga `wrangler login`)
 */
import type { AirTraffic } from '../../src/types'

export interface Env {
  /** Lista dozwolonych originów oddzielona przecinkami, albo "*" */
  ALLOWED_ORIGINS?: string
  /** Repozytorium GitHub w formie owner/repo (gałąź `data`) */
  DATA_REPO?: string
  /**
   * Opcjonalne źródło naprawdę na żywo: własny poller (live-poller/) stojący poza Cloudflare,
   * np. https://live.czyidziewojna.pl/mil. Sekret: `wrangler secret put LIVE_SOURCE_KEY`.
   */
  LIVE_SOURCE_URL?: string
  LIVE_SOURCE_KEY?: string
}

const FRESH_TTL = 20 // s – jedno odczytanie z GitHuba na 20 s, niezależnie od liczby odwiedzających
const STALE_TTL = 600 // s – jak długo serwujemy ostatnią dobrą odpowiedź, gdy GitHub nie odpowiada
const DEFAULT_REPO = 'bartvla/czy-idzie-wojna'

function corsHeaders(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get('Origin') ?? ''
  const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  // Lokalny `wrangler dev` (host localhost/127.0.0.1) przyjmuje każdy origin, żeby nie trzymać localhost w konfiguracji produkcyjnej.
  const isLocalDev = /^(localhost|127\.0\.0\.1)$/.test(new URL(req.url).hostname)
  const allow = isLocalDev || allowed.includes('*') ? '*' : allowed.includes(origin) ? origin : ''
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
}

function json(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...headers },
  })
}

function withHeaders(res: Response, headers: Record<string, string>): Response {
  const out = new Response(res.body, res)
  for (const [k, v] of Object.entries({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...headers })) out.headers.set(k, v)
  return out
}

/** Odczyt pliku z gałęzi data. Parametr zapytania omija 5-minutowy cache CDN raw.githubusercontent.com. */
async function readDataBranch(env: Env, file: string): Promise<unknown> {
  const repo = /^[\w.-]+\/[\w.-]+$/.test(env.DATA_REPO ?? '') ? env.DATA_REPO : DEFAULT_REPO
  const bust = Math.floor(Date.now() / (FRESH_TTL * 1000))
  const res = await fetch(`https://raw.githubusercontent.com/${repo}/data/${file}?v=${bust}`, {
    headers: { 'User-Agent': 'czyidziewojna.pl/0.1 (+https://czyidziewojna.pl/kontakt)', Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`)
  return res.json()
}

function isAirTraffic(x: unknown): x is AirTraffic {
  const t = x as AirTraffic
  return !!t && typeof t === 'object' && Array.isArray(t.aircraft) && typeof t.fetchedAt === 'string' && typeof t.byCategory === 'object'
}

/** Własny poller (co ~15 s), potem aircraft.json z GitHuba (co 5 min), na końcu snapshot.json (co godzinę). */
async function fetchMil(env: Env): Promise<string> {
  const errors: string[] = []
  if (env.LIVE_SOURCE_URL) {
    try {
      const res = await fetch(env.LIVE_SOURCE_URL, {
        headers: { Accept: 'application/json', ...(env.LIVE_SOURCE_KEY ? { 'X-Live-Key': env.LIVE_SOURCE_KEY } : {}) },
        signal: AbortSignal.timeout(8_000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const t = (await res.json()) as unknown
      if (isAirTraffic(t)) return JSON.stringify(t)
      errors.push('live: zły format')
    } catch (e) {
      errors.push(`live: ${(e as Error).message}`)
    }
  }
  try {
    const t = await readDataBranch(env, 'aircraft.json')
    if (isAirTraffic(t)) return JSON.stringify(t)
    errors.push('aircraft.json: zły format')
  } catch (e) {
    errors.push((e as Error).message)
  }
  try {
    const s = (await readDataBranch(env, 'snapshot.json')) as { airTraffic?: unknown }
    if (isAirTraffic(s.airTraffic)) return JSON.stringify(s.airTraffic)
    errors.push('snapshot.json: brak airTraffic')
  } catch (e) {
    errors.push((e as Error).message)
  }
  throw new Error(errors.join('; '))
}

async function mil(req: Request, env: Env, ctx: ExecutionContext, cors: Record<string, string>): Promise<Response> {
  const cache = caches.default
  const origin = new URL(req.url).origin
  const freshKey = new Request(`${origin}/mil`, { method: 'GET' })
  const staleKey = new Request(`${origin}/mil?stale`, { method: 'GET' })

  const fresh = await cache.match(freshKey)
  if (fresh) return withHeaders(fresh, { ...cors, 'X-Cache': 'HIT' })

  try {
    const body = await fetchMil(env)
    const mk = (ttl: number) =>
      new Response(body, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${ttl}` } })
    ctx.waitUntil(Promise.all([cache.put(freshKey, mk(FRESH_TTL)), cache.put(staleKey, mk(STALE_TTL))]))
    return withHeaders(mk(FRESH_TTL), { ...cors, 'X-Cache': 'MISS' })
  } catch (e) {
    const stale = await cache.match(staleKey)
    if (stale) return withHeaders(stale, { ...cors, 'Cache-Control': 'no-store', 'X-Cache': 'STALE' })
    // Szczegóły błędu tylko w logach Workera (wrangler tail), nie w odpowiedzi publicznej.
    console.error('mil:', (e as Error).message)
    return json({ error: 'upstream unavailable' }, 502, cors)
  }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const cors = corsHeaders(req, env)
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
    if (req.method !== 'GET') return json({ error: 'method not allowed' }, 405, cors)

    const path = new URL(req.url).pathname
    if (path === '/health') return new Response('ok', { headers: { ...cors, ...SECURITY_HEADERS } })
    if (path === '/mil') return mil(req, env, ctx, cors)
    return json({ error: 'not found' }, 404, cors)
  },
} satisfies ExportedHandler<Env>
