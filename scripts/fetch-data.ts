/**
 * Pobiera dane ze wszystkich źródeł i zapisuje public/data/snapshot.json
 * (payload dla frontendu) oraz public/data/history.json (własna, narastająca
 * historia dla wskaźników, które nie mają darmowej historii dziennej).
 *
 * Uruchomienie: npm run fetch
 * W produkcji odpalane cyklicznie przez GitHub Actions (patrz .github/workflows).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Advisory, NewsItem, OddsMarket, Series, SeriesPoint, Snapshot } from '../src/types'
import { fetchAirRaid, fetchAirTraffic, fetchGpsJam } from './airspace'
import { computeTension } from '../src/lib/tension'

const OUT_DIR = path.resolve('public/data')
const SNAPSHOT_FILE = path.join(OUT_DIR, 'snapshot.json')
const HISTORY_FILE = path.join(OUT_DIR, 'history.json')

// adsb.lol wymaga UA z danymi kontaktowymi; pozostałe serwisy akceptują dowolny.
const UA =
  'czyidziewojna.pl/0.1 (+https://czyidziewojna.pl/kontakt) Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36'

const today = () => new Date().toISOString().slice(0, 10)
const errors: string[] = []

/**
 * Linki z zewnętrznych źródeł trafiają na stronę jako href. Przyjmujemy tylko https
 * i tylko z oczekiwanej domeny; w innym wypadku zwracamy bezpieczny adres zastępczy.
 */
function safeUrl(candidate: string | undefined, allowedHost: string, fallback: string): string {
  try {
    const u = new URL((candidate ?? '').trim())
    const hostOk = u.hostname === allowedHost || u.hostname.endsWith(`.${allowedHost}`)
    if (u.protocol === 'https:' && hostOk) return u.toString()
  } catch {
    /* niepoprawny URL */
  }
  return fallback
}

async function http(url: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: { 'User-Agent': UA, Accept: '*/*', 'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.8', ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`)
  return res
}

async function safe<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    const v = await fn()
    console.log(`✔ ${label}`)
    return v
  } catch (e) {
    const msg = `${label}: ${(e as Error).message}`
    errors.push(msg)
    console.warn(`✖ ${msg}`)
    return undefined
  }
}

const sortDedupe = (points: SeriesPoint[]): SeriesPoint[] => {
  const map = new Map<string, number>()
  for (const p of points) if (Number.isFinite(p.value)) map.set(p.date, p.value)
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({ date, value }))
}

const mkSeries = (
  id: string,
  label: string,
  unit: string,
  source: string,
  sourceUrl: string,
  frequency: Series['frequency'],
  points: SeriesPoint[],
): Series => ({ id, label, unit, source, sourceUrl, frequency, updatedAt: new Date().toISOString(), points: sortDedupe(points) })

/* ------------------------------------------------------------------ */
/* Historia 10 lat: pełne dane dzienne w history.json (gałąź data),     */
/* do snapshotu dzienne z ostatniego roku + tygodniowe ze starszych lat  */
/* ------------------------------------------------------------------ */
const HISTORY_YEARS = 10
const DAILY_DAYS_IN_CHART = 400
const DAY_MS = 86_400_000

const isoDaysAgo = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10)
const historyStart = () => {
  const d = new Date()
  d.setUTCFullYear(d.getUTCFullYear() - HISTORY_YEARS)
  return d.toISOString().slice(0, 10)
}
const trimFrom = (points: SeriesPoint[], from: string) => points.filter((p) => p.date >= from)

/** Czy zapisana historia nie sięga początku okna (z zapasem na święta i weekendy)? */
const needsBackfill = (points: SeriesPoint[], start: string) => {
  if (points.length === 0) return true
  const slackDays = 14
  return new Date(points[0].date).getTime() - new Date(start).getTime() > slackDays * DAY_MS
}

/** Dzienne punkty z ostatnich DAILY_DAYS_IN_CHART dni, starsze jako ostatni punkt każdego tygodnia. */
function downsampleForChart(points: SeriesPoint[]): SeriesPoint[] {
  const cutoff = isoDaysAgo(DAILY_DAYS_IN_CHART)
  const weekly = new Map<number, SeriesPoint>()
  const recent: SeriesPoint[] = []
  for (const p of points) {
    if (p.date >= cutoff) recent.push(p)
    else weekly.set(Math.floor((new Date(p.date).getTime() / DAY_MS + 3) / 7), p)
  }
  return [...weekly.values(), ...recent]
}

/* ------------------------------------------------------------------ */
/* WIG20 – BiznesRadar (tabela HTML, 50 sesji/stronę)                   */
/* ------------------------------------------------------------------ */
function parseBiznesRadarRows(html: string): SeriesPoint[] {
  const points: SeriesPoint[] = []
  for (const m of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    // |11.09.2026| |4124.76| |4151.38| |4120.28| |4139.25| |3 028 413 403|
    const cells = m[1]
      .replace(/<[^>]+>/g, '|')
      .replace(/\s+/g, ' ')
      .split('|')
      .map((c) => c.trim())
      .filter(Boolean)
    const d = cells[0]?.match(/^(\d{2})\.(\d{2})\.(\d{4})$/)
    if (!d || cells.length < 5) continue
    const close = Number(cells[4].replace(/\s/g, '').replace(',', '.'))
    if (Number.isFinite(close)) points.push({ date: `${d[3]}-${d[2]}-${d[1]}`, value: close })
  }
  return points
}

/**
 * Pierwsze uruchomienie (albo luka w historii): strony wstecz aż do początku okna 10 lat (~51 stron, raz).
 * Kolejne uruchomienia: tylko 2 najnowsze strony, dopisywane do historii.
 */
async function fetchWig20(history: History): Promise<Series> {
  const start = historyStart()
  const stored = history.wig20_daily ?? []
  const backfill = needsBackfill(stored, start)
  const maxPages = backfill ? 60 : 2
  const fresh: SeriesPoint[] = []
  for (let page = 1; page <= maxPages; page++) {
    const url = `https://www.biznesradar.pl/notowania-historyczne/WIG20${page > 1 ? `,${page}` : ''}`
    const rows = parseBiznesRadarRows(await (await http(url)).text())
    if (rows.length === 0) break
    fresh.push(...rows)
    if (rows.some((p) => p.date < start)) break
    await new Promise((r) => setTimeout(r, 400))
  }
  if (fresh.length < 20) throw new Error('za mało wierszy – zmieniła się struktura strony?')
  if (backfill) console.log(`  WIG20: uzupełniono historię (${fresh.length} sesji)`)
  history.wig20_daily = trimFrom(sortDedupe([...stored, ...fresh]), start)
  return mkSeries(
    'wig20',
    'WIG20',
    'pkt',
    'BiznesRadar / GPW',
    'https://www.biznesradar.pl/notowania-historyczne/WIG20',
    'daily',
    downsampleForChart(history.wig20_daily),
  )
}

/* ------------------------------------------------------------------ */
/* Kursy NBP (tabela A, kurs średni)                                    */
/* API: max 255 notowań w zapytaniu "last", max 367 dni w zakresie dat,  */
/* dane od 2002-01-02. Historię 10 lat pobieramy w kawałkach po 366 dni. */
/* ------------------------------------------------------------------ */
async function fetchNbpRange(code: string, from: string, to: string): Promise<SeriesPoint[]> {
  const out: SeriesPoint[] = []
  let cursor = new Date(from)
  const end = new Date(to)
  while (cursor <= end) {
    const chunkEnd = new Date(Math.min(cursor.getTime() + 365 * DAY_MS, end.getTime()))
    const a = cursor.toISOString().slice(0, 10)
    const b = chunkEnd.toISOString().slice(0, 10)
    try {
      const json = (await (await http(`https://api.nbp.pl/api/exchangerates/rates/a/${code}/${a}/${b}/?format=json`)).json()) as {
        rates: { effectiveDate: string; mid: number }[]
      }
      out.push(...json.rates.map((r) => ({ date: r.effectiveDate, value: r.mid })))
    } catch (e) {
      // 404 = brak notowań w zakresie (np. same dni wolne) – to nie błąd
      if (!(e as Error).message.startsWith('404')) throw e
    }
    cursor = new Date(chunkEnd.getTime() + DAY_MS)
  }
  return out
}

async function fetchNbp(code: string, id: string, label: string, history: History): Promise<Series> {
  const key = `${id}_daily`
  const start = historyStart()
  const stored = history[key] ?? []
  const backfill = needsBackfill(stored, start)
  // Przy dociąganiu bierzemy tydzień zakładki, żeby złapać ewentualne korekty tabel.
  const lastStored = stored.at(-1)?.date
  const from = backfill || !lastStored ? start : new Date(new Date(lastStored).getTime() - 7 * DAY_MS).toISOString().slice(0, 10)
  const fresh = await fetchNbpRange(code, from, today())
  if (backfill) console.log(`  ${label}: uzupełniono historię (${fresh.length} notowań)`)
  history[key] = trimFrom(sortDedupe([...stored, ...fresh]), start)
  if (history[key].length < 20) throw new Error('za mało notowań')
  return mkSeries(id, label, 'PLN', 'NBP (kurs średni, tabela A)', 'https://api.nbp.pl/', 'daily', downsampleForChart(history[key]))
}

/* ------------------------------------------------------------------ */
/* Rentowności obligacji – bieżąca wartość z TradingView (scanner)      */
/* + historia miesięczna z FRED/OECD + własne dzienne zrzuty            */
/* ------------------------------------------------------------------ */
interface History {
  [seriesId: string]: SeriesPoint[]
}

async function loadHistory(): Promise<History> {
  try {
    return JSON.parse(await readFile(HISTORY_FILE, 'utf8')) as History
  } catch {
    return {}
  }
}

async function fetchTradingViewCloses(tickers: string[]): Promise<Record<string, number>> {
  const res = await http('https://scanner.tradingview.com/global/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://www.tradingview.com', Referer: 'https://www.tradingview.com/' },
    body: JSON.stringify({ symbols: { tickers }, columns: ['close'] }),
  })
  const json = (await res.json()) as { data: { s: string; d: [number] }[] }
  return Object.fromEntries(json.data.map((d) => [d.s, d.d[0]]))
}

async function fetchFredMonthly(seriesId: string): Promise<SeriesPoint[]> {
  const csv = await (await http(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${seriesId}`)).text()
  return csv
    .split('\n')
    .slice(1)
    .map((l) => l.trim().split(','))
    .filter(([d, v]) => d && v && v !== '.')
    .map(([d, v]) => ({ date: d, value: Number(v) }))
}

async function fetchYields(history: History): Promise<Series[]> {
  const closes = await fetchTradingViewCloses(['TVC:PL10Y'])
  const day = today()
  const pl = closes['TVC:PL10Y']
  if (pl !== undefined) history.pl10y = sortDedupe([...(history.pl10y ?? []), { date: day, value: pl }])
  // Rentowności USA i Niemiec służyły tylko do usuniętego spreadu PL–Bund.
  delete history.us10y
  delete history.de10y

  const fredPl = await safe('FRED PL 10Y (miesięcznie)', () => fetchFredMonthly('IRLTLT01PLM156N'))
  // Historia miesięczna OECD do ostatniego miesiąca, potem nasze dzienne zrzuty.
  const lastMonthly = fredPl?.at(-1)?.date ?? '0000'
  const merged = trimFrom([...(fredPl ?? []), ...(history.pl10y ?? []).filter((p) => p.date > lastMonthly)], historyStart())

  return [
    mkSeries('pl10y', 'Obligacje skarbowe 10Y (rentowność)', '%', 'TradingView (bieżąca) + OECD/FRED (historia miesięczna)', 'https://www.tradingview.com/symbols/TVC-PL10Y/', 'snapshot', merged),
  ]
}

/* ------------------------------------------------------------------ */
/* Polymarket – rynki predykcyjne                                       */
/* ------------------------------------------------------------------ */
const POLYMARKET_EVENTS = [
  'will-russia-invade-a-nato-country-in-2025',
  'nato-x-russia-military-clash-in-2025',
  'nato-article-5-before-2027',
  'will-russia-invade-another-country-in-2026',
]

async function fetchPolymarket(): Promise<OddsMarket[]> {
  const out: OddsMarket[] = []
  for (const slug of POLYMARKET_EVENTS) {
    const json = (await (await http(`https://gamma-api.polymarket.com/events?slug=${slug}`)).json()) as {
      slug: string
      markets: { question: string; outcomePrices: string; volumeNum?: number; volume?: string; endDate?: string; closed: boolean }[]
    }[]
    const ev = json[0]
    if (!ev) continue
    const open = ev.markets.filter((m) => !m.closed).sort((a, b) => (b.endDate ?? '').localeCompare(a.endDate ?? ''))
    // najbliższy termin, który jest jeszcze otwarty
    const m = open.sort((a, b) => (a.endDate ?? '').localeCompare(b.endDate ?? ''))[0]
    if (!m) continue
    const prices = JSON.parse(m.outcomePrices) as string[]
    // slug idzie do linku na stronie – tylko znaki dozwolone w slugach Polymarket
    if (!/^[a-z0-9-]+$/i.test(ev.slug)) continue
    out.push({
      slug: ev.slug,
      question: m.question,
      yes: Number(prices[0]),
      volume: Number(m.volumeNum ?? m.volume ?? 0),
      endDate: m.endDate,
      url: `https://polymarket.com/event/${ev.slug}`,
    })
  }
  return out
}

/* ------------------------------------------------------------------ */
/* Ostrzeżenia dla podróżnych do Polski (USA, UK)                       */
/* ------------------------------------------------------------------ */
async function fetchAdvisories(): Promise<Advisory[]> {
  const out: Advisory[] = []
  await safe('US State Dept advisories', async () => {
    const xml = await (await http('https://travel.state.gov/_res/rss/TAsTWs.xml')).text()
    const item = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]).find((i) => /<title>\s*Poland\b/i.test(i))
    if (!item) throw new Error('brak wpisu dla Polski')
    const title = item.match(/<title>([\s\S]*?)<\/title>/)?.[1].trim() ?? ''
    const level = title.match(/Level \d/i)?.[0] ?? '?'
    const link = safeUrl(item.match(/<link>([\s\S]*?)<\/link>/)?.[1], 'state.gov', 'https://travel.state.gov/')
    const pub = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1].trim() ?? ''
    out.push({ country: 'USA', level, summary: title.replace(/^Poland\s*-\s*/i, ''), updatedAt: new Date(pub).toISOString(), url: link })
  })
  await safe('UK FCDO advisory', async () => {
    const json = (await (await http('https://www.gov.uk/api/content/foreign-travel-advice/poland')).json()) as {
      public_updated_at: string
      details: { alert_status: string[]; change_description?: string }
    }
    const status = json.details.alert_status
    const level = status.length === 0 ? 'no alert' : status.join(', ')
    out.push({
      country: 'Wielka Brytania',
      level,
      summary: json.details.change_description ?? '',
      updatedAt: json.public_updated_at,
      url: 'https://www.gov.uk/foreign-travel-advice/poland',
    })
  })
  return out
}

/* ------------------------------------------------------------------ */
/* Komunikaty gov.pl (MON, RCB, MSZ) – lista "Aktualności" ze strony      */
/* głównej danej instytucji (gov.pl nie udostępnia RSS)                   */
/* ------------------------------------------------------------------ */
async function fetchGovPlNews(site: string, label: string): Promise<NewsItem[]> {
  const html = await (
    await http(`https://www.gov.pl/web/${site}`, { headers: { Accept: 'text/html,application/xhtml+xml' } })
  ).text()
  const section = html.match(/<section id="Aktualnosci"[\s\S]*?<\/section>/)?.[0]
  if (!section) throw new Error('brak sekcji Aktualności (zmiana struktury gov.pl?)')
  const items: NewsItem[] = []
  for (const li of section.matchAll(/<li>([\s\S]*?)<\/li>/g)) {
    const date = li[1].match(/class="date">\s*(\d{2})\.(\d{2})\.(\d{4})/)
    const link = li[1].match(/class="title">\s*<a href="([^"]+)">([\s\S]*?)<\/a>/)
    if (!link) continue
    items.push({
      source: label,
      title: link[2].replace(/\s+/g, ' ').trim(),
      url: safeUrl(new URL(link[1], 'https://www.gov.pl').toString(), 'gov.pl', `https://www.gov.pl/web/${site}`),
      publishedAt: date ? `${date[3]}-${date[2]}-${date[1]}` : '',
    })
  }
  if (items.length === 0) throw new Error('nie znaleziono wpisów')
  return items
}

async function fetchAllNews(): Promise<NewsItem[]> {
  const lists = await Promise.all([
    safe('MON (gov.pl)', () => fetchGovPlNews('obrona-narodowa', 'MON')),
    safe('RCB (gov.pl)', () => fetchGovPlNews('rcb', 'RCB')),
    safe('MSZ (gov.pl)', () => fetchGovPlNews('dyplomacja', 'MSZ')),
  ])
  return lists
    .flatMap((l) => l ?? [])
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .slice(0, 12)
}

/* ------------------------------------------------------------------ */
async function main() {
  await mkdir(OUT_DIR, { recursive: true })
  const history = await loadHistory()
  let prev: Snapshot | undefined
  try {
    prev = JSON.parse(await readFile(SNAPSHOT_FILE, 'utf8')) as Snapshot
  } catch {
    /* pierwszy run */
  }

  const [wig20, usdpln, eurpln, yields, odds, advisories, monNews, airRaid, airTraffic, gpsJam] =
    await Promise.all([
    safe('WIG20 (BiznesRadar)', () => fetchWig20(history)),
    safe('USD/PLN (NBP)', () => fetchNbp('usd', 'usdpln', 'USD/PLN', history)),
    safe('EUR/PLN (NBP)', () => fetchNbp('eur', 'eurpln', 'EUR/PLN', history)),
    safe('Rentowności (TradingView/FRED)', () => fetchYields(history)),
    safe('Polymarket', () => fetchPolymarket()),
    fetchAdvisories(),
    fetchAllNews(),
    safe('Alarmy lotnicze (alerts.com.ua)', () => fetchAirRaid(http)),
    safe('Lotnictwo wojskowe (adsb.lol)', () => fetchAirTraffic(http)),
    safe('Zakłócenia GPS (gpsjam)', () => fetchGpsJam(http)),
  ])

  // Własna historia dla wskaźników bez darmowej historii.
  const day = today()
  const pushHist = (id: string, v: number | undefined) => {
    if (v === undefined) return
    history[id] = sortDedupe([...(history[id] ?? []), { date: day, value: v }])
  }
  if (gpsJam) {
    pushHist('gpsjam_baltic', gpsJam.baltic.pct)
    pushHist('gpsjam_poland', gpsJam.poland.pct)
  }
  if (airTraffic) pushHist('mil_aircraft_near_pl', airTraffic.aircraft.length)
  if (airRaid) pushHist('air_raid_western', airRaid.western.filter((r) => r.alert).length)

  const series: Record<string, Series> = {}
  for (const s of [wig20, usdpln, eurpln, ...(yields ?? [])]) if (s) series[s.id] = s

  // Zachowaj poprzednie dane, jeśli dziś pobranie się nie udało (nie psuj strony przez chwilową awarię źródła).
  // Tylko serie, które strona faktycznie pokazuje; inaczej usunięte kiedyś serie wracałyby ze starego snapshotu.
  const SERIES_IDS = ['wig20', 'usdpln', 'eurpln', 'pl10y']
  if (prev) for (const id of SERIES_IDS) if (!series[id] && prev.series[id]) series[id] = prev.series[id]

  const now = new Date().toISOString()
  const partial = {
    series,
    odds: odds ?? prev?.odds ?? [],
    advisories: advisories.length ? advisories : (prev?.advisories ?? []),
    news: monNews.length ? monNews : (prev?.news ?? []),
    airRaid: airRaid ?? prev?.airRaid,
    airTraffic: airTraffic ?? prev?.airTraffic,
    gpsJam: gpsJam ?? prev?.gpsJam,
  }

  const tension = computeTension(partial).score
  pushHist('tension', tension)

  const snapshot: Snapshot = {
    generatedAt: now,
    ...partial,
    tensionHistory: history.tension ?? [],
    errors,
  }

  // Zwarty JSON: pełna dzienna historia 10 lat to kilka tysięcy punktów na serię.
  await writeFile(HISTORY_FILE, JSON.stringify(history))
  await writeFile(SNAPSHOT_FILE, JSON.stringify(snapshot))
  console.log(`\nZapisano ${SNAPSHOT_FILE} (${Object.keys(series).length} serii, ${errors.length} błędów)`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
