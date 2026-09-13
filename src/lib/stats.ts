import type { SeriesPoint } from '../types'

export function last(points: SeriesPoint[]): SeriesPoint | undefined {
  return points[points.length - 1]
}

/** Percent change between the last point and the point closest to `days` calendar days earlier. */
export function changeOverDays(points: SeriesPoint[], days: number): number | undefined {
  const end = last(points)
  if (!end) return undefined
  const target = new Date(end.date)
  target.setDate(target.getDate() - days)
  const iso = target.toISOString().slice(0, 10)
  let ref: SeriesPoint | undefined
  for (const p of points) {
    if (p.date <= iso) ref = p
    else break
  }
  if (!ref || ref.value === 0) return undefined
  // Punkt odniesienia musi być blisko szukanej daty; w przeciwnym razie (np. luka między
  // historią miesięczną a własnymi zrzutami) zmiana byłaby myląca.
  const gapDays = (new Date(iso).getTime() - new Date(ref.date).getTime()) / 86_400_000
  if (gapDays > Math.max(4, days * 0.5)) return undefined
  return ((end.value - ref.value) / ref.value) * 100
}

export function sliceDays(points: SeriesPoint[], days: number): SeriesPoint[] {
  const end = last(points)
  if (!end) return []
  const from = new Date(end.date)
  from.setDate(from.getDate() - days)
  const iso = from.toISOString().slice(0, 10)
  return points.filter((p) => p.date >= iso)
}

export function fmt(value: number, digits = 2): string {
  return value.toLocaleString('pl-PL', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

export function fmtPct(value: number, digits = 1): string {
  const sign = value > 0 ? '+' : ''
  return `${sign}${fmt(value, digits)}%`
}

/** ISO (YYYY-MM-DD lub pełny timestamp) -> "13.09". Zostawia niepoprawny tekst bez zmian. */
export function fmtDayMonth(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(iso) ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}` : iso
}

/** ISO (YYYY-MM-DD lub pełny timestamp) -> "13.09.2026", gdy rok ma znaczenie. */
export function fmtDate(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(iso) ? `${fmtDayMonth(iso)}.${iso.slice(0, 4)}` : iso
}
