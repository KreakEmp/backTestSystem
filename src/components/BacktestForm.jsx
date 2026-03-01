import { useState, useEffect } from 'react'
import { strategies } from '../lib/strategies/index.js'
import { INDICES, NIFTY50_STOCKS } from '../lib/instruments.js'

const today = new Date().toISOString().split('T')[0]
const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

const FORM_KEY = 'bt_backtest_form'

function defaultStrategyParams(strategy) {
  return Object.fromEntries(strategy.paramFields.map(f => [f.name, f.default]))
}

function loadForm(defaultInterval) {
  try {
    const saved = JSON.parse(localStorage.getItem(FORM_KEY))
    if (saved && strategies.find(s => s.id === saved.strategyId)) {
      const strategy = strategies.find(s => s.id === saved.strategyId)
      return {
        ...saved,
        // merge in any new strategy params that didn't exist when saved
        strategyParams: { ...defaultStrategyParams(strategy), ...saved.strategyParams },
      }
    }
  } catch {}
  const s = strategies[0]
  return {
    ticker:         'NIFTY 50',
    startDate:      oneYearAgo,
    endDate:        today,
    initialCapital: 100000,
    stopLoss:       0,
    target:         0,
    strategyId:     s.id,
    interval:       defaultInterval,
    strategyParams: defaultStrategyParams(s),
  }
}

export default function BacktestForm({ onSubmit, loading, intervalOptions, defaultInterval }) {
  const [form, setForm] = useState(() => loadForm(defaultInterval))

  useEffect(() => {
    localStorage.setItem(FORM_KEY, JSON.stringify(form))
  }, [form])

  const selectedStrategy = strategies.find(s => s.id === form.strategyId)

  function handleBase(e) {
    setForm(f => ({ ...f, [e.target.name]: e.target.value }))
  }

  function handleStrategyChange(e) {
    const strategy = strategies.find(s => s.id === e.target.value)
    setForm(f => ({ ...f, strategyId: strategy.id, strategyParams: defaultStrategyParams(strategy) }))
  }

  function handleStrategyParam(e) {
    setForm(f => ({ ...f, strategyParams: { ...f.strategyParams, [e.target.name]: e.target.value } }))
  }

  function handleSubmit(e) {
    e.preventDefault()
    onSubmit({
      ticker:         form.ticker,
      startDate:      form.startDate,
      endDate:        form.endDate,
      initialCapital: parseFloat(form.initialCapital),
      riskConfig: {
        stopLoss: parseFloat(form.stopLoss) || 0,
        target:   parseFloat(form.target)   || 0,
      },
      strategyId:     form.strategyId,
      interval:       form.interval,
      strategyParams: form.strategyParams,
    })
  }

  return (
    <form onSubmit={handleSubmit} className="backtest-form">

      {/* Instrument + dates + capital */}
      <div className="form-row">
        <label className="ticker-label">
          Instrument
          <select name="ticker" value={form.ticker} onChange={handleBase}>
            <optgroup label="── Indices ──">
              {INDICES.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </optgroup>
            <optgroup label="── Nifty 50 Stocks ──">
              {NIFTY50_STOCKS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </optgroup>
          </select>
        </label>
        <label>
          Start Date
          <input type="date" name="startDate" value={form.startDate} onChange={handleBase} required />
        </label>
        <label>
          End Date
          <input type="date" name="endDate" value={form.endDate} onChange={handleBase} required />
        </label>
        <label>
          Initial Capital (₹)
          <input type="number" name="initialCapital" value={form.initialCapital} onChange={handleBase} min={1000} required />
        </label>
      </div>

      {/* Candle timeframe + strategy + strategy params */}
      <div className="form-row">
        <label>
          Candle Timeframe
          <select name="interval" value={form.interval} onChange={handleBase}>
            {intervalOptions.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <label>
          Strategy
          <select value={form.strategyId} onChange={handleStrategyChange}>
            {strategies.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        {selectedStrategy.paramFields.map(field => (
          <label key={field.name}>
            {field.label}
            {field.type === 'select' ? (
              <select name={field.name} value={form.strategyParams[field.name]} onChange={handleStrategyParam}>
                {field.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            ) : (
              <input
                type={field.type}
                name={field.name}
                value={form.strategyParams[field.name]}
                onChange={handleStrategyParam}
                min={field.min}
                max={field.max}
                required
              />
            )}
          </label>
        ))}
      </div>

      {/* Risk config */}
      <div className="form-row">
        <label>
          Stop Loss %
          <input
            type="number" name="stopLoss" value={form.stopLoss} onChange={handleBase}
            min={0} max={100} step={0.1} placeholder="0 = hold until trend change"
          />
        </label>
        <label>
          Target %
          <input
            type="number" name="target" value={form.target} onChange={handleBase}
            min={0} max={1000} step={0.1} placeholder="0 = hold until trend change"
          />
        </label>
        <div className="risk-hint">
          Set both to <strong>0</strong> to hold until the strategy signals a trend change.
        </div>
      </div>

      <button type="submit" disabled={loading}>
        {loading ? 'Running…' : 'Run Backtest'}
      </button>
    </form>
  )
}
