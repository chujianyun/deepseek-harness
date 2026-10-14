// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadPins, pinKey, savePin } from '../src/client/pins.ts'

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('installed-skill pins', () => {
  it('keys a pin by group and name and keeps the newest last, bounded', () => {
    expect(pinKey('market', 'pdf')).toBe('market:pdf')
    let pins: readonly string[] = []
    for (let i = 0; i < 205; i += 1) pins = savePin(pins, `custom:s${i}`, true)
    expect(pins).toHaveLength(200)
    expect(pins.at(-1)).toBe('custom:s204')
    expect(loadPins()).toEqual(pins)
    expect(savePin(pins, 'custom:s204', false).includes('custom:s204')).toBe(false)
  })

  it('reads unreadable or foreign storage as no pins, and a failing write keeps the pin for the page', () => {
    localStorage.setItem('dsh.skills.pinned', '{not json')
    expect(loadPins()).toEqual([])
    localStorage.setItem('dsh.skills.pinned', '{"a":1}')
    expect(loadPins()).toEqual([])
    localStorage.setItem('dsh.skills.pinned', '["custom:a", 3, "custom:a"]')
    expect(loadPins()).toEqual(['custom:a'])
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full') })
    expect(savePin([], 'custom:b', true)).toEqual(['custom:b'])
  })
})
