interface Props {
  label: string
  value: string
  sub?: string
  /** 0..100 fill of the bar, optional */
  bar?: number
  barColor?: string
  href?: string
}

export function Tile({ label, value, sub, bar, barColor, href }: Props) {
  return (
    <div className="card tile">
      <span className="tile__label">
        {href ? (
          <a href={href} target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>
            {label} ↗
          </a>
        ) : (
          label
        )}
      </span>
      <span className="tile__value">{value}</span>
      {sub && <span className="tile__sub">{sub}</span>}
      {bar !== undefined && (
        <span className="tile__bar">
          <i style={{ width: `${Math.max(0, Math.min(100, bar))}%`, background: barColor }} />
        </span>
      )}
    </div>
  )
}
