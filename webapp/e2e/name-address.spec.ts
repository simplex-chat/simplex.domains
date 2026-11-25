import { expect, type Page } from "@playwright/test"
import { LOCAL } from "../src/config.ts"
import { checksumAddress } from "../src/crypto/wallet.ts"
import { walletOf } from "../src/flow.ts"
import { checkoutOwnerCode, control, onStep, search, startOrder, test, toCodeStep, uniqueLabel, waitRegistered } from "./helpers.ts"

const PUBLIC = "Your name address is public. Send it with any support requests."
const addressOf = (code: string) => checksumAddress(walletOf(code)!.address)
const shownAddress = (page: Page) => onStep(page).locator(".name-address .mono")
const explorer = (page: Page) => onStep(page).getByRole("link", { name: "Open your names on Etherscan" })

test("the name address stands beside the name code on its step, on the registered order's page and in Your names", async ({ page, request }) => {
  await search(page, uniqueLabel("addrstep"))
  await toCodeStep(page)
  const stepCode = await checkoutOwnerCode(page)
  await expect(onStep(page).locator(".name-address")).toContainText(PUBLIC)
  await expect(shownAddress(page)).toHaveText(addressOf(stepCode))

  const label = uniqueLabel("addr")
  const { invoiceId, ownerCode } = await startOrder(page, label, { method: "btc" })
  await control(request, `settle/${invoiceId}`)
  await waitRegistered(page, label)
  await expect(shownAddress(page)).toHaveText(addressOf(ownerCode))
  await page.goto("/#/names")
  const row = page.locator(".list-row", { hasText: `${label}.simplex` })
  await row.getByRole("button", { name: "Name code" }).click()
  await expect(row.locator(".name-address .mono")).toHaveText(addressOf(ownerCode))
})

test("a registered name links Etherscan's page of the registrar's tokens its name address holds", async ({ page, request }) => {
  const label = uniqueLabel("scan")
  const { invoiceId, ownerCode } = await startOrder(page, label, { method: "btc" })
  await control(request, `settle/${invoiceId}`)
  await waitRegistered(page, label)
  const href = `${LOCAL.explorer}/token/${LOCAL.baseRegistrar}?a=${addressOf(ownerCode)}`
  await expect(explorer(page)).toHaveAttribute("href", href)
  await expect(onStep(page).locator(".explorer")).toHaveText("Open your names on Etherscan. Check that this name is listed. If it is not, contact support.")
  await page.goto("/#/names")
  const row = page.locator(".list-row", { hasText: `${label}.simplex` })
  await row.getByRole("button", { name: "Name code" }).click()
  await expect(row.getByRole("link", { name: "Open your names on Etherscan" })).toHaveAttribute("href", href)
})
