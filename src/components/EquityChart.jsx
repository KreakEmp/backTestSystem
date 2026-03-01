import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'

export default function EquityChart({ equityCurve }) {
  const formatted = equityCurve.map(d => ({
    ...d,
    date: d.date.slice(5), // show MM-DD
  }))

  // Show at most ~60 ticks on X axis
  const tickInterval = Math.max(1, Math.floor(formatted.length / 60))

  return (
    <div className="chart-container">
      <h3>Equity Curve</h3>
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={formatted} margin={{ top: 8, right: 24, left: 16, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
          <XAxis dataKey="date" interval={tickInterval} tick={{ fontSize: 11 }} />
          <YAxis
            tickFormatter={v => `₹${v.toLocaleString('en-IN')}`}
            tick={{ fontSize: 11 }}
            width={80}
          />
          <Tooltip formatter={v => [`₹${v.toLocaleString('en-IN')}`, 'Portfolio Value']} />
          <Line type="monotone" dataKey="value" stroke="#4ade80" dot={false} strokeWidth={2} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
