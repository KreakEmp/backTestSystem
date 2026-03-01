import zerodha from './zerodha.js'

// ─── Add new providers here ───────────────────────────────────────────────────
// 1. Create src/lib/providers/<yourProvider>.js following the same contract.
// 2. Import it below and add it to the array. Nothing else needs to change.
// ─────────────────────────────────────────────────────────────────────────────
const providers = [
  zerodha,
]

export const getProvider = id => providers.find(p => p.id === id)
export { providers }
