/**
 * ═══════════════════════════════════════════════════════════════
 *  Strategy: S-Trend+ (SuperTrend + Dual-EMA + EMA-Touch Re-entry)
 * ═══════════════════════════════════════════════════════════════
 *
 *  OVERVIEW
 *  ────────
 *  Identical to S-Trend with one addition: when the candle price
 *  touches EMA_small while a trade is open, the trade closes and a
 *  fresh observation cycle starts immediately in the current ST
 *  direction — no ST flip required.  This gives a quicker re-entry
 *  path after a pullback to the fast EMA.
 *
 *  PARAMETERS
 *  ──────────
 *  EMA Small Period     Faster EMA (default 9).  Tracks short-term momentum.
 *  EMA Large Period     Slower EMA (default 21). Tracks medium-term trend.
 *  ST Period            ATR lookback for SuperTrend (default 10).
 *  ST Multiplier        Band width multiplier for SuperTrend (default 3.0).
 *                       Higher → wider bands → fewer flips → longer trades.
 *  Observation Candles  How many candles to observe after the ST flip (or
 *                       EMA touch) before setting the breakout level
 *                       (default 2, includes the trigger candle itself).
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
 *           OR for an EMA-touch exit on a live LONG trade (see EXIT RULES).
 *           Any prior observation is discarded on a new flip.
 *
 *  Step 2 — Observe candles (starting from the trigger candle):
 *           • Track the HIGHEST HIGH across all observation candles.
 *           • For ST-flip trigger: observation ends when obsCandles elapsed AND
 *             EMA_small ≤ EMA_large was seen at least once (pullback confirmed).
 *           • For EMA-touch trigger: the touch itself is the pullback; observation
 *             ends when obsCandles candles have been observed (no extra EMA cross needed).
 *           • If SuperTrend turns bearish during observation → cancel.
 *
 *  Step 3 — Breakout gate:
 *           Wait for a candle where BOTH conditions hold:
 *             • HIGH ≥ observation HIGH  (price breaks above consolidation)
 *             • All four run conditions are already met  (see Step 4)
 *           • If SuperTrend turns bearish before breakout → cancel.
 *
 *  Step 4 — BUY signal is emitted on the breakout candle and on every
 *           subsequent candle while ALL four run conditions hold:
 *             1. SuperTrend direction = bullish  (dir = +1)
 *             2. EMA_small > EMA_large
 *             3. EMA_small > SuperTrend value
 *             4. EMA_large > SuperTrend value
 *           The run ends immediately if the candle LOW touches EMA_small
 *           (EMA-touch exit) OR if any of the 4 conditions fails.
 *
 *  SHORT  (mirror of LONG):
 *    • Trigger:    ST flips BEARISH  (dir: +1 → −1)  OR  EMA-touch exit on SHORT
 *    • Observe:    track LOWEST LOW; ST-flip: obsCandles + EMA_small ≥ EMA_large seen;
 *                  EMA-touch: just obsCandles (touch IS the pullback)
 *    • Breakout:   candle LOW ≤ observation LOW
 *    • Run cond:   ST bearish, ema_small < ema_large, both below ST value
 *
 *  EXIT RULES
 *  ──────────
 *  Primary   — Stop Loss % or Target % configured in the engine.
 *  Fallback  — Two sub-cases (engine exits at candle close):
 *
 *              a) EMA-touch exit — candle LOW ≤ EMA_small (LONG) or
 *                 candle HIGH ≥ EMA_small (SHORT): trade closes and a
 *                 fresh observation cycle starts immediately in the
 *                 current ST direction — no ST flip required.
 *                 EMA-touch is only active after a 10-candle lockout
 *                 from the most recent breakout signal.
 *
 *              b) Other condition failure — any of the 4 run conditions
 *                 fails without an EMA touch: trade closes and a new
 *                 ST flip is required before re-entry.
 *
 *  LOCKOUT
 *  ───────
 *  After each breakout signal is emitted, EMA-touch monitoring is
 *  suppressed for the next 10 strategy candles.  This prevents an
 *  immediate EMA-touch (which can happen 1–2 candles after entry)
 *  from resetting the cycle too early.  Once the lockout expires,
 *  any EMA touch restarts a fresh observation/breakout cycle.
 *
 *  MULTIPLE SIGNALS PER ST PHASE
 *  ──────────────────────────────
 *  A single SuperTrend directional phase can produce multiple trades.
 *  Each trade is preceded by its own EMA-touch → observation → breakout
 *  cycle.  There is no "one signal per ST flip" limit.
 *
 *  If a breakout signal was emitted but no trade entry was taken by the
 *  engine (e.g. the 1-min sim was mid-bar), EMA-touch is still ignored
 *  during the lockout — only actual candle-close conditions matter to
 *  the strategy's state machine.
 *
 *  NOTES
 *  ─────
 *  • EMA-touch exit gives a quick re-entry path: price dipping to the
 *    fast EMA resets the observation gate without waiting for a full ST flip.
 *  • Other exits (conditions failing) still require a new ST flip,
 *    preventing repeated entries in a trending but weakening market.
 *  • For intraday, use short periods (e.g. EMA 9/21, ST 7×2, obs 1–2)
 *    on 5-min or 15-min candles.
 *  • For positional, try EMA 21/55, ST 10×3, obs 3–5 on daily candles.
 */

import { computeMA, computeSuperTrend } from '../indicators.js'

export default {
  id:   'sTrendEma',
  name: 'S-Trend+',
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

    let prevStDir = (fromIndex > 0 && st[fromIndex - 1] !== null)
      ? st[fromIndex - 1].direction
      : null

    let phase            = 'idle'  // 'idle' | 'observing' | 'pending_breakout'
    let phaseDir         = null    // 'BUY' or 'SELL'
    let obsCount         = 0
    let breakoutPrice    = null
    let pullbackSeen     = false
    let lockoutRemaining = 0       // EMA-touch suppressed for this many more candles

    for (let i = fromIndex; i < data.length; i++) {
      if (ema1[i] === null || ema2[i] === null || st[i] === null) continue

      const { direction: stDir, value: stVal } = st[i]
      const stJustFlipped = prevStDir !== null && stDir !== prevStDir

      const longOk  = stDir ===  1 && ema1[i] > ema2[i] && ema1[i] > stVal && ema2[i] > stVal
      const shortOk = stDir === -1 && ema1[i] < ema2[i] && ema1[i] < stVal && ema2[i] < stVal

      // ── 1. Active run: keep emitting while conditions hold ───────────
      if (emittingDir !== null) {
        const runOk = emittingDir === 'BUY' ? longOk : shortOk

        // EMA-touch exit: only active once the post-signal lockout has expired
        const emaTouched = lockoutRemaining <= 0 && (
          emittingDir === 'BUY'
            ? data[i].low  <= ema1[i]   // long:  candle low touched / crossed below EMA_small
            : data[i].high >= ema1[i]   // short: candle high touched / crossed above EMA_small
        )

        if (runOk && !emaTouched) {
          signals[i] = emittingDir
          if (lockoutRemaining > 0) lockoutRemaining--
        } else {
          emittingDir      = null
          lockoutRemaining = 0

          if (emaTouched) {
            // Treat EMA touch as the pullback event itself — price came back to the
            // fast EMA, so pullbackSeen starts true.  Observation only needs to
            // count obsCandles before advancing to the breakout gate.
            const newDir  = stDir === 1 ? 'BUY' : 'SELL'
            phase         = 'observing'
            phaseDir      = newDir
            obsCount      = 1
            breakoutPrice = newDir === 'BUY' ? data[i].high : data[i].low
            pullbackSeen  = true   // EMA-touch IS the pullback — no extra EMA cross needed
            if (obsCandles === 0 || obsCount >= obsCandles) phase = 'pending_breakout'
            prevStDir = stDir
            continue  // skip gate for this candle — observation already initialised above
          }
          // Other conditions failed (no EMA touch) → idle, wait for ST flip (fall through to gate)
        }
      }

      // ── 2. Observation / breakout gate ───────────────────────────────
      if (emittingDir === null) {

        if (stJustFlipped) {
          const newDir     = stDir === 1 ? 'BUY' : 'SELL'
          const isPullback = newDir === 'BUY' ? ema1[i] <= ema2[i] : ema1[i] >= ema2[i]
          phase         = 'observing'
          phaseDir      = newDir
          obsCount      = 1
          breakoutPrice = newDir === 'BUY' ? data[i].high : data[i].low
          pullbackSeen  = isPullback
          if (obsCandles === 0 || (obsCount >= obsCandles && pullbackSeen)) phase = 'pending_breakout'

        } else if (phase === 'observing') {
          const expectedDir = phaseDir === 'BUY' ? 1 : -1
          if (stDir !== expectedDir) {
            phase = 'idle'; phaseDir = null; obsCount = 0; breakoutPrice = null; pullbackSeen = false
          } else {
            obsCount++
            breakoutPrice = phaseDir === 'BUY'
              ? Math.max(breakoutPrice, data[i].high)
              : Math.min(breakoutPrice, data[i].low)
            const pullback = phaseDir === 'BUY' ? ema1[i] <= ema2[i] : ema1[i] >= ema2[i]
            if (pullback) pullbackSeen = true
            if (obsCount >= obsCandles && pullbackSeen) phase = 'pending_breakout'
          }

        } else if (phase === 'pending_breakout') {
          const expectedDir = phaseDir === 'BUY' ? 1 : -1
          if (stDir !== expectedDir) {
            phase = 'idle'; phaseDir = null; obsCount = 0; breakoutPrice = null; pullbackSeen = false
          } else {
            const broke = phaseDir === 'BUY'
              ? data[i].high >= breakoutPrice
              : data[i].low  <= breakoutPrice
            const runOk = phaseDir === 'BUY' ? longOk : shortOk
            if (broke && runOk) {
              signals[i]       = phaseDir
              emittingDir      = phaseDir
              lockoutRemaining = 10
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
