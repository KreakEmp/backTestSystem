import { useState, useEffect } from 'react'
import {
  ComposedChart, Bar, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts'
import { strategies, getStrategy } from '../lib/strategies/index.js'
import { fetchDataChunked } from '../lib/providers/zerodha.js'
import { computeMA, computeSuperTrend } from '../lib/indicators.js'
import { INDICES, NIFTY50_STOCKS } from '../lib/instruments.js'

// ── Constants / helpers (mirrored from App.jsx) ───────────────────────────────

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

// ── Indicator series computation ──────────────────────────────────────────────
// Returns { series: [{ key, label, color }], keys: per-candle indicator values }

function computeIndicatorSeries(strategyId, data, params) {
  const closes = data.map(d => d.close)

  if (strategyId === 'maCrossover') {
    const maType      = params.maType ?? 'SMA'
    const shortPeriod = Number(params.shortPeriod)
    const longPeriod  = Number(params.longPeriod)
    const shortMA = computeMA(closes, shortPeriod, maType)
    const longMA  = computeMA(closes, longPeriod,  maType)
    const shortKey = `${maType}${shortPeriod}`
    const longKey  = `${maType}${longPeriod}`
    return {
      series: [
        { key: shortKey, label: `${maType} ${shortPeriod}`, color: '#60a5fa' },
        { key: longKey,  label: `${maType} ${longPeriod}`,  color: '#fbbf24' },
      ],
      keys: data.map((_, i) => ({ [shortKey]: shortMA[i], [longKey]: longMA[i] })),
    }
  }

  if (strategyId === 'sTrend') {
    const emaSmall = computeMA(closes, Number(params.emaSmall), 'EMA')
    const emaLarge = computeMA(closes, Number(params.emaLarge), 'EMA')
    const st       = computeSuperTrend(data, Number(params.stPeriod), Number(params.stMultiplier))
    return {
      series: [
        { key: 'emaSmall', label: `EMA ${params.emaSmall}`, color: '#60a5fa' },
        { key: 'emaLarge', label: `EMA ${params.emaLarge}`, color: '#fbbf24' },
        { key: 'stBull',   label: 'ST Bullish',             color: '#4ade80' },
        { key: 'stBear',   label: 'ST Bearish',             color: '#f87171' },
      ],
      keys: data.map((_, i) => ({
        emaSmall: emaSmall[i],
        emaLarge: emaLarge[i],
        stBull: st[i]?.direction ===  1 ? st[i].value : null,
        stBear: st[i]?.direction === -1 ? st[i].value : null,
      })),
    }
  }

  return { series: [], keys: data.map(() => ({})) }
}

// ── Custom candlestick shape for Recharts Bar ─────────────────────────────────
// The Bar uses dataKey="ohlcRange" → [low, high], so:
//   y         = pixel position of high (top of bar)
//   y+height  = pixel position of low  (bottom of bar)
// open/high/low/close come from the full data entry passed as props.

function CandleShape({ x, y, width, height, open, high, low, close }) {
  if (!height || height <= 0 || !width || width <= 0) return null
  const range  = high - low
  const isBull = close >= open
  const color  = isBull ? '#26a65b' : '#e74c3c'
  const cx = x + width / 2
  const bw = Math.max(1, width - 2)

  if (!range) {
    return <rect x={Math.round(cx - bw / 2)} y={y} width={bw} height={1} fill={color} />
  }

  const bodyTopPx    = y + height * (high - Math.max(open, close)) / range
  const bodyHeightPx = Math.max(1, height * Math.abs(close - open) / range)

  return (
    <g>
      {/* Wick: full high-to-low line */}
      <line x1={cx} y1={y} x2={cx} y2={y + height} stroke={color} strokeWidth={1} />
      {/* Body: open-to-close rectangle */}
      <rect
        x={Math.round(cx - bw / 2)}
        y={bodyTopPx}
        width={bw}
        height={bodyHeightPx}
        fill={color}
      />
    </g>
  )
}

// ── Signal marker shapes ──────────────────────────────────────────────────────

function BuyDot({ cx, cy }) {
  if (cx == null || cy == null) return null
  return (
    <polygon
      points={`${cx},${cy - 8} ${cx - 5},${cy + 2} ${cx + 5},${cy + 2}`}
      fill="#4ade80"
    />
  )
}

function SellDot({ cx, cy }) {
  if (cx == null || cy == null) return null
  return (
    <polygon
      points={`${cx},${cy + 8} ${cx - 5},${cy - 2} ${cx + 5},${cy - 2}`}
      fill="#f87171"
    />
  )
}

// ── Tooltip ───────────────────────────────────────────────────────────────────

function OHLCTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload
  if (!d) return null
  const fmt = v => v != null
    ? Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 })
    : '—'

  const indLines = payload.filter(p =>
    p.dataKey !== 'ohlcRange' &&
    p.dataKey !== 'signalBuy' &&
    p.dataKey !== 'signalSell' &&
    p.value != null
  )

  return (
    <div className="ohlc-tooltip">
      <div className="ohlc-tooltip-date">{label}</div>
      <div className="ohlc-tooltip-ohlc">
        <span>O: {fmt(d.open)}</span>
        <span>H: {fmt(d.high)}</span>
        <span>L: {fmt(d.low)}</span>
        <span className={d.close >= d.open ? 'positive' : 'negative'}>C: {fmt(d.close)}</span>
      </div>
      {indLines.map(p => (
        <div key={p.dataKey} className="ohlc-tooltip-ind" style={{ color: p.stroke || p.color }}>
          {p.name}: {fmt(p.value)}
        </div>
      ))}
    </div>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtLabel(dateStr, interval) {
  const s = String(dateStr)
  if (['day', 'week', 'month'].includes(interval)) return s.slice(0, 10)
  return s.slice(0, 16).replace('T', ' ')
}

function defaultParams(strategy) {
  return Object.fromEntries(strategy.paramFields.map(f => [f.name, f.default]))
}

const FORM_KEY = 'bt_indicator_form'

const today          = new Date().toISOString().split('T')[0]
const threeMonthsAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

function loadForm() {
  try {
    const saved = JSON.parse(localStorage.getItem(FORM_KEY))
    if (saved && getStrategy(saved.strategyId)) {
      const strategy = getStrategy(saved.strategyId)
      return {
        ...saved,
        strategyParams: { ...defaultParams(strategy), ...saved.strategyParams },
      }
    }
  } catch {}
  const s = strategies[0]
  return {
    ticker:         'NIFTY 50',
    startDate:      threeMonthsAgo,
    endDate:        today,
    interval:       'day',
    strategyId:     s.id,
    strategyParams: defaultParams(s),
  }
}

const INTERVAL_OPTIONS = [
  { value: 'minute',    label: '1 Minute'  },
  { value: '3minute',   label: '3 Minutes' },
  { value: '5minute',   label: '5 Minutes' },
  { value: '10minute',  label: '10 Minutes'},
  { value: '15minute',  label: '15 Minutes'},
  { value: '30minute',  label: '30 Minutes'},
  { value: '60minute',  label: '60 Minutes'},
  { value: 'day',       label: 'Daily'     },
  { value: 'week',      label: 'Weekly'    },
  { value: 'month',     label: 'Monthly'   },
]

// ── Page component ────────────────────────────────────────────────────────────

export default function IndicatorPage() {
  const [form, setForm] = useState(loadForm)

  useEffect(() => {
    localStorage.setItem(FORM_KEY, JSON.stringify(form))
  }, [form])

  const [phase,     setPhase]     = useState('idle')  // 'idle'|'fetching'|'done'|'error'
  const [error,     setError]     = useState(null)
  const [statusMsg, setStatusMsg] = useState('')
  const [chartData, setChartData] = useState([])
  const [indSeries, setIndSeries] = useState([])

  const selectedStrategy = getStrategy(form.strategyId)

  function handleBase(e) {
    setForm(f => ({ ...f, [e.target.name]: e.target.value }))
  }

  function handleStrategyChange(e) {
    const s = getStrategy(e.target.value)
    setForm(f => ({ ...f, strategyId: s.id, strategyParams: defaultParams(s) }))
  }

  function handleParam(e) {
    setForm(f => ({ ...f, strategyParams: { ...f.strategyParams, [e.target.name]: e.target.value } }))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setPhase('fetching')
    setError(null)
    setChartData([])
    setIndSeries([])

    try {
      const storedConfig = (() => {
        try { return JSON.parse(localStorage.getItem('bt_provider_config') ?? '{}') } catch { return {} }
      })()
      const creds = storedConfig.credentials ?? {}

      const strategy      = getStrategy(form.strategyId)
      const warmupCandles = strategy.warmupPeriod?.(form.strategyParams) ?? 0
      const fetchFrom     = warmupStartDate(form.startDate, warmupCandles, form.interval)
      const warmupNote    = fetchFrom !== form.startDate ? ` (warmup from ${fetchFrom})` : ''
      setStatusMsg(`Fetching ${form.interval} data…${warmupNote}`)

      const allData = await fetchDataChunked(
        form.ticker, fetchFrom, form.endDate, creds, form.interval,
        () => {},
      )

      if (!allData.length) throw new Error('No data returned for the selected range.')

      // fromIndex: first candle on/after startDate (warmup candles before this are indicator-only)
      const fromIndex = Math.max(0,
        allData.findIndex(c => String(c.date).slice(0, 10) >= form.startDate)
      )

      setStatusMsg('Computing indicators and signals…')

      const { series, keys } = computeIndicatorSeries(form.strategyId, allData, form.strategyParams)
      const signals = strategy.generateSignals(allData, form.strategyParams, fromIndex)

      // Build display data: only candles from startDate onward, with indicator values
      // Signal markers show only the ENTRY candle of each run (first in consecutive run)
      let prevSig = null
      const built = allData.slice(fromIndex).map((candle, idx) => {
        const i   = fromIndex + idx
        const sig = signals[i]
        const isEntryBuy  = sig === 'BUY'  && prevSig !== 'BUY'
        const isEntrySell = sig === 'SELL' && prevSig !== 'SELL'
        prevSig = sig
        return {
          date:      fmtLabel(candle.date, form.interval),
          open:      candle.open,
          high:      candle.high,
          low:       candle.low,
          close:     candle.close,
          ohlcRange: [candle.low, candle.high],
          ...keys[i],
          signalBuy:  isEntryBuy  ? candle.low  * 0.997 : null,
          signalSell: isEntrySell ? candle.high * 1.003 : null,
        }
      })

      setChartData(built)
      setIndSeries(series)
      setPhase('done')
      setStatusMsg('')
    } catch (err) {
      setError(err.message)
      setPhase('error')
      setStatusMsg('')
    }
  }

  const yMin = chartData.length ? Math.min(...chartData.map(d => d.low))  * 0.999 : 'auto'
  const yMax = chartData.length ? Math.max(...chartData.map(d => d.high)) * 1.001 : 'auto'

  return (
    <div>
      <div className="page-header">
        <h1>Indicator Chart</h1>
        <p>Plot strategy indicators and signals on candlestick data to validate indicator logic.</p>
      </div>

      <form onSubmit={handleSubmit} className="backtest-form">
        <div className="form-row">
          <label className="ticker-label">
            Instrument
            <select name="ticker" value={form.ticker} onChange={handleBase}>
              <optgroup label="── Indices ──">
                {INDICES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </optgroup>
              <optgroup label="── Nifty 50 Stocks ──">
                {NIFTY50_STOCKS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
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
            Timeframe
            <select name="interval" value={form.interval} onChange={handleBase}>
              {INTERVAL_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>

          <label>
            Strategy
            <select value={form.strategyId} onChange={handleStrategyChange}>
              {strategies.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        </div>

        {selectedStrategy.paramFields.length > 0 && (
          <div className="strategy-params-section">
            <span className="strategy-params-title">{selectedStrategy.name} — Parameters</span>
            <div className="form-row">
              {selectedStrategy.paramFields.map(field => (
                <label key={field.name}>
                  {field.label}
                  {field.type === 'select' ? (
                    <select name={field.name} value={form.strategyParams[field.name]} onChange={handleParam}>
                      {field.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  ) : (
                    <input
                      type={field.type}
                      name={field.name}
                      value={form.strategyParams[field.name]}
                      onChange={handleParam}
                      min={field.min}
                      max={field.max}
                      step={field.step ?? 'any'}
                    />
                  )}
                </label>
              ))}
            </div>
          </div>
        )}

        <button type="submit" disabled={phase === 'fetching'}>
          {phase === 'fetching' ? 'Loading…' : 'Plot Chart'}
        </button>
      </form>

      {statusMsg && <p className="indicator-status">{statusMsg}</p>}
      {error     && <div className="error-banner">{error}</div>}

      {phase === 'done' && chartData.length > 0 && (
        <div className="chart-container indicator-chart-wrap">
          <h3>
            {form.ticker}
            <span className="indicator-chart-meta">
              {form.interval} &nbsp;·&nbsp; {form.startDate} → {form.endDate}
              &nbsp;·&nbsp; {chartData.length} candles
            </span>
          </h3>

          {chartData.length > 500 && (
            <p className="indicator-chart-warn">
              {chartData.length} candles — candles may be too narrow to render clearly.
              Consider a shorter date range or a larger timeframe.
            </p>
          )}

          <div className="indicator-legend-hint">
            Triangles mark entry signals: green = BUY entry, red = SELL entry.
          </div>

          <ResponsiveContainer width="100%" height={520}>
            <ComposedChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
              <CartesianGrid stroke="#1e1e1e" vertical={false} />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 10, fill: '#555' }}
                interval="preserveStartEnd"
                tickLine={false}
                axisLine={{ stroke: '#2a2a2a' }}
              />
              <YAxis
                domain={[yMin, yMax]}
                tick={{ fontSize: 10, fill: '#555' }}
                tickLine={false}
                axisLine={false}
                width={72}
                tickFormatter={v => Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
              />
              <Tooltip content={<OHLCTooltip />} />
              <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '12px' }} />

              {/* Candlestick bars (hidden from legend) */}
              <Bar
                dataKey="ohlcRange"
                name="OHLC"
                shape={<CandleShape />}
                isAnimationActive={false}
                legendType="none"
              />

              {/* Indicator lines */}
              {indSeries.map(s => (
                <Line
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  name={s.label}
                  stroke={s.color}
                  dot={false}
                  strokeWidth={1.5}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              ))}

              {/* Entry signal markers — entry candle only, no line */}
              <Line
                dataKey="signalBuy"
                name="BUY Entry"
                stroke="none"
                dot={<BuyDot />}
                activeDot={false}
                connectNulls={false}
                isAnimationActive={false}
                legendType="none"
              />
              <Line
                dataKey="signalSell"
                name="SELL Entry"
                stroke="none"
                dot={<SellDot />}
                activeDot={false}
                connectNulls={false}
                isAnimationActive={false}
                legendType="none"
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}
