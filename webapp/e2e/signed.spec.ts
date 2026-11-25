import { expect, type APIRequestContext } from "@playwright/test"
import { control, MOCK, onStep, REGISTRATION_MS, startOrder, test, uniqueLabel, waitRegistered } from "./helpers.ts"

const NO_CODE = "This order's name code is not in this browser. Enter it to see the order."
const SKEW_MS = 20 * 60_000
const ORDER_READ = /\/api\/(invoice|registration)\/[^/]+$/

const orderRequests = async (request: APIRequestContext) =>
  ((await (await request.get(`${MOCK}/control/state`)).json()) as { orderRequests: { signed: number; refused: number } }).orderRequests

test("every request for an order is signed with its owner's name key, polls, cancels and the reads to the name registered", async ({ page, request }) => {
  const before = await orderRequests(request)
  const label = uniqueLabel("signed")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  await control(request, `settle/${invoiceId}`)
  await waitRegistered(page, label)
  await startOrder(page, uniqueLabel("signedc"), { method: "btc" })
  await onStep(page).getByRole("button", { name: "Cancel this invoice" }).click()
  await expect(page.getByText("This invoice was cancelled and nothing was received.")).toBeVisible()
  const after = await orderRequests(request)
  expect(after.refused - before.refused, "no order request refused").toBe(0)
  expect(after.signed - before.signed, "the order's reads, signed").toBeGreaterThan(1)
})

test("an order's link in a browser without its name code sends no request for the order and asks for the code", async ({ page, browser, request }) => {
  const { invoiceId } = await startOrder(page, uniqueLabel("nocode"), { method: "btc" })
  const elsewhere = await (await browser.newContext()).newPage()
  const asked: string[] = []
  elsewhere.on("request", (r) => { if (ORDER_READ.test(new URL(r.url()).pathname)) asked.push(r.url()) })
  await elsewhere.goto(`/?order=${invoiceId}`)
  await expect(onStep(elsewhere).getByText(NO_CODE)).toBeVisible()
  await expect(onStep(elsewhere).getByRole("button", { name: "Enter your name code" })).toBeVisible()
  expect(asked).toEqual([])
  expect((await (await request.get(`${MOCK}/control/invoice/${invoiceId}`)).json() as { status: string }).status).toBe("open")
})

test("a device clock 20 minutes off has the order drawn after one more signature, at the service's clock", async ({ page }) => {
  const { invoiceId } = await startOrder(page, uniqueLabel("skew"), { method: "btc" })
  await page.addInitScript((skew) => {
    const now = Date.now
    Date.now = () => now() + skew
  }, SKEW_MS)
  const reads: number[] = []
  page.on("response", (r) => { if (new URL(r.url()).pathname === `/api/invoice/${invoiceId}`) reads.push(r.status()) })
  await page.reload()
  await expect(onStep(page).getByRole("heading", { name: "Pay with Bitcoin" })).toBeVisible({ timeout: REGISTRATION_MS })
  expect(reads.slice(0, 2), "refused for its time, then answered").toEqual([400, 200])
})
