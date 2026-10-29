import type { Pixels } from "../src/scan.ts"

// pixels a module is drawn as, which jsQR reads at once
const MODULE_PX = 4

// A QR code's modules, `true` for dark, as the RGBA a canvas gives, each module MODULE_PX square on white.
export function qrPixels(modules: boolean[][]): Pixels {
  const width = modules.length * MODULE_PX
  const data = new Uint8ClampedArray(width * width * 4).fill(255)
  modules.forEach((row, y) => row.forEach((dark, x) => {
    if (!dark) return
    for (let dy = 0; dy < MODULE_PX; dy++) {
      for (let dx = 0; dx < MODULE_PX; dx++) data.set([0, 0, 0, 255], (((y * MODULE_PX + dy) * width) + x * MODULE_PX + dx) * 4)
    }
  }))
  return { data, width, height: width }
}

// The modules of a QR code with a white border of `quiet` modules on each side, as a reader needs one.
export const withQuietZone = (modules: boolean[][], quiet: number): boolean[][] => {
  const span = modules.length + quiet * 2
  return Array.from({ length: span }, (_, y) => Array.from({ length: span }, (_, x) => modules[y - quiet]?.[x - quiet] ?? false))
}
