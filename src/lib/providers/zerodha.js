/**
 * Data provider: Zerodha Kite Connect
 *
 * Contract — every provider must export an object with:
 *   id               string           unique identifier
 *   name             string           display name shown in the UI
 *   credentialFields FieldDef[]       fields rendered in the form for auth / config
 *   intervalOptions  IntervalOption[] candle timeframes this provider supports
 *   defaultInterval  string           pre-selected interval value
 *   fetchData(ticker, startDate, endDate, credentials, interval) => Promise<Candle[]>
 *
 * Candle: { date: string, open: number, high: number, low: number, close: number, volume: number }
 *
 * ⚠️  CORS NOTE: Kite Connect is designed for server-side use and does not allow
 * direct browser requests. You need a lightweight proxy server that forwards
 * requests to api.kite.trade and adds the auth headers. Point BASE_URL at your
 * proxy (e.g. http://localhost:3001) during development.
 *
 * Credentials required:
 *   apiKey      — from your Kite Connect developer app
 *   accessToken — generated daily via the Kite OAuth login flow
 *
 * Ticker format: NSE symbol (e.g. INFY, RELIANCE, NIFTY 50)
 */

// Requests go through Vite's dev proxy (/kite → https://api.kite.trade)
// so the browser never hits api.kite.trade directly and CORS is not an issue.
export const BASE_URL = '/kite'

// In-session instrument token cache (symbol → token), populated on first use
let _instrumentCache = null

function authHeaders(credentials) {
  return {
    'X-Kiteconnect-Apikey': credentials.apiKey,
    'Authorization': `token ${credentials.apiKey}:${credentials.accessToken}`,
  }
}

/**
 * Fetches the NSE equity instruments list and builds a symbol→token map.
 * Cached for the lifetime of the browser session.
 */
async function getInstrumentCache(credentials) {
  if (_instrumentCache) return _instrumentCache

  const res = await fetch(`${BASE_URL}/instruments/NSE`, { headers: authHeaders(credentials) })
  if (!res.ok) throw new Error(`Failed to fetch instrument list: ${res.status}`)

  const csv = await res.text()
  const lines = csv.trim().split('\n')
  const headers = lines[0].split(',')

  const tokenIdx   = headers.indexOf('instrument_token')
  const symbolIdx  = headers.indexOf('tradingsymbol')
  const typeIdx    = headers.indexOf('instrument_type')
  const segmentIdx = headers.indexOf('segment')

  const cache = {}
  for (let i = 1; i < lines.length; i++) {
    const cols    = lines[i].split(',')
    const type    = cols[typeIdx]?.trim()
    const segment = cols[segmentIdx]?.trim()
    // Include equity stocks and NSE indices
    if (type === 'EQ' || segment === 'INDICES') {
      cache[cols[symbolIdx]?.trim().toUpperCase()] = cols[tokenIdx]?.trim()
    }
  }

  _instrumentCache = cache
  return cache
}

async function resolveToken(ticker, credentials) {
  const cache = await getInstrumentCache(credentials)
  const token = cache[ticker.toUpperCase()]
  if (!token) throw new Error(`Instrument not found on NSE: ${ticker}. Check the symbol and try again.`)
  return token
}

export default {
  id: 'zerodha',
  name: 'Zerodha Kite Connect',

  credentialFields: [
    {
      name: 'apiKey',
      label: 'API Key',
      placeholder: 'Kite Connect API key',
      secret: true,
    },
    {
      name: 'apiSecret',
      label: 'API Secret',
      placeholder: 'Kite Connect API secret (used for token generation)',
      secret: true,
    },
    {
      name: 'accessToken',
      label: 'Access Token',
      placeholder: 'Daily access token — use Token Helper to generate',
      secret: true,
    },
  ],

  intervalOptions: [
    { value: 'minute',    label: '1 Minute' },
    { value: '3minute',   label: '3 Minutes' },
    { value: '5minute',   label: '5 Minutes' },
    { value: '10minute',  label: '10 Minutes' },
    { value: '15minute',  label: '15 Minutes' },
    { value: '30minute',  label: '30 Minutes' },
    { value: '60minute',  label: '60 Minutes' },
    { value: 'day',       label: 'Daily' },
    { value: 'week',      label: 'Weekly' },
    { value: 'month',     label: 'Monthly' },
  ],

  defaultInterval: 'day',

  async fetchData(ticker, startDate, endDate, credentials, interval) {
    const token = await resolveToken(ticker, credentials)

    // Kite expects datetime strings: "YYYY-MM-DD HH:MM:SS"
    const from = encodeURIComponent(`${startDate} 09:15:00`)
    const to   = encodeURIComponent(`${endDate} 15:30:00`)

    const url = `${BASE_URL}/instruments/historical/${token}/${interval}?from=${from}&to=${to}&continuous=0&oi=0`
    const res = await fetch(url, { headers: authHeaders(credentials) })
    if (!res.ok) throw new Error(`Kite API error: ${res.status}`)

    const json = await res.json()
    if (json.status === 'error') throw new Error(`Kite error: ${json.message}`)

    // Each candle: [timestamp, open, high, low, close, volume]
    const candles = json.data?.candles ?? []
    if (candles.length === 0) throw new Error('No data found for the selected date range.')

    return candles.map(([date, open, high, low, close, volume]) => ({
      date,
      open,
      high,
      low,
      close,
      volume,
    }))
  },
}
