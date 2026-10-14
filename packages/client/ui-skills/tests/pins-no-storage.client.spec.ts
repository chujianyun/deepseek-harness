import { expect, it } from 'vitest'
import { loadPins, savePin } from '../src/client/pins.ts'

it('works without browser storage: no pins read, pins kept for the page only', () => {
  expect(typeof localStorage).toBe('undefined')
  expect(loadPins()).toEqual([])
  expect(savePin([], 'custom:a', true)).toEqual(['custom:a'])
})
