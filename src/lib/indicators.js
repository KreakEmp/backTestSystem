/**
 * SuperTrend indicator.
 * @param {Candle[]} data        — array of { high, low, close }
 * @param {number}  period       — ATR period (Wilder's smoothing)
 * @param {number}  multiplier   — band multiplier
 * @returns Array<null | { direction: 1|-1, value: number }>
 *   direction  1 = bullish (price above ST, value is lower band / support)
 *             -1 = bearish (price below ST, value is upper band / resistance)
 */
export function computeSuperTrend(data, period, multiplier) {
  const n = data.length
  const result = new Array(n).fill(null)
  if (n < period) return result

  // True Range
  const tr = new Array(n).fill(0)
  tr[0] = data[0].high - data[0].low
  for (let i = 1; i < n; i++) {
    tr[i] = Math.max(
      data[i].high - data[i].low,
      Math.abs(data[i].high - data[i - 1].close),
      Math.abs(data[i].low  - data[i - 1].close)
    )
  }

  // ATR — simple average for seed, then Wilder's smoothing
  const atr = new Array(n).fill(null)
  atr[period - 1] = tr.slice(0, period).reduce((a, b) => a + b, 0) / period
  for (let i = period; i < n; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period
  }

  // SuperTrend bands and direction
  let finalUpper = 0
  let finalLower = 0
  let direction  = 1   // 1=bullish, -1=bearish

  for (let i = period - 1; i < n; i++) {
    const hl2        = (data[i].high + data[i].low) / 2
    const basicUpper = hl2 + multiplier * atr[i]
    const basicLower = hl2 - multiplier * atr[i]

    if (i === period - 1) {
      // Seed: initialise bands and pick direction from close
      finalUpper = basicUpper
      finalLower = basicLower
      direction  = data[i].close <= finalUpper ? -1 : 1
      result[i]  = { direction, value: direction === 1 ? finalLower : finalUpper }
      continue
    }

    const prevUpper = finalUpper
    const prevLower = finalLower
    const prevClose = data[i - 1].close

    // Ratchet bands — only tighten, never widen while trend holds
    finalUpper = (basicUpper < prevUpper || prevClose > prevUpper) ? basicUpper : prevUpper
    finalLower = (basicLower > prevLower || prevClose < prevLower) ? basicLower : prevLower

    const prevDir = direction
    if (prevDir === -1) {
      direction = data[i].close > finalUpper ? 1 : -1
    } else {
      direction = data[i].close < finalLower ? -1 : 1
    }

    result[i] = { direction, value: direction === 1 ? finalLower : finalUpper }
  }

  return result
}

export function computeMA(prices, period, type) {
  const result = new Array(prices.length).fill(null)

  if (type === 'SMA') {
    for (let i = period - 1; i < prices.length; i++) {
      const slice = prices.slice(i - period + 1, i + 1)
      result[i] = slice.reduce((a, b) => a + b, 0) / period
    }
  } else {
    // EMA
    const k = 2 / (period + 1)
    let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period
    result[period - 1] = ema
    for (let i = period; i < prices.length; i++) {
      ema = prices[i] * k + ema * (1 - k)
      result[i] = ema
    }
  }

  return result
}
