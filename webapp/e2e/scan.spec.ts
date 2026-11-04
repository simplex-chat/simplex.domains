import { chromium, expect, type Browser } from "@playwright/test"
import { readFileSync, writeFileSync } from "node:fs"
import { newOwnerCode } from "../src/flow.ts"
import { encodeQr } from "../src/qr.ts"
import type { Pixels } from "../src/scan.ts"
import { qrPixels, withQuietZone } from "../test/qr-image.ts"
import { codeField, LINKS_HEADING, onStep, search, test, uniqueLabel } from "./helpers.ts"

// Chromium's fake camera stands in for a phone's: listed as a device, refused until the camera is granted, and showing a
// still frame of a QR code when given a video file.
test.skip(({ browserName }) => browserName !== "chromium", "only Chromium has a fake camera to read from")

const PHONE = { width: 390, height: 844 }
const LAPTOP = { width: 1280, height: 900 }
const FAKE_CAMERA = "--use-fake-device-for-media-stream"
// the decode test's fixture: a link's QR code in grey, tilted and noisy, as a binary PGM
const FIXTURE = new URL("../test/fixtures/scan-link.pgm", import.meta.url)
const FIXTURE_LINK = "https://smp8.simplex.im/a#ScanY8m3qT0vLw2Ab7cD9eF1gH3jK5mN7p"
const NO_CAMERA = "Allow the camera, or paste the link."

// Playwright's headless shell has no cameras at all; the full Chromium, in its own headless mode, has the fake one
const withCamera = (args: string[]) => chromium.launch({ channel: "chromium", args })

// The grey image as one frame of a Y4M video, its colour planes neutral, which Chromium's fake camera shows on a loop.
function y4mOf(pgm: Buffer): Buffer {
  const header = /^P5\s+(\d+)\s+(\d+)\s+255\s/.exec(pgm.toString("latin1", 0, 32))!
  const [width, height] = [Number(header[1]), Number(header[2])]
  const chroma = Buffer.alloc((width / 2) * (height / 2) * 2, 128)
  return Buffer.concat([Buffer.from(`YUV4MPEG2 W${width} H${height} F10:1 Ip A1:1 C420jpeg\nFRAME\n`), pgm.subarray(header[0].length), chroma])
}

// the white border, in modules, a QR code is shown with
const QUIET_ZONE = 4
// a reader's picture of a name code's QR, as a binary PGM, in grey
function pgmOf({ data, width, height }: Pixels): Buffer {
  const grey = Buffer.alloc(width * height)
  for (let i = 0; i < grey.length; i++) grey[i] = data[i * 4]
  return Buffer.concat([Buffer.from(`P5\n${width} ${height}\n255\n`), grey])
}

async function linksStep(browser: Browser, baseURL: string, grant: boolean) {
  const context = await browser.newContext({ baseURL, viewport: PHONE, hasTouch: true, reducedMotion: "reduce" })
  if (grant) await context.grantPermissions(["camera"])
  const page = await context.newPage()
  await search(page, uniqueLabel("scan"))
  await onStep(page).getByRole("button", { name: "Register" }).click()
  await expect(onStep(page).getByRole("heading", { name: LINKS_HEADING })).toBeVisible()
  return { context, page, scan: onStep(page).getByRole("button", { name: "Scan QR code" }) }
}

test("the Link field offers a scan only on a phone with a camera, and only while it is empty", async ({ baseURL, page }) => {
  const without = await linksStep(page.context().browser()!, baseURL!, false)
  const link = (on: typeof page) => onStep(on).getByRole("textbox", { name: "Link", exact: true })
  await expect(without.page.getByRole("button", { name: "Paste" })).toBeVisible()
  await expect(without.scan, "no camera, no scan").toBeHidden()
  await expect(link(without.page), "a phone's placeholder fits beside Paste").toHaveAttribute("placeholder", "Contact or channel link")
  await without.context.close()
  const browser = await withCamera([FAKE_CAMERA])
  try {
    const { page: phone, scan } = await linksStep(browser, baseURL!, false)
    await expect(scan).toBeVisible()
    await expect(phone.getByRole("button", { name: "Paste" }), "paste stays").toBeVisible()
    await expect(link(phone)).toHaveAttribute("placeholder", "Paste or scan a link")
    const fits = await link(phone).evaluate((input: HTMLInputElement) => {
      const probe = Object.assign(document.createElement("span"), { textContent: input.placeholder })
      probe.style.cssText = `position: absolute; white-space: nowrap; font: ${getComputedStyle(input).font}`
      document.body.append(probe)
      return probe.getBoundingClientRect().width <= input.clientWidth
    })
    expect(fits, "the placeholder fits its field beside Paste and the scan button").toBe(true)
    await phone.setViewportSize(LAPTOP)
    await expect(scan, "a laptop's camera faces its reader").toBeHidden()
    await expect(link(phone), "the placeholder follows the window").toHaveAttribute("placeholder", "Paste a contact address or channel link")
    await phone.setViewportSize(PHONE)
    await expect(link(phone)).toHaveAttribute("placeholder", "Paste or scan a link")
    await onStep(phone).getByRole("textbox", { name: "Link", exact: true }).fill("https://smp8.simplex.im/a#typed")
    await expect(scan).toBeHidden()
  } finally {
    await browser.close()
  }
})

test("a camera not allowed says so, and the field still takes a pasted link", async ({ baseURL }) => {
  const browser = await withCamera([FAKE_CAMERA])
  try {
    const { page, scan } = await linksStep(browser, baseURL!, false)
    await scan.click()
    await expect(onStep(page).locator(".field-error")).toHaveText(NO_CAMERA)
    await expect(page.getByRole("dialog")).toHaveCount(0)
    const link = onStep(page).getByRole("textbox", { name: "Link", exact: true })
    await link.fill(FIXTURE_LINK)
    await expect(onStep(page).locator(".link-field").first()).toHaveAttribute("data-state", "ok")
    await expect(onStep(page).getByText(NO_CAMERA)).toHaveCount(0)
  } finally {
    await browser.close()
  }
})

test("the camera reads a link's QR code into the Link field", async ({ baseURL }, testInfo) => {
  const video = testInfo.outputPath("scan-link.y4m")
  writeFileSync(video, y4mOf(readFileSync(FIXTURE)))
  const browser = await withCamera([FAKE_CAMERA, `--use-file-for-fake-video-capture=${video}`])
  try {
    const { page, scan } = await linksStep(browser, baseURL!, true)
    await scan.click()
    const link = onStep(page).getByRole("textbox", { name: "Link", exact: true })
    await expect(link).toHaveValue(FIXTURE_LINK, { timeout: 10_000 })
    await expect(page.getByRole("dialog"), "the camera's view goes once it has read the code").toHaveCount(0)
    await expect(onStep(page).locator(".link-field").first()).toHaveAttribute("data-state", "ok")
    await expect(link).toBeFocused()
  } finally {
    await browser.close()
  }
})

test("Cancel closes the camera's view, leaving the field empty and focused", async ({ baseURL }) => {
  // the fake camera's own picture, which holds no QR code
  const browser = await withCamera([FAKE_CAMERA])
  try {
    const { page, scan } = await linksStep(browser, baseURL!, true)
    await scan.click()
    const dialog = page.getByRole("dialog", { name: "Scan a QR code" })
    await expect(dialog.locator("video")).toBeVisible()
    await expect.poll(() => dialog.locator("video").evaluate((v: HTMLVideoElement) => v.videoWidth), "the camera's picture").toBeGreaterThan(0)
    await dialog.getByRole("button", { name: "Cancel" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    const link = onStep(page).getByRole("textbox", { name: "Link", exact: true })
    await expect(link).toHaveValue("")
    await expect(link).toBeFocused()
  } finally {
    await browser.close()
  }
})

test("the camera reads a name code's QR code into the Code field of Check your code, which judges it", async ({ baseURL }, testInfo) => {
  const code = newOwnerCode()
  const video = testInfo.outputPath("scan-code.y4m")
  writeFileSync(video, y4mOf(pgmOf(qrPixels(withQuietZone(encodeQr(code)!.modules, QUIET_ZONE)))))
  const browser = await withCamera([FAKE_CAMERA, `--use-file-for-fake-video-capture=${video}`])
  try {
    const context = await browser.newContext({ baseURL, viewport: PHONE, hasTouch: true, reducedMotion: "reduce" })
    await context.grantPermissions(["camera"])
    const page = await context.newPage()
    await page.goto("/#/code")
    const scan = onStep(page).getByRole("button", { name: "Scan QR code" })
    await expect(scan).toBeVisible()
    await page.setViewportSize(LAPTOP)
    await expect(scan, "a laptop's camera faces its reader").toBeHidden()
    await page.setViewportSize(PHONE)
    await scan.click()
    await expect(page.getByRole("dialog", { name: "Scan a QR code" })).toContainText("Point the camera at the QR code of your name code.")
    await expect(codeField(page)).toHaveValue(code, { timeout: 10_000 })
    await expect(page.getByRole("dialog"), "the camera's view goes once it has read the code").toHaveCount(0)
    await expect(onStep(page).locator(".verdict"), "the code judged").not.toBeEmpty()
    await expect(codeField(page)).toBeFocused()
    await expect(scan, "a field holding a code offers no scan").toBeHidden()
  } finally {
    await browser.close()
  }
})

test("a camera not allowed for the Code field says so", async ({ baseURL }) => {
  const browser = await withCamera([FAKE_CAMERA])
  try {
    const context = await browser.newContext({ baseURL, viewport: PHONE, hasTouch: true, reducedMotion: "reduce" })
    const page = await context.newPage()
    await page.goto("/#/code")
    await onStep(page).getByRole("button", { name: "Scan QR code" }).click()
    await expect(onStep(page).locator(".verdict.bad")).toHaveText("The camera could not be used. Allow the camera, or paste the code.")
    await expect(page.getByRole("dialog")).toHaveCount(0)
  } finally {
    await browser.close()
  }
})
