import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { type Pixels, readQr } from "../src/scan.ts"

// test/fixtures/scan-link.pgm: a link's QR code tilted 6°, softened and noisy on an uneven grey ground, as a camera sees one
const FIXTURE = new URL("./fixtures/scan-link.pgm", import.meta.url)
const FIXTURE_LINK = "https://smp8.simplex.im/a#ScanY8m3qT0vLw2Ab7cD9eF1gH3jK5mN7p"

// A binary PGM's grey pixels as the RGBA a canvas gives.
function pgm(bytes: Buffer): Pixels {
  const header = /^P5\s+(\d+)\s+(\d+)\s+255\s/.exec(bytes.toString("latin1", 0, 32))!
  const [width, height] = [Number(header[1]), Number(header[2])]
  const grey = bytes.subarray(header[0].length)
  const data = new Uint8ClampedArray(width * height * 4)
  grey.forEach((v, i) => data.set([v, v, v, 255], i * 4))
  return { data, width, height }
}

describe("readQr", () => {
  it("reads a SimpleX link from a camera-like image of its QR code", async () => {
    expect(await readQr(pgm(readFileSync(FIXTURE)))).toBe(FIXTURE_LINK)
  })
  it("reads nothing from an image without a QR code, or from its half", async () => {
    const image = pgm(readFileSync(FIXTURE))
    const blank = { ...image, data: new Uint8ClampedArray(image.data.length).fill(200) }
    expect(await readQr(blank)).toBeNull()
    const top = { width: image.width, height: image.height / 2, data: image.data.slice(0, image.data.length / 2) }
    expect(await readQr(top)).toBeNull()
  })
})
