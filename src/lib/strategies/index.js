import maCrossover from './maCrossover.js'
import sTrend      from './sTrend.js'

// ─── Add new strategies here ──────────────────────────────────────────────────
// 1. Create src/lib/strategies/<yourStrategy>.js following the same contract.
// 2. Import it below and add it to the array. Nothing else needs to change.
// ─────────────────────────────────────────────────────────────────────────────
const strategies = [
  maCrossover,
  sTrend,
]

export const getStrategy = id => strategies.find(s => s.id === id)
export { strategies }
