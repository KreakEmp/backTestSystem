/**
 * Data provider: Zerodha Kite Connect
 *
 * Exports:
 *   BASE_URL            — proxy path (used by SettingsPage for token exchange)
 *   CHUNK_DAYS          — max calendar days per API request per interval
 *   fetchDataChunked()  — chunked fetch usable by the simulation engine
 *   default             — provider object satisfying the provider contract
 */

// Requests go through Vite's dev proxy (/kite → https://api.kite.trade)
export const BASE_URL = '/kite'

// Kite API: maximum calendar days of data that can be requested in a single call
export const CHUNK_DAYS = {
  minute:    60,
  '3minute':  100,
  '5minute':  100,
  '10minute': 100,
  '15minute': 200,
  '30minute': 200,
  '60minute': 400,
  day:        2000,
  week:       2000,
  month:      2000,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// In-session instrument token cache (symbol → token), populated on first use
let _instrumentCache = null

// ── In-session data cache (LRU) ───────────────────────────────────────────
// Keyed by "ticker|interval|startDate|endDate".
// Prevents redundant API calls when the user re-runs with the same data params.
const MAX_CACHE_ENTRIES = 15
const _dataCache = new Map()  // Map preserves insertion order → easy LRU

function _cacheKey(ticker, interval, start, end) {
  return `${ticker.toUpperCase()}|${interval}|${start}|${end}`
}

function _cacheGet(key) {
  if (!_dataCache.has(key)) return null
  const data = _dataCache.get(key)
  _dataCache.delete(key)   // promote to most-recently-used (end of map)
  _dataCache.set(key, data)
  return data
}

function _cacheSet(key, data) {
  _dataCache.delete(key)
  _dataCache.set(key, data)
  if (_dataCache.size > MAX_CACHE_ENTRIES)
    _dataCache.delete(_dataCache.keys().next().value)  // evict oldest
}

function authHeaders(credentials) {
  return {
    'X-Kiteconnect-Apikey': credentials.apiKey,
    'Authorization': `token ${credentials.apiKey}:${credentials.accessToken}`,
  }
}

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

/** Fetch a single date-range chunk from the Kite historical API. */
async function fetchSingleChunk(token, chunkStart, chunkEnd, credentials, interval, abortSignal) {
  const from = encodeURIComponent(`${chunkStart} 09:15:00`)
  const to   = encodeURIComponent(`${chunkEnd} 15:30:00`)
  const url  = `${BASE_URL}/instruments/historical/${token}/${interval}?from=${from}&to=${to}&continuous=0&oi=0`
  const res  = await fetch(url, {
    headers: authHeaders(credentials),
    signal:  abortSignal ?? undefined,
  })
  if (!res.ok) {
    if (res.status === 403) throw new Error('Access denied (403) — your Kite access token has expired. Please refresh it in Settings → Data Connector → Token Helper.')
    throw new Error(`Kite API error: ${res.status}`)
  }
  const json = await res.json()
  if (json.status === 'error') throw new Error(`Kite error: ${json.message}`)
  return (json.data?.candles ?? []).map(([date, open, high, low, close, volume]) => ({
    date, open, high, low, close, volume,
  }))
}

/** Build an array of [chunkStart, chunkEnd] date-string pairs. */
function buildDateChunks(startDate, endDate, chunkSize) {
  const chunks = []
  const end = new Date(endDate)
  let cur   = new Date(startDate)

  while (cur <= end) {
    const chunkEnd = new Date(cur)
    chunkEnd.setDate(chunkEnd.getDate() + chunkSize - 1)
    if (chunkEnd > end) chunkEnd.setTime(end.getTime())

    chunks.push([
      cur.toISOString().slice(0, 10),
      chunkEnd.toISOString().slice(0, 10),
    ])

    cur = new Date(chunkEnd)
    cur.setDate(cur.getDate() + 1)
  }

  return chunks
}

/**
 * Fetch historical data for any interval, automatically chunking the date
 * range to respect Kite's per-request day limits.
 *
 * @param {string}   ticker
 * @param {string}   startDate  'YYYY-MM-DD'
 * @param {string}   endDate    'YYYY-MM-DD'
 * @param {object}   credentials
 * @param {string}   interval   one of the supported Kite intervals
 * @param {Function} onProgress (done: number, total: number) => void
 * @param {AbortSignal} [abortSignal]
 * @returns {Promise<Candle[]>}
 */
export async function fetchDataChunked(ticker, startDate, endDate, credentials, interval, onProgress, abortSignal) {
  const key    = _cacheKey(ticker, interval, startDate, endDate)
  const cached = _cacheGet(key)
  if (cached) return cached

  const token     = await resolveToken(ticker, credentials)
  const chunkSize = CHUNK_DAYS[interval] ?? 60
  const chunks    = buildDateChunks(startDate, endDate, chunkSize)
  const total     = chunks.length

  const allData = []
  for (let i = 0; i < chunks.length; i++) {
    if (abortSignal?.aborted) break
    const [chunkStart, chunkEnd] = chunks[i]
    const data = await fetchSingleChunk(token, chunkStart, chunkEnd, credentials, interval, abortSignal)
    allData.push(...data)
    onProgress?.(i + 1, total)
  }

  // Only cache complete (non-aborted) fetches
  if (!abortSignal?.aborted) _cacheSet(key, allData)
  return allData
}

// ── Provider object ───────────────────────────────────────────────────────────

export default {
  id:   'zerodha',
  name: 'Zerodha Kite Connect',

  credentialFields: [
    { name: 'apiKey',      label: 'API Key',      placeholder: 'Kite Connect API key',                                   secret: true },
    { name: 'apiSecret',   label: 'API Secret',   placeholder: 'Kite Connect API secret (used for token generation)',    secret: true },
    { name: 'accessToken', label: 'Access Token', placeholder: 'Daily access token — use Token Helper to generate',      secret: true },
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
    const data  = await fetchSingleChunk(token, startDate, endDate, credentials, interval)
    if (data.length === 0) throw new Error('No data found for the selected date range.')
    return data
  },

  fetchDataChunked(ticker, startDate, endDate, credentials, interval, onProgress, abortSignal) {
    return fetchDataChunked(ticker, startDate, endDate, credentials, interval, onProgress, abortSignal)
  },
}
