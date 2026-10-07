/** Turn an uploaded image into a square, compressed avatar the `assistants` service accepts. */

/** Image types an avatar may be uploaded as. */
export const AVATAR_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp']

/** Edge of the stored avatar, in pixels. */
const EDGE = 256

/**
 * Crop the image's centered square, scale it to 256 pixels, and encode it as WebP, or PNG where
 * the browser cannot encode WebP.
 * @param file - the uploaded image.
 * @returns the avatar as a data URL.
 */
export async function squareAvatar(file: Blob): Promise<string> {
  const bitmap = await createImageBitmap(file)
  try {
    const side = Math.min(bitmap.width, bitmap.height)
    const canvas = document.createElement('canvas')
    canvas.width = EDGE
    canvas.height = EDGE
    const context = canvas.getContext('2d')
    if (context === null) throw new Error('no 2d canvas context')
    context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, EDGE, EDGE)
    return canvas.toDataURL('image/webp', 0.85)
  } finally {
    bitmap.close()
  }
}
