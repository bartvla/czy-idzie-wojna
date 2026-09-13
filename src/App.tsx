import { useEffect, useState } from 'react'
import type { Snapshot } from './types'
import { ChartCard } from './components/ChartCard'
import { Tile } from './components/Tile'
import { Verdict } from './components/Verdict'
import { AirRaidCard, AirTrafficCard, GpsJamCard, useLiveAirTraffic } from './components/Airspace'
import { fmt, fmtDate, fmtDayMonth } from './lib/stats'

function useSnapshot() {
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}data/snapshot.json`, { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setSnap)
      .catch((e: Error) => setError(e.message))
  }, [])
  return { snap, error }
}

const levelClass = (level: string) =>
  /level [34]|avoid|do not|red|amber/i.test(level) ? 'badge badge--alert' : /level 2|yellow/i.test(level) ? 'badge badge--warn' : 'badge badge--ok'

export default function App() {
  const { snap: loaded, error } = useSnapshot()
  const { live, error: liveError } = useLiveAirTraffic()
  // Dane na żywo z Workera zastępują lotnictwo ze snapshotu wszędzie: w werdykcie, kafelkach i na mapie.
  const snap = loaded && live ? { ...loaded, airTraffic: live } : loaded

  if (error) {
    return (
      <main className="container">
        <p className="errors">
          Nie udało się wczytać danych ({error}). Uruchom <code>npm run fetch</code>, żeby wygenerować <code>public/data/snapshot.json</code>.
        </p>
      </main>
    )
  }
  if (!snap) return <main className="container">Ładowanie…</main>

  const s = snap.series
  const invade = snap.odds.find((o) => /invade a nato/i.test(o.question))
  const clash = snap.odds.find((o) => /nato x russia/i.test(o.question))
  const art5 = snap.odds.find((o) => /article 5/i.test(o.question))
  const another = snap.odds.find((o) => /invade another country/i.test(o.question))

  return (
    <main className="container">
      <header className="header">
        <div className="brand">
          <h1>
            czy idzie <span>wojna</span>.pl
          </h1>
          <p>Twarde wskaźniki zamiast nagłówków: przestrzeń powietrzna, komunikaty instytucji, zakłady, rynki.</p>
        </div>
        <div className="updated" title="Lotnictwo odświeżane co kilka minut; pozostałe dane z ostatniego pobrania">
          ostatnie pobranie danych: {new Date(snap.generatedAt).toLocaleString('pl-PL', { dateStyle: 'short', timeStyle: 'short' })}
        </div>
      </header>

      {/* 1. Werdykt + kluczowe liczby */}
      <Verdict snap={snap} />

      {/* 3. Mapy */}
      <h2 className="section-title">Przestrzeń powietrzna</h2>
      <div className="grid">
        <AirRaidCard data={snap.airRaid} />
        <GpsJamCard data={snap.gpsJam} />
      </div>
      <div className="grid" style={{ gridTemplateColumns: '1fr' }}>
        <AirTrafficCard data={loaded?.airTraffic} live={live} liveError={liveError} />
      </div>

      {/* 4. Decyzje instytucji */}
      <h2 className="section-title">Instytucje i dyplomacja</h2>
      <div className="grid">
        <div className="card">
          <div className="card__head">
            <h3 className="card__title">Komunikaty MON / RCB / MSZ</h3>
          </div>
          {snap.news.length > 0 ? (
            <ul className="list list--compact list--scroll">
              {snap.news.map((n) => (
                <li key={n.url}>
                  <span className="when">
                    <span className={/alert rcb|zagrożenie|atak/i.test(n.title) ? 'badge badge--alert' : 'badge badge--muted'}>{n.source}</span>{' '}
                    {fmtDayMonth(n.publishedAt)}
                  </span>
                  <a href={n.url} target="_blank" rel="noreferrer">
                    {n.title}
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <div className="placeholder">
              Brak komunikatów w ostatnim pobraniu. Komunikaty DORSZ (wojsko-polskie.pl) nie są jeszcze pobierane, bo serwis blokuje boty
              (Imperva); docelowo monitoring konta @DowOperSZ.
            </div>
          )}
        </div>

        <div className="card">
          <div className="card__head">
            <h3 className="card__title">Ostrzeżenia dla podróżnych do Polski</h3>
          </div>
          <ul className="list list--compact">
            {snap.advisories.map((a) => (
              <li key={a.country} className="advisory">
                <b>{a.country}</b>
                <span className={levelClass(a.level)}>{a.level}</span>
                <a className="when" href={a.url} target="_blank" rel="noreferrer" title={a.summary}>
                  {fmtDate(a.updatedAt)}
                </a>
              </li>
            ))}
            {snap.advisories.length === 0 && <li>Brak danych.</li>}
          </ul>
          <div className="card__source">Podniesienie poziomu (USA „Level 3/4”, UK „avoid all travel”) historycznie wyprzedzało ewakuacje ambasad.</div>
        </div>
      </div>

      {/* 5. Rynki finansowe */}
      <h2 className="section-title">Rynki finansowe</h2>
      <div className="grid grid--charts">
        {s.wig20 && <ChartCard series={s.wig20} upIsBad={false} digits={0} color="#4cc9f0" />}
        {s.pl10y && <ChartCard series={s.pl10y} upIsBad digits={2} color="#f5b942" />}
        {s.usdpln && <ChartCard series={s.usdpln} upIsBad digits={4} color="#3ddc84" />}
        {s.eurpln && <ChartCard series={s.eurpln} upIsBad digits={4} color="#b388ff" />}
      </div>

      {/* 6. Rynki predykcyjne */}
      <h2 className="section-title">Rynki predykcyjne (Polymarket)</h2>
      <div className="grid grid--tiles">
        {[invade, clash, art5, another]
          .filter((o) => o !== undefined)
          .map((o) => (
            <Tile
              key={o.slug}
              label={o.question}
              value={`${(o.yes * 100).toFixed(1)}%`}
              sub={`wolumen $${fmt(o.volume, 0)}`}
              bar={o.yes * 100}
              barColor={o.yes >= 0.15 ? 'var(--alert)' : 'var(--warn)'}
              href={o.url}
            />
          ))}
        {snap.odds.length === 0 && <div className="placeholder">Brak danych z Polymarket.</div>}
      </div>

      <footer className="footer">
        <p>
          Dane są pobierane automatycznie i mogą zawierać błędy. Strona nie jest źródłem oficjalnych komunikatów; w sytuacji zagrożenia kieruj
          się komunikatami RCB (Alert RCB), MON i Dowództwa Operacyjnego RSZ.
        </p>
        {snap.errors.length > 0 && <p className="errors">Ostatnie pobranie: {snap.errors.length} źródło/a niedostępne ({snap.errors.join('; ')}).</p>}
      </footer>
    </main>
  )
}
