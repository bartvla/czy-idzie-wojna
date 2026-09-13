import { useEffect, useState } from 'react'
import type { Snapshot } from './types'
import { ChartCard } from './components/ChartCard'
import { Tile } from './components/Tile'
import { Verdict } from './components/Verdict'
import { AirRaidCard, AirTrafficCard, GpsJamCard } from './components/Airspace'
import { fmt, fmtPct, changeOverDays } from './lib/stats'

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
  const { snap, error } = useSnapshot()

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
  const spread = s.pl10y && s.de10y ? (s.pl10y.points.at(-1)?.value ?? 0) - (s.de10y.points.at(-1)?.value ?? 0) : undefined

  return (
    <main className="container">
      <header className="header">
        <div className="brand">
          <h1>
            czy idzie <span>wojna</span>.pl
          </h1>
          <p>Twarde wskaźniki zamiast nagłówków: przestrzeń powietrzna, komunikaty instytucji, zakłady, rynki.</p>
        </div>
        <div className="updated">dane z {new Date(snap.generatedAt).toLocaleString('pl-PL')}</div>
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
        <AirTrafficCard data={snap.airTraffic} />
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
                    {n.publishedAt.slice(5).replace('-', '.')}
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
                  {a.updatedAt.slice(0, 10)}
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

      {/* 6. Tło globalne */}
      <h2 className="section-title">Tło globalne</h2>
      <div className="grid grid--tiles">
        {s.vix && (
          <Tile
            label="VIX (indeks strachu)"
            value={fmt(s.vix.points.at(-1)!.value, 1)}
            sub={`30 dni: ${fmtPct(changeOverDays(s.vix.points, 30) ?? 0)}`}
            bar={(s.vix.points.at(-1)!.value / 50) * 100}
            barColor={s.vix.points.at(-1)!.value > 25 ? 'var(--alert)' : 'var(--ok)'}
          />
        )}
        {s.brent && (
          <Tile label="Ropa Brent (USD)" value={fmt(s.brent.points.at(-1)!.value, 1)} sub={`30 dni: ${fmtPct(changeOverDays(s.brent.points, 30) ?? 0)}`} />
        )}
        {s.gold && <Tile label="Złoto (USD/oz)" value={fmt(s.gold.points.at(-1)!.value, 0)} sub={`30 dni: ${fmtPct(changeOverDays(s.gold.points, 30) ?? 0)}`} />}
        {spread !== undefined && <Tile label="Spread PL 10Y − Bund 10Y" value={`${fmt(spread, 2)} pp`} sub="premia za ryzyko Polski vs Niemcy" />}
      </div>

      {/* 7. Rynki predykcyjne */}
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
