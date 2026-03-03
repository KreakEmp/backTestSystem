import { useState, useRef, useEffect } from 'react'
import Sidebar from './components/Sidebar'
import BacktestForm from './components/BacktestForm'
import MetricsCard from './components/MetricsCard'
import EquityChart from './components/EquityChart'
import TradeLog from './components/TradeLog'
import SettingsPage from './pages/SettingsPage'
import IndicatorPage from './pages/IndicatorPage'
import BulkBacktestPage from './pages/BulkBacktestPage'
import CopyJsonButton from './components/CopyJsonButton'
import { getProvider, providers } from './lib/providers/index.js'
import { getStrategy } from './lib/strategies/index.js'
import { fetchDataChunked } from './lib/providers/zerodha.js'
import { simulateBacktest, computeMetrics } from './lib/backtestEngine'
import './App.css'

function defaultProviderConfig() {
  return {
    providerId:  providers[0].id,
    credentials: Object.fromEntries(providers[0].credentialFields.map(f => [f.name, ''])),
  }
}

function loadProviderConfig() {
  try {
    const stored = JSON.parse(localStorage.getItem('bt_provider_config'))
    if (stored && getProvider(stored.providerId)) return stored
  } catch {}
  return defaultProviderConfig()
}

// Number of strategy-interval candles that fit in one NSE trading day (375 min session)
const CANDLES_PER_TRADING_DAY = {
  minute:    375, '3minute': 125, '5minute': 75, '10minute': 37,
  '15minute': 25, '30minute': 12, '60minute':  6,
  day: 1, week: 0.2, month: 0.05,
}

/**
 * How far before startDate to begin fetching strategy-interval data so that
 * indicators have `warmupCandles` valid historical candles by the time
 * startDate is reached.
 *
 * Uses a 2× multiplier on trading-days to account for weekends + NSE
 * holidays, plus 5 extra calendar days of safety margin.
 */
function warmupStartDate(startDate, warmupCandles, interval) {
  if (!warmupCandles) return startDate
  const cpd          = CANDLES_PER_TRADING_DAY[interval] ?? 1
  const tradingDays  = Math.ceil(warmupCandles / cpd)
  const calendarDays = Math.ceil(tradingDays * 2) + 5
  const d = new Date(startDate)
  d.setDate(d.getDate() - calendarDays)
  return d.toISOString().slice(0, 10)
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  if (h > 0) return `${h}h ${m % 60}m ${String(s % 60).padStart(2, '0')}s`
  if (m > 0) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${s}s`
}

function formatTime(date) {
  return date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export default function App() {
  const [page,           setPage]           = useState('backtest')
  const [providerConfig, setProviderConfig] = useState(loadProviderConfig)

  // ── Backtest lifecycle ───────────────────────────────────────────────────────
  // phase: 'idle' | 'fetching' | 'simulating' | 'done' | 'stopped'
  const [phase,     setPhase]     = useState('idle')
  const [startTime, setStartTime] = useState(null)   // Date
  const [endTime,   setEndTime]   = useState(null)   // Date
  const [elapsed,   setElapsed]   = useState(0)      // seconds, live-updated

  // Fetch progress
  const [fetchProgress, setFetchProgress] = useState({ minDone: 0, minTotal: 0, stratDone: 0, stratTotal: 0, label: '' })

  // Results — accumulated incrementally
  const [equityCurve, setEquityCurve] = useState([])
  const [trades,      setTrades]      = useState([])
  const [metrics,     setMetrics]     = useState(null)

  const [error,      setError]      = useState(null)
  const [lastParams, setLastParams] = useState(null)

  // Mutable refs for abort control (don't trigger re-render when changed)
  const stopRef  = useRef(false)
  const abortRef = useRef(null)

  // ── Live elapsed timer ───────────────────────────────────────────────────────
  useEffect(() => {
    const running = phase === 'fetching' || phase === 'simulating'
    if (!running || !startTime) return
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startTime.getTime()) / 1000)), 1000)
    return () => clearInterval(id)
  }, [phase, startTime])

  // ── Provider config persistence ──────────────────────────────────────────────
  function saveProviderConfig(config) {
    setProviderConfig(config)
    localStorage.setItem('bt_provider_config', JSON.stringify(config))
  }

  // ── Stop ─────────────────────────────────────────────────────────────────────
  function handleStop() {
    stopRef.current = true
    abortRef.current?.abort()
  }

  // ── Main backtest flow ───────────────────────────────────────────────────────
  async function handleSubmit(params) {
    // Reset
    stopRef.current  = false
    abortRef.current = new AbortController()
    const abortSignal = abortRef.current.signal

    setPhase('fetching')
    setStartTime(new Date())
    setEndTime(null)
    setElapsed(0)
    setError(null)
    setEquityCurve([])
    setTrades([])
    setMetrics(null)
    setFetchProgress({ minDone: 0, minTotal: 0, stratDone: 0, stratTotal: 0, label: '' })
    setLastParams(params)

    try {
      const provider = getProvider(providerConfig.providerId)
      const strategy = getStrategy(params.strategyId)
      const creds    = providerConfig.credentials

      // ── Step 1: fetch 1-min data for simulation ──────────────────────────────
      setFetchProgress(p => ({ ...p, label: 'Fetching 1-min candles…' }))
      const minData = await fetchDataChunked(
        params.ticker, params.startDate, params.endDate, creds, 'minute',
        (done, total) => setFetchProgress(p => ({ ...p, minDone: done, minTotal: total })),
        abortSignal,
      )
      if (stopRef.current) { finish('stopped'); return }

      // ── Step 2: fetch strategy-interval data for signals (with warmup) ──────
      // Extend the fetch start date far enough back so that every indicator
      // (EMA, SuperTrend, etc.) has a full history of candles by `startDate`.
      // The 1-min simulation data is unaffected — it still starts at startDate.
      const warmupCandles = strategy.warmupPeriod?.(params.strategyParams) ?? 0
      const stratFromDate = warmupStartDate(params.startDate, warmupCandles, params.interval)

      let stratData
      if (params.interval === 'minute' && stratFromDate === params.startDate) {
        // No warmup needed for 1-min strategy — reuse already-fetched minData
        stratData = minData
      } else {
        const warmupNote = stratFromDate !== params.startDate ? ` (warmup from ${stratFromDate})` : ''
        setFetchProgress(p => ({ ...p, label: `Fetching ${params.interval} candles for signals…${warmupNote}` }))
        stratData = await fetchDataChunked(
          params.ticker, stratFromDate, params.endDate, creds, params.interval,
          (done, total) => setFetchProgress(p => ({ ...p, stratDone: done, stratTotal: total })),
          abortSignal,
        )
      }
      if (stopRef.current) { finish('stopped'); return }

      if (!minData.length || !stratData.length) {
        throw new Error('No market data returned for the selected range.')
      }

      // ── Step 3: generate strategy signals from strategy-interval data ─────────
      // fromIndex = first stratData candle on/after the user's startDate.
      // Candles before it warm up the indicators but the state machine (and all
      // signal emission) only starts from this index — ensuring:
      //   • No trades are triggered from warmup-period signals
      //   • S-Trend waits for a SuperTrend flip that occurs on/after startDate
      const fromIndex = Math.max(0,
        stratData.findIndex(c => String(c.date).slice(0, 10) >= params.startDate)
      )
      const rawSignals = strategy.generateSignals(stratData, params.strategyParams, fromIndex)

      // ── Step 4: stream the simulation day-by-day ─────────────────────────────
      setPhase('simulating')

      let accEquity = []
      let accTrades = []

      const gen = simulateBacktest(minData, stratData, rawSignals, params.initialCapital,
        { ...params.riskConfig, interval: params.interval })

      for await (const { newTrades, equityPoint, runningMaxDD } of gen) {
        if (stopRef.current) break

        if (equityPoint) accEquity = [...accEquity, equityPoint]
        if (newTrades.length) accTrades = [...accTrades, ...newTrades]

        // Pass intraday max-DD from the engine — more accurate than computing from
        // end-of-day equity points (which miss intraday dips that recover by close)
        const m = computeMetrics(accEquity, params.initialCapital, runningMaxDD, accTrades)
        setEquityCurve(accEquity)
        setTrades(accTrades)
        setMetrics(m)
        // The generator already yields control (setTimeout 0) after each day,
        // so React has time to commit between iterations
      }

      finish(stopRef.current ? 'stopped' : 'done')
    } catch (err) {
      if (err.name !== 'AbortError') setError(err.message)
      finish('stopped')
    }
  }

  function finish(nextPhase) {
    setPhase(nextPhase)
    setEndTime(new Date())
  }

  // ── Derived ──────────────────────────────────────────────────────────────────
  const isRunning  = phase === 'fetching' || phase === 'simulating'
  const hasResults = equityCurve.length > 0 || trades.length > 0

  const selectedProvider = getProvider(providerConfig.providerId)

  return (
    <div className="layout">
      <Sidebar activePage={page} onNavigate={setPage} />

      <main className="main-content">
        {page === 'backtest' && (
          <>
            <div className="page-header">
              <h1>Backtest</h1>
              <p>Run a strategy against historical NSE data using 1-minute tick simulation.</p>
            </div>

            <BacktestForm
              key={providerConfig.providerId}
              onSubmit={handleSubmit}
              loading={isRunning}
              intervalOptions={selectedProvider.intervalOptions}
              defaultInterval={selectedProvider.defaultInterval}
            />

            {/* ── Run controls panel ───────────────────────────────────────── */}
            {(isRunning || phase === 'done' || phase === 'stopped') && (
              <div className="run-status-panel">
                <div className="run-status-row">
                  <span className={`run-phase-badge run-phase-${phase}`}>
                    {phase === 'fetching'   && 'Fetching data…'}
                    {phase === 'simulating' && 'Simulating…'}
                    {phase === 'done'       && 'Done'}
                    {phase === 'stopped'    && 'Stopped'}
                  </span>

                  {isRunning && (
                    <button className="stop-btn" onClick={handleStop}>Stop</button>
                  )}

                  <span className="run-elapsed">
                    {startTime && `Started ${formatTime(startTime)}`}
                    {' · '}
                    {isRunning
                      ? formatDuration(elapsed * 1000)
                      : endTime && startTime
                        ? `completed in ${formatDuration(endTime - startTime)}`
                        : ''}
                  </span>
                </div>

                {/* Fetch progress bars */}
                {phase === 'fetching' && (
                  <div className="fetch-progress">
                    {fetchProgress.label && (
                      <p className="fetch-label">{fetchProgress.label}</p>
                    )}
                    {fetchProgress.minTotal > 0 && (
                      <div className="progress-row">
                        <span className="progress-label">1-min data</span>
                        <progress className="progress-bar" value={fetchProgress.minDone} max={fetchProgress.minTotal} />
                        <span className="progress-frac">{Math.round(fetchProgress.minDone / fetchProgress.minTotal * 100)}%</span>
                      </div>
                    )}
                    {fetchProgress.stratTotal > 0 && (
                      <div className="progress-row">
                        <span className="progress-label">{lastParams?.interval} data</span>
                        <progress className="progress-bar" value={fetchProgress.stratDone} max={fetchProgress.stratTotal} />
                        <span className="progress-frac">{Math.round(fetchProgress.stratDone / fetchProgress.stratTotal * 100)}%</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {error && <div className="error-banner">{error}</div>}

            {/* ── Progressive results ────────────────────────────────────────── */}
            {hasResults && lastParams && (
              <section className="results">
                <div className="results-header">
                  <h2>
                    Results — {lastParams.ticker}&nbsp;
                    <span className="subtitle">
                      {getStrategy(lastParams.strategyId).name}&nbsp;·&nbsp;
                      signals from {lastParams.interval} candles&nbsp;·&nbsp;
                      {lastParams.startDate} → {lastParams.endDate}
                      {isRunning && <span className="sim-live-badge">live</span>}
                    </span>
                  </h2>
                  {!isRunning && metrics && (
                    <CopyJsonButton getData={() => ({ config: lastParams, metrics })} />
                  )}
                </div>
                {metrics && <MetricsCard metrics={metrics} />}
                {equityCurve.length > 1 && <EquityChart equityCurve={equityCurve} />}
                <TradeLog trades={trades} />
              </section>
            )}
          </>
        )}

        {page === 'bulk' && (
          <BulkBacktestPage providerConfig={providerConfig} />
        )}

        {page === 'indicators' && <IndicatorPage />}

        {page === 'settings' && (
          <SettingsPage
            providerConfig={providerConfig}
            onSave={saveProviderConfig}
          />
        )}
      </main>
    </div>
  )
}
