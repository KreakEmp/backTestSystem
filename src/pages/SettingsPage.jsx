import { useState } from 'react'
import { providers } from '../lib/providers/index.js'
import { BASE_URL } from '../lib/providers/zerodha.js'

// ── Tab registry — add new settings tabs here ────────────────────────────────
const TABS = [
  { id: 'dataConnector', label: 'Data Connector' },
]
// ─────────────────────────────────────────────────────────────────────────────

function defaultCredentials(provider) {
  return Object.fromEntries(provider.credentialFields.map(f => [f.name, '']))
}

async function sha256hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

// ── Token Helper (Zerodha-specific) ──────────────────────────────────────────
function TokenHelper({ credentials, onTokenGenerated }) {
  const [requestToken, setRequestToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null) // { type: 'success'|'error', text }

  const { apiKey = '', apiSecret = '' } = credentials
  const loginUrl = apiKey
    ? `https://kite.trade/connect/login?api_key=${encodeURIComponent(apiKey)}&v=3`
    : null

  async function handleExchange(e) {
    e.preventDefault()
    if (!apiKey || !apiSecret || !requestToken.trim()) return
    setBusy(true)
    setMsg(null)
    try {
      const checksum = await sha256hex(apiKey + requestToken.trim() + apiSecret)
      const res = await fetch(`${BASE_URL}/session/token`, {
        method: 'POST',
        headers: {
          'X-Kiteconnect-Apikey': apiKey,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          api_key:       apiKey,
          request_token: requestToken.trim(),
          checksum,
        }),
      })
      const json = await res.json()
      if (json.status === 'error') throw new Error(json.message)
      const token = json.data?.access_token
      if (!token) throw new Error('No access_token in response.')
      onTokenGenerated(token)
      setMsg({ type: 'success', text: 'Access token generated and saved! Valid until midnight.' })
      setRequestToken('')
    } catch (err) {
      const isCors = err.message === 'Failed to fetch'
      setMsg({
        type: 'error',
        text: isCors
          ? 'Browser blocked the request (CORS). Kite API requires a server-side proxy. Use the manual Python method below instead.'
          : err.message,
      })
    } finally {
      setBusy(false)
    }
  }

  const missingKey    = !apiKey
  const missingSecret = !apiSecret
  const canExchange   = apiKey && apiSecret && requestToken.trim()

  return (
    <div className="settings-card token-helper-card">
      <div>
        <h3>Access Token Helper</h3>
        <p className="settings-hint">
          Zerodha access tokens expire daily at midnight. Follow these steps each trading day to generate a fresh token.
          Make sure <strong>API Key</strong> and <strong>API Secret</strong> are saved in the Data Connector tab first.
        </p>
        {(missingKey || missingSecret) && (
          <p className="token-warning">
            {missingKey ? 'API Key' : 'API Secret'} is not set — go to the Data Connector tab and save it first.
          </p>
        )}
      </div>

      {/* Step 1 */}
      <div className="token-step">
        <span className="step-badge">1</span>
        <div className="token-step-body">
          <strong>Open Kite Login</strong>
          <p className="settings-hint">Click below to authenticate with your Zerodha account in a new tab.</p>
          {loginUrl ? (
            <a href={loginUrl} target="_blank" rel="noopener noreferrer" className="save-btn token-link-btn">
              Open Kite Login &rarr;
            </a>
          ) : (
            <span className="settings-hint token-warning">Set API Key first.</span>
          )}
        </div>
      </div>

      {/* Step 2 */}
      <div className="token-step">
        <span className="step-badge">2</span>
        <div className="token-step-body">
          <strong>Copy the request_token from the redirect URL</strong>
          <p className="settings-hint">
            After login you'll be redirected to your app's redirect URL. Look for this in the address bar:
          </p>
          <code className="token-code">?request_token=<strong>COPY_THIS_VALUE</strong>&amp;status=success</code>
        </div>
      </div>

      {/* Step 3 */}
      <div className="token-step">
        <span className="step-badge">3</span>
        <div className="token-step-body" style={{ flex: 1 }}>
          <strong>Exchange for Access Token</strong>
          <p className="settings-hint">Paste the request_token and click exchange. The access token is auto-saved.</p>
          <form onSubmit={handleExchange} className="token-exchange-row">
            <input
              placeholder="Paste request_token here"
              value={requestToken}
              onChange={e => setRequestToken(e.target.value)}
              autoComplete="off"
            />
            <button type="submit" className="save-btn" disabled={busy || !canExchange}>
              {busy ? 'Exchanging…' : 'Get Access Token'}
            </button>
          </form>
          {msg && (
            <p className={msg.type === 'success' ? 'token-success' : 'token-error'}>
              {msg.text}
            </p>
          )}
        </div>
      </div>

      {/* Manual Python fallback */}
      <details className="token-manual">
        <summary>Show manual method (if browser exchange is CORS-blocked)</summary>
        <p className="settings-hint" style={{ marginTop: '8px' }}>
          Run this Python snippet once after Step 2. Paste the printed token into Settings &rarr; Data Connector &rarr; Access Token.
        </p>
        <pre className="token-pre">{`import hashlib, requests

api_key    = "${apiKey  || 'YOUR_API_KEY'}"
api_secret = "${apiSecret || 'YOUR_API_SECRET'}"
req_token  = "PASTE_REQUEST_TOKEN_HERE"

checksum = hashlib.sha256(
    (api_key + req_token + api_secret).encode()
).hexdigest()

r = requests.post(
    "https://api.kite.trade/session/token",
    headers={"X-Kiteconnect-Apikey": api_key},
    data={"api_key": api_key, "request_token": req_token, "checksum": checksum}
)
print(r.json()["data"]["access_token"])`}
        </pre>
      </details>
    </div>
  )
}
// ─────────────────────────────────────────────────────────────────────────────

// ── Zerodha one-click login (popup flow) ─────────────────────────────────────
function ZerodhaLoginButton({ apiKey, apiSecret, tokenUpdatedAt, onTokenGenerated }) {
  const [status, setStatus] = useState(null) // null | 'waiting' | 'exchanging' | 'success' | 'error'
  const [msg,    setMsg]    = useState('')

  async function handleLogin() {
    setStatus('waiting')
    setMsg('')

    const loginUrl = `https://kite.trade/connect/login?api_key=${encodeURIComponent(apiKey)}&v=3`
    const popup = window.open(loginUrl, 'kite_login', 'width=600,height=700')
    if (!popup) {
      setStatus('error')
      setMsg('Popup blocked — allow popups for this site and try again.')
      return
    }

    const poll = setInterval(async () => {
      try {
        const params = new URL(popup.location.href).searchParams
        const requestToken = params.get('request_token')
        const loginStatus  = params.get('status')

        if (loginStatus === 'success' && requestToken) {
          clearInterval(poll)
          popup.close()
          setStatus('exchanging')
          try {
            const checksum = await sha256hex(apiKey + requestToken + apiSecret)
            const res = await fetch(`${BASE_URL}/session/token`, {
              method: 'POST',
              headers: {
                'X-Kiteconnect-Apikey': apiKey,
                'Content-Type': 'application/x-www-form-urlencoded',
              },
              body: new URLSearchParams({ api_key: apiKey, request_token: requestToken, checksum }),
            })
            const json = await res.json()
            if (json.status === 'error') throw new Error(json.message)
            const token = json.data?.access_token
            if (!token) throw new Error('No access_token in response.')
            onTokenGenerated(token)
            setStatus('success')
            setMsg('Logged in — access token saved.')
          } catch (err) {
            setStatus('error')
            setMsg(err.message === 'Failed to fetch'
              ? 'CORS error during token exchange. Check your proxy / Vite config.'
              : err.message)
          }
        } else if (loginStatus === 'error') {
          clearInterval(poll)
          popup.close()
          setStatus('error')
          setMsg('Zerodha login failed or was cancelled.')
        }
      } catch {
        // Still on Kite domain (cross-origin) — keep polling
      }

      if (popup.closed) {
        clearInterval(poll)
        setStatus(prev => prev === 'waiting' ? null : prev)
      }
    }, 500)
  }

  const busy = status === 'waiting' || status === 'exchanging'

  const lastUpdated = tokenUpdatedAt ? new Date(tokenUpdatedAt) : null

  return (
    <div className="zerodha-login-section">
      <button
        type="button"
        className="save-btn"
        onClick={handleLogin}
        disabled={!apiKey || !apiSecret || busy}
        title={!apiKey || !apiSecret ? 'Enter API Key and API Secret first' : ''}
      >
        {status === 'waiting'     ? 'Waiting for login…'
          : status === 'exchanging' ? 'Getting token…'
          : 'Refresh Auth Token'}
      </button>
      <div className="zerodha-login-meta">
        {lastUpdated && !status && (
          <span className="settings-hint">
            Last refreshed: {lastUpdated.toLocaleDateString()} {lastUpdated.toLocaleTimeString()}
          </span>
        )}
        {status === 'success' && <span className="token-success">{msg}</span>}
        {status === 'error'   && <span className="token-error">{msg}</span>}
      </div>
    </div>
  )
}
// ─────────────────────────────────────────────────────────────────────────────

export default function SettingsPage({ providerConfig, onSave }) {
  const [activeTab, setActiveTab]   = useState(TABS[0].id)
  const [local, setLocal]           = useState(providerConfig)
  const [visibleFields, setVisible] = useState({})
  const [saveStatus, setSaveStatus] = useState(null) // null | 'saved'

  const selectedProvider = providers.find(p => p.id === local.providerId)

  // Only show tabs relevant to the current provider
  const visibleTabs = TABS.filter(t => !t.providerOnly || t.providerOnly === local.providerId)

  function handleProviderChange(e) {
    const provider = providers.find(p => p.id === e.target.value)
    setLocal({ providerId: provider.id, credentials: defaultCredentials(provider) })
    setVisible({})
    setActiveTab(TABS[0].id)
  }

  function handleCredential(e) {
    setLocal(l => ({ ...l, credentials: { ...l.credentials, [e.target.name]: e.target.value } }))
  }

  function toggleVisible(name) {
    setVisible(v => ({ ...v, [name]: !v[name] }))
  }

  function handleSave(e) {
    e.preventDefault()
    onSave(local)
    setSaveStatus('saved')
    setTimeout(() => setSaveStatus(null), 2500)
  }

  function handleTokenGenerated(token) {
    const updated = {
      ...local,
      credentials: { ...local.credentials, accessToken: token },
      tokenUpdatedAt: new Date().toISOString(),
    }
    setLocal(updated)
    onSave(updated)
  }

  return (
    <div className="settings-page">
      <div className="page-header">
        <h1>Settings</h1>
        <p>Configure data providers and application preferences.</p>
      </div>

      {/* Tab bar */}
      <div className="settings-tabs">
        {visibleTabs.map(tab => (
          <button
            key={tab.id}
            className={`tab-btn ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Data Connector tab */}
      {activeTab === 'dataConnector' && (
        <form className="settings-card" onSubmit={handleSave}>
          <div>
            <h3>Data Provider</h3>
            <p className="settings-hint">Select where market data is fetched from.</p>
          </div>

          <div className="settings-field">
            <label>Provider</label>
            <select value={local.providerId} onChange={handleProviderChange}>
              {providers.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>

          {selectedProvider.credentialFields.length > 0 && (
            <div>
              <h3>Credentials</h3>
              <p className="settings-hint">
                Your keys are stored only in this browser's localStorage and never sent anywhere
                except directly to {selectedProvider.name}.
              </p>
            </div>
          )}

          {selectedProvider.credentialFields.filter(field =>
            !(local.providerId === 'zerodha' && field.name === 'accessToken')
          ).map(field => (
            <div key={field.name} className="settings-field">
              <label>{field.label}</label>
              <div className="secret-wrapper">
                <input
                  name={field.name}
                  type={field.secret && !visibleFields[field.name] ? 'password' : 'text'}
                  value={local.credentials[field.name] ?? ''}
                  onChange={handleCredential}
                  placeholder={field.placeholder}
                  autoComplete="off"
                />
                {field.secret && (
                  <button
                    type="button"
                    className="toggle-secret"
                    onClick={() => toggleVisible(field.name)}
                  >
                    {visibleFields[field.name] ? 'Hide' : 'Show'}
                  </button>
                )}
              </div>
            </div>
          ))}

          {local.providerId === 'zerodha' && (
            <ZerodhaLoginButton
              apiKey={local.credentials.apiKey}
              apiSecret={local.credentials.apiSecret}
              tokenUpdatedAt={local.tokenUpdatedAt}
              onTokenGenerated={handleTokenGenerated}
            />
          )}

          <div className="settings-actions">
            <button type="submit" className="save-btn">Save Settings</button>
            {saveStatus === 'saved' && (
              <span className="save-success">&#10003; Saved</span>
            )}
          </div>
        </form>
      )}

      {/* Token Helper tab */}
      {activeTab === 'tokenHelper' && (
        <TokenHelper
          credentials={local.credentials}
          onTokenGenerated={handleTokenGenerated}
        />
      )}
    </div>
  )
}
