/**
 * What sorting a product image needs from its pixels: its size, how much of it is transparent, and
 * whether its border is white. PNG and JPEG files are decoded in pure JavaScript, so the bundled skill
 * script runs under plain Node.
 */

import { decode as decodeJpeg } from 'jpeg-js'
import { PNG } from 'pngjs'

/** An image's facts. */
export interface ImageFacts {
  /** The format the bytes are in, whatever the file is named. */
  readonly format: 'png' | 'jpeg'
  readonly width: number
  readonly height: number
  /** Share of the image whose pixels are (almost) fully transparent, 0–1. */
  readonly transparentShare: number
  /** Share of the outer border whose pixels are opaque and near white, 0–1. */
  readonly whiteBorderShare: number
}

/** A picture's decoded RGBA pixels. */
interface Pixels {
  readonly width: number
  readonly height: number
  readonly data: Uint8Array
}

/** File extensions treated as images. */
export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.heic'])

/**
 * The format of an image file from its first bytes.
 * @param bytes - the file.
 * @returns `png`, `jpeg`, or undefined for any other format.
 */
export function imageFormat(bytes: Uint8Array): 'png' | 'jpeg' | undefined {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  return undefined
}

/**
 * Decode an image and measure it.
 * @param bytes - the file.
 * @returns the facts.
 * @throws Error when the file is not a readable PNG or JPEG.
 */
export function readImage(bytes: Uint8Array): ImageFacts {
  const format = imageFormat(bytes)
  if (format === undefined) throw new Error('不是 PNG 或 JPEG 图片')
  const pixels: Pixels = format === 'png'
    ? PNG.sync.read(Buffer.from(bytes))
    : decodeJpeg(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 })
  return { format, ...measure(pixels) }
}

/**
 * Measure decoded pixels on a sampling grid of about 200 points per side.
 * @param pixels - RGBA pixels.
 * @returns the facts.
 */
export function measure(pixels: Pixels): Omit<ImageFacts, 'format'> {
  const { width, height, data } = pixels
  const step = Math.max(1, Math.floor(Math.min(width, height) / 200))
  const band = Math.max(1, Math.round(Math.min(width, height) * 0.03))
  let sampled = 0
  let transparent = 0
  let border = 0
  let white = 0
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const at = (y * width + x) * 4
      const alpha = data[at + 3] as number
      sampled++
      if (alpha < 16) transparent++
      if (x < band || y < band || x >= width - band || y >= height - band) {
        border++
        if (alpha >= 250 && (data[at] as number) >= 240 && (data[at + 1] as number) >= 240 && (data[at + 2] as number) >= 240) white++
      }
    }
  }
  return { width, height, transparentShare: transparent / sampled, whiteBorderShare: white / border }
}
