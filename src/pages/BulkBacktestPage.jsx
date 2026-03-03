import { useState, useRef, useEffect, useMemo } from 'react'
import BacktestForm from '../components/BacktestForm'
import CopyJsonButton from '../components/CopyJsonButton'
import { getProvider } from '../lib/providers/index.js'
import { getStrategy, strategies } from '../lib/strategies/index.js'
import { fetchDataChunked } from '../lib/providers/zerodha.js'
import { simulateBacktest, computeMetrics } from '../lib/backtestEngine'

const OPTIMIZE_KEY = 'bt_bulk_optimize'

const CANDLES_PER_TRADING_DAY = {
  minute: 375, '3minute': 125, '5minute': 75, '10minute': 37,
  '15minute': 25, '30minute': 12, '60minute': 6,
  day: 1, week: 0.2, month: 0.05,
}

function warmupStartDate(startDate, warmupCandles, interval) {
  if (!warmupCandles) return startDate
  const cpd          = CANDLES_PER_TRADING_DAY[interval] ?? 1
  const tradingDays  = Math.ceil(warmupCandles / cpd)
  const calendarDays = Math.ceil(tradingDays * 2) + 5
  const d = new Date(startDate)
  d.setDate(d.getDate() - calendarDays)
  return d.toISOString().slice(0, 10)
}

// Fields whose values don't affect signal generation — data can be fetched once
const RISK_FIELDS = new Set(['stopLoss', 'target', 'quantity'])

const BASE_OPT_FIELDS = [
  { id: 'stopLoss', label: 'Stop Loss %', min: 0.1, max: 20,  step: 0.1, group: 'Risk Config' },
  { id: 'target',   label: 'Target %',   min: 0.1, max: 50,  step: 0.1, group: 'Risk Config' },
]

function getOptimizeFields(strategyId) {
  const strategy    = strategies.find(s => s.id === strategyId)
  const stratFields = (strategy?.paramFields ?? [])
    .filter(f => f.type === 'number')
    .map(f => ({ id: f.name, label: f.label, min: f.min ?? 1, max: f.max ?? 100, step: f.step ?? 1, group: strategy.name }))
  return [...BASE_OPT_FIELDS, ...stratFields]
}

// Integer arithmetic to avoid floating-point drift in the sweep loop
function generateValues(from, to, step) {
  const f = parseFloat(from), t = parseFloat(to), s = parseFloat(step)
  if (!isFinite(f) || !isFinite(t) || !isFinite(s) || s <= 0 || f > t) return []
  const decimals = Math.max(
    (String(s).split('.')[1] ?? '').length,
    (String(f).split('.')[1] ?? '').length,
  )
  const mult  = Math.pow(10, decimals)
  const iFrom = Math.round(f * mult)
  const iTo   = Math.round(t * mult)
  const iStep = Math.round(s * mult)
  const values = []
  for (let v = iFrom; v <= iTo; v += iStep) {
    values.push(v / mult)
    if (values.length > 500) break
  }
  return values
}

function loadOptimizeConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem(OPTIMIZE_KEY))
    if (saved) return saved
  } catch {}
  return { field: 'target', from: 0.5, to: 5.0, step: 0.5 }
}

// Mirror of BacktestForm's handleSubmit transformation
function formToParams(form) {
  return {
    ticker:         form.ticker,
    startDate:      form.startDate,
    endDate:        form.endDate,
    initialCapital: parseFloat(form.initialCapital),
    riskConfig: {
      stopLoss:       parseFloat(form.stopLoss)   || 0,
      target:         parseFloat(form.target)     || 0,
      quantity:       parseInt(form.quantity, 10) || 0,
      direction:      form.tradeDirection,
      tradeMode:      form.tradeMode,
      tradeStartTime: form.tradeMode === 'intraday' ? form.tradeStartTime : null,
      tradeEndTime:   form.tradeMode === 'intraday' ? form.tradeEndTime   : null,
    },
    strategyId:     form.strategyId,
    interval:       form.interval,
    strategyParams: { ...form.strategyParams },
  }
}

function patchParams(baseParams, fieldId, value) {
  if (RISK_FIELDS.has(fieldId)) {
    return { ...baseParams, riskConfig: { ...baseParams.riskConfig, [fieldId]: value } }
  }
  return { ...baseParams, strategyParams: { ...baseParams.strategyParams, [fieldId]: value } }
}

function money(v) {
  return parseFloat(v).toLocaleString('en-IN', { maximumFractionDigits: 0 })
}

const SORT_COLS = [
  { id: 'totalPnl',        label: 'Total P&L',  asc: false },
  { id: 'totalReturn',     label: 'Return %',   asc: false },
  { id: 'accuracy',        label: 'Accuracy',   asc: false },
  { id: 'expectancy',      label: 'Expectancy', asc: false },
  { id: 'rewardRiskRatio', label: 'R:R',        asc: false },
  { id: 'maxDrawdown',     label: 'Max DD %',   asc: true  },
]

export default function BulkBacktestPage({ providerConfig }) {
  const [currentForm,     setCurrentForm]     = useState(null)
  const [optimizeConfig,  setOptimizeConfig]  = useState(loadOptimizeConfig)
  const [phase,           setPhase]           = useState('idle')
  const [progress,        setProgress]        = useState({ current: 0, total: 0 })
  const [scenarioResults, setScenarioResults] = useState([])
  const [error,           setError]           = useState(null)
  const [sortBy,          setSortBy]          = useState('totalPnl')

  const stopRef  = useRef(false)
  const abortRef = useRef(null)

  useEffect(() => {
    localStorage.setItem(OPTIMIZE_KEY, JSON.stringify(optimizeConfig))
  }, [optimizeConfig])

  const optimizeFields = useMemo(
    () => currentForm ? getOptimizeFields(currentForm.strategyId) : BASE_OPT_FIELDS,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentForm?.strategyId],
  )

  // If the selected optimize field doesn't exist for the newly selected strategy, reset to first
  useEffect(() => {
    if (!optimizeFields.find(f => f.id === optimizeConfig.field)) {
      const first = optimizeFields[0]
      setOptimizeConfig(c => ({
        ...c,
        field: first.id,
        from:  first.min,
        to:    Math.min(first.max, parseFloat(first.min) + parseFloat(first.step) * 9),
        step:  first.step,
      }))
    }
  }, [optimizeFields]) // eslint-disable-line react-hooks/exhaustive-deps

  function handleOptimizeFieldChange(fieldId) {
    const def = optimizeFields.find(f => f.id === fieldId)
    if (!def) return
    setOptimizeConfig(c => ({
      ...c,
      field: fieldId,
      from:  def.min,
      to:    Math.min(def.max, parseFloat(def.min) + parseFloat(def.step) * 9),
      step:  def.step,
    }))
  }

  function handleStop() {
    stopRef.current = true
    abortRef.current?.abort()
  }

  async function handleRunOptimization() {
    if (!currentForm) { setError('Configure the form above before running.'); return }

    const values = generateValues(optimizeConfig.from, optimizeConfig.to, optimizeConfig.step)
    if (!values.length) { setError('No scenarios generated — check From / To / Step.'); return }

    stopRef.current  = false
    abortRef.current = new AbortController()
    const abortSignal = abortRef.current.signal

    setPhase('running')
    setError(null)
    setProgress({ current: 0, total: values.length })
    setScenarioResults(values.map(v => ({ value: v, status: 'pending', metrics: null })))

    const baseParams = formToParams(currentForm)
    const strategy   = getStrategy(baseParams.strategyId)
    const creds      = providerConfig.credentials

    try {
      // ── Fetch market data once ──────────────────────────────────────────────
      const minData = await fetchDataChunked(
        baseParams.ticker, baseParams.startDate, baseParams.endDate, creds, 'minute',
        () => {}, abortSignal,
      )
      if (stopRef.current) { setPhase('stopped'); return }

      const warmupCandles = strategy.warmupPeriod?.(baseParams.strategyParams) ?? 0
      const stratFromDate = warmupStartDate(baseParams.startDate, warmupCandles, baseParams.interval)

      let stratData
      if (baseParams.interval === 'minute' && stratFromDate === baseParams.startDate) {
        stratData = minData
      } else {
        stratData = await fetchDataChunked(
          baseParams.ticker, stratFromDate, baseParams.endDate, creds, baseParams.interval,
          () => {}, abortSignal,
        )
      }
      if (stopRef.current) { setPhase('stopped'); return }

      if (!minData.length || !stratData.length) {
        throw new Error('No market data returned for the selected range.')
      }

      const fromIndex = Math.max(0,
        stratData.findIndex(c => String(c.date).slice(0, 10) >= baseParams.startDate)
      )

      // Pre-generate signals once when optimizing a risk-only field (signals are unaffected)
      const isRiskField    = RISK_FIELDS.has(optimizeConfig.field)
      const sharedSignals  = isRiskField
        ? strategy.generateSignals(stratData, baseParams.strategyParams, fromIndex)
        : null

      // ── Sweep one scenario per value ────────────────────────────────────────
      for (let i = 0; i < values.length; i++) {
        if (stopRef.current) break

        const value  = values[i]
        const params = patchParams(baseParams, optimizeConfig.field, value)

        setScenarioResults(prev => prev.map((r, idx) => idx === i ? { ...r, status: 'running' } : r))
        setProgress({ current: i + 1, total: values.length })

        const signals = sharedSignals
          ?? strategy.generateSignals(stratData, params.strategyParams, fromIndex)

        let accEquity = [], accTrades = [], runningMaxDD = 0
        try {
          const gen = simulateBacktest(
            minData, stratData, signals, params.initialCapital,
            { ...params.riskConfig, interval: params.interval },
          )
          for await (const tick of gen) {
            if (stopRef.current) break
            if (tick.equityPoint)      accEquity = [...accEquity, tick.equityPoint]
            if (tick.newTrades.length) accTrades = [...accTrades, ...tick.newTrades]
            runningMaxDD = tick.runningMaxDD
          }
          const metrics = computeMetrics(accEquity, params.initialCapital, runningMaxDD, accTrades)
          setScenarioResults(prev =>
            prev.map((r, idx) => idx === i ? { ...r, status: 'done', metrics } : r)
          )
        } catch (err) {
          if (err.name !== 'AbortError') {
            setScenarioResults(prev =>
              prev.map((r, idx) => idx === i ? { ...r, status: 'failed' } : r)
            )
          }
        }
      }

      setPhase(stopRef.current ? 'stopped' : 'done')
    } catch (err) {
      if (err.name !== 'AbortError') setError(err.message)
      setPhase('stopped')
    }
  }

  // Sort results; pending/running rows sink to the bottom
  const sortedResults = useMemo(() => {
    const col = SORT_COLS.find(c => c.id === sortBy)
    return [...scenarioResults].sort((a, b) => {
      if (!a.metrics && !b.metrics) return 0
      if (!a.metrics) return 1
      if (!b.metrics) return -1
      const av = parseFloat(a.metrics[sortBy] ?? 0)
      const bv = parseFloat(b.metrics[sortBy] ?? 0)
      return col?.asc ? av - bv : bv - av
    })
  }, [scenarioResults, sortBy])

  // Ordered top-5 for rank badges
  const top5List = useMemo(
    () => sortedResults.filter(r => r.metrics).slice(0, 5).map(r => r.value),
    [sortedResults],
  )
  const top5Map = useMemo(
    () => new Map(top5List.map((v, i) => [v, i + 1])),
    [top5List],
  )

  const selectedProvider = getProvider(providerConfig.providerId)
  const currentOptField  = optimizeFields.find(f => f.id === optimizeConfig.field) ?? optimizeFields[0]
  const isRunning        = phase === 'running'
  const previewCount     = generateValues(optimizeConfig.from, optimizeConfig.to, optimizeConfig.step).length

  // Group fields for <optgroup> rendering
  const fieldGroups = useMemo(() => {
    const groups = {}
    for (const f of optimizeFields) {
      if (!groups[f.group]) groups[f.group] = []
      groups[f.group].push(f)
    }
    return Object.entries(groups)
  }, [optimizeFields])

  return (
    <>
      <div className="page-header">
        <h1>Bulk Backtest</h1>
        <p>Sweep a single parameter across a range and compare all scenario results side-by-side.</p>
      </div>

      <BacktestForm
        key={providerConfig.providerId}
        storageKey="bt_bulk_form"
        onSubmit={() => {}}
        onChange={setCurrentForm}
        loading={isRunning}
        hideSubmit
        intervalOptions={selectedProvider.intervalOptions}
        defaultInterval={selectedProvider.defaultInterval}
      />

      {/* ── Parameter Sweep Config ──────────────────────────────────────────── */}
      <div className="optimize-panel">
        <span className="strategy-params-title">Parameter Sweep</span>

        <div className="form-row">
          <label>
            Optimize Field
            <select
              value={optimizeConfig.field}
              onChange={e => handleOptimizeFieldChange(e.target.value)}
              disabled={isRunning}
            >
              {fieldGroups.length === 1
                ? fieldGroups[0][1].map(f => <option key={f.id} value={f.id}>{f.label}</option>)
                : fieldGroups.map(([group, fields]) => (
                    <optgroup key={group} label={group}>
                      {fields.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
                    </optgroup>
                  ))
              }
            </select>
          </label>

          <label>
            From
            <input
              type="number"
              value={optimizeConfig.from}
              onChange={e => setOptimizeConfig(c => ({ ...c, from: e.target.value }))}
              min={currentOptField?.min}
              step={currentOptField?.step}
              disabled={isRunning}
            />
          </label>

          <label>
            To
            <input
              type="number"
              value={optimizeConfig.to}
              onChange={e => setOptimizeConfig(c => ({ ...c, to: e.target.value }))}
              min={currentOptField?.min}
              step={currentOptField?.step}
              disabled={isRunning}
            />
          </label>

          <label>
            Step
            <input
              type="number"
              value={optimizeConfig.step}
              onChange={e => setOptimizeConfig(c => ({ ...c, step: e.target.value }))}
              min={0.0001}
              step={currentOptField?.step}
              disabled={isRunning}
            />
          </label>

          <div className="optimize-scenario-count">
            <strong>{previewCount}</strong> scenario{previewCount !== 1 ? 's' : ''}
          </div>
        </div>

        <div className="optimize-actions">
          {!isRunning ? (
            <button
              className="optimize-run-btn"
              onClick={handleRunOptimization}
              disabled={!currentForm || previewCount === 0}
            >
              Run {previewCount} Scenario{previewCount !== 1 ? 's' : ''}
            </button>
          ) : (
            <div className="optimize-progress-row">
              <span className="run-phase-badge run-phase-simulating">
                Running {progress.current} / {progress.total}
              </span>
              <progress
                className="progress-bar"
                value={progress.current}
                max={progress.total}
                style={{ width: 160 }}
              />
              <span className="progress-frac">
                {Math.round(progress.current / progress.total * 100)}%
              </span>
              <button className="stop-btn" onClick={handleStop}>Stop</button>
            </div>
          )}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {/* ── Results Table ────────────────────────────────────────────────────── */}
      {scenarioResults.length > 0 && (
        <section className="optimize-results">
          <div className="optimize-results-header">
            <h2>Results — {currentOptField?.label}</h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <CopyJsonButton getData={() => ({
                config: {
                  ...formToParams(currentForm),
                  sweep: optimizeConfig,
                },
                scenarios: scenarioResults
                  .filter(r => r.metrics)
                  .map(r => ({ value: r.value, metrics: r.metrics })),
              })} />
              <div className="sort-control">
                <span>Sort by</span>
                <select value={sortBy} onChange={e => setSortBy(e.target.value)}>
                  {SORT_COLS.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                </select>
              </div>
            </div>
          </div>

          <div className="optimize-table-wrap">
            <table className="optimize-table">
              <thead>
                <tr>
                  <th>{currentOptField?.label}</th>
                  <th>Total P&amp;L</th>
                  <th>Return %</th>
                  <th>Accuracy</th>
                  <th>Trades</th>
                  <th>R:R</th>
                  <th>Expectancy</th>
                  <th>Max DD %</th>
                </tr>
              </thead>
              <tbody>
                {sortedResults.map(row => {
                  const rank  = top5Map.get(row.value) ?? null
                  const isTop = rank !== null
                  return (
                    <tr
                      key={row.value}
                      className={[
                        `optimize-row-${row.status}`,
                        isTop ? 'optimize-row-top5' : '',
                      ].join(' ').trim()}
                    >
                      <td className="optimize-value-cell">
                        {row.value}
                        {isTop && <span className="top5-badge">#{rank}</span>}
                      </td>

                      {row.status === 'running' && (
                        <td colSpan={7} className="optimize-cell-status" style={{ color: '#60a5fa' }}>Running…</td>
                      )}
                      {row.status === 'pending' && (
                        <td colSpan={7} className="optimize-cell-status td-muted">—</td>
                      )}
                      {row.status === 'failed' && (
                        <td colSpan={7} className="optimize-cell-status negative">Failed</td>
                      )}

                      {row.status === 'done' && row.metrics && <>
                        <td className={parseFloat(row.metrics.totalPnl) >= 0 ? 'positive' : 'negative'}>
                          {parseFloat(row.metrics.totalPnl) >= 0 ? '+' : ''}₹{money(row.metrics.totalPnl)}
                        </td>
                        <td className={parseFloat(row.metrics.totalReturn) >= 0 ? 'positive' : 'negative'}>
                          {parseFloat(row.metrics.totalReturn) >= 0 ? '+' : ''}{row.metrics.totalReturn}%
                        </td>
                        <td>{row.metrics.accuracy}%</td>
                        <td>
                          <span className="positive">{row.metrics.winCount}W</span>
                          <span className="td-muted"> / </span>
                          <span className="negative">{row.metrics.lossCount}L</span>
                        </td>
                        <td>{row.metrics.rewardRiskRatio !== null ? `${row.metrics.rewardRiskRatio}:1` : '—'}</td>
                        <td className={parseFloat(row.metrics.expectancy) >= 0 ? 'positive' : 'negative'}>
                          {parseFloat(row.metrics.expectancy) >= 0 ? '+' : ''}{parseFloat(row.metrics.expectancy).toFixed(2)}R
                        </td>
                        <td className="negative">-{row.metrics.maxDrawdown}%</td>
                      </>}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {(phase === 'done' || phase === 'stopped') && scenarioResults.some(r => r.metrics) && (
            <p className="optimize-done-note">
              Top 5 by {SORT_COLS.find(c => c.id === sortBy)?.label} highlighted.
              {phase === 'stopped' && ' Run stopped early.'}
            </p>
          )}
        </section>
      )}
    </>
  )
}
