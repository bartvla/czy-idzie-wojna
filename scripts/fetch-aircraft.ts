/**
 * Lekki skrypt uruchamiany co 5 minut przez GitHub Actions (.github/workflows/aircraft.yml):
 * pobiera lotnictwo wojskowe w regionie i zapisuje public/data/aircraft.json.
 * Plik trafia na gałąź `data`, skąd czyta go Cloudflare Worker (GET /mil).
 *
 * Dlaczego nie bezpośrednio z Workera: adsb.fi, adsb.lol, airplanes.live i OpenSky
 * blokują adresy wychodzące Cloudflare (403/429/522), a serwery GitHub Actions nie są blokowane.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fetchMilUpstreams, type RawAdsbAircraft } from '../shared/aircraft'

const OUT_DIR = path.resolve('public/data')
const OUT_FILE = path.join(OUT_DIR, 'aircraft.json')
const UA = 'czyidziewojna.pl/0.1 (+https://czyidziewojna.pl/kontakt)'

async function main() {
  await mkdir(OUT_DIR, { recursive: true })
  const traffic = await fetchMilUpstreams(async (url) => {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as { ac: RawAdsbAircraft[]; now?: number }
  })
  await writeFile(OUT_FILE, JSON.stringify(traffic))
  console.log(`✔ ${traffic.source}: ${traffic.aircraft.length} maszyn w regionie, ${traffic.aircraft.filter((a) => a.overPoland).length} nad Polską`)
}

main().catch((e) => {
  console.error(`✖ ${(e as Error).message}`)
  process.exit(1)
})
