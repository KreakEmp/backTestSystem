import { useState } from 'react'
import Sidebar from './components/Sidebar'
import BacktestForm from './components/BacktestForm'
import MetricsCard from './components/MetricsCard'
import EquityChart from './components/EquityChart'
import TradeLog from './components/TradeLog'
import SettingsPage from './pages/SettingsPage'
import { getProvider, providers } from './lib/providers/index.js'
import { getStrategy } from './lib/strategies/index.js'
import { runBacktest } from './lib/backtestEngine'
import './App.css'

function defaultProviderConfig() {
  return {
    providerId: providers[0].id,
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

export default function App() {
  const [page,          setPage]          = useState('backtest')
  const [providerConfig, setProviderConfig] = useState(loadProviderConfig)
  const [loading,       setLoading]       = useState(false)
  const [error,         setError]         = useState(null)
  const [results,       setResults]       = useState(null)
  const [lastParams,    setLastParams]     = useState(null)

  function saveProviderConfig(config) {
    setProviderConfig(config)
    localStorage.setItem('bt_provider_config', JSON.stringify(config))
  }

  async function handleSubmit(params) {
    setLoading(true)
    setError(null)
    setResults(null)
    setLastParams(params)
    try {
      const provider = getProvider(providerConfig.providerId)
      const strategy = getStrategy(params.strategyId)

      const data = await provider.fetchData(
        params.ticker,
        params.startDate,
        params.endDate,
        providerConfig.credentials,
        params.interval
      )

      const signals = strategy.generateSignals(data, params.strategyParams)
      const { equityCurve, trades, metrics } = runBacktest(data, signals, params.initialCapital, params.riskConfig)

      setResults({ equityCurve, trades, metrics })
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const selectedProvider = getProvider(providerConfig.providerId)

  return (
    <div className="layout">
      <Sidebar activePage={page} onNavigate={setPage} />

      <main className="main-content">
        {page === 'backtest' && (
          <>
            <div className="page-header">
              <h1>Backtest</h1>
              <p>Run a strategy against historical NSE data.</p>
            </div>

            <BacktestForm
              key={providerConfig.providerId}
              onSubmit={handleSubmit}
              loading={loading}
              intervalOptions={selectedProvider.intervalOptions}
              defaultInterval={selectedProvider.defaultInterval}
            />

            {error && <div className="error-banner">{error}</div>}
            {loading && <div className="loading">Fetching data and running backtest…</div>}

            {results && lastParams && (
              <section className="results">
                <h2>
                  Results — {lastParams.ticker} &nbsp;
                  <span className="subtitle">
                    {getStrategy(lastParams.strategyId).name} &nbsp;·&nbsp;
                    {lastParams.interval} candles &nbsp;
                    {lastParams.startDate} → {lastParams.endDate}
                  </span>
                </h2>
                <MetricsCard metrics={results.metrics} />
                <EquityChart equityCurve={results.equityCurve} />
                <TradeLog trades={results.trades} />
              </section>
            )}
          </>
        )}

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
