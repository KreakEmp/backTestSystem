import { useMemo } from 'react'

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

function cellColor(pnl, maxAbs) {
  if (pnl === null || pnl === undefined || maxAbs === 0) return null
  const ratio = Math.min(Math.abs(pnl) / maxAbs, 1)
  // Lightness: 14% (small) → 36% (large) — stays readable on dark background
  const l = 14 + ratio * 22
  return pnl >= 0 ? `hsl(142, 60%, ${l}%)` : `hsl(0, 60%, ${l}%)`
}

function fmt(v) {
  if (v === undefined || v === null) return ''
  return (v >= 0 ? '+' : '') +
    Math.round(v).toLocaleString('en-IN')
}

export default function PnlHeatmap({ trades }) {
  const { grid, years, maxAbs } = useMemo(() => {
    const grid = {}
    for (const t of trades) {
      if (!t.exitDate || t.pnl === undefined) continue
      const year  = parseInt(t.exitDate.slice(0, 4))
      const month = parseInt(t.exitDate.slice(5, 7))   // 1-12
      if (!grid[year]) grid[year] = {}
      grid[year][month] = (grid[year][month] ?? 0) + t.pnl
    }

    const years = Object.keys(grid).map(Number).sort()
    let maxAbs = 0
    for (const y of years) {
      for (let m = 1; m <= 12; m++) {
        if (grid[y][m] !== undefined) maxAbs = Math.max(maxAbs, Math.abs(grid[y][m]))
      }
    }
    return { grid, years, maxAbs }
  }, [trades])

  if (!years.length) return null

  return (
    <div className="pnl-heatmap-wrap">
      <h3 className="pnl-heatmap-title">Monthly P&amp;L Heatmap</h3>
      <div className="pnl-heatmap-scroll">
        <table className="pnl-heatmap">
          <thead>
            <tr>
              <th className="pnl-hm-year-col">Year</th>
              {MONTHS.map(m => <th key={m}>{m}</th>)}
              <th className="pnl-hm-total-col">Year Total</th>
            </tr>
          </thead>
          <tbody>
            {years.map(year => {
              const yearTotal = Object.values(grid[year]).reduce((a, b) => a + b, 0)
              return (
                <tr key={year}>
                  <td className="pnl-hm-year-cell">{year}</td>
                  {Array.from({ length: 12 }, (_, i) => i + 1).map(m => {
                    const val = grid[year][m]
                    const bg  = val !== undefined ? cellColor(val, maxAbs) : null
                    return (
                      <td
                        key={m}
                        className={`pnl-hm-cell${val === undefined ? ' pnl-hm-empty' : ''}`}
                        style={bg ? { background: bg } : undefined}
                      >
                        {val !== undefined ? fmt(val) : ''}
                      </td>
                    )
                  })}
                  <td
                    className="pnl-hm-cell pnl-hm-total-cell"
                    style={{ background: cellColor(yearTotal, maxAbs) ?? undefined }}
                  >
                    {fmt(yearTotal)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
