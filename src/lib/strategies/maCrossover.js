/**
 * Strategy: MA Crossover (Golden Cross / Death Cross)
 *
 * Contract — every strategy must export an object with:
 *   id            string        unique identifier
 *   name          string        display name shown in the UI
 *   paramFields   FieldDef[]    fields rendered in the form for strategy params
 *   generateSignals(data: Candle[], params: object) => Signal[]
 *
 * Signal[i]: null | 'BUY' | 'SELL'  — one entry per data point
 */

import { computeMA } from '../indicators.js'

export default {
  id: 'maCrossover',
  name: 'MA Crossover',

  paramFields: [
    {
      name: 'maType',
      label: 'MA Type',
      type: 'select',
      default: 'SMA',
      options: [
        { value: 'SMA', label: 'SMA' },
        { value: 'EMA', label: 'EMA' },
      ],
    },
    { name: 'shortPeriod', label: 'Short Period', type: 'number', default: 20, min: 2, max: 200 },
    { name: 'longPeriod',  label: 'Long Period',  type: 'number', default: 50, min: 3, max: 500 },
  ],

  generateSignals(data, params) {
    const { maType, shortPeriod, longPeriod } = params
    const closes = data.map(d => d.close)
    const shortMA = computeMA(closes, Number(shortPeriod), maType)
    const longMA  = computeMA(closes, Number(longPeriod),  maType)

    const signals = new Array(data.length).fill(null)

    for (let i = 1; i < data.length; i++) {
      const ps = shortMA[i - 1], pl = longMA[i - 1]
      const cs = shortMA[i],     cl = longMA[i]
      if (ps === null || pl === null || cs === null || cl === null) continue

      if (ps <= pl && cs > cl) signals[i] = 'BUY'   // golden cross
      else if (ps >= pl && cs < cl) signals[i] = 'SELL' // death cross
    }

    return signals
  },
}
