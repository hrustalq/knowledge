import { describe, expect, it, vi } from 'vitest'
import { formatCost, formatCosts, formatPrice } from './format'

vi.mock('../api/api', () => ({ getLocale: () => 'en' }))

describe('cost formatting', () => {
  it('prints each amount in its own currency, in both locales', () => {
    expect(formatCost({ micros: 1_230_000, currency: 'USD' })).toBe('$1.23')
    expect(formatCost({ micros: 1_230_000, currency: 'RUB' })).toBe('₽1.23')
    expect(formatCost({ micros: 1_230_000, currency: 'RUB' }, 'ru').replace(/\s/g, ' ')).toBe('1,23 ₽')
  })

  it('never lets a real charge below a cent read as free', () => {
    expect(formatCost({ micros: 9_999, currency: 'RUB' })).toBe('<₽0.01')
    expect(formatCost({ micros: 0, currency: 'USD' })).toBe('$0.00')
  })

  it('shows two currencies side by side, and a dash for nothing priced', () => {
    expect(
      formatCosts([
        { micros: 500_000, currency: 'RUB' },
        { micros: 3_000_000, currency: 'USD' },
      ]),
    ).toBe('₽0.50 · $3.00')
    expect(formatCosts([])).toBe('—')
  })

  it('prices a provider row in its currency', () => {
    expect(formatPrice(0.0105, 'RUB')).toBe('₽0.0105')
    expect(formatPrice(2)).toBe('$2.00')
  })
})
