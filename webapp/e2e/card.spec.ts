import { expect, type Page } from "@playwright/test"
import { heldPrice, LOCAL } from "../src/config.ts"
import { cardFrame, cardFrameOf, fakeIntent, onStep, payButton, startOrder, test, uniqueLabel, withStripeKey } from "./helpers.ts"

const UNCHECKED = "Sorry, the payment details of this order could not be checked, so they are not shown. Please contact support with the order reference."
const OTHER_ORIGIN = "http://127.0.0.2:5999"
const SETTLE_MS = 2000

// a page of another origin that frames the card page and sends it a mount
async function framedElsewhere(page: Page, browserName: string): Promise<void> {
  if (browserName === "chromium") await page.context().grantPermissions(["local-network-access"])
  await page.route(`${OTHER_ORIGIN}/**`, (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><iframe src="${LOCAL.cardOrigin}/"></iframe>` }))
  await page.goto(`${OTHER_ORIGIN}/`)
  const frame = page.frames().find((f) => f.url().startsWith(LOCAL.cardOrigin))!
  await frame.waitForLoadState()
  await page.evaluate((card) => document.querySelector("iframe")!.contentWindow!.postMessage({ type: "mount", clientSecret: "pi_x_secret_y", amount: 10000, dark: false }, card), LOCAL.cardOrigin)
}

test("the card page takes a mount only from the names page's origin", async ({ page, browserName }) => {
  await framedElsewhere(page, browserName)
  await page.waitForTimeout(SETTLE_MS)
  const frame = page.frames().find((f) => f.url().startsWith(LOCAL.cardOrigin))!
  expect(await frame.locator("#form > *").count(), "nothing drawn for another origin").toBe(0)
})

test("a PaymentIntent of another amount than the invoice's is not mounted, and the order's page withholds the card form", async ({ page }) => {
  const label = uniqueLabel("intent")
  await startOrder(page, label, { method: "card" })
  await withStripeKey(page)
  const mounts: number[] = []
  await page.exposeFunction("cardMounted", () => mounts.push(1))
  await page.route("https://js.stripe.com/**", (route) => route.fulfill({ contentType: "text/javascript", body: `window.Stripe = () => ({
    retrievePaymentIntent: async () => (${fakeIntent(heldPrice(label.length) + 100)}),
    elements: () => ({ update: () => undefined, create: () => ({ on: () => undefined, destroy: () => undefined, mount: () => window.cardMounted?.() }) }),
  })` }))
  await page.reload()
  await expect(onStep(page).getByText(UNCHECKED)).toBeVisible()
  await expect(onStep(page).locator(".stripe")).toHaveCount(0)
  expect(mounts).toEqual([])
})

test("a message from another origin, or from the names page itself, is ignored, and the card page's own paid moves the order on", async ({ page }) => {
  test.skip(!!process.env.BASE_URL, "frames another origin, which the built page's policy refuses")
  await startOrder(page, uniqueLabel("paidmsg"), { method: "card" })
  await expect(cardFrame(page).locator(".stand-in")).toBeVisible()
  const forged = "parent.postMessage({ type: \"paid\", id: \"pi_forged\" }, \"*\"); parent.postMessage({ type: \"height\", px: 4321 }, \"*\")"
  await page.route(`${OTHER_ORIGIN}/**`, (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><script>${forged}</script>` }))
  await page.evaluate((other) => {
    document.body.append(Object.assign(document.createElement("iframe"), { src: `${other}/` }))
    postMessage({ type: "paid", id: "pi_forged" }, "*")
    postMessage({ type: "height", px: 4321 }, "*")
  }, OTHER_ORIGIN)
  await page.waitForTimeout(SETTLE_MS)
  await expect(onStep(page).getByRole("heading", { name: "Pay by card" })).toBeVisible()
  expect(await page.locator("iframe.card-frame").evaluate((f) => (f as HTMLElement).style.height), "the frame's height from the card page alone").not.toBe("4321px")
  await (await cardFrameOf(page)).evaluate(() => parent.postMessage({ type: "paid", id: "pi_forged" }, "*"))
  await page.waitForTimeout(SETTLE_MS)
  await expect(onStep(page).getByRole("heading", { name: "Pay by card" }), "a paid the page did not ask for").toBeVisible()
  await payButton(page).click()
  await expect(page.getByText("Waiting for Stripe to confirm")).toBeVisible()
})

test("the names page admits the card page's origin alone among the frames, and no Stripe host", async ({ page }) => {
  test.skip(!process.env.BASE_URL, "the policy is the built page's")
  await page.goto("/")
  const policy = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content")
  expect(policy).toContain(`frame-src ${LOCAL.cardOrigin};`)
  expect(policy).not.toContain("stripe")
})
