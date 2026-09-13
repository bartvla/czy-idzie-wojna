/**
 * Przestrzeń powietrzna: alarmy lotnicze w Ukrainie, lotnictwo wojskowe nad Polską,
 * zakłócenia GPS (gpsjam). Używane przez fetch-data.ts.
 */
import { cellToBoundary, cellToLatLng } from 'h3-js'
import type { AirRaid, AirRaidRegion, AirTraffic, GpsJam, GpsJamCell, GpsJamRegion } from '../src/types'
import { PL_BBOX, fetchMilUpstreams, type RawAdsbAircraft } from '../shared/aircraft'

type Http = (url: string, init?: RequestInit) => Promise<Response>

/* ------------------------------------------------------------------ */
/* Alarmy lotnicze – alerts.com.ua (publiczne, bez klucza)             */
/* ------------------------------------------------------------------ */
const WESTERN_OBLASTS = ['Lviv', 'Volyn', 'Zakarpattia', 'Rivne', 'Ivano-Frankivsk', 'Ternopil', 'Chernivtsi', 'Khmelnytskyi']

// Nazwy ukraińskie (ubilling) -> angielskie, żeby oba źródła dawały ten sam kształt danych.
const UA_TO_EN: Record<string, string> = {
  'Львівська': 'Lviv', 'Волинська': 'Volyn', 'Закарпатська': 'Zakarpattia', 'Рівненська': 'Rivne', 'Івано-Франківська': 'Ivano-Frankivsk',
  'Тернопільська': 'Ternopil', 'Чернівецька': 'Chernivtsi', 'Хмельницька': 'Khmelnytskyi', 'Вінницька': 'Vinnytsia', 'Житомирська': 'Zhytomyr',
  'Київська': 'Kyiv', 'м. Київ': 'Kyiv city', 'Черкаська': 'Cherkasy', 'Кіровоградська': 'Kirovohrad', 'Миколаївська': 'Mykolaiv', 'Одеська': 'Odesa',
  'Херсонська': 'Kherson', 'Запорізька': 'Zaporizhzhia', 'Дніпропетровська': 'Dnipropetrovsk', 'Полтавська': 'Poltava', 'Сумська': 'Sumy',
  'Харківська': 'Kharkiv', 'Донецька': 'Donetsk', 'Луганська': 'Luhansk', 'Чернігівська': 'Chernihiv', 'Севастополь': 'Sevastopol', 'Крим': 'Crimea',
}

function pickWestern(regions: AirRaidRegion[]): AirRaidRegion[] {
  return WESTERN_OBLASTS.map((w) => regions.find((r) => r.name.toLowerCase().startsWith(w.toLowerCase()))).filter(
    (r): r is AirRaidRegion => !!r,
  )
}

const validIso = (s: string | undefined): string => {
  const t = s ? Date.parse(s) : NaN
  return Number.isFinite(t) && t > Date.parse('2022-02-24') ? new Date(t).toISOString() : ''
}

/** Źródło główne: ubilling.net.ua (agregator, świeży cache, bez klucza). Znaczniki czasu zmian są tam bezużyteczne. */
async function fetchAirRaidUbilling(http: Http): Promise<AirRaid> {
  const json = (await (await http('https://ubilling.net.ua/aerialalerts/?json=true')).json()) as {
    cachedat: string
    states: Record<string, { alertnow: boolean; changed: string }>
  }
  const regions: AirRaidRegion[] = Object.entries(json.states).map(([name, s]) => {
    const key = Object.keys(UA_TO_EN).find((k) => name.startsWith(k))
    return { name: key ? UA_TO_EN[key] : name, alert: s.alertnow, changed: validIso(s.changed) }
  })
  if (regions.length < 20) throw new Error('za mało obwodów')
  return {
    source: 'ubilling.net.ua/aerialalerts',
    sourceUrl: 'https://ubilling.net.ua/aerialalerts/',
    fetchedAt: new Date().toISOString(),
    regions,
    western: pickWestern(regions),
    totalActive: regions.filter((r) => r.alert).length,
    totalRegions: regions.length,
  }
}

/** Źródło zapasowe: alerts.com.ua. W testach (wrzesień 2026) pokazywało mniej alarmów niż inne agregatory. */
async function fetchAirRaidAlertsComUa(http: Http): Promise<AirRaid> {
  const json = (await (await http('https://alerts.com.ua/api/states')).json()) as {
    states: { id: number; name: string; name_en: string; alert: boolean; changed: string }[]
  }
  const regions: AirRaidRegion[] = json.states.map((s) => ({
    name: s.name_en.replace(/ oblast$/i, ''),
    alert: s.alert,
    changed: validIso(s.changed),
  }))
  return {
    source: 'alerts.com.ua',
    sourceUrl: 'https://alerts.com.ua/',
    fetchedAt: new Date().toISOString(),
    regions,
    western: pickWestern(regions),
    totalActive: regions.filter((r) => r.alert).length,
    totalRegions: regions.length,
  }
}

export async function fetchAirRaid(http: Http): Promise<AirRaid> {
  try {
    return await fetchAirRaidUbilling(http)
  } catch (e) {
    console.warn(`ubilling niedostępny (${(e as Error).message}), używam alerts.com.ua`)
    return fetchAirRaidAlertsComUa(http)
  }
}

/* ------------------------------------------------------------------ */
/* Lotnictwo wojskowe – adsb.lol /v2/mil (publiczne, wymaga UA z kontaktem) */
/* Logika filtrowania i kategoryzacji jest w shared/aircraft.ts (wspólna    */
/* z Cloudflare Workerem, który serwuje podgląd na żywo).                   */
/* ------------------------------------------------------------------ */
export async function fetchAirTraffic(http: Http): Promise<AirTraffic> {
  return fetchMilUpstreams(async (url) => (await (await http(url)).json()) as { ac: RawAdsbAircraft[]; now?: number })
}

/* ------------------------------------------------------------------ */
/* Zakłócenia GPS – gpsjam.org (dzienny CSV, siatka H3 res 4)          */
/* ------------------------------------------------------------------ */
const BALTIC = { lat0: 53.5, lat1: 60.5, lon0: 13.0, lon1: 30.0 }
// Obszar mapy zakłóceń: Polska, Bałtyk, Kaliningrad, Białoruś, zachodnia Ukraina, wschodnie Niemcy.
const MAP_AREA = { lat0: 47.5, lat1: 61.0, lon0: 10.0, lon1: 32.0 }

function mapCells(rows: [string, number, number][]): GpsJamCell[] {
  const out: GpsJamCell[] = []
  for (const [hex, good, bad] of rows) {
    const [lat, lon] = cellToLatLng(hex)
    if (lat < MAP_AREA.lat0 || lat > MAP_AREA.lat1 || lon < MAP_AREA.lon0 || lon > MAP_AREA.lon1) continue
    if (good + bad < 1) continue
    const p = cellToBoundary(hex).map(([la, lo]): [number, number] => [Math.round(la * 1000) / 1000, Math.round(lo * 1000) / 1000])
    out.push({ h: hex, g: good, b: bad, p })
  }
  return out
}

function regionStats(rows: [string, number, number][], box: { lat0: number; lat1: number; lon0: number; lon1: number }): GpsJamRegion {
  let cells = 0
  let badCells = 0
  for (const [hex, good, bad] of rows) {
    const [lat, lon] = cellToLatLng(hex)
    if (lat < box.lat0 || lat > box.lat1 || lon < box.lon0 || lon > box.lon1) continue
    if (good + bad < 1) continue
    cells++
    if (bad / (good + bad) >= 0.1) badCells++
  }
  return { cells, badCells, pct: cells ? (100 * badCells) / cells : 0 }
}

export async function fetchGpsJam(http: Http): Promise<GpsJam> {
  // gpsjam publikuje plik za poprzedni dzień (UTC); próbujemy wczoraj, potem wcześniej.
  let lastErr: Error | undefined
  for (const back of [1, 2, 3]) {
    const d = new Date()
    d.setUTCDate(d.getUTCDate() - back)
    const date = d.toISOString().slice(0, 10)
    try {
      const csv = await (await http(`https://gpsjam.org/data/${date}-h3_4.csv`)).text()
      const rows = csv
        .trim()
        .split('\n')
        .slice(1)
        .map((l) => l.split(','))
        .filter((c) => c.length >= 3)
        .map((c): [string, number, number] => [c[0], Number(c[1]), Number(c[2])])
      if (rows.length < 100) throw new Error('pusty plik')
      return {
        source: 'gpsjam.org (John Wiseman, dane ADS-B)',
        sourceUrl: `https://gpsjam.org/?date=${date}&lat=54&lon=19&z=5`,
        date,
        baltic: regionStats(rows, BALTIC),
        poland: regionStats(rows, PL_BBOX),
        cells: mapCells(rows),
      }
    } catch (e) {
      lastErr = e as Error
    }
  }
  throw lastErr ?? new Error('brak danych gpsjam')
}
