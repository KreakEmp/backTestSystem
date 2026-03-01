export default function MetricsCard({ metrics, initialCapital }) {
  const { totalReturn, sharpe, maxDrawdown, finalValue } = metrics
  const isPositive = parseFloat(totalReturn) >= 0

  return (
    <div className="metrics-card">
      <div className="metric">
        <span className="metric-label">Total Return</span>
        <span className={`metric-value ${isPositive ? 'positive' : 'negative'}`}>
          {isPositive ? '+' : ''}{totalReturn}%
        </span>
      </div>
      <div className="metric">
        <span className="metric-label">Final Value</span>
        <span className="metric-value">₹{parseFloat(finalValue).toLocaleString('en-IN')}</span>
      </div>
      <div className="metric">
        <span className="metric-label">Sharpe Ratio</span>
        <span className="metric-value">{sharpe}</span>
      </div>
      <div className="metric">
        <span className="metric-label">Max Drawdown</span>
        <span className="metric-value negative">-{maxDrawdown}%</span>
      </div>
    </div>
  )
}
