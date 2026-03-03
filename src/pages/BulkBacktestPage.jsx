import { useState, useRef, useEffect, useMemo } from 'react'
import BacktestForm from '../components/BacktestForm'
import CopyJsonButton from '../components/CopyJsonButton'
import { getProvider } from '../lib/providers/index.js'
import { getStrategy, strategies } from '../lib/strategies/index.js'
import { fetchDataChunked } from '../lib/providers/zerodha.js'
import { simulateBacktest, computeMetrics } from '../lib/backtestEngine'

// ── Limits (easy to update) ───────────────────────────────────────────────────
const MAX_SWEEP_VARS = 5
const MAX_SCENARIOS  = 1000

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

// Fields that don't affect signal generation — signals can be shared across scenarios
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

// Integer arithmetic to avoid floating-point drift
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
    if (values.length > MAX_SCENARIOS) break
  }
  return values
}

// Cartesian product of all variable value arrays → scenario list (capped at MAX_SCENARIOS)
function generateScenarios(vars) {
  const perVar = vars.map(v =>
    generateValues(v.from, v.to, v.step).map(val => ({ fieldId: v.field, value: val }))
  )
  if (perVar.some(arr => arr.length === 0)) return []
  const combos = perVar.reduce(
    (acc, vals) => acc.flatMap(combo => vals.map(val => [...combo, val])),
    [[]]
  )
  return combos.slice(0, MAX_SCENARIOS).map(patches => ({
    key:     patches.map(p => `${p.fieldId}=${p.value}`).join('|'),
    patches,
    status:  'pending',
    metrics: null,
  }))
}

// Count total scenarios without generating them (for preview)
function countScenarios(vars) {
  const counts = vars.map(v => generateValues(v.from, v.to, v.step).length)
  if (counts.some(c => c === 0)) return 0
  return counts.reduce((acc, c) => acc * c, 1)
}

function newVarId() { return `var-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` }

function loadOptimizeConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem(OPTIMIZE_KEY))
    if (saved?.vars) {
      // Always regenerate IDs to prevent stale duplicates from old data causing vars to share state
      return { ...saved, vars: saved.vars.map(v => ({ ...v, id: newVarId() })) }
    }
    // Migrate old single-var format
    if (saved?.field !== undefined) {
      return { vars: [{ id: newVarId(), field: saved.field, from: saved.from, to: saved.to, step: saved.step }] }
    }
  } catch {}
  return { vars: [{ id: newVarId(), field: 'target', from: 0.5, to: 5.0, step: 0.5 }] }
}

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

function applyPatches(baseParams, patches) {
  return patches.reduce((params, { fieldId, value }) => patchParams(params, fieldId, value), baseParams)
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

  // When strategy changes, reset any vars whose field no longer exists
  useEffect(() => {
    const validIds = new Set(optimizeFields.map(f => f.id))
    setOptimizeConfig(c => ({
      ...c,
      vars: c.vars.map(v => {
        if (validIds.has(v.field)) return v
        const first = optimizeFields[0]
        return { ...v, field: first.id, from: first.min, to: Math.min(first.max, parseFloat(first.min) + parseFloat(first.step) * 9), step: first.step }
      }),
    }))
  }, [optimizeFields]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Var management ──────────────────────────────────────────────────────────

  function addVar() {
    if (optimizeConfig.vars.length >= MAX_SWEEP_VARS) return
    const first = optimizeFields[0]
    setOptimizeConfig(c => ({
      ...c,
      vars: [...c.vars, { id: newVarId(), field: first.id, from: first.min, to: Math.min(first.max, parseFloat(first.min) + parseFloat(first.step) * 9), step: first.step }],
    }))
  }

  function removeVar(id) {
    if (optimizeConfig.vars.length <= 1) return
    setOptimizeConfig(c => ({ ...c, vars: c.vars.filter(v => v.id !== id) }))
  }

  function updateVarField(id, fieldId) {
    const def = optimizeFields.find(f => f.id === fieldId)
    if (!def) return
    setOptimizeConfig(c => ({
      ...c,
      vars: c.vars.map(v => v.id !== id ? v : {
        ...v, field: fieldId, from: def.min,
        to: Math.min(def.max, parseFloat(def.min) + parseFloat(def.step) * 9), step: def.step,
      }),
    }))
  }

  function updateVar(id, changes) {
    setOptimizeConfig(c => ({
      ...c,
      vars: c.vars.map(v => v.id === id ? { ...v, ...changes } : v),
    }))
  }

  // ── Run ─────────────────────────────────────────────────────────────────────

  function handleStop() {
    stopRef.current = true
    abortRef.current?.abort()
  }

  async function handleRunOptimization() {
    if (!currentForm) { setError('Configure the form above before running.'); return }

    const scenarios = generateScenarios(optimizeConfig.vars)
    if (!scenarios.length) { setError('No scenarios generated — check From / To / Step values.'); return }

    stopRef.current  = false
    abortRef.current = new AbortController()
    const abortSignal = abortRef.current.signal

    setPhase('running')
    setError(null)
    setProgress({ current: 0, total: scenarios.length })
    setScenarioResults(scenarios)

    const baseParams = formToParams(currentForm)
    const strategy   = getStrategy(baseParams.strategyId)
    const creds      = providerConfig.credentials

    try {
      // ── Fetch market data once ────────────────────────────────────────────
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

      // Share signals across all scenarios when every sweep var is a risk field
      const allRiskVars   = optimizeConfig.vars.every(v => RISK_FIELDS.has(v.field))
      const sharedSignals = allRiskVars
        ? strategy.generateSignals(stratData, baseParams.strategyParams, fromIndex)
        : null

      // ── Sweep scenarios ───────────────────────────────────────────────────
      for (let i = 0; i < scenarios.length; i++) {
        if (stopRef.current) break

        const scenario = scenarios[i]
        const params   = applyPatches(baseParams, scenario.patches)

        setScenarioResults(prev => prev.map((r, idx) => idx === i ? { ...r, status: 'running' } : r))
        setProgress({ current: i + 1, total: scenarios.length })

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

  // ── Derived ─────────────────────────────────────────────────────────────────

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

  const top5List = useMemo(
    () => sortedResults.filter(r => r.metrics).slice(0, 5).map(r => r.key),
    [sortedResults],
  )
  const top5Map = useMemo(
    () => new Map(top5List.map((k, i) => [k, i + 1])),
    [top5List],
  )

  const fieldGroups = useMemo(() => {
    const groups = {}
    for (const f of optimizeFields) {
      if (!groups[f.group]) groups[f.group] = []
      groups[f.group].push(f)
    }
    return Object.entries(groups)
  }, [optimizeFields])

  const selectedProvider = getProvider(providerConfig.providerId)
  const isRunning        = phase === 'running'
  const fullCount        = useMemo(() => countScenarios(optimizeConfig.vars), [optimizeConfig.vars])
  const previewCount     = Math.min(fullCount, MAX_SCENARIOS)
  const isCapped         = fullCount > MAX_SCENARIOS

  function renderFieldSelect(varId, selectedField) {
    return (
      <select value={selectedField} onChange={e => updateVarField(varId, e.target.value)} disabled={isRunning}>
        {fieldGroups.length === 1
          ? fieldGroups[0][1].map(f => <option key={f.id} value={f.id}>{f.label}</option>)
          : fieldGroups.map(([group, fields]) => (
              <optgroup key={group} label={group}>
                {fields.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
              </optgroup>
            ))
        }
      </select>
    )
  }

  return (
    <>
      <div className="page-header">
        <h1>Bulk Backtest</h1>
        <p>Sweep multiple parameters across ranges — all combinations run with a single click.</p>
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

        <div className="optimize-vars-list">
          {optimizeConfig.vars.map((v, idx) => {
            const fieldDef   = optimizeFields.find(f => f.id === v.field) ?? optimizeFields[0]
            const valueCount = generateValues(v.from, v.to, v.step).length
            return (
              <div key={v.id} className="optimize-var-row">
                <label className="optimize-var-field">
                  Variable {idx + 1}
                  {renderFieldSelect(v.id, v.field)}
                </label>

                <label className="optimize-var-num">
                  From
                  <input
                    type="number" value={v.from}
                    onChange={e => updateVar(v.id, { from: e.target.value })}
                    min={fieldDef?.min} step={fieldDef?.step} disabled={isRunning}
                  />
                </label>

                <label className="optimize-var-num">
                  To
                  <input
                    type="number" value={v.to}
                    onChange={e => updateVar(v.id, { to: e.target.value })}
                    min={fieldDef?.min} step={fieldDef?.step} disabled={isRunning}
                  />
                </label>

                <label className="optimize-var-num">
                  Step
                  <input
                    type="number" value={v.step}
                    onChange={e => updateVar(v.id, { step: e.target.value })}
                    min={0.0001} step={fieldDef?.step} disabled={isRunning}
                  />
                </label>

                <label className="optimize-var-count">
                  Scenario count
                  <span className="optimize-var-count-val">{valueCount}</span>
                </label>

                {optimizeConfig.vars.length > 1 && (
                  <button
                    className="optimize-var-remove"
                    onClick={() => removeVar(v.id)}
                    disabled={isRunning}
                    title="Remove variable"
                  >×</button>
                )}
              </div>
            )
          })}
        </div>

        <div className="optimize-panel-footer">
          <button
            className="add-var-btn"
            onClick={addVar}
            disabled={isRunning || optimizeConfig.vars.length >= MAX_SWEEP_VARS}
          >
            + Add variable
            {optimizeConfig.vars.length >= MAX_SWEEP_VARS && ` (max ${MAX_SWEEP_VARS})`}
          </button>

          <span className={`optimize-scenario-summary${isCapped ? ' capped' : ''}`}>
            Total Scenarios: <strong>{previewCount}</strong>
            {isCapped && <span className="optimize-cap-note"> (capped at {MAX_SCENARIOS} — full product: {fullCount})</span>}
          </span>
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
              <progress className="progress-bar" value={progress.current} max={progress.total} style={{ width: 160 }} />
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
            <h2>Results</h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <CopyJsonButton getData={() => ({
                config: {
                  ...formToParams(currentForm),
                  sweep: optimizeConfig.vars.map(v => ({
                    field: v.field,
                    label: optimizeFields.find(f => f.id === v.field)?.label ?? v.field,
                    from: v.from, to: v.to, step: v.step,
                  })),
                },
                scenarios: scenarioResults
                  .filter(r => r.metrics)
                  .map(r => ({
                    vars:    r.patches.reduce((acc, p) => ({ ...acc, [p.fieldId]: p.value }), {}),
                    metrics: r.metrics,
                  })),
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
                  {optimizeConfig.vars.map(v => {
                    const def = optimizeFields.find(f => f.id === v.field)
                    return <th key={v.id}>{def?.label ?? v.field}</th>
                  })}
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
                  const rank  = top5Map.get(row.key) ?? null
                  const isTop = rank !== null
                  return (
                    <tr
                      key={row.key}
                      className={[`optimize-row-${row.status}`, isTop ? 'optimize-row-top5' : ''].join(' ').trim()}
                    >
                      {row.patches.map((p, idx) => (
                        <td key={p.fieldId} className="optimize-value-cell">
                          {p.value}
                          {idx === 0 && isTop && <span className="top5-badge">#{rank}</span>}
                        </td>
                      ))}

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
