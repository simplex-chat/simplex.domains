import { expect, type APIRequestContext, type Page } from "@playwright/test"
import { mkdirSync } from "node:fs"

export const SCREENSHOTS = process.env.SCREENSHOTS_DIR ?? "screenshots"
const MOCK = process.env.MOCK_URL ?? "http://127.0.0.1:8099"
const DESKTOP = { width: 1280, height: 900 }
const PHONE = { width: 390, height: 844 }
// commit age plus mining, signing and the register transaction, with room for a slow chain
export const REGISTRATION_MS = 120_000

// labels are unique per run, since every test shares one chain
export function uniqueLabel(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`
}

export const contactLink = (tag: string) => `https://smp8.simplex.im/a#${tag}Y8m3qT0vLw2Ab7cD9eF1gH3jK5mN7p`
export const channelLink = (tag: string) => `https://smp9.simplex.im/c#${tag}Rk27xN4pDe9Tz1Wb3Yc5Vd7Xf9Hg2J`

export async function control(request: APIRequestContext, path: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = await request.post(`${MOCK}/control/${path}`, { data: body })
  expect(res.ok(), `control ${path}: ${await res.text()}`).toBeTruthy()
  return res.json()
}

export async function registrationOf(request: APIRequestContext, invoiceId: string): Promise<string> {
  const res = await request.get(`${MOCK}/api/invoice/${invoiceId}`)
  return (await res.json()).registration.id
}

export async function searchName(request: APIRequestContext, label: string): Promise<Record<string, unknown>> {
  const { labelHash } = await import("../src/crypto/registration.ts")
  const { hex } = await import("../src/crypto/wallet.ts")
  const res = await request.get(`${MOCK}/api/name/${hex(labelHash(label))}?length=${label.length}`)
  return res.json()
}

// The page in light and dark, on a desktop and on a phone; the theme is a class, so no redraw is needed.
export async function shot(page: Page, name: string): Promise<void> {
  // Chromium's captures are the reviewed set; other browsers keep theirs beside them, to compare
  const browser = page.context().browser()!.browserType().name()
  const dir = browser === "chromium" ? SCREENSHOTS : `${SCREENSHOTS}/${browser}`
  mkdirSync(dir, { recursive: true })
  // fonts.ready can settle before a face first used on this page has loaded, so every declared face is loaded first
  await page.evaluate(() => Promise.all([...document.fonts].map((f) => f.load().catch(() => undefined))).then(() => document.fonts.ready))
  // a face that just loaded, or a colour just switched, is painted on a later frame
  const painted = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  await painted()
  // the pointer is moved off the page's controls, so no capture shows a hover
  await page.mouse.move(0, 0)
  // a popup holds the page still, so a person sees the window, which its backdrop covers whole
  const popupOpen = await page.locator(".modal-overlay:not(.closing)").count() > 0
  // Playwright's WebKit on Linux, drawing in software, takes each capture after a theme switch slower than the last,
  // past a test's time; its captures are a comparison set, so it keeps the light ones
  const themes = browser === "webkit" ? [false] : [false, true]
  for (const [device, size] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
    await page.setViewportSize(size)
    // a phone's scrollbar lies over the page and takes no room
    await page.evaluate((phone) => { document.documentElement.style.scrollbarGutter = phone ? "auto" : "" }, device === "phone")
    for (const dark of themes) {
      await page.evaluate((d) => document.documentElement.classList.toggle("dark", d), dark)
      await painted()
      await page.screenshot({ path: `${dir}/${name}-${device}-${dark ? "dark" : "light"}.png`, fullPage: !popupOpen, animations: "disabled" })
    }
  }
  await page.evaluate(() => {
    document.documentElement.classList.remove("dark")
    document.documentElement.style.scrollbarGutter = ""
  })
  await page.setViewportSize(DESKTOP)
}

export async function search(page: Page, label: string): Promise<void> {
  await page.goto("/")
  await page.getByLabel("Name", { exact: true }).fill(label)
  await page.getByLabel("Name", { exact: true }).press("Enter")
}

export interface OrderOptions {
  method?: "card" | "btc" | "xmr"
  contact?: string
  channel?: string
  shots?: string
}

const METHOD_NAMES = { card: "Card", btc: "Bitcoin", xmr: "Monero" }

// Search, checkout and the owner code, up to the order's page; returns the invoice and the owner code.
export async function startOrder(page: Page, label: string, opts: OrderOptions = {}): Promise<{ invoiceId: string; ownerCode: string }> {
  await search(page, label)
  await page.getByRole("button", { name: "Register" }).click()
  await expect(page.getByRole("heading", { name: "Check your order" })).toBeVisible()
  if (opts.contact) {
    await page.getByLabel("Address").fill(opts.contact)
    await expect(page.locator(".link-field").first().locator(".entity:not(.skeleton)")).toBeVisible()
  }
  if (opts.channel) {
    await page.getByLabel("Channel").fill(opts.channel)
    await expect(page.locator(".link-field").nth(1).locator(".entity:not(.skeleton)")).toBeVisible()
  }
  await page.locator(".method", { hasText: METHOD_NAMES[opts.method ?? "btc"] }).click()
  if (opts.shots) await shot(page, `${opts.shots}-checkout`)
  await page.getByRole("button", { name: "Continue" }).click()
  await expect(page.getByRole("heading", { name: "Save your name code" })).toBeVisible()
  const ownerCode = (await page.getByTestId("owner-code").textContent())!.trim()
  await expect(page.getByRole("button", { name: "Continue to payment" })).toBeDisabled()
  await savedCode(page)
  if (opts.shots) await shot(page, `${opts.shots}-owner-code`)
  await page.getByRole("button", { name: "Continue to payment" }).click()
  await page.waitForURL(/\?order=/)
  const invoiceId = new URL(page.url()).searchParams.get("order")!
  return { invoiceId, ownerCode }
}

// the box stays ticked for the tab's checkout, so a second pass must not untick it
export async function savedCode(page: Page): Promise<void> {
  if (!(await page.getByRole("checkbox", { name: "I have saved my code" }).isChecked())) await page.getByText("I have saved my code").click()
}

export async function waitRegistered(page: Page, label: string): Promise<void> {
  await expect(page.getByRole("heading", { name: `${label}.simplex is yours` })).toBeVisible({ timeout: REGISTRATION_MS })
}
