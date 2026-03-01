import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'

export default function EquityChart({ equityCurve }) {
  const tickInterval = Math.max(1, Math.floor(equityCurve.length / 8))

  // Pick tick indices
  const tickIndices = []
  for (let i = 0; i < equityCurve.length; i += tickInterval) tickIndices.push(i)

  // For each tick, label based on what changed vs the previous tick:
  //   year changed (or first tick) → "YYYY"
  //   month changed               → "MMM"
  //   same month                  → "D"
  const tickLabels = {}
  tickIndices.forEach((idx, i) => {
    const cur  = new Date(equityCurve[idx].date)
    const prev = i > 0 ? new Date(equityCurve[tickIndices[i - 1]].date) : null

    let label
    if (!prev || cur.getFullYear() !== prev.getFullYear()) {
      label = String(cur.getFullYear())
    } else if (cur.getMonth() !== prev.getMonth()) {
      label = cur.toLocaleDateString('en-US', { month: 'short' })
    } else {
      label = String(cur.getDate())
    }
    tickLabels[equityCurve[idx].date] = label
  })

  const ticks = tickIndices.map(i => equityCurve[i].date)

  return (
    <div className="chart-container">
      <h3>Equity Curve</h3>
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={equityCurve} margin={{ top: 8, right: 24, left: 16, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
          <XAxis
            dataKey="date"
            ticks={ticks}
            tickFormatter={date => tickLabels[date] ?? ''}
            tick={{ fontSize: 11 }}
          />
          <YAxis
            tickFormatter={v => `₹${v.toLocaleString('en-IN')}`}
            tick={{ fontSize: 11 }}
            width={80}
          />
          <Tooltip
            formatter={v => [`₹${v.toLocaleString('en-IN')}`, 'Portfolio Value']}
            labelFormatter={date => new Date(date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
          />
          <Line type="monotone" dataKey="value" stroke="#4ade80" dot={false} strokeWidth={2} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
