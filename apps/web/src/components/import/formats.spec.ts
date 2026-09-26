import { describe, expect, it } from 'vitest'
import { formatBytes, formatList } from '@/lib/format'
import { inspectFile } from './formats'

const file = (name: string, size: number, type = '') => new File([new Uint8Array(size)], name, { type })

describe('inspectFile', () => {
  it('returns message keys, not English, for every refusal', () => {
    expect(inspectFile(file('a.xyz', 10), 1024).reason?.key).toBe('import.verdict.unsupported')
    expect(inspectFile(file('noext', 10), 1024).reason?.key).toBe('import.verdict.noExtension')
    expect(inspectFile(file('a.md', 0), 1024).reason).toEqual({ key: 'import.verdict.empty' })
    expect(inspectFile(file('a.md', 2048), 1024).reason).toEqual({
      key: 'import.verdict.tooLarge',
      params: { size: '2 KB', limit: '1 KB' },
    })
  })

  it('accepts a supported file within the limit', () => {
    expect(inspectFile(file('a.md', 10), 1024)).toMatchObject({ ok: true })
  })
})

describe('lib/format', () => {
  it('lists alternatives in the reader’s language', () => {
    expect(formatList(['PDF', 'Word', 'PDF', 'Markdown'], 'disjunction', 'en')).toBe('PDF, Word or Markdown')
    expect(formatList(['PDF', 'Word', 'Markdown'], 'disjunction', 'ru')).toBe('PDF, Word или Markdown')
  })

  it('formats byte sizes with a localized number', () => {
    expect(formatBytes(1536, 'en')).toBe('1.5 KB')
    expect(formatBytes(1536, 'ru')).toBe('1,5 KB')
  })
})
