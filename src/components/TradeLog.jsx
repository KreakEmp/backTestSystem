// Parses an ISO candle date into { date, time } for display.
// Handles both "YYYY-MM-DDTHH:MM:SS+05:30" and plain "YYYY-MM-DD".
function parseDt(isoStr) {
  if (!isoStr) return { date: '—', time: '—' }
  const d = new Date(isoStr)
  if (isNaN(d)) return { date: String(isoStr).slice(0, 10), time: '—' }
  const hasTime = typeof isoStr === 'string' && isoStr.includes('T')
  return {
    date: d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
    time: hasTime
      ? d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })
      : '—',
  }
}

// Extracts the HH:MM portion from a sub-tick timestamp "YYYY-MM-DD HH:MM:SS" (already in IST).
function tickTime(tickStr) {
  if (!tickStr) return '—'
  const sp = String(tickStr).split(' ')
  return sp.length >= 2 ? sp[1].slice(0, 5) : '—'
}

function money(v) {
  return `₹${Math.abs(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function pnlCell(v) {
  if (v === null || v === undefined) return { text: '—', cls: '' }
  const sign = v >= 0 ? '+' : '−'
  return { text: `${sign}${money(v)}`, cls: v >= 0 ? 'positive' : 'negative' }
}

const EXIT_BADGE = {
  'Target':           { cls: 'badge-target',    label: 'Target' },
  'Stop Loss':        { cls: 'badge-stoploss', label: 'Stop Loss' },
  'Stop Loss (Gap)':  { cls: 'badge-stoploss', label: 'Stop Loss' },
  'Signal':           { cls: 'badge-sell',       label: 'Signal' },
  'Intraday Close':   { cls: 'badge-intraday',   label: 'Intraday Close' },
  'End of Data':      { cls: 'badge-end',        label: 'End of Data' },
}

export default function TradeLog({ trades }) {
  if (trades.length === 0) {
    return <p className="no-trades">No trades were generated. Try adjusting the strategy params or date range.</p>
  }

  return (
    <div className="trade-log">
      <h3>Trade Details ({trades.length} trades)</h3>
      <div className="table-wrapper">
        <table className="trade-details-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Type</th>
              <th>Qty</th>
              <th>Signal Px</th>
              <th>Entry Px</th>
              <th>Target</th>
              <th>Stop Loss</th>
              <th>Exit Px</th>
              <th>Exit Reason</th>
              <th>Signal Time</th>
              <th>Entry Time</th>
              <th>Exit Time</th>
              <th>P&amp;L</th>
              <th>Cum. P&amp;L</th>
              <th>Max DD</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((t, i) => {
              const entryDt = parseDt(t.entryDate)
              const exitDt  = parseDt(t.exitDate)
              const eb      = EXIT_BADGE[t.exitReason] ?? { cls: 'badge-end', label: t.exitReason }
              const tradePnl = pnlCell(t.pnl)
              const cumPnl   = pnlCell(t.cumulativePnl)

              // Signal time: raw candle open time (from signalDate ISO string)
              const signalTime = parseDt(t.signalDate).time

              // Entry / exit times: prefer sub-tick fields (set by simulateBacktest);
              // fall back to candle-level times (set by runBacktest)
              const entryTime = t.entryTickTime ? tickTime(t.entryTickTime) : entryDt.time
              const rawExitTime = t.exitTickTime ? tickTime(t.exitTickTime) : exitDt.time

              // Include exit date when trade spans multiple days
              const entryDay = String(t.entryDate).slice(0, 10)
              const exitDay  = String(t.exitDate).slice(0, 10)
              const exitLabel = exitDay !== entryDay
                ? `${exitDt.date} ${rawExitTime}`
                : rawExitTime

              return (
                <tr key={i}>
                  <td className="td-date">{entryDt.date}</td>
                  <td>
                    <span className={`badge ${t.entryType === 'SHORT' ? 'badge-short' : 'badge-long'}`}>{t.entryType}</span>
                  </td>
                  <td>{t.shares}</td>
                  <td>₹{t.signalPrice.toFixed(2)}</td>
                  <td>₹{t.entryPrice.toFixed(2)}</td>
                  <td className="td-muted">
                    {t.targetPrice != null ? `₹${t.targetPrice.toFixed(2)}` : '—'}
                  </td>
                  <td className="td-muted">
                    {t.stopLossPrice != null ? `₹${t.stopLossPrice.toFixed(2)}` : '—'}
                  </td>
                  <td>₹{t.exitPrice.toFixed(2)}</td>
                  <td>
                    <span className={`badge ${eb.cls}`}>{eb.label}</span>
                  </td>
                  <td className="td-time">{signalTime}</td>
                  <td className="td-time">{entryTime}</td>
                  <td className="td-time">{exitLabel}</td>
                  <td className={tradePnl.cls}>{tradePnl.text}</td>
                  <td className={cumPnl.cls}>{cumPnl.text}</td>
                  <td className="td-muted">{t.maxDrawdownTillDate}%</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
