import { useMemo, useState } from 'react'
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { Series } from '../types'
import { changeOverDays, fmt, fmtPct, last, sliceDays } from '../lib/stats'

interface Props {
  series: Series
  /** Does a rising value mean "worse" (e.g. bond yield, USD/PLN)? */
  upIsBad: boolean
  digits?: number
  color?: string
}

const RANGES: { label: string; days: number }[] = [
  { label: '1M', days: 31 },
  { label: '3M', days: 92 },
  { label: '1R', days: 366 },
  { label: 'MAX', days: 36500 },
]

export function ChartCard({ series, upIsBad, digits = 2, color = '#4cc9f0' }: Props) {
  const [range, setRange] = useState(RANGES[2])
  const points = useMemo(() => sliceDays(series.points, range.days), [series.points, range.days])
  const latest = last(series.points)
  const d7 = changeOverDays(series.points, 7)
  const d30 = changeOverDays(series.points, 30)

  const deltaClass = (v: number | undefined) => {
    if (v === undefined || Math.abs(v) < 0.05) return 'delta delta--flat'
    const worse = upIsBad ? v > 0 : v < 0
    return `delta ${worse ? 'delta--up' : 'delta--down'}`
  }

  const gradientId = `grad-${series.id}`

  return (
    <div className="card">
      <div className="card__head">
        <h3 className="card__title">{series.label}</h3>
        <span className="card__value">
          {latest ? fmt(latest.value, digits) : '—'}{' '}
          <small style={{ fontSize: 12, color: 'var(--muted)' }}>{series.unit}</small>
        </span>
      </div>
      <div className="card__meta">
        <span>
          7 dni: <span className={deltaClass(d7)}>{d7 === undefined ? '—' : fmtPct(d7)}</span>
        </span>
        <span>
          30 dni: <span className={deltaClass(d30)}>{d30 === undefined ? '—' : fmtPct(d30)}</span>
        </span>
        <span className="range">
          {RANGES.map((r) => (
            <button key={r.label} className={r.label === range.label ? 'active' : ''} onClick={() => setRange(r)}>
              {r.label}
            </button>
          ))}
        </span>
      </div>
      <div style={{ width: '100%', height: 300 }}>
        <ResponsiveContainer>
          <AreaChart data={points} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.35} />
                <stop offset="100%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="date"
              tick={{ fill: 'var(--muted)', fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              minTickGap={40}
              tickFormatter={(d: string) => d.slice(5)}
            />
            <YAxis
              domain={['auto', 'auto']}
              width={54}
              tick={{ fill: 'var(--muted)', fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) => fmt(v, digits > 2 ? 2 : digits)}
            />
            <Tooltip
              contentStyle={{ background: 'var(--bg-elev2)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}
              labelStyle={{ color: 'var(--muted)' }}
              formatter={(v) => [fmt(Number(v), digits) + ' ' + series.unit, series.label]}
            />
            <Area
              type="monotone"
              dataKey="value"
              stroke={color}
              strokeWidth={2}
              fill={`url(#${gradientId})`}
              dot={false}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div className="card__source">
        Źródło:{' '}
        <a href={series.sourceUrl} target="_blank" rel="noreferrer">
          {series.source}
        </a>
        {series.frequency === 'monthly' && ' · dane miesięczne'}
        {series.frequency === 'snapshot' && ' · własne dzienne zrzuty'}
        {' · '}aktualizacja {series.updatedAt.slice(0, 10)}
      </div>
    </div>
  )
}
