/**
 * Cloudflare Worker: proxy z cache dla danych "na żywo", których przeglądarka nie
 * może pobrać bezpośrednio (adsb.lol wymaga nagłówka User-Agent z kontaktem,
 * którego przeglądarka nie ustawi).
 *
 *   GET /mil     -> lotnictwo wojskowe w regionie (AirTraffic), cache 20 s,
 *                   przy awarii upstreamu ostatnia dobra odpowiedź do 10 min (X-Cache: STALE)
 *   GET /health  -> "ok"
 *
 * Uruchomienie lokalne: cd worker && npm run dev   (http://localhost:8787)
 * Wdrożenie:            cd worker && npm run deploy (wymaga `wrangler login`)
 */
import { fetchMilUpstreams, type RawAdsbAircraft } from '../../shared/aircraft'

export interface Env {
  /** Lista dozwolonych originów oddzielona przecinkami, albo "*" */
  ALLOWED_ORIGINS?: string
  /** URL kontaktowy wysyłany w User-Agent do adsb.lol */
  CONTACT_URL?: string
}

const FRESH_TTL = 20 // s – jedno zapytanie do adsb.lol na 20 s, niezależnie od liczby odwiedzających
const STALE_TTL = 600 // s – jak długo serwujemy ostatnią dobrą odpowiedź, gdy adsb.lol odpowiada 429/5xx

function corsHeaders(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get('Origin') ?? ''
  const allowed = (env.ALLOWED_ORIGINS ?? '*').split(',').map((s) => s.trim())
  const allow = allowed.includes('*') ? '*' : allowed.includes(origin) ? origin : ''
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

function json(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } })
}

function withHeaders(res: Response, headers: Record<string, string>): Response {
  const out = new Response(res.body, res)
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v)
  return out
}

async function fetchMil(env: Env): Promise<string> {
  const ua = `czyidziewojna.pl/0.1 (+${env.CONTACT_URL ?? 'https://czyidziewojna.pl/kontakt'})`
  const traffic = await fetchMilUpstreams(async (url) => {
    const upstream = await fetch(url, { headers: { 'User-Agent': ua, Accept: 'application/json' } })
    if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`)
    return (await upstream.json()) as { ac: RawAdsbAircraft[]; now?: number }
  })
  return JSON.stringify(traffic)
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
    if (stale) return withHeaders(stale, { ...cors, 'Cache-Control': 'no-store', 'X-Cache': 'STALE', 'X-Upstream-Error': (e as Error).message })
    return json({ error: (e as Error).message }, 502, { ...cors, 'Cache-Control': 'no-store' })
  }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const cors = corsHeaders(req, env)
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
    if (req.method !== 'GET') return json({ error: 'method not allowed' }, 405, cors)

    const path = new URL(req.url).pathname
    if (path === '/health') return new Response('ok', { headers: cors })
    if (path === '/mil') return mil(req, env, ctx, cors)
    return json({ error: 'not found' }, 404, cors)
  },
} satisfies ExportedHandler<Env>
