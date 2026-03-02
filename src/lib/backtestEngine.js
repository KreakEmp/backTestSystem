/**
 * Backtesting engine — two modes:
 *
 *  runBacktest()        — synchronous, strategy-timeframe candles only (legacy)
 *  simulateBacktest()   — async generator, 1-min sub-tick simulation (preferred)
 *
 * Sub-tick model (per 1-minute candle):
 *   t+15s  open  → entry (LONG on BUY signal, SHORT on SELL signal)
 *   LONG:  t+30s low → SL check;  t+45s high → target check; t+60s close → SELL exit
 *   SHORT: t+30s high → SL check; t+45s low  → target check; t+60s close → BUY exit
 *   (SHORT checks SL before target to be conservative — worst case first)
 *
 * Signal alignment:
 *   Strategy signals come from strategy-timeframe candles (e.g. 15-min).
 *   A signal from stratData[i] is stamped on EVERY 1-min candle from the moment
 *   that strategy candle closes (stratData[i].date + intervalMs) until the next
 *   strategy candle closes.  This lets the simulation enter at ANY 1-min mark
 *   within the active window — not just the single candle on the strategy boundary.
 *   null strategy candles are skipped, leaving those 1-min slots as null.
 *   alignSignals() is always used to avoid lookahead bias and so that
 *   signalDate/signalPrice reflect the strategy candle, not the entry candle.
 */

// ── Shared helpers ────────────────────────────────────────────────────────────

/**
 * @param {object[]} equityCurve      — daily equity points { date, value }
 * @param {number}   initialCapital
 * @param {number}   [intradayMaxDD]  — running max-DD from the simulation (includes
 *                                      intraday drawdowns that end-of-day points miss).
 *                                      When provided, overrides the curve-derived value.
 */
export function computeMetrics(equityCurve, initialCapital, intradayMaxDD = null, trades = []) {
  const empty = {
    totalReturn: '0.00', totalPnl: '0.00',
    maxDrawdown: '0.00', maxDrawdownAbs: '0.00',
    accuracy: '0.0', winCount: 0, lossCount: 0,
    rewardRiskRatio: null, avgProfit: '0.00', avgLoss: '0.00', expectancy: '0.00',
    finalValue: initialCapital.toFixed(2),
  }
  if (!equityCurve.length) return empty

  const finalValue  = equityCurve[equityCurve.length - 1].value
  const totalReturn = ((finalValue - initialCapital) / initialCapital) * 100
  const totalPnl    = finalValue - initialCapital


  // End-of-day max drawdown (fallback when intradayMaxDD isn't available)
  let eodMaxDD = 0
  let peakEquity = initialCapital
  for (const { value } of equityCurve) {
    if (value > peakEquity) peakEquity = value
    const dd = (peakEquity - value) / peakEquity
    if (dd > eodMaxDD) eodMaxDD = dd
  }

  // Prefer the intraday-accurate max DD from the simulation engine
  const maxDrawdown    = intradayMaxDD ?? eodMaxDD
  const maxDrawdownAbs = maxDrawdown * peakEquity

  // Trade-level stats
  const wins   = trades.filter(t => t.pnl > 0)
  const losses = trades.filter(t => t.pnl < 0)
  const winCount  = wins.length
  const lossCount = losses.length
  const accuracy  = trades.length ? (winCount / trades.length) * 100 : 0
  const avgProfit = winCount  ? wins.reduce((a, t) => a + t.pnl, 0)   / winCount  : 0
  const avgLoss   = lossCount ? losses.reduce((a, t) => a + t.pnl, 0) / lossCount : 0
  const rewardRiskRatio = lossCount && avgLoss !== 0
    ? (avgProfit / Math.abs(avgLoss)).toFixed(2)
    : null
  const winRate    = trades.length ? winCount  / trades.length : 0
  const lossRate   = trades.length ? lossCount / trades.length : 0
  const rrRaw      = lossCount && avgLoss !== 0 ? avgProfit / Math.abs(avgLoss) : 0
  // Expectancy in R-multiples: (Win Rate × R:R) − (Loss Rate × 1)
  const expectancy = trades.length ? (winRate * rrRaw) - (lossRate * 1) : 0

  return {
    totalReturn:     totalReturn.toFixed(2),
    totalPnl:        totalPnl.toFixed(2),
    maxDrawdown:     (maxDrawdown * 100).toFixed(2),
    maxDrawdownAbs:  maxDrawdownAbs.toFixed(2),
    accuracy:        accuracy.toFixed(1),
    winCount,
    lossCount,
    rewardRiskRatio,
    avgProfit:       avgProfit.toFixed(2),
    avgLoss:         avgLoss.toFixed(2),
    expectancy:      expectancy.toFixed(2),
    finalValue:      finalValue.toFixed(2),
  }
}

// ── Simulation helpers ────────────────────────────────────────────────────────

/** Milliseconds per strategy interval (used to compute candle close time). */
const INTERVAL_MS = {
  minute:     60_000,
  '3minute':  3  * 60_000,
  '5minute':  5  * 60_000,
  '10minute': 10 * 60_000,
  '15minute': 15 * 60_000,
  '30minute': 30 * 60_000,
  '60minute': 60 * 60_000,
  day:        24 * 60 * 60_000,
  week:       7  * 24 * 60 * 60_000,
  month:      30 * 24 * 60 * 60_000,
}

/**
 * Add `seconds` to an ISO timestamp string and return a formatted
 * 'YYYY-MM-DD HH:MM:SS' string in IST (+05:30).
 */
function addSeconds(isoStr, seconds) {
  const ms  = new Date(isoStr).getTime() + seconds * 1000
  // Shift to IST for display
  const ist = new Date(ms + (5 * 60 + 30) * 60 * 1000)
  const p   = n => String(n).padStart(2, '0')
  return `${ist.getUTCFullYear()}-${p(ist.getUTCMonth() + 1)}-${p(ist.getUTCDate())} ` +
         `${p(ist.getUTCHours())}:${p(ist.getUTCMinutes())}:${p(ist.getUTCSeconds())}`
}

/**
 * Group 1-min candles by calendar day.
 * Returns ordered Map<'YYYY-MM-DD', number[]> — values are indices into minData.
 */
function groupByDay(minData) {
  const map = new Map()
  for (let i = 0; i < minData.length; i++) {
    const day = String(minData[i].date).slice(0, 10)
    if (!map.has(day)) map.set(day, [])
    map.get(day).push(i)
  }
  return map
}

/**
 * Map strategy-level signals onto the 1-minute candle array.
 *
 * Each strategy signal is carried forward across ALL 1-min candles from the
 * moment the strategy candle closes until the next strategy candle closes:
 *
 *   active window = [ stratData[i].date + intervalMs,
 *                     stratData[i+1].date + intervalMs )
 *
 * This means a BUY (or SELL) signal is visible on every 1-min candle in that
 * window, so the simulation can enter at ANY minute — not just the one candle
 * that happens to land on the strategy-interval boundary.
 *
 * Rules:
 *  a) null strategy signals are skipped — those 1-min candles stay null.
 *  b) signal[i] never activates before the candle closes (no lookahead).
 *  c) The last strategy candle's signal carries forward to the end of minData.
 *
 * Returns:
 *   aligned — Signal[] indexed by minData position ('BUY' | 'SELL' | null)
 *   meta    — parallel array of { date, price } from the strategy candle that
 *             generated each signal (used for signalDate / signalPrice in trades)
 */
function alignSignals(minData, stratData, stratSignals, intervalMs) {
  const aligned  = new Array(minData.length).fill(null)
  const meta     = new Array(minData.length).fill(null)
  const minTimes = minData.map(c => new Date(c.date).getTime())

  for (let i = 0; i < stratData.length; i++) {
    if (stratSignals[i] === null) continue

    // Window: [this candle's close, next candle's close)
    const activationMs     = new Date(stratData[i].date).getTime() + intervalMs
    const nextActivationMs = i + 1 < stratData.length
      ? new Date(stratData[i + 1].date).getTime() + intervalMs
      : Infinity

    // Binary search: first 1-min index with time >= activationMs
    let lo = 0, hi = minTimes.length - 1, startIdx = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (minTimes[mid] >= activationMs) { startIdx = mid; hi = mid - 1 }
      else lo = mid + 1
    }
    if (startIdx === -1) continue

    // Stamp every 1-min candle in the window with this strategy signal
    const sigMeta = { date: stratData[i].date, price: stratData[i].close }
    for (let j = startIdx; j < minTimes.length && minTimes[j] < nextActivationMs; j++) {
      aligned[j] = stratSignals[i]
      meta[j]    = sigMeta
    }
  }

  return { aligned, meta }
}

// ── Legacy synchronous engine (kept for reference) ────────────────────────────

export function runBacktest(data, signals, initialCapital, riskConfig = { stopLoss: 0, target: 0 }) {
  const { stopLoss, target } = riskConfig
  const trades      = []
  const equityCurve = []

  let cash         = initialCapital
  let shares       = 0
  let inPosition   = false
  let entryPrice   = 0
  let pendingTrade = null
  let cumulativePnl = 0
  let peak          = initialCapital
  let runningMaxDD  = 0

  function pushEquity(date, value) {
    const v = parseFloat(value.toFixed(2))
    if (v > peak) peak = v
    const dd = peak > 0 ? (peak - v) / peak : 0
    if (dd > runningMaxDD) runningMaxDD = dd
    equityCurve.push({ date, value: v })
  }

  function closeTrade(exitDate, exitPrice, exitReason, pnl) {
    cumulativePnl += pnl
    trades.push({
      ...pendingTrade,
      exitDate, exitPrice, exitReason, pnl,
      cumulativePnl,
      maxDrawdownTillDate: parseFloat((runningMaxDD * 100).toFixed(2)),
    })
    pendingTrade = null; shares = 0; inPosition = false
  }

  for (let i = 0; i < data.length; i++) {
    const { date, open, high, low, close } = data[i]
    const signal = signals[i]

    if (inPosition) {
      const slPrice     = stopLoss > 0 ? entryPrice * (1 - stopLoss / 100) : null
      const targetPrice = target   > 0 ? entryPrice * (1 + target   / 100) : null

      if (slPrice !== null && low <= slPrice) {
        const exitPrice = Math.min(open, slPrice)
        cash += shares * exitPrice
        pushEquity(date, cash)
        closeTrade(date, exitPrice, 'Stop Loss', shares * (exitPrice - entryPrice))
        continue
      }
      if (targetPrice !== null && high >= targetPrice) {
        const exitPrice = Math.max(open, targetPrice)
        cash += shares * exitPrice
        pushEquity(date, cash)
        closeTrade(date, exitPrice, 'Target', shares * (exitPrice - entryPrice))
        continue
      }
      if (signal === 'SELL') {
        cash += shares * close
        closeTrade(date, close, 'Signal', shares * (close - entryPrice))
      }
    } else if (signal === 'BUY') {
      const qty = Math.floor(cash / close)
      if (qty > 0) {
        entryPrice = close; shares = qty; cash -= qty * close; inPosition = true
        const slP  = stopLoss > 0 ? close * (1 - stopLoss / 100) : null
        const tgtP = target   > 0 ? close * (1 + target   / 100) : null
        pendingTrade = {
          signalDate: date, signalPrice: close,
          entryDate: date, entryType: 'BUY', entryPrice: close,
          shares: qty, stopLossPrice: slP, targetPrice: tgtP,
        }
      }
    }

    pushEquity(date, cash + shares * close)
  }

  if (inPosition && shares > 0) {
    const { date, close } = data[data.length - 1]
    cash += shares * close
    closeTrade(date, close, 'End of Data', shares * (close - entryPrice))
  }

  return { equityCurve, trades, metrics: computeMetrics(equityCurve, initialCapital) }
}

// ── Streaming simulation engine ───────────────────────────────────────────────

/**
 * Async generator that simulates a backtest at 1-minute granularity with
 * intra-minute sub-ticks. Yields one result object per trading day so the
 * UI can update progressively.
 *
 * @param {Candle[]} minData    — 1-minute candles for the full date range
 * @param {Candle[]} stratData  — strategy-interval candles (may === minData)
 * @param {Signal[]} signals    — per-stratData signal array
 * @param {number}   capital    — initial capital
 * @param {object}   riskConfig — { stopLoss, target, interval, ... }
 *   interval — strategy interval string (e.g. '15minute', 'day').
 *              Used to compute each strategy candle's close time so that
 *              signal activation is based on the 1-min clock, not the
 *              strategy-interval grid. Defaults to 'minute'.
 *
 * Yields: { dayDate: string, newTrades: Trade[], equityPoint: {date, value} }
 */
// Extract 'HH:MM' from a 'YYYY-MM-DD HH:MM:SS' date string
function timeHHMM(dateStr) { return dateStr.slice(11, 16) }

export async function* simulateBacktest(minData, stratData, signals, capital, riskConfig = {}) {
  const { stopLoss, target, quantity = 0, direction = 'long',
          tradeMode = 'positional', tradeStartTime = '09:15', tradeEndTime = '15:15',
          interval = 'minute' } = riskConfig
  const isIntraday = tradeMode === 'intraday'

  // Resolve strategy candle duration in milliseconds for activation time computation.
  // Falls back to 'minute' (60 s) for unknown intervals — safe default.
  const intervalMs = INTERVAL_MS[interval] ?? INTERVAL_MS.minute

  // Always align via alignSignals — this handles both the same-interval (1-min) case
  // and different-interval cases correctly, with no lookahead bias.
  const { aligned, meta } = alignSignals(minData, stratData, signals, intervalMs)

  // Simulation state
  let cash          = capital
  let shares        = 0
  let inPosition    = false
  let positionType  = null   // 'long' | 'short'
  let entryPrice    = 0
  let pendingTrade  = null
  let cumulativePnl = 0
  let peak          = capital
  let runningMaxDD  = 0

  // Re-entry guard: after any exit, block re-entry in the SAME direction until
  // an OPPOSITE-direction signal is seen.  This prevents multiple trades within
  // one ST flip cycle when carry-forward stamps BUY/SELL on many 1-min candles.
  let reEntryBlocked = false
  let lastExitDir    = null   // 'long' | 'short'

  function updateDD(value) {
    if (value > peak) peak = value
    const dd = peak > 0 ? (peak - value) / peak : 0
    if (dd > runningMaxDD) runningMaxDD = dd
  }

  function recordTrade(exitDate, exitTickTime, exitPrice, exitReason, pnl) {
    cumulativePnl += pnl
    const trade = {
      ...pendingTrade,
      exitDate,
      exitTickTime,
      exitPrice:           parseFloat(exitPrice.toFixed(2)),
      exitReason,
      pnl:                 parseFloat(pnl.toFixed(2)),
      cumulativePnl:       parseFloat(cumulativePnl.toFixed(2)),
      maxDrawdownTillDate: parseFloat((runningMaxDD * 100).toFixed(2)),
    }
    reEntryBlocked = true       // block same-direction re-entry after any exit
    lastExitDir    = positionType  // capture before clearing
    pendingTrade = null; shares = 0; inPosition = false; positionType = null
    return trade
  }

  // Short cash model (symmetric with long):
  //   entry:  cash -= shares * open              (margin deployed)
  //   exit:   cash += shares * entryPrice + pnl  (margin back + P&L)
  //   equity: cash + shares * (2 * entryPrice - currentPrice)

  const days = groupByDay(minData)

  for (const [dayDate, idxList] of days) {
    const dayTrades = []

    for (const idx of idxList) {
      const { date, open, high, low, close } = minData[idx]
      const signal = aligned[idx]
      const time   = timeHHMM(date)

      // ── Intraday forced exit — close at open of first candle at/after tradeEndTime ──
      if (isIntraday && inPosition && time >= tradeEndTime) {
        const exitPx = open
        const pnl = positionType === 'long'
          ? shares * (exitPx - entryPrice)
          : shares * (entryPrice - exitPx)
        if (positionType === 'long') cash += shares * exitPx
        else cash += shares * entryPrice + pnl
        updateDD(cash)
        dayTrades.push(recordTrade(date, addSeconds(date, 0), exitPx, 'Intraday Close', pnl))
      }

      // ── tick 0: OPEN (t+15s) — entry ──────────────────────────────────────
      const canEnter = !isIntraday || (time >= tradeStartTime && time < tradeEndTime)
      if (!inPosition && canEnter) {
        // Re-entry guard: unblock only when the signal flips to the opposite direction.
        // While carry-forward keeps BUY/SELL active across many 1-min candles, the
        // block ensures only ONE trade per ST flip cycle.
        if (reEntryBlocked) {
          const sigIsOpposite = (signal === 'BUY'  && lastExitDir === 'short')
                             || (signal === 'SELL' && lastExitDir === 'long')
          if (sigIsOpposite) reEntryBlocked = false
        }

        const sigMeta = meta[idx]   // { date, price } of the strategy candle that fired
        if (!reEntryBlocked && signal === 'BUY' && direction !== 'short') {
          const qty = quantity > 0 ? quantity : Math.floor(cash / open)
          if (qty > 0) {
            shares = qty; entryPrice = open; cash -= qty * open; inPosition = true; positionType = 'long'
            pendingTrade = {
              signalDate:    sigMeta?.date  ?? date,   // strategy candle date
              signalPrice:   sigMeta?.price ?? open,   // strategy candle close
              entryDate:     date,
              entryTickTime: addSeconds(date, 15),
              entryType:     'LONG',
              entryPrice:    open,
              shares:        qty,
              stopLossPrice: stopLoss > 0 ? open * (1 - stopLoss / 100) : null,
              targetPrice:   target   > 0 ? open * (1 + target   / 100) : null,
            }
          }
        } else if (!reEntryBlocked && signal === 'SELL' && direction !== 'long') {
          const qty = quantity > 0 ? quantity : Math.floor(cash / open)
          if (qty > 0) {
            shares = qty; entryPrice = open; cash -= qty * open; inPosition = true; positionType = 'short'
            pendingTrade = {
              signalDate:    sigMeta?.date  ?? date,   // strategy candle date
              signalPrice:   sigMeta?.price ?? open,   // strategy candle close
              entryDate:     date,
              entryTickTime: addSeconds(date, 15),
              entryType:     'SHORT',
              entryPrice:    open,
              shares:        qty,
              stopLossPrice: stopLoss > 0 ? open * (1 + stopLoss / 100) : null,  // SL above entry
              targetPrice:   target   > 0 ? open * (1 - target   / 100) : null,  // target below entry
            }
          }
        }
      }

      if (inPosition) {
        const slPrice  = positionType === 'long'
          ? (stopLoss > 0 ? entryPrice * (1 - stopLoss / 100) : null)
          : (stopLoss > 0 ? entryPrice * (1 + stopLoss / 100) : null)
        const tgtPrice = positionType === 'long'
          ? (target > 0 ? entryPrice * (1 + target / 100) : null)
          : (target > 0 ? entryPrice * (1 - target / 100) : null)
        let exited = false

        if (positionType === 'long') {
          // ── tick 1: LOW (t+30s) — SL check ──────────────────────────────
          if (!exited && slPrice !== null && low <= slPrice) {
            const exitPx = Math.min(open, slPrice)
            const pnl    = shares * (exitPx - entryPrice)
            cash        += shares * exitPx
            updateDD(cash)
            // open < slPrice means we gapped down through SL (worse than SL)
            const slReason = open < slPrice ? 'Stop Loss (Gap)' : 'Stop Loss'
            dayTrades.push(recordTrade(date, addSeconds(date, 30), exitPx, slReason, pnl))
            exited = true
          }
          // ── tick 2: HIGH (t+45s) — target check ──────────────────────────
          if (!exited && tgtPrice !== null && high >= tgtPrice) {
            const exitPx = Math.max(open, tgtPrice)
            const pnl    = shares * (exitPx - entryPrice)
            cash        += shares * exitPx
            updateDD(cash)
            const tgtReason = 'Target'
            dayTrades.push(recordTrade(date, addSeconds(date, 45), exitPx, tgtReason, pnl))
            exited = true
          }
          // ── tick 3: CLOSE (t+60s) — SELL signal exit ─────────────────────
          if (!exited && signal === 'SELL') {
            const pnl = shares * (close - entryPrice)
            cash     += shares * close
            updateDD(cash)
            dayTrades.push(recordTrade(date, addSeconds(date, 60), close, 'Signal', pnl))
            exited = true
          }
        } else {
          // SHORT — conservative: check SL (HIGH) before target (LOW)
          // ── tick 1: HIGH (t+30s) — SL check ──────────────────────────────
          if (!exited && slPrice !== null && high >= slPrice) {
            const exitPx = Math.max(open, slPrice)
            const pnl    = shares * (entryPrice - exitPx)
            cash        += shares * entryPrice + pnl
            updateDD(cash)
            // open > slPrice means we gapped up through SL (worse than SL for short)
            const slReason = open > slPrice ? 'Stop Loss (Gap)' : 'Stop Loss'
            dayTrades.push(recordTrade(date, addSeconds(date, 30), exitPx, slReason, pnl))
            exited = true
          }
          // ── tick 2: LOW (t+45s) — target check ───────────────────────────
          if (!exited && tgtPrice !== null && low <= tgtPrice) {
            const exitPx = Math.min(open, tgtPrice)
            const pnl    = shares * (entryPrice - exitPx)
            cash        += shares * entryPrice + pnl
            updateDD(cash)
            const tgtReason = 'Target'
            dayTrades.push(recordTrade(date, addSeconds(date, 45), exitPx, tgtReason, pnl))
            exited = true
          }
          // ── tick 3: CLOSE (t+60s) — BUY signal exit ──────────────────────
          if (!exited && signal === 'BUY') {
            const pnl = shares * (entryPrice - close)
            cash     += shares * entryPrice + pnl
            updateDD(cash)
            dayTrades.push(recordTrade(date, addSeconds(date, 60), close, 'Signal', pnl))
            exited = true
          }
        }

      } else {
        // flat — no open position, update drawdown with cash
        updateDD(cash)
      }
    }

    // End-of-day equity
    const lastClose = minData[idxList[idxList.length - 1]].close
    const eqValue = inPosition
      ? parseFloat((positionType === 'long'
          ? cash + shares * lastClose
          : cash + shares * (2 * entryPrice - lastClose)
        ).toFixed(2))
      : parseFloat(cash.toFixed(2))
    // Only update drawdown when flat — user wants drawdown computed on closed-trade equity only
    if (!inPosition) updateDD(eqValue)

    yield { dayDate, newTrades: dayTrades, equityPoint: { date: dayDate, value: eqValue }, runningMaxDD }

    // Yield control to the browser so React can commit the state update
    await new Promise(r => setTimeout(r, 0))
  }

  // Close any open position at end of data
  if (inPosition && shares > 0) {
    const last = minData[minData.length - 1]
    const pnl  = positionType === 'long'
      ? shares * (last.close - entryPrice)
      : shares * (entryPrice - last.close)
    cash += positionType === 'long' ? shares * last.close : shares * entryPrice + pnl
    updateDD(cash)
    const t = recordTrade(last.date, addSeconds(last.date, 60), last.close, 'End of Data', pnl)
    yield {
      dayDate:     last.date.slice(0, 10),
      newTrades:   [t],
      equityPoint: { date: last.date.slice(0, 10), value: parseFloat(cash.toFixed(2)) },
      runningMaxDD,
    }
  }
}
