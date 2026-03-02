/**
 * ═══════════════════════════════════════════════════════════════
 *  Strategy: MA Crossover  (Golden Cross / Death Cross)
 * ═══════════════════════════════════════════════════════════════
 *
 *  OVERVIEW
 *  ────────
 *  Classic dual moving-average trend-following strategy.
 *  Generates a signal only at the moment the two MAs cross —
 *  not on every candle — so positions are entered once and held
 *  until the opposite crossover fires (or SL / Target is hit).
 *
 *  PARAMETERS
 *  ──────────
 *  MA Type       SMA or EMA applied to both lines (default: SMA)
 *  Short Period  Faster MA (default 20).  Reacts quickly to price.
 *  Long Period   Slower MA (default 50).  Represents the major trend.
 *
 *  ENTRY RULES
 *  ───────────
 *  BUY  (Golden Cross)  — short MA crosses ABOVE long MA
 *    Condition: prev_short ≤ prev_long  AND  curr_short > curr_long
 *
 *  SELL  (Death Cross)  — short MA crosses BELOW long MA
 *    Condition: prev_short ≥ prev_long  AND  curr_short < curr_long
 *
 *  EXIT RULES
 *  ──────────
 *  Primary   — Stop Loss % or Target % configured in the engine.
 *  Fallback  — Opposite crossover fires; engine closes the current
 *              position on the opposing BUY / SELL signal at candle close.
 *
 *  NOTES
 *  ─────
 *  • Transition-based: BUY / SELL fires ONLY on the crossover candle,
 *    not on every candle where short > long.  Avoids re-entering
 *    during the same unbroken trend leg after an SL exit.
 *  • EMA reacts faster to recent price; prefer EMA in volatile
 *    markets, SMA for smoother (fewer) signals.
 *  • Works best on trending instruments with a well-separated
 *    period gap (e.g. 20/50, 50/200).  Choppy markets produce
 *    frequent false crosses ("whipsaws").
 *
 * ═══════════════════════════════════════════════════════════════
 *  Strategy contract  (shape all strategies must follow)
 * ═══════════════════════════════════════════════════════════════
 *  id            string        unique identifier
 *  name          string        display name shown in the UI
 *  type          string        category used for grouping in the form
 *  paramFields   FieldDef[]    fields rendered in the form
 *  generateSignals(data: Candle[], params: object) => Signal[]
 *    Signal[i]: null | 'BUY' | 'SELL'  — one entry per data point
 */

import { computeMA } from '../indicators.js'

export default {
  id: 'maCrossover',
  name: 'MA Crossover',
  type: 'Trend Following',

  paramFields: [
    {
      name: 'maType',
      label: 'MA Type',
      type: 'select',
      default: 'SMA',
      options: [
        { value: 'SMA', label: 'SMA' },
        { value: 'EMA', label: 'EMA' },
      ],
    },
    { name: 'shortPeriod', label: 'Short Period', type: 'number', default: 20, min: 2, max: 200 },
    { name: 'longPeriod',  label: 'Long Period',  type: 'number', default: 50, min: 3, max: 500 },
  ],

  /** Returns the number of strategy-interval candles needed before startDate for indicators to be valid. */
  warmupPeriod(params) {
    return Math.max(Number(params.shortPeriod), Number(params.longPeriod))
  },

  generateSignals(data, params, fromIndex = 0) {
    const { maType, shortPeriod, longPeriod } = params
    const closes = data.map(d => d.close)
    const shortMA = computeMA(closes, Number(shortPeriod), maType)
    const longMA  = computeMA(closes, Number(longPeriod),  maType)

    const signals = new Array(data.length).fill(null)

    // Start at fromIndex so warmup candles never emit signals.
    // Math.max(1, fromIndex) because the crossover check needs a previous candle.
    for (let i = Math.max(1, fromIndex); i < data.length; i++) {
      const ps = shortMA[i - 1], pl = longMA[i - 1]
      const cs = shortMA[i],     cl = longMA[i]
      if (ps === null || pl === null || cs === null || cl === null) continue

      if (ps <= pl && cs > cl) signals[i] = 'BUY'   // golden cross
      else if (ps >= pl && cs < cl) signals[i] = 'SELL' // death cross
    }

    return signals
  },
}
