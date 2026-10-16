// Renders the SimpleX symbol into the names site's app icons: on white, opaque, with the symbol in the middle; the
// maskable one keeps it inside the central 60%, the safe zone a launcher's mask never cuts.
//   node dev/app-icons.mjs ../img/simplex-symbol-light.svg ../img
import { readFileSync } from "node:fs"
import { chromium } from "@playwright/test"
const [symbolPath, out] = process.argv.slice(2)
const svg = readFileSync(symbolPath, "utf8")
const icons = [["icon-192.png", 192, 0.62], ["icon-512.png", 512, 0.62], ["icon-maskable-512.png", 512, 0.5], ["apple-touch-icon.png", 180, 0.62]]
const browser = await chromium.launch()
for (const [name, size, share] of icons) {
  const page = await browser.newPage({ viewport: { width: size, height: size } })
  await page.setContent(`<body style="margin:0;width:${size}px;height:${size}px;display:grid;place-items:center;background:#fff">
    <div style="width:${size * share}px;height:${size * share}px">${svg.replace(/width="\d+" height="\d+"/, 'width="100%" height="100%"')}</div></body>`)
  await page.screenshot({ path: `${out}/${name}`, omitBackground: false })
  await page.close()
}
await browser.close()
