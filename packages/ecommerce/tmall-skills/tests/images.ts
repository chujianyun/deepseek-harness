/** Small PNG and JPEG files for tests of image sorting. */

import { encode as encodeJpeg } from 'jpeg-js'
import { PNG } from 'pngjs'

export type Fill = 'photo' | 'white' | 'clear'

/** RGBA pixels: a photo-like gradient, white with a gray center, or transparent with an opaque center. */
function pixels(width: number, height: number, fill: Fill): Uint8Array {
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4
      const center = x > width / 4 && x < width * 3 / 4 && y > height / 4 && y < height * 3 / 4
      const value = fill === 'photo' ? (x * 7 + y * 3) % 200 : center ? 120 : 255
      data.set([value, value, value, fill === 'clear' && !center ? 0 : 255], at)
    }
  }
  return data
}

export function png(width: number, height: number, fill: Fill = 'photo'): Buffer {
  const image = new PNG({ width, height })
  image.data = Buffer.from(pixels(width, height, fill))
  return PNG.sync.write(image)
}

export function jpeg(width: number, height: number, fill: Fill = 'photo'): Uint8Array {
  return encodeJpeg({ width, height, data: pixels(width, height, fill) }, 90).data
}
