export interface SeriesPoint {
  /** ISO date YYYY-MM-DD */
  date: string
  value: number
}

export interface Series {
  id: string
  label: string
  unit: string
  source: string
  sourceUrl: string
  /** How often the underlying source publishes */
  frequency: 'daily' | 'monthly' | 'snapshot'
  updatedAt: string
  points: SeriesPoint[]
}

export interface OddsMarket {
  slug: string
  question: string
  /** Probability of YES, 0..1 */
  yes: number
  volume: number
  endDate?: string
  url: string
}

export interface Advisory {
  country: string
  level: string
  summary: string
  updatedAt: string
  url: string
}

export interface NewsItem {
  source: string
  title: string
  url: string
  publishedAt: string
}

export interface AirRaidRegion {
  /** Nazwa obwodu (EN), zgodna z `name` w public/geo/ukr-adm1.json */
  name: string
  alert: boolean
  /** ISO timestamp ostatniej zmiany stanu, '' gdy źródło go nie podaje */
  changed: string
}

export interface AirRaid {
  source: string
  sourceUrl: string
  fetchedAt: string
  /** Wszystkie obwody */
  regions: AirRaidRegion[]
  /** Zachodnie obwody graniczące/blisko Polski */
  western: AirRaidRegion[]
  /** Liczba wszystkich obwodów z aktywnym alarmem */
  totalActive: number
  totalRegions: number
}

export type AircraftCategory = 'awacs' | 'tanker' | 'fighter' | 'transport' | 'isr' | 'drone' | 'helicopter' | 'other'

export interface MilAircraft {
  hex: string
  callsign: string
  type: string
  description: string
  registration: string
  category: AircraftCategory
  altitudeFt: number | null
  groundSpeedKt: number | null
  /** Kurs w stopniach, null gdy nieznany */
  track: number | null
  lat: number
  lon: number
  /** Czy pozycja jest nad terytorium Polski (przybliżony bbox), czy tylko w sąsiedztwie */
  overPoland: boolean
}

export interface AirTraffic {
  source: string
  sourceUrl: string
  fetchedAt: string
  aircraft: MilAircraft[]
  byCategory: Record<AircraftCategory, number>
}

export interface GpsJamRegion {
  cells: number
  badCells: number
  /** Odsetek komórek H3 z >=10% samolotów zgłaszających złą nawigację */
  pct: number
}

export interface GpsJamCell {
  /** Indeks H3 */
  h: string
  /** Samoloty z dobrą nawigacją */
  g: number
  /** Samoloty ze złą nawigacją */
  b: number
  /** Obrys komórki jako [lat, lon][] */
  p: [number, number][]
}

export interface GpsJam {
  source: string
  sourceUrl: string
  /** Data pliku (gpsjam publikuje dzień wstecz) */
  date: string
  baltic: GpsJamRegion
  poland: GpsJamRegion
  /** Komórki w regionie mapy (Polska, Bałtyk, sąsiedzi) */
  cells: GpsJamCell[]
}

export interface Snapshot {
  generatedAt: string
  series: Record<string, Series>
  odds: OddsMarket[]
  advisories: Advisory[]
  gdelt?: { label: string; points: SeriesPoint[] }
  news: NewsItem[]
  airRaid?: AirRaid
  airTraffic?: AirTraffic
  gpsJam?: GpsJam
  /** Historia indeksu napięcia (jeden punkt dziennie) */
  tensionHistory: SeriesPoint[]
  errors: string[]
}
