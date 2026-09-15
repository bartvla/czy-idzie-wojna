/**
 * Cloudflare Worker: dane na żywo dla strony.
 *
 *   GET /live     -> { airTraffic, airRaid } w jednej odpowiedzi (strona odpytuje to co 30 s)
 *   GET /mil      -> AirTraffic, pamięć 20 s
 *   GET /airraid  -> AirRaid (alarmy lotnicze w Ukrainie), pamięć 30 s
 *   GET /health   -> "ok"
 * Przy awarii źródła każda część jest serwowana z ostatniej dobrej odpowiedzi do 10 min (STALE).
 *
 * Lotnictwo: Worker NIE pyta API ADS-B bezpośrednio, bo adsb.fi (403, reguła zapory)
 * i adsb.lol (429) odrzucają adresy wychodzące Cloudflare (sprawdzone z brzegu we wrześniu 2026).
 *   1. LIVE_SOURCE_URL – funkcja na Vercelu (vercel-live/), która pyta adsb.fi na żądanie,
 *   2. snapshot.json z gałęzi `data`, zapisywany co godzinę przez deploy.yml.
 * Alarmy: ubilling.net.ua i alerts.com.ua odpowiadają z Cloudflare, więc Worker pyta je sam (shared/airraid.ts).
 *
 * Uruchomienie lokalne: cd worker && npm run dev   (http://localhost:8787)
 * Wdrożenie:            cd worker && npm run deploy (wymaga `wrangler login`)
 */
import type { AirTraffic } from '../../src/types'
import { fetchAirRaid, isAirRaid } from '../../shared/airraid'

export interface Env {
  /** Lista dozwolonych originów oddzielona przecinkami, albo "*" */
  ALLOWED_ORIGINS?: string
  /** Repozytorium GitHub w formie owner/repo (gałąź `data`) */
  DATA_REPO?: string
  /**
   * Źródło na żywo poza Cloudflare: funkcja Vercel (vercel-live/) albo własny poller (live-poller/).
   * Adres w wrangler.jsonc, klucz jako sekret: `wrangler secret put LIVE_SOURCE_KEY`.
   */
  LIVE_SOURCE_URL?: string
  LIVE_SOURCE_KEY?: string
}

const MIL_TTL = 20 // s – jedno zapytanie do źródła lotnictwa na 20 s, niezależnie od liczby odwiedzających
const AIRRAID_TTL = 30 // s – ubilling odświeża dane co ok. 60 s, więc częściej nie ma sensu
const STALE_TTL = 600 // s – jak długo serwujemy ostatnią dobrą odpowiedź, gdy źródło nie odpowiada
const DEFAULT_REPO = 'bartvla/czy-idzie-wojna'
const UA = 'czyidziewojna.pl/0.1 (+https://czyidziewojna.pl/kontakt)'

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
}

function respond(body: string, status: number, headers: Record<string, string>): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...headers },
  })
}

/* ------------------------------------------------------------------ */
/* Pamięć: świeża kopia (TTL źródła) + kopia zapasowa na awarię (10 min) */
/* ------------------------------------------------------------------ */
type CacheStatus = 'HIT' | 'MISS' | 'STALE'

async function cached(
  origin: string,
  name: string,
  ttl: number,
  ctx: ExecutionContext,
  load: () => Promise<string>,
): Promise<{ body: string; status: CacheStatus } | null> {
  const cache = caches.default
  const freshKey = new Request(`${origin}/__cache/${name}`, { method: 'GET' })
  const staleKey = new Request(`${origin}/__cache/${name}?stale`, { method: 'GET' })

  const fresh = await cache.match(freshKey)
  if (fresh) return { body: await fresh.text(), status: 'HIT' }

  try {
    const body = await load()
    const mk = (seconds: number) =>
      new Response(body, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${seconds}` } })
    ctx.waitUntil(Promise.all([cache.put(freshKey, mk(ttl)), cache.put(staleKey, mk(STALE_TTL))]))
    return { body, status: 'MISS' }
  } catch (e) {
    // Szczegóły błędu tylko w logach Workera (wrangler tail), nie w odpowiedzi publicznej.
    console.error(`${name}:`, (e as Error).message)
    const stale = await cache.match(staleKey)
    return stale ? { body: await stale.text(), status: 'STALE' } : null
  }
}

/* ------------------------------------------------------------------ */
/* Lotnictwo                                                            */
/* ------------------------------------------------------------------ */
/** Odczyt pliku z gałęzi data. Parametr zapytania omija 5-minutowy cache CDN raw.githubusercontent.com. */
async function readDataBranch(env: Env, file: string): Promise<unknown> {
  const repo = /^[\w.-]+\/[\w.-]+$/.test(env.DATA_REPO ?? '') ? env.DATA_REPO : DEFAULT_REPO
  const bust = Math.floor(Date.now() / (MIL_TTL * 1000))
  const res = await fetch(`https://raw.githubusercontent.com/${repo}/data/${file}?v=${bust}`, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`)
  return res.json()
}

function isAirTraffic(x: unknown): x is AirTraffic {
  const t = x as AirTraffic
  return !!t && typeof t === 'object' && Array.isArray(t.aircraft) && typeof t.fetchedAt === 'string' && typeof t.byCategory === 'object'
}

/** Źródło na żywo (Vercel lub poller), a przy jego awarii snapshot.json z GitHuba (co godzinę). */
async function loadMil(env: Env): Promise<string> {
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
    const s = (await readDataBranch(env, 'snapshot.json')) as { airTraffic?: unknown }
    if (isAirTraffic(s.airTraffic)) return JSON.stringify(s.airTraffic)
    errors.push('snapshot.json: brak airTraffic')
  } catch (e) {
    errors.push((e as Error).message)
  }
  throw new Error(errors.join('; '))
}

/* ------------------------------------------------------------------ */
/* Alarmy lotnicze                                                      */
/* ------------------------------------------------------------------ */
async function loadAirRaid(): Promise<string> {
  const raid = await fetchAirRaid(async (url) => {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(8_000) })
    if (!res.ok) throw new Error(`${new URL(url).hostname}: HTTP ${res.status}`)
    return res
  })
  if (!isAirRaid(raid)) throw new Error('airraid: zły format')
  return JSON.stringify(raid)
}

/* ------------------------------------------------------------------ */
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const cors = corsHeaders(req, env)
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
    if (req.method !== 'GET') return respond(JSON.stringify({ error: 'method not allowed' }), 405, cors)

    const { origin, pathname } = new URL(req.url)
    const mil = () => cached(origin, 'mil', MIL_TTL, ctx, () => loadMil(env))
    const airRaid = () => cached(origin, 'airraid', AIRRAID_TTL, ctx, loadAirRaid)
    const unavailable = () => respond(JSON.stringify({ error: 'upstream unavailable' }), 502, cors)

    switch (pathname) {
      case '/health':
        return new Response('ok', { headers: { ...cors, ...SECURITY_HEADERS, 'Cache-Control': 'no-store' } })

      case '/mil': {
        const m = await mil()
        return m ? respond(m.body, 200, { ...cors, 'X-Cache': m.status }) : unavailable()
      }

      case '/airraid': {
        const a = await airRaid()
        return a ? respond(a.body, 200, { ...cors, 'X-Cache': a.status }) : unavailable()
      }

      case '/live': {
        const [m, a] = await Promise.all([mil(), airRaid()])
        if (!m && !a) return unavailable()
        // Części są już zwalidowanym JSON-em, więc składamy odpowiedź bez ponownego parsowania.
        const body = `{"airTraffic":${m?.body ?? 'null'},"airRaid":${a?.body ?? 'null'}}`
        return respond(body, 200, { ...cors, 'X-Cache-Mil': m?.status ?? 'NONE', 'X-Cache-AirRaid': a?.status ?? 'NONE' })
      }

      default:
        return respond(JSON.stringify({ error: 'not found' }), 404, cors)
    }
  },
} satisfies ExportedHandler<Env>
