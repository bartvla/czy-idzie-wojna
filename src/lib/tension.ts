import type { Snapshot } from '../types'
import { changeOverDays, fmtPct } from './stats'

export interface Signal {
  label: string
  points: number
  detail: string
}

/**
 * Prosta, jawna heurystyka "indeksu napięcia" (0..100).
 * Każdy sygnał dodaje kilka punktów; progi są celowo konserwatywne.
 * To NIE jest prognoza, tylko streszczenie tego, jak nerwowe są obserwowane wskaźniki.
 * Funkcja jest czysta, używa jej frontend i skrypt pobierający (do historii).
 */
export function computeTension(snap: Pick<Snapshot, 'series' | 'odds' | 'advisories' | 'airRaid' | 'gpsJam' | 'airTraffic'>): {
  score: number
  signals: Signal[]
} {
  const signals: Signal[] = []
  const s = snap.series
  const add = (label: string, points: number, detail: string) => signals.push({ label, points, detail })

  const wig = s.wig20 && changeOverDays(s.wig20.points, 30)
  if (wig !== undefined) {
    const p = wig < -15 ? 20 : wig < -8 ? 12 : wig < -3 ? 5 : 0
    add('WIG20 (30 dni)', p, fmtPct(wig))
  }
  const usd = s.usdpln && changeOverDays(s.usdpln.points, 30)
  if (usd !== undefined) {
    const p = usd > 8 ? 15 : usd > 4 ? 8 : usd > 2 ? 3 : 0
    add('USD/PLN (30 dni)', p, fmtPct(usd))
  }
  const y10 = s.pl10y && changeOverDays(s.pl10y.points, 30)
  if (y10 !== undefined) {
    const p = y10 > 15 ? 15 : y10 > 8 ? 8 : y10 > 3 ? 3 : 0
    add('Rentowność 10Y (30 dni)', p, fmtPct(y10))
  }
  const vix = s.vix?.points.at(-1)?.value
  if (vix !== undefined) {
    const p = vix > 40 ? 15 : vix > 30 ? 10 : vix > 22 ? 4 : 0
    add('VIX (strach na rynkach)', p, vix.toFixed(1))
  }
  const brent = s.brent && changeOverDays(s.brent.points, 30)
  if (brent !== undefined) {
    const p = brent > 25 ? 10 : brent > 12 ? 5 : 0
    add('Ropa Brent (30 dni)', p, fmtPct(brent))
  }
  const strike = snap.odds.find((o) => /strike on poland/i.test(o.question))
  if (strike) {
    const p = strike.yes > 0.3 ? 25 : strike.yes > 0.15 ? 15 : strike.yes > 0.07 ? 7 : strike.yes > 0.03 ? 3 : 0
    add('Polymarket: rosyjski atak na Polskę', p, `${(strike.yes * 100).toFixed(0)}%`)
  }
  const nato = snap.odds.find((o) => /invade a nato|nato x russia|article 5/i.test(o.question))
  if (nato) {
    const p = nato.yes > 0.3 ? 15 : nato.yes > 0.15 ? 9 : nato.yes > 0.07 ? 4 : 0
    add('Polymarket: Rosja vs NATO', p, `${(nato.yes * 100).toFixed(0)}%`)
  }
  if (snap.airRaid) {
    const n = snap.airRaid.western.filter((r) => r.alert).length
    const p = n >= 5 ? 10 : n >= 3 ? 6 : n >= 1 ? 3 : 0
    add('Alarmy lotnicze w zach. Ukrainie', p, `${n} z ${snap.airRaid.western.length} obwodów`)
  }
  if (snap.gpsJam) {
    const pct = snap.gpsJam.poland.pct
    const p = pct >= 50 ? 12 : pct >= 30 ? 6 : pct >= 15 ? 2 : 0
    add('Zakłócenia GPS nad Polską', p, `${pct.toFixed(0)}% komórek`)
  }
  if (snap.airTraffic) {
    const c = snap.airTraffic.byCategory
    const heavy = c.awacs + c.isr + c.tanker
    const p = heavy >= 6 ? 10 : heavy >= 3 ? 5 : heavy >= 1 ? 2 : 0
    add('AWACS / rozpoznanie / tankowce w regionie', p, `${heavy} maszyn`)
  }
  const adv = snap.advisories.filter((a) => /level [34]|avoid all|do not travel|red|amber/i.test(a.level))
  add('Ostrzeżenia dla podróżnych do Polski', adv.length ? 25 : 0, adv.length ? `${adv.length} kraj(e) odradza(ją) podróże` : 'brak')

  const score = Math.min(100, signals.reduce((a, b) => a + b.points, 0))
  return { score, signals }
}

export function tensionLevel(score: number): { color: string; headline: string } {
  if (score >= 60) return { color: 'var(--alert)', headline: 'Wysokie napięcie' }
  if (score >= 30) return { color: 'var(--warn)', headline: 'Podwyższona nerwowość' }
  return { color: 'var(--ok)', headline: 'Raczej nie' }
}
