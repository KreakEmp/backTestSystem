/**
 * Generic backtesting simulation engine.
 *
 * Decoupled from any specific strategy — it only knows about candle data,
 * a pre-computed signal array, and portfolio mechanics.
 *
 * Usage:
 *   const signals   = strategy.generateSignals(data, params)
 *   const result    = runBacktest(data, signals, initialCapital, riskConfig)
 *
 * riskConfig: { stopLoss: number, target: number }
 *   stopLoss — % below entry price to exit (e.g. 2 = 2%). 0 = disabled.
 *   target   — % above entry price to exit (e.g. 4 = 4%). 0 = disabled.
 *   When both are 0, the position is held until the strategy emits a SELL signal.
 *
 * SL/Target are evaluated against the candle's LOW (for SL) and HIGH (for target)
 * so they reflect intra-candle price movement. If both are breached in the same
 * candle, SL is assumed to have hit first (conservative).
 */

export function runBacktest(data, signals, initialCapital, riskConfig = { stopLoss: 0, target: 0 }) {
  const { stopLoss, target } = riskConfig
  const trades = []
  const equityCurve = []

  let cash = initialCapital
  let shares = 0
  let inPosition = false
  let entryPrice = 0

  for (let i = 0; i < data.length; i++) {
    const { date, open, high, low, close } = data[i]
    const signal = signals[i]

    if (inPosition) {
      const slPrice     = stopLoss > 0 ? entryPrice * (1 - stopLoss / 100) : null
      const targetPrice = target   > 0 ? entryPrice * (1 + target   / 100) : null

      // Check SL first (conservative — assume worst case within a candle)
      if (slPrice !== null && low <= slPrice) {
        const exitPrice = Math.min(open, slPrice) // gap-down protection
        const proceeds  = shares * exitPrice
        const pnl       = proceeds - shares * entryPrice
        cash += proceeds
        trades.push({ date, action: 'SELL', reason: 'Stop Loss', price: exitPrice, shares, portfolioValue: cash, pnl })
        shares = 0
        inPosition = false
        equityCurve.push({ date, value: parseFloat(cash.toFixed(2)) })
        continue
      }

      // Check target
      if (targetPrice !== null && high >= targetPrice) {
        const exitPrice = Math.max(open, targetPrice) // gap-up benefit
        const proceeds  = shares * exitPrice
        const pnl       = proceeds - shares * entryPrice
        cash += proceeds
        trades.push({ date, action: 'SELL', reason: 'Target', price: exitPrice, shares, portfolioValue: cash, pnl })
        shares = 0
        inPosition = false
        equityCurve.push({ date, value: parseFloat(cash.toFixed(2)) })
        continue
      }

      // Check strategy SELL signal
      if (signal === 'SELL') {
        const proceeds = shares * close
        const pnl      = proceeds - shares * entryPrice
        cash += proceeds
        trades.push({ date, action: 'SELL', reason: 'Signal', price: close, shares, portfolioValue: cash, pnl })
        shares = 0
        inPosition = false
      }
    } else if (signal === 'BUY') {
      shares = Math.floor(cash / close)
      if (shares > 0) {
        entryPrice = close
        cash -= shares * close
        inPosition = true
        trades.push({ date, action: 'BUY', reason: null, price: close, shares, portfolioValue: cash + shares * close, pnl: null })
      }
    }

    equityCurve.push({ date, value: parseFloat((cash + shares * close).toFixed(2)) })
  }

  // Close any open position at end of data
  if (inPosition && shares > 0) {
    const finalPrice = data[data.length - 1].close
    const proceeds   = shares * finalPrice
    const pnl        = proceeds - shares * entryPrice
    cash += proceeds
    trades.push({
      date: data[data.length - 1].date,
      action: 'SELL',
      reason: 'End of Data',
      price: finalPrice,
      shares,
      portfolioValue: cash,
      pnl,
    })
  }

  const metrics = computeMetrics(equityCurve, initialCapital)
  return { equityCurve, trades, metrics }
}

function computeMetrics(equityCurve, initialCapital) {
  const finalValue  = equityCurve[equityCurve.length - 1]?.value ?? initialCapital
  const totalReturn = ((finalValue - initialCapital) / initialCapital) * 100

  const dailyReturns = []
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1].value
    const cur  = equityCurve[i].value
    if (prev !== 0) dailyReturns.push((cur - prev) / prev)
  }

  let sharpe = 0
  if (dailyReturns.length > 1) {
    const mean     = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length
    const variance = dailyReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / dailyReturns.length
    const std      = Math.sqrt(variance)
    sharpe = std === 0 ? 0 : (mean / std) * Math.sqrt(252)
  }

  let peak = -Infinity
  let maxDrawdown = 0
  for (const { value } of equityCurve) {
    if (value > peak) peak = value
    const drawdown = (peak - value) / peak
    if (drawdown > maxDrawdown) maxDrawdown = drawdown
  }

  return {
    totalReturn: totalReturn.toFixed(2),
    sharpe:      sharpe.toFixed(2),
    maxDrawdown: (maxDrawdown * 100).toFixed(2),
    finalValue:  finalValue.toFixed(2),
  }
}
