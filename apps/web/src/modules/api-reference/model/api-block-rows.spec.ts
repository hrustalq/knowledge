import { describe, expect, it } from 'vitest'
import { locationOf, readApiBlockRows, requiredValue } from '@/modules/api-reference/model/api-block-rows'

describe('reading an API block table for display', () => {
  it('recognises the template headers in either language', () => {
    const en = readApiBlockRows('params', ['Name', 'In', 'Type', 'Required', 'Description'], [['id', 'path', 'uuid', 'yes', 'Account id']])
    const ru = readApiBlockRows('params', ['Имя', 'Где', 'Тип', 'Обяз.', 'Описание'], [['id', 'путь', 'uuid', 'да', 'Идентификатор']])
    expect(en[0]).toMatchObject({ name: 'id', in: 'path', type: 'uuid', required: 'yes', description: 'Account id', extras: [] })
    expect(ru[0]).toMatchObject({ name: 'id', in: 'путь', type: 'uuid', required: 'да', description: 'Идентификатор' })
  })

  it('drops the template’s blank row and keeps a column nobody recognises', () => {
    const rows = readApiBlockRows('body', ['Field', 'Type', 'Required', 'Description', 'Since'], [
      ['', '', '', '', ''],
      ['amount', 'number', 'yes', 'In cents', 'v2'],
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].extras).toEqual([{ label: 'Since', value: 'v2' }])
  })

  it('falls back to the template column order for headers in a third language', () => {
    const [row] = readApiBlockRows('responses', ['Kód', 'Tělo', 'Popis'], [['404', 'Error', 'Nenalezeno']])
    expect(row).toMatchObject({ code: '404', body: 'Error', description: 'Nenalezeno' })
  })

  it('reads required and location words, and leaves anything else to the author', () => {
    expect(['yes', 'Да', '✓'].map(requiredValue)).toEqual([true, true, true])
    expect(['no', 'нет', '—'].map(requiredValue)).toEqual([false, false, false])
    expect(requiredValue('when paying')).toBeNull()
    expect([locationOf('Path'), locationOf('заголовок'), locationOf('somewhere')]).toEqual(['path', 'header', null])
  })
})
