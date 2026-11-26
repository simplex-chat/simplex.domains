import { expect, type Page } from "@playwright/test"
import { LOCAL } from "../src/config.ts"
import { checksumAddress } from "../src/crypto/wallet.ts"
import { walletOf } from "../src/flow.ts"
import { checkoutOwnerCode, codeField, control, onStep, search, startOrder, test, toCodeStep, uniqueLabel, waitRegistered } from "./helpers.ts"

const PUBLIC = "Your name address is public. Send it with any support requests."
const addressOf = (code: string) => checksumAddress(walletOf(code)!.address)
const shownAddress = (page: Page) => onStep(page).locator(".name-address .mono")
const explorer = (page: Page) => onStep(page).getByRole("link", { name: "Open your names on Etherscan" })

test("the name address stands beside the name code on its step, on the registered order's page, in Your names and in Check your code", async ({ page, request }) => {
  await search(page, uniqueLabel("addrstep"))
  await toCodeStep(page)
  const stepCode = await checkoutOwnerCode(page)
  await expect(onStep(page).locator(".name-address")).toContainText(PUBLIC)
  await expect(shownAddress(page)).toHaveText(addressOf(stepCode))

  const label = uniqueLabel("addr")
  const { invoiceId, ownerCode } = await startOrder(page, label, { method: "btc" })
  await control(request, `settle/${invoiceId}`)
  await waitRegistered(page, label)
  await expect(shownAddress(page), "under the registration's end, with the code hidden").toHaveText(addressOf(ownerCode))
  await expect(onStep(page).getByTestId("owner-code")).not.toHaveText(ownerCode)
  await page.goto("/#/names")
  const row = page.locator(".list-row", { hasText: `${label}.simplex` })
  await row.getByRole("button", { name: "Name code" }).click()
  await expect(row.locator(".name-address .mono")).toHaveText(addressOf(ownerCode))
  await page.goto("/#/code")
  await codeField(page).fill(ownerCode)
  await expect(onStep(page).getByRole("button", { name: "Add to Your names" })).toBeEnabled()
  await expect(shownAddress(page), "Check your code with the name code").toHaveText(addressOf(ownerCode))
})

test("a registered name links Etherscan's page of the registrar's tokens its name address holds", async ({ page, request }) => {
  const label = uniqueLabel("scan")
  const { invoiceId, ownerCode } = await startOrder(page, label, { method: "btc" })
  await control(request, `settle/${invoiceId}`)
  await waitRegistered(page, label)
  const href = `${LOCAL.explorer}/token/${LOCAL.baseRegistrar}?a=${addressOf(ownerCode)}`
  await expect(explorer(page), "with the code hidden").toHaveAttribute("href", href)
  await expect(onStep(page).locator(".explorer")).toHaveText("Open your names on Etherscan. Check that this name is listed. If it is not, contact support.")
  const lead = await onStep(page).locator(".lead").boundingBox()
  const line = await onStep(page).locator(".explorer").boundingBox()
  expect(line!.y, "under Registered until").toBeGreaterThan(lead!.y)
  expect(await onStep(page).locator(".screen-body > *").first().locator(".explorer").count(), "the first thing under it").toBe(1)
  await page.goto("/#/names")
  const row = page.locator(".list-row", { hasText: `${label}.simplex` })
  await row.getByRole("button", { name: "Name code" }).click()
  await expect(row.getByRole("link", { name: "Open your names on Etherscan" })).toHaveAttribute("href", href)
})
