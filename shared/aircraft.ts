/**
 * Wspólna logika dla lotnictwa wojskowego (ADS-B): filtr regionu, kategoryzacja,
 * mapowanie surowego JSON-a adsb.lol na nasz typ. Używana przez skrypt (snapshot)
 * i przez Cloudflare Worker (podgląd na żywo), więc bez zależności od Node i DOM.
 */
import type { AircraftCategory, AirTraffic, MilAircraft } from '../src/types'

export interface RawAdsbAircraft {
  hex: string
  flight?: string
  r?: string
  t?: string
  desc?: string
  alt_baro?: number | string
  gs?: number
  track?: number
  lat?: number
  lon?: number
}

export interface BBox {
  lat0: number
  lat1: number
  lon0: number
  lon1: number
}

// Przybliżony bbox Polski i szerszy bbox "sąsiedztwo" (Bałtyk, Kaliningrad, zach. Ukraina, Białoruś).
export const PL_BBOX: BBox = { lat0: 49.0, lat1: 54.9, lon0: 14.1, lon1: 24.2 }
export const NEAR_BBOX: BBox = { lat0: 47.5, lat1: 57.0, lon0: 11.0, lon1: 27.0 }

export const inBox = (lat: number, lon: number, b: BBox): boolean => lat >= b.lat0 && lat <= b.lat1 && lon >= b.lon0 && lon <= b.lon1

const CATEGORY_BY_TYPE: Record<string, AircraftCategory> = {
  E3CF: 'awacs', E3TF: 'awacs', E7: 'awacs', E737: 'awacs', E2: 'awacs', SB7L: 'awacs',
  K35R: 'tanker', K35E: 'tanker', KC10: 'tanker', A332: 'tanker', A333: 'tanker', A310: 'tanker', KC46: 'tanker', MRTT: 'tanker', A339: 'tanker', KC13: 'tanker',
  F16: 'fighter', F15: 'fighter', F18: 'fighter', F18H: 'fighter', F18S: 'fighter', F35: 'fighter', F35A: 'fighter', F35B: 'fighter', F35C: 'fighter',
  EUFI: 'fighter', RFAL: 'fighter', TORN: 'fighter', GRIP: 'fighter', JAS3: 'fighter', F22: 'fighter', MG29: 'fighter', SU27: 'fighter', A10: 'fighter',
  C17: 'transport', C30J: 'transport', C130: 'transport', H130: 'transport', A400: 'transport', C5M: 'transport', C5: 'transport', C295: 'transport',
  CN35: 'transport', C27J: 'transport', C160: 'transport', IL76: 'transport', AN12: 'transport', AN26: 'transport', AN72: 'transport',
  P8: 'isr', R135: 'isr', RC35: 'isr', GLEX: 'isr', GLF6: 'isr', E6: 'isr', E8: 'isr', P3: 'isr', ATLA: 'isr', CL60: 'isr', G550: 'isr', GLF5: 'isr', DHC8: 'isr', U2: 'isr',
  Q4: 'drone', RQ4: 'drone', MQ9: 'drone', Q9: 'drone', HRON: 'drone', EH10: 'drone',
  H60: 'helicopter', UH60: 'helicopter', H47: 'helicopter', CH47: 'helicopter', NH90: 'helicopter', EC45: 'helicopter', AS65: 'helicopter', A139: 'helicopter',
  H64: 'helicopter', AH64: 'helicopter', EC35: 'helicopter', H145: 'helicopter', S70: 'helicopter', MI8: 'helicopter', MI17: 'helicopter', W3: 'helicopter', V22: 'helicopter',
}

const CATEGORY_BY_CALLSIGN: [RegExp, AircraftCategory][] = [
  [/^(NATO|MAGIC|BLKCAT|SENTRY)/i, 'awacs'],
  [/^(FORTE|JAKE|HOMER|REDEYE|TOPCAT|LAGR|DUKE|EVAC|ATHENA|BART|GLASS|CIRCUS)/i, 'isr'],
  [/^(QID|MMF|ESSO|GOLD|PETRO|SHELL|OPEC|TEXACO|NCHO|GRANT|BALT)/i, 'tanker'],
  [/^(HERKY|RCH|CNV|REACH|MOOSE|BULL|RRR|GAF|BAF|CTM|FAF|PLF|HKY)/i, 'transport'],
  [/^(VIPER|EAGLE|HAWK|FANG|MUSTANG|TIGER|WOLF|GRIF)/i, 'fighter'],
]

export function categorize(type: string, callsign: string): AircraftCategory {
  if (CATEGORY_BY_TYPE[type]) return CATEGORY_BY_TYPE[type]
  for (const [re, cat] of CATEGORY_BY_CALLSIGN) if (re.test(callsign)) return cat
  return 'other'
}

export interface MilUpstream {
  url: string
  source: string
  sourceUrl: string
}

/**
 * Publiczne API zgodne z readsb (ten sam kształt JSON, endpoint /v2/mil).
 * Kolejność = priorytet: adsb.fi nie limituje tak agresywnie jak adsb.lol,
 * które z adresów Cloudflare odpowiada 429. Oba wymagają rozsądnego User-Agenta.
 */
export const MIL_UPSTREAMS: MilUpstream[] = [
  { url: 'https://opendata.adsb.fi/api/v2/mil', source: 'adsb.fi (ADS-B, tylko samoloty oznaczone jako wojskowe)', sourceUrl: 'https://adsb.fi/' },
  { url: 'https://api.adsb.lol/v2/mil', source: 'adsb.lol (ADS-B, tylko samoloty oznaczone jako wojskowe)', sourceUrl: 'https://adsb.lol/' },
]

/** Próbuje kolejnych upstreamów; zwraca pierwszy poprawny wynik. */
export async function fetchMilUpstreams(
  fetchJson: (url: string) => Promise<{ ac: RawAdsbAircraft[]; now?: number }>,
  upstreams: MilUpstream[] = MIL_UPSTREAMS,
): Promise<AirTraffic> {
  const errors: string[] = []
  for (const up of upstreams) {
    try {
      const data = await fetchJson(up.url)
      if (!Array.isArray(data.ac)) throw new Error('brak pola ac')
      return toAirTraffic(data.ac, new Date(data.now ?? Date.now()).toISOString(), up)
    } catch (e) {
      errors.push(`${new URL(up.url).host}: ${(e as Error).message}`)
    }
  }
  throw new Error(errors.join('; '))
}

/** Surowa lista readsb -> nasz AirTraffic (tylko region NEAR_BBOX). */
export function toAirTraffic(ac: RawAdsbAircraft[], fetchedAt: string, upstream: MilUpstream = MIL_UPSTREAMS[0]): AirTraffic {
  const aircraft: MilAircraft[] = []
  for (const a of ac) {
    if (a.lat == null || a.lon == null) continue
    if (!inBox(a.lat, a.lon, NEAR_BBOX)) continue
    // Identyfikator ICAO trafia do linków na stronie; przyjmujemy tylko 6 znaków hex (adres 24-bit).
    if (typeof a.hex !== 'string' || !/^[0-9a-f]{6}$/i.test(a.hex)) continue
    const callsign = (a.flight ?? '').trim()
    const type = (a.t ?? '').trim()
    aircraft.push({
      hex: a.hex,
      callsign,
      type,
      description: a.desc ?? '',
      registration: a.r ?? '',
      category: categorize(type, callsign),
      altitudeFt: typeof a.alt_baro === 'number' ? a.alt_baro : null,
      groundSpeedKt: a.gs ?? null,
      track: typeof a.track === 'number' ? a.track : null,
      lat: a.lat,
      lon: a.lon,
      overPoland: inBox(a.lat, a.lon, PL_BBOX),
    })
  }
  const byCategory: Record<AircraftCategory, number> = { awacs: 0, tanker: 0, fighter: 0, transport: 0, isr: 0, drone: 0, helicopter: 0, other: 0 }
  for (const a of aircraft) byCategory[a.category]++
  aircraft.sort((a, b) => Number(b.overPoland) - Number(a.overPoland) || a.category.localeCompare(b.category))
  return { source: upstream.source, sourceUrl: upstream.sourceUrl, fetchedAt, aircraft, byCategory }
}
