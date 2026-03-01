function money(v) {
  return parseFloat(v).toLocaleString('en-IN', { maximumFractionDigits: 0 })
}

export default function MetricsCard({ metrics }) {
  const {
    totalReturn, totalPnl,
    maxDrawdown, maxDrawdownAbs,
    accuracy, winCount, lossCount,
    rewardRiskRatio,
    avgProfit, avgLoss,
    expectancy,
  } = metrics

  const pnlPos = parseFloat(totalPnl) >= 0
  const expPos = parseFloat(expectancy) >= 0

  return (
    <div className="metrics-card">

      {/* Total P&L */}
      <div className="metric">
        <span className="metric-label">Total P&amp;L</span>
        <span className={`metric-value ${pnlPos ? 'positive' : 'negative'}`}>
          {pnlPos ? '+' : ''}₹{money(totalPnl)}
        </span>
        <span className={`metric-sub ${pnlPos ? 'positive' : 'negative'}`}>
          {pnlPos ? '+' : ''}{totalReturn}%
        </span>
      </div>

      {/* Accuracy */}
      <div className="metric">
        <span className="metric-label">Accuracy</span>
        <span className="metric-value">{accuracy}%</span>
        <span className="metric-sub">
          <span className="positive">{winCount}W</span>
          <span className="metric-sub-sep"> / </span>
          <span className="negative">{lossCount}L</span>
          <span className="metric-sub-sep"> / {winCount + lossCount} total</span>
        </span>
      </div>

      {/* Reward : Risk */}
      <div className="metric">
        <span className="metric-label">Reward : Risk</span>
        <span className="metric-value">
          {rewardRiskRatio !== null ? `${rewardRiskRatio} : 1` : '—'}
        </span>
        <span className="metric-sub">
          <span className="positive">+₹{money(avgProfit)}</span>
          <span className="metric-sub-sep"> : </span>
          <span className="negative">₹{money(avgLoss)}</span>
        </span>
      </div>

      {/* Expectancy */}
      <div className="metric">
        <span className="metric-label">Expectancy</span>
        <span className={`metric-value ${expPos ? 'positive' : 'negative'}`}>
          {expPos ? '+' : ''}{parseFloat(expectancy).toFixed(2)}R
        </span>
        <span className="metric-sub">per unit of risk</span>
      </div>

      {/* Max Drawdown */}
      <div className="metric">
        <span className="metric-label">Max Drawdown</span>
        <span className="metric-value negative">-₹{money(maxDrawdownAbs)}</span>
        <span className="metric-sub negative">-{maxDrawdown}%</span>
      </div>

    </div>
  )
}
