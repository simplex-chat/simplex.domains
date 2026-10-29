// A QR code's text read from an image's pixels, by jsQR, which is loaded only when a code is first read.
export interface Pixels {
  data: Uint8ClampedArray
  width: number
  height: number
}

export async function readQr(image: Pixels): Promise<string | null> {
  const { default: jsQR } = await import("jsqr")
  return jsQR(image.data, image.width, image.height)?.data ?? null
}
