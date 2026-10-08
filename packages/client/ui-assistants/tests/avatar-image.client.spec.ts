// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { squareAvatar } from '../src/client/avatar-image.ts'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('squareAvatar', () => {
  it('draws the centered square at 256 pixels and encodes WebP', async () => {
    const close = vi.fn()
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 400, height: 200, close })))
    const drawImage = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as never)
    const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/webp;base64,AA')
    expect(await squareAvatar(new Blob(['x']))).toBe('data:image/webp;base64,AA')
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 100, 0, 200, 200, 0, 0, 256, 256)
    expect(toDataURL).toHaveBeenCalledWith('image/webp', 0.85)
    expect(close).toHaveBeenCalledOnce()
  })

  it('fails without a 2d context and still releases the bitmap', async () => {
    const close = vi.fn()
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 10, height: 10, close })))
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    await expect(squareAvatar(new Blob(['x']))).rejects.toThrow('no 2d canvas context')
    expect(close).toHaveBeenCalledOnce()
  })
})
