const REASON_BADGE = {
  'Target':      { cls: 'badge-target',   label: 'Target' },
  'Stop Loss':   { cls: 'badge-stoploss', label: 'Stop Loss' },
  'Signal':      { cls: 'badge-sell',     label: 'Signal' },
  'End of Data': { cls: 'badge-end',      label: 'End of Data' },
}

export default function TradeLog({ trades }) {
  if (trades.length === 0) {
    return <p className="no-trades">No trades were generated. Try adjusting the strategy params or date range.</p>
  }

  return (
    <div className="trade-log">
      <h3>Trade Log ({trades.length} trades)</h3>
      <div className="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Action</th>
              <th>Exit Reason</th>
              <th>Price</th>
              <th>Shares</th>
              <th>Portfolio Value</th>
              <th>P&amp;L</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((t, i) => {
              const isBuy = t.action === 'BUY'
              const rb    = t.reason ? REASON_BADGE[t.reason] : null
              return (
                <tr key={i}>
                  <td>{t.date}</td>
                  <td>
                    <span className={`badge ${isBuy ? 'badge-buy' : 'badge-sell'}`}>
                      {t.action}
                    </span>
                  </td>
                  <td>
                    {rb ? <span className={`badge ${rb.cls}`}>{rb.label}</span> : '—'}
                  </td>
                  <td>₹{t.price.toFixed(2)}</td>
                  <td>{t.shares}</td>
                  <td>₹{t.portfolioValue.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
                  <td className={t.pnl === null ? '' : t.pnl >= 0 ? 'positive' : 'negative'}>
                    {t.pnl === null ? '—' : `${t.pnl >= 0 ? '+' : ''}₹${t.pnl.toFixed(2)}`}
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
