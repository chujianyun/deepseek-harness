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
  return { format, ...measure(decode(bytes)) }
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

/**
 * An image cut to a size the platform requires: the largest centered part with the target's shape,
 * scaled to the target by averaging the source pixels each target pixel covers, as PNG.
 * @param bytes - a PNG or JPEG file.
 * @param width - the target width.
 * @param height - the target height.
 * @returns the PNG file.
 * @throws Error when the file is not a readable PNG or JPEG.
 */
export function fitImage(bytes: Uint8Array, width: number, height: number): Buffer {
  const source = decode(bytes)
  const scale = Math.min(source.width / width, source.height / height)
  const left = (source.width - width * scale) / 2
  const top = (source.height - height * scale) / 2
  const target = new PNG({ width, height })
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(left + x * scale)
      const y0 = Math.floor(top + y * scale)
      const x1 = Math.max(x0 + 1, Math.floor(left + (x + 1) * scale))
      const y1 = Math.max(y0 + 1, Math.floor(top + (y + 1) * scale))
      const sum = [0, 0, 0, 0]
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const at = (sy * source.width + sx) * 4
          for (let c = 0; c < 4; c++) sum[c] = (sum[c] as number) + (source.data[at + c] as number)
        }
      }
      const count = (x1 - x0) * (y1 - y0)
      const at = (y * width + x) * 4
      for (let c = 0; c < 4; c++) target.data[at + c] = Math.round((sum[c] as number) / count)
    }
  }
  return PNG.sync.write(target)
}

/** Decode a PNG or JPEG file to RGBA pixels. */
function decode(bytes: Uint8Array): Pixels {
  const format = imageFormat(bytes)
  if (format === undefined) throw new Error('不是 PNG 或 JPEG 图片')
  return format === 'png' ? PNG.sync.read(Buffer.from(bytes)) : decodeJpeg(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 })
}
