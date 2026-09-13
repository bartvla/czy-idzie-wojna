import { useEffect, useState } from 'react'
import type { AircraftCategory, AirRaid, AirTraffic, GpsJam } from '../types'
import { fmt, fmtDate } from '../lib/stats'
import { AircraftMap, GpsJamMap, UkraineMap } from './Maps'

const CATEGORY_LABEL: Record<AircraftCategory, string> = {
  awacs: 'AWACS / wczesne ostrzeganie',
  tanker: 'tankowce',
  fighter: 'myśliwce',
  transport: 'transportowce',
  isr: 'rozpoznanie (ISR)',
  drone: 'drony',
  helicopter: 'śmigłowce',
  other: 'inne',
}

const CATEGORY_ORDER: AircraftCategory[] = ['awacs', 'isr', 'tanker', 'fighter', 'transport', 'drone', 'helicopter', 'other']

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const h = Math.floor(ms / 3_600_000)
  if (h < 1) return `${Math.max(1, Math.floor(ms / 60_000))} min temu`
  if (h < 48) return `${h} h temu`
  return `${Math.floor(h / 24)} dni temu`
}

export function AirRaidCard({ data }: { data?: AirRaid }) {
  if (!data) return <div className="card placeholder">Brak danych o alarmach lotniczych.</div>
  const active = data.western.filter((r) => r.alert)
  return (
    <div className="card">
      <div className="card__head">
        <h3 className="card__title">Alarmy lotnicze w zachodniej Ukrainie</h3>
        <span className={`badge ${active.length ? 'badge--alert' : 'badge--ok'}`}>
          {active.length} / {data.western.length} obwodów
        </span>
      </div>
      <div className="card__meta">
        <span>
          Cała Ukraina: {data.totalActive} / {data.totalRegions} obwodów z alarmem
        </span>
      </div>
      <UkraineMap data={data} />
      <ul className="oblasts">
        {data.western.map((r) => (
          <li key={r.name} className={r.alert ? 'oblast oblast--alert' : 'oblast'}>
            <b>{r.name}</b>
            <span>{r.alert ? 'ALARM' : 'spokój'}</span>
            {r.changed && <small>{timeAgo(r.changed)}</small>}
          </li>
        ))}
      </ul>
      <div className="card__source">
        Alarm w obwodach lwowskim, wołyńskim i zakarpackim oznacza cele w odległości kilkudziesięciu km od granicy RP. Źródło:{' '}
        <a href={data.sourceUrl} target="_blank" rel="noreferrer">
          {data.source}
        </a>{' '}
        · {new Date(data.fetchedAt).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })}
      </div>
    </div>
  )
}

export function GpsJamCard({ data }: { data?: GpsJam }) {
  if (!data) return <div className="card placeholder">Brak danych o zakłóceniach GPS.</div>
  const level = (pct: number) => (pct >= 40 ? 'var(--alert)' : pct >= 15 ? 'var(--warn)' : 'var(--ok)')
  return (
    <div className="card">
      <div className="card__head">
        <h3 className="card__title">Zakłócenia GPS (jamming)</h3>
        <span className="card__value" style={{ color: level(data.baltic.pct) }}>
          {fmt(data.baltic.pct, 0)}%
        </span>
      </div>
      <div className="card__meta">
        <span>odsetek komórek siatki z ≥10% samolotów zgłaszających złą nawigację, {fmtDate(data.date)}</span>
      </div>
      <GpsJamMap data={data} />
      <div className="jam">
        <div>
          <span className="tile__label">Bałtyk i Kaliningrad</span>
          <span className="tile__value" style={{ color: level(data.baltic.pct) }}>
            {fmt(data.baltic.pct, 0)}%
          </span>
          <span className="tile__bar">
            <i style={{ width: `${data.baltic.pct}%`, background: level(data.baltic.pct) }} />
          </span>
          <span className="tile__sub">
            {data.baltic.badCells} z {data.baltic.cells} komórek
          </span>
        </div>
        <div>
          <span className="tile__label">Polska</span>
          <span className="tile__value" style={{ color: level(data.poland.pct) }}>
            {fmt(data.poland.pct, 0)}%
          </span>
          <span className="tile__bar">
            <i style={{ width: `${data.poland.pct}%`, background: level(data.poland.pct) }} />
          </span>
          <span className="tile__sub">
            {data.poland.badCells} z {data.poland.cells} komórek
          </span>
        </div>
      </div>
      <div className="card__source">
        Zagłuszanie GNSS nad Bałtykiem to stały element od 2023 r.; sygnałem jest wzrost ponad zwykły poziom i rozlanie się na centralną
        Polskę. Źródło:{' '}
        <a href={data.sourceUrl} target="_blank" rel="noreferrer">
          {data.source}
        </a>
      </div>
    </div>
  )
}

const LIVE_API = (import.meta.env.VITE_LIVE_API_URL ?? '').replace(/\/$/, '')
const LIVE_INTERVAL_MS = 30_000

/**
 * Odpytuje Workera co 30 s; gdy nie skonfigurowany lub błąd, zwraca undefined (używamy snapshotu).
 * Worker serwuje plik odświeżany przez GitHub Actions co ~5 min, więc "na żywo" oznacza tu kilka minut opóźnienia.
 */
export function useLiveAirTraffic(): { live?: AirTraffic; error?: string; refreshedAt?: Date } {
  const [state, setState] = useState<{ live?: AirTraffic; error?: string; refreshedAt?: Date }>({})
  useEffect(() => {
    if (!LIVE_API) return
    let stopped = false
    const tick = async () => {
      try {
        const r = await fetch(`${LIVE_API}/mil`, { cache: 'no-store' })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const live = (await r.json()) as AirTraffic
        if (!stopped) setState({ live, refreshedAt: new Date() })
      } catch (e) {
        if (!stopped) setState((s) => ({ ...s, error: (e as Error).message }))
      }
    }
    void tick()
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void tick()
    }, LIVE_INTERVAL_MS)
    return () => {
      stopped = true
      clearInterval(id)
    }
  }, [])
  return state
}

const timeHM = (iso: string) => new Date(iso).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })

export function AirTrafficCard({ data: snapshot, live, liveError }: { data?: AirTraffic; live?: AirTraffic; liveError?: string }) {
  const data = live ?? snapshot
  if (!data) return <div className="card placeholder">Brak danych o lotnictwie wojskowym.</div>
  const over = data.aircraft.filter((a) => a.overPoland)
  const cats = CATEGORY_ORDER.filter((c) => data.byCategory[c] > 0)
  const ageMin = Math.max(0, Math.round((Date.now() - new Date(data.fetchedAt).getTime()) / 60_000))
  return (
    <div className="card">
      <div className="card__head">
        <h3 className="card__title">
          Lotnictwo wojskowe (ADS-B){' '}
          {live ? (
            <span
              className={`badge live ${ageMin > 20 ? 'badge--warn' : 'badge--ok'}`}
              title={`pozycje z ${timeHM(data.fetchedAt)}, plik odświeżany co ok. 5 min, strona sprawdza co ${LIVE_INTERVAL_MS / 1000} s`}
            >
              ● {timeHM(data.fetchedAt)}
              {ageMin > 20 && ` (${ageMin} min temu)`}
            </span>
          ) : LIVE_API ? (
            <span className="badge badge--warn" title={liveError}>
              snapshot
            </span>
          ) : null}
        </h3>
        <span className="card__value">
          {over.length} <small style={{ fontSize: 12, color: 'var(--muted)' }}>nad Polską</small>{' '}
          <span style={{ color: 'var(--muted)', fontSize: 14 }}>/ {data.aircraft.length} w regionie</span>
        </span>
      </div>
      <div className="card__meta">
        {cats.map((c) => (
          <span key={c}>
            {CATEGORY_LABEL[c]}: <b style={{ color: 'var(--text)' }}>{data.byCategory[c]}</b>
          </span>
        ))}
        {cats.length === 0 && <span>brak widocznych maszyn wojskowych</span>}
      </div>
      <AircraftMap data={data} />
      {data.aircraft.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table className="ac">
            <thead>
              <tr>
                <th>znak</th>
                <th>typ</th>
                <th>kategoria</th>
                <th>wys. (ft)</th>
                <th>gdzie</th>
              </tr>
            </thead>
            <tbody>
              {data.aircraft.slice(0, 12).map((a) => (
                <tr key={a.hex} className={a.overPoland ? 'ac--pl' : ''}>
                  <td>
                    <a href={`https://globe.adsb.lol/?icao=${a.hex}`} target="_blank" rel="noreferrer">
                      {a.callsign || a.registration || a.hex}
                    </a>
                  </td>
                  <td>{a.type || '?'}</td>
                  <td>{CATEGORY_LABEL[a.category]}</td>
                  <td>{a.altitudeFt === null ? '—' : fmt(a.altitudeFt, 0)}</td>
                  <td>{a.overPoland ? 'Polska' : 'sąsiedztwo'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="card__source">
        Tylko maszyny nadające ADS-B i oznaczone jako wojskowe w bazie źródła; myśliwce w akcji zwykle nie nadają. Sygnałem jest
        obecność AWACS, tankowców i rozpoznania (RC-135, Global Hawk) oraz nagły wzrost transportowców. Źródło:{' '}
        <a href={data.sourceUrl} target="_blank" rel="noreferrer">
          {data.source.split(' ')[0]}
        </a>{' '}
        · pozycje z {timeHM(data.fetchedAt)}
      </div>
    </div>
  )
}
