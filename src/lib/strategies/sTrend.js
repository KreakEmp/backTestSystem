/**
 * ═══════════════════════════════════════════════════════════════
 *  Strategy: S-Trend  (SuperTrend + Dual-EMA Confirmation)
 * ═══════════════════════════════════════════════════════════════
 *
 *  OVERVIEW
 *  ────────
 *  Combines the SuperTrend indicator with two EMAs to confirm
 *  trend direction before entering.  A new entry is triggered by a
 *  SuperTrend direction flip followed by an observation + breakout gate
 *  that filters out premature entries.
 *
 *  PARAMETERS
 *  ──────────
 *  EMA Small Period     Faster EMA (default 9).  Tracks short-term momentum.
 *  EMA Large Period     Slower EMA (default 21). Tracks medium-term trend.
 *  ST Period            ATR lookback for SuperTrend (default 10).
 *  ST Multiplier        Band width multiplier for SuperTrend (default 3.0).
 *                       Higher → wider bands → fewer flips → longer trades.
 *  Observation Candles  How many candles to observe after the ST flip before
 *                       setting the breakout level (default 2, includes the
 *                       flip candle itself).  Observation also ends early if
 *                       the EMA pullback condition is met (see below).
 *
 *  HOW SUPERTREND WORKS
 *  ────────────────────
 *  ATR is computed with Wilder's smoothing.
 *  Upper band = HL/2 + multiplier × ATR   (resistance / bearish line)
 *  Lower band = HL/2 − multiplier × ATR   (support  / bullish line)
 *  Bands only tighten while the trend holds (ratchet mechanism).
 *  Direction flips to bullish  when close crosses ABOVE the upper band.
 *  Direction flips to bearish  when close crosses BELOW the lower band.
 *
 *  ENTRY SEQUENCE  (LONG — SHORT is the mirror image)
 *  ───────────────────────────────────────────────────
 *  Step 1 — Wait for SuperTrend to flip BULLISH  (dir: −1 → +1)
 *           This is a transition trigger, not a persistent condition.
 *           Any prior observation is discarded on a new flip.
 *
 *  Step 2 — Observe candles (starting from the flip candle):
 *           • Track the HIGHEST HIGH across all observation candles.
 *           • Observation ends when EITHER condition is first met:
 *               a) obsCandles candles have been observed, OR
 *               b) EMA_small ≤ EMA_large  (fast EMA pulled back below slow EMA)
 *           • If SuperTrend turns bearish during observation → cancel.
 *
 *  Step 3 — Breakout gate:
 *           Wait for a candle where BOTH conditions hold:
 *             • HIGH ≥ observation HIGH  (price breaks above consolidation)
 *             • All four run conditions are already met  (see Step 4)
 *           Staying in this phase until both are satisfied avoids entering
 *           before the EMA cross has confirmed the trend shift.
 *           • If SuperTrend turns bearish before breakout → cancel.
 *
 *  Step 4 — BUY signal is emitted on the breakout candle and on every
 *           subsequent candle while ALL four run conditions hold:
 *             1. SuperTrend direction = bullish  (dir = +1)
 *             2. EMA_small > EMA_large
 *             3. EMA_small > SuperTrend value
 *             4. EMA_large > SuperTrend value
 *           When any condition fails the run ends and a fresh ST flip
 *           is required before re-entry (back to Step 1).
 *
 *  SHORT  (mirror of LONG):
 *    • Trigger:    ST flips BEARISH  (dir: +1 → −1)
 *    • Observe:    track LOWEST LOW; end when obsCandles elapsed OR
 *                  EMA_small ≥ EMA_large  (fast EMA bounced above slow)
 *    • Breakout:   candle LOW ≤ observation LOW
 *    • Run cond:   ST bearish, ema_small < ema_large, both below ST value
 *
 *  EXIT RULES
 *  ──────────
 *  Primary   — Stop Loss % or Target % configured in the engine.
 *  Fallback  — Any of the 4 run conditions fails (engine exits at candle
 *              close).  A new ST flip (back to Step 1) is required before
 *              re-entry — no repeat entries within the same ST trend.
 *
 *  NOTES
 *  ─────
 *  • Requiring a new ST flip before each entry prevents repeated trades
 *    in a trending but weakening market.
 *  • For intraday, use short periods (e.g. EMA 9/21, ST 7×2, obs 1–2)
 *    on 5-min or 15-min candles.
 *  • For positional, try EMA 21/55, ST 10×3, obs 3–5 on daily candles.
 */

import { computeMA, computeSuperTrend } from '../indicators.js'

export default {
  id:   'sTrend',
  name: 'S-Trend',
  type: 'Trend Following',

  paramFields: [
    { name: 'emaSmall',     label: 'EMA Small Period',    type: 'number', default: 9,  step: 1   },
    { name: 'emaLarge',     label: 'EMA Large Period',    type: 'number', default: 21, step: 1   },
    { name: 'stPeriod',     label: 'ST Period',           type: 'number', default: 10, step: 1   },
    { name: 'stMultiplier', label: 'ST Multiplier',       type: 'number', default: 3,  step: 0.1 },
    { name: 'obsCandles',   label: 'Observation Candles', type: 'number', default: 2,  step: 1, min: 0 },
  ],

  /** Returns the number of strategy-interval candles needed before startDate for indicators to be valid. */
  warmupPeriod(params) {
    return Math.max(Number(params.emaSmall), Number(params.emaLarge), Number(params.stPeriod))
  },

  generateSignals(data, params, fromIndex = 0) {
    const emaSmall     = Number(params.emaSmall)
    const emaLarge     = Number(params.emaLarge)
    const stPeriod     = Number(params.stPeriod)
    const stMultiplier = Number(params.stMultiplier)
    const obsCandles   = Number(params.obsCandles)

    const closes = data.map(d => d.close)
    const ema1   = computeMA(closes, emaSmall, 'EMA')
    const ema2   = computeMA(closes, emaLarge,  'EMA')
    const st     = computeSuperTrend(data, stPeriod, stMultiplier)

    const signals = new Array(data.length).fill(null)

    let emittingDir = null  // direction of current active run ('BUY'|'SELL'|null)

    // Seed prevStDir from the last warmup candle so a flip happening exactly
    // at fromIndex is detected.  If no valid warmup candle exists, null means
    // the first flip will be detected at fromIndex+1 at the earliest — either
    // way the state machine never inherits a trend from before fromIndex.
    let prevStDir = (fromIndex > 0 && st[fromIndex - 1] !== null)
      ? st[fromIndex - 1].direction
      : null

    // Observation / breakout gate state — always starts fresh at fromIndex
    let phase         = 'idle'  // 'idle' | 'observing' | 'pending_breakout'
    let phaseDir      = null    // 'BUY' or 'SELL'
    let obsCount      = 0
    let breakoutPrice = null
    let pullbackSeen  = false   // has the pullback condition been met during this observation?

    // Indicator computation covers the full array (including warmup).
    // The state machine only runs from fromIndex so that:
    //   • warmup candles never emit signals
    //   • for S-Trend, the very first entry requires a SuperTrend flip that
    //     occurs on or after fromIndex (no inherited trend from warmup)
    for (let i = fromIndex; i < data.length; i++) {
      if (ema1[i] === null || ema2[i] === null || st[i] === null) continue

      const { direction: stDir, value: stVal } = st[i]
      const stJustFlipped = prevStDir !== null && stDir !== prevStDir

      // Four conditions that must ALL hold for an active run to continue
      const longOk  = stDir ===  1 && ema1[i] > ema2[i] && ema1[i] > stVal && ema2[i] > stVal
      const shortOk = stDir === -1 && ema1[i] < ema2[i] && ema1[i] < stVal && ema2[i] < stVal

      // ── 1. Active run: keep emitting while conditions hold ───────────
      if (emittingDir !== null) {
        const runOk = emittingDir === 'BUY' ? longOk : shortOk

        if (runOk) {
          signals[i] = emittingDir
        } else {
          // Conditions failed → idle; a new ST flip is required before re-entry
          emittingDir = null
        }
      }

      // ── 2. Observation / breakout gate ───────────────────────────────
      if (emittingDir === null) {

        if (stJustFlipped) {
          // ST flipped — discard any prior observation, start fresh
          const newDir     = stDir === 1 ? 'BUY' : 'SELL'
          const isPullback = newDir === 'BUY' ? ema1[i] <= ema2[i] : ema1[i] >= ema2[i]
          phase         = 'observing'
          phaseDir      = newDir
          obsCount      = 1
          breakoutPrice = newDir === 'BUY' ? data[i].high : data[i].low
          pullbackSeen  = isPullback
          // obsCandles=0: skip pullback requirement, enter gate immediately
          // obsCandles>0: BOTH count threshold AND pullback are required
          if (obsCandles === 0 || (obsCount >= obsCandles && pullbackSeen)) phase = 'pending_breakout'

        } else if (phase === 'observing') {
          const expectedDir = phaseDir === 'BUY' ? 1 : -1
          if (stDir !== expectedDir) {
            // ST lost the expected direction — cancel, wait for next flip
            phase = 'idle'; phaseDir = null; obsCount = 0; breakoutPrice = null; pullbackSeen = false
          } else {
            obsCount++
            breakoutPrice = phaseDir === 'BUY'
              ? Math.max(breakoutPrice, data[i].high)
              : Math.min(breakoutPrice, data[i].low)
            const pullback = phaseDir === 'BUY' ? ema1[i] <= ema2[i] : ema1[i] >= ema2[i]
            if (pullback) pullbackSeen = true
            // Observation ends only when BOTH the minimum candle count is reached
            // AND a pullback has been seen — pullback alone is not sufficient
            if (obsCount >= obsCandles && pullbackSeen) phase = 'pending_breakout'
          }

        } else if (phase === 'pending_breakout') {
          const expectedDir = phaseDir === 'BUY' ? 1 : -1
          if (stDir !== expectedDir) {
            // ST reversed before breakout — cancel
            phase = 'idle'; phaseDir = null; obsCount = 0; breakoutPrice = null; pullbackSeen = false
          } else {
            const broke = phaseDir === 'BUY'
              ? data[i].high >= breakoutPrice
              : data[i].low  <= breakoutPrice
            // Run conditions must also hold on the breakout candle before entering.
            // e.g. for SHORT: EMA_small must be < EMA_large (the cross must have happened).
            // If price broke but conditions aren't met yet, stay in pending_breakout —
            // the entry fires on the first candle where BOTH broke AND runOk are true.
            const runOk = phaseDir === 'BUY' ? longOk : shortOk
            if (broke && runOk) {
              signals[i] = phaseDir
              emittingDir = phaseDir
              phase = 'idle'; phaseDir = null; obsCount = 0; breakoutPrice = null; pullbackSeen = false
            }
          }
        }
      }

      prevStDir = stDir
    }

    return signals
  },
}
