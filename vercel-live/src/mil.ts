/**
 * Funkcja Vercel: lotnictwo wojskowe w regionie prosto z adsb.fi (zapas: adsb.lol).
 *
 * Po co: adsb.fi i adsb.lol odrzucają zapytania z adresów Cloudflare Workers (403/429),
 * więc Worker `czyidziewojna-live` pyta tę funkcję, a ona pyta API z adresów Vercela.
 *
 *   GET /api/mil  z nagłówkiem X-Live-Key  -> AirTraffic (ten sam kształt co w snapshotcie)
 *
 * Zmienna środowiskowa LIVE_KEY (sekret w Vercelu) = sekret LIVE_SOURCE_KEY w Workerze.
 * Budowanie: `npm run bundle` w vercel-live/ pakuje ten plik razem z shared/aircraft.ts do api/mil.js.
 */
import { timingSafeEqual } from 'node:crypto'
import { fetchMilUpstreams, type RawAdsbAircraft } from '../../shared/aircraft'

const UA = 'czyidziewojna.pl/0.1 (+https://czyidziewojna.pl/kontakt)'
// adsb.fi pozwala na 1 zapytanie/s. Worker pyta co 20 s, ale ta pamięć chroni limit także przy błędzie po stronie Workera.
const MIN_INTERVAL_MS = 5_000

let memo: { body: string; at: number; source: string } | undefined

const headers = (extra: Record<string, string> = {}) => ({
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  ...extra,
})

function keyMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function GET(request: Request): Promise<Response> {
  const expected = process.env.LIVE_KEY
  if (!expected || expected.length < 16) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 500, headers: headers() })
  }
  if (!keyMatches(request.headers.get('x-live-key') ?? '', expected)) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: headers() })
  }

  if (memo && Date.now() - memo.at < MIN_INTERVAL_MS) {
    return new Response(memo.body, { headers: headers({ 'X-Upstream': memo.source, 'X-Memo': 'HIT' }) })
  }

  try {
    const traffic = await fetchMilUpstreams(async (url) => {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(8_000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return (await res.json()) as { ac: RawAdsbAircraft[]; now?: number }
    })
    const source = new URL(traffic.sourceUrl).hostname
    memo = { body: JSON.stringify(traffic), at: Date.now(), source }
    return new Response(memo.body, { headers: headers({ 'X-Upstream': source, 'X-Memo': 'MISS' }) })
  } catch (e) {
    // Szczegóły tylko w logach Vercela, nie w odpowiedzi.
    console.error('mil:', (e as Error).message)
    return new Response(JSON.stringify({ error: 'upstream unavailable' }), { status: 502, headers: headers() })
  }
}
