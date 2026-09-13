import type { Snapshot } from '../types'
import { computeTension, tensionLevel } from '../lib/tension'
import { fmtDayMonth } from '../lib/stats'

function KeyNumber({ label, value, sub, color, href }: { label: string; value: string; sub?: string; color?: string; href?: string }) {
  return (
    <div className="key">
      <span className="key__label">{label}</span>
      <span className="key__value" style={{ color }}>
        {value}
      </span>
      {sub &&
        (href ? (
          <a className="key__sub" href={href} target="_blank" rel="noreferrer">
            {sub}
          </a>
        ) : (
          <span className="key__sub">{sub}</span>
        ))}
    </div>
  )
}

export function Verdict({ snap }: { snap: Snapshot }) {
  const { score, signals } = computeTension(snap)
  const { color, headline } = tensionLevel(score)
  const active = signals.filter((s) => s.points > 0).sort((a, b) => b.points - a.points)
  const style = { '--gauge': score, '--gauge-color': color } as React.CSSProperties

  // Trend: punkt sprzed ~7 dni z historii indeksu (jeśli już jest).
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10)
  const ref = [...(snap.tensionHistory ?? [])].reverse().find((p) => p.date <= weekAgo)
  const trend = ref ? score - ref.value : undefined

  const lastRcb = snap.news.find((n) => n.source === 'RCB' && /alert rcb/i.test(n.title))
  const westernAlerts = snap.airRaid ? snap.airRaid.western.filter((r) => r.alert).length : undefined
  const overPl = snap.airTraffic ? snap.airTraffic.aircraft.filter((a) => a.overPoland).length : undefined
  const heavy = snap.airTraffic ? snap.airTraffic.byCategory.awacs + snap.airTraffic.byCategory.isr + snap.airTraffic.byCategory.tanker : 0

  return (
    <section className="verdict" style={style}>
      <div className="verdict__main">
        <div className="gauge">
          <strong style={{ color }}>{score}</strong>
          <small>/ 100</small>
        </div>
        <div>
          <h2>
            {headline}
            {trend !== undefined && (
              <span className="trend" style={{ color: trend > 0 ? 'var(--alert)' : trend < 0 ? 'var(--ok)' : 'var(--muted)' }}>
                {trend > 0 ? '▲' : trend < 0 ? '▼' : '■'} {Math.abs(trend)} pkt vs 7 dni temu
              </span>
            )}
          </h2>
          <p>
            Indeks napięcia to jawna suma punktów z rynków, zakładów, przestrzeni powietrznej i komunikatów instytucji. Nie jest prognozą,
            tylko streszczeniem tego, jak nerwowe są obserwowane wskaźniki.
          </p>
          <ul>
            {active.length === 0 && <li>Żaden z obserwowanych wskaźników nie przekracza progów alarmowych.</li>}
            {active.slice(0, 5).map((s) => (
              <li key={s.label}>
                <b>+{s.points}</b> {s.label}: {s.detail}
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="keys">
        <KeyNumber
          label="Ostatni Alert RCB"
          value={lastRcb ? fmtDayMonth(lastRcb.publishedAt) : 'brak'}
          sub={lastRcb ? lastRcb.title.replace(/^Alert RCB\s*-?\s*/i, '') : 'w ostatnich komunikatach'}
          color={lastRcb && /atak|zagrożenie|rakiet|dron/i.test(lastRcb.title) ? 'var(--alert)' : undefined}
          href={lastRcb?.url}
        />
        <KeyNumber
          label="Alarmy: zach. Ukraina"
          value={westernAlerts === undefined ? '—' : `${westernAlerts} / ${snap.airRaid!.western.length}`}
          sub="obwodów w alarmie"
          color={westernAlerts ? 'var(--alert)' : 'var(--ok)'}
        />
        <KeyNumber
          label="Wojskowe nad Polską"
          value={overPl === undefined ? '—' : String(overPl)}
          sub={heavy ? `${heavy} AWACS / ISR / tankowce w regionie` : 'maszyn nadających ADS-B'}
          color={heavy ? 'var(--warn)' : undefined}
        />
        <KeyNumber
          label="GPS nad Polską"
          value={snap.gpsJam ? `${snap.gpsJam.poland.pct.toFixed(0)}%` : '—'}
          sub="komórek z zakłóceniami"
          color={snap.gpsJam && snap.gpsJam.poland.pct >= 40 ? 'var(--alert)' : snap.gpsJam && snap.gpsJam.poland.pct >= 15 ? 'var(--warn)' : 'var(--ok)'}
        />
      </div>
    </section>
  )
}
