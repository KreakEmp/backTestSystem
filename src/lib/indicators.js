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
