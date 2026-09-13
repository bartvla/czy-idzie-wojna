import { useEffect, useMemo, useState } from 'react'
import L from 'leaflet'
import { GeoJSON, MapContainer, Marker, Polygon, Popup, TileLayer, Tooltip } from 'react-leaflet'
import type { Feature, FeatureCollection, Geometry } from 'geojson'
import type { AircraftCategory, AirRaid, AirTraffic, GpsJam } from '../types'
import { fmt, fmtDate } from '../lib/stats'

// CARTO wymaga darmowego klucza (bez niego wypala napis „API KEY REQUIRED” w kaflach).
// Bez klucza używamy ciemnego podkładu Esri z osobną warstwą etykiet.
const CARTO_KEY = import.meta.env.VITE_CARTO_KEY ?? ''

function BaseTiles() {
  if (CARTO_KEY) {
    return (
      <TileLayer
        url={`https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?key=${encodeURIComponent(CARTO_KEY)}`}
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
        subdomains="abcd"
        maxZoom={12}
      />
    )
  }
  const esri = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas'
  return (
    <>
      <TileLayer
        url={`${esri}/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`}
        attribution="Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors"
        maxZoom={12}
      />
      <TileLayer url={`${esri}/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`} maxZoom={12} pane="shadowPane" />
    </>
  )
}

function Base({ children, center, zoom, tall }: { children: React.ReactNode; center: [number, number]; zoom: number; tall?: boolean }) {
  return (
    <MapContainer center={center} zoom={zoom} scrollWheelZoom={false} className={`map${tall ? ' map--tall' : ''}`} preferCanvas>
      <BaseTiles />
      {children}
    </MapContainer>
  )
}

/* ------------------------------------------------------------------ */
/* 1. Ukraina – obwody i alarmy lotnicze                               */
/* ------------------------------------------------------------------ */
type OblastFeature = Feature<Geometry, { name: string }>

export function UkraineMap({ data }: { data: AirRaid }) {
  const [geo, setGeo] = useState<FeatureCollection<Geometry, { name: string }> | null>(null)
  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}geo/ukr-adm1.json`)
      .then((r) => r.json())
      .then(setGeo)
      .catch(() => setGeo(null))
  }, [])

  const byName = useMemo(() => new Map(data.regions.map((r) => [r.name, r])), [data.regions])
  const western = useMemo(() => new Set(data.western.map((r) => r.name)), [data.western])

  const style = (f?: OblastFeature): L.PathOptions => {
    const r = f && byName.get(f.properties.name)
    const west = f ? western.has(f.properties.name) : false
    if (r?.alert) return { color: '#ff5c5c', weight: west ? 2 : 1, fillColor: '#ff5c5c', fillOpacity: west ? 0.55 : 0.35 }
    return { color: west ? '#3ddc84' : '#3a4a5c', weight: west ? 1.5 : 0.8, fillColor: west ? '#3ddc84' : '#1c2733', fillOpacity: west ? 0.18 : 0.35 }
  }

  return (
    <>
      <Base center={[49.4, 27.5]} zoom={5}>
        {geo && (
          <GeoJSON
            key={data.fetchedAt}
            data={geo}
            style={(f) => style(f as OblastFeature)}
            onEachFeature={(f, layer) => {
              const r = byName.get((f as OblastFeature).properties.name)
              const name = (f as OblastFeature).properties.name
              // bindTooltip przyjmuje HTML; nazwę podajemy jako element tekstowy, żeby nigdy nie była interpretowana jako znaczniki.
              const label = document.createElement('span')
              label.textContent = `${name}: ${r ? (r.alert ? 'ALARM' : 'spokój') : 'brak danych'}`
              layer.bindTooltip(label, { sticky: true, className: 'dark' })
            }}
          />
        )}
      </Base>
      <div className="legend">
        <span>
          <i style={{ background: '#ff5c5c' }} />
          alarm lotniczy
        </span>
        <span>
          <i style={{ background: '#3ddc84', opacity: 0.6 }} />
          zachodnie obwody (obserwowane)
        </span>
        <span>
          <i style={{ background: '#1c2733', border: '1px solid #3a4a5c' }} />
          pozostałe
        </span>
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* 2. Zakłócenia GPS – komórki H3                                      */
/* ------------------------------------------------------------------ */
function jamColor(ratio: number): string | null {
  if (ratio >= 0.1) return '#ff5c5c'
  if (ratio >= 0.02) return '#f5b942'
  return null
}

export function GpsJamMap({ data }: { data: GpsJam }) {
  const cells = useMemo(
    () =>
      data.cells
        .map((c) => ({ ...c, ratio: c.b / (c.g + c.b) }))
        .filter((c) => c.ratio >= 0.02)
        .sort((a, b) => a.ratio - b.ratio),
    [data.cells],
  )
  return (
    <>
      <Base center={[54.2, 20.5]} zoom={5}>
        {cells.map((c) => {
          const color = jamColor(c.ratio)!
          return (
            <Polygon key={c.h} positions={c.p} pathOptions={{ color, weight: 0.5, fillColor: color, fillOpacity: 0.28 + Math.min(0.4, c.ratio * 0.6) }}>
              <Tooltip sticky className="dark">
                {`${(c.ratio * 100).toFixed(0)}% samolotów ze złą nawigacją (${c.b} z ${c.g + c.b})`}
              </Tooltip>
            </Polygon>
          )
        })}
      </Base>
      <div className="legend">
        <span>
          <i style={{ background: '#ff5c5c' }} />≥ 10% samolotów z zakłóconą nawigacją
        </span>
        <span>
          <i style={{ background: '#f5b942' }} />
          2–10%
        </span>
        <span>komórki poniżej 2% nie są rysowane · dane za {fmtDate(data.date)}</span>
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* 3. Lotnictwo wojskowe – pozycje                                     */
/* ------------------------------------------------------------------ */
const CAT_COLOR: Record<AircraftCategory, string> = {
  awacs: '#ff5c5c',
  isr: '#ff8c42',
  tanker: '#f5b942',
  fighter: '#4cc9f0',
  transport: '#3ddc84',
  drone: '#b388ff',
  helicopter: '#8b9bb0',
  other: '#e6edf3',
}
const CAT_LABEL: Record<AircraftCategory, string> = {
  awacs: 'AWACS',
  isr: 'rozpoznanie',
  tanker: 'tankowiec',
  fighter: 'myśliwiec',
  transport: 'transport',
  drone: 'dron',
  helicopter: 'śmigłowiec',
  other: 'inne',
}

function planeIcon(color: string, track: number | null): L.DivIcon {
  const rot = track ?? 0
  const html = `<svg class="plane" width="26" height="26" viewBox="0 0 24 24" style="transform:rotate(${rot}deg)"><path fill="${color}" d="M21 16v-2l-8-5V3.5A1.5 1.5 0 0 0 11.5 2 1.5 1.5 0 0 0 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/></svg>`
  return L.divIcon({ html, className: '', iconSize: [26, 26], iconAnchor: [13, 13], popupAnchor: [0, -10] })
}

export function AircraftMap({ data }: { data: AirTraffic }) {
  const icons = useMemo(() => new Map(data.aircraft.map((a) => [a.hex, planeIcon(CAT_COLOR[a.category], a.track)])), [data.aircraft])
  return (
    <>
      <Base center={[52.3, 19.5]} zoom={6} tall>
        <Polygon
          positions={[
            [49.0, 14.1],
            [49.0, 24.2],
            [54.9, 24.2],
            [54.9, 14.1],
          ]}
          pathOptions={{ color: '#4cc9f0', weight: 1, dashArray: '4 4', fill: false, opacity: 0.5 }}
        />
        {data.aircraft.map((a) => (
          <Marker key={a.hex} position={[a.lat, a.lon]} icon={icons.get(a.hex)}>
            <Popup>
              <b>{a.callsign || a.registration || a.hex}</b> · {CAT_LABEL[a.category]}
              <br />
              typ: {a.type || '?'} {a.registration && `· rej. ${a.registration}`}
              <br />
              {a.altitudeFt !== null && `${fmt(a.altitudeFt, 0)} ft`}
              {a.groundSpeedKt !== null && ` · ${fmt(a.groundSpeedKt, 0)} kt`}
              {a.track !== null && ` · kurs ${a.track.toFixed(0)}°`}
              <br />
              <a href={`https://globe.adsb.lol/?icao=${a.hex}`} target="_blank" rel="noreferrer">
                śledź na adsb.lol
              </a>
            </Popup>
          </Marker>
        ))}
      </Base>
      <div className="legend">
        {(Object.keys(CAT_LABEL) as AircraftCategory[]).map((c) => (
          <span key={c}>
            <i style={{ background: CAT_COLOR[c], borderRadius: '50%' }} />
            {CAT_LABEL[c]}
          </span>
        ))}
        <span>
          <i style={{ border: '1px dashed #4cc9f0', background: 'transparent' }} />
          przybliżony obszar Polski
        </span>
      </div>
    </>
  )
}
