import { expect, test } from "@playwright/test"
import { control, savedCode, searchName, shot, startOrder, uniqueLabel, waitRegistered } from "./helpers.ts"

test("a prepaid code is checked, applied on search, and registers a name with nothing to pay", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 6, years: 5 }) as { code: string }
  await page.goto("/")
  await page.getByText("Check a code").click()
  await page.getByRole("textbox", { name: "Code", exact: true }).fill(code.toLowerCase())
  await expect(page.locator(".verdict.ok")).toContainText("Covers names of 6 or more letters, for 5 years.")
  await shot(page, "K1-code-valid")
  await page.getByRole("button", { name: "Use this code" }).click()
  await expect(page.getByText("Code applied: names of 6 or more letters, for 5\u00a0years. Search a name to use it.")).toBeVisible()
  await shot(page, "K1b-code-applied-home")

  const label = uniqueLabel("pre")
  await page.getByLabel("Name", { exact: true }).fill(label)
  await page.getByLabel("Name", { exact: true }).press("Enter")
  await expect(page.getByText("Code applied")).toBeVisible()
  await expect(page.locator(".result .chip", { hasText: "5 years + 30 days" })).toBeVisible()
  await shot(page, "K2-code-applied")
  await page.getByRole("button", { name: "Register with code" }).click()

  await expect(page.getByText("Paid with your code")).toBeVisible()
  await expect(page.locator(".crumb", { hasText: "Payment" })).toHaveCount(0)
  await shot(page, "K3-checkout-covered")
  await page.getByRole("button", { name: "Continue" }).click()
  await savedCode(page)
  await page.getByRole("button", { name: "Register" }).click()
  await page.waitForURL(/\?registration=/)
  await expect(page.locator(".crumb.on")).toHaveText("4Registration")
  await waitRegistered(page, label)
  await expect(page.getByText(/Registered for 5 years \+ 30 days/)).toBeVisible()
  await shot(page, "K8-registered-with-code")
  expect((await searchName(request, label)).status).toBe("registered")
  await page.goto("/#/names")
  await expect(page.locator(".row-item", { hasText: `${label}.simplex` }).locator(".chip")).toHaveText("Registered")
  await expect(page.locator(".row-item", { hasText: `${label}.simplex` })).toContainText(/paid with a code/i)
  await shot(page, "K10-names-paid-with-code")

  // the code is spent
  await page.goto("/")
  await page.getByText("Check a code").click()
  await page.getByRole("textbox", { name: "Code", exact: true }).fill(code)
  await expect(page.locator(".verdict.bad")).toContainText("This code was already used")
  await shot(page, "K5-code-used")
})

test("the checkout's code entry refuses a code for longer names, and the popup refuses typos and owner codes", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 8 }) as { code: string }
  await page.goto("/")
  await page.getByText("Check a code").click()
  await page.getByRole("textbox", { name: "Code", exact: true }).fill("SN7-BJTBP-29596-R3HJ8-25YM8")
  await expect(page.locator(".verdict.bad")).toContainText("This code is not valid")
  await shot(page, "K6-code-invalid")
  await page.getByRole("textbox", { name: "Code", exact: true }).fill("SN-8M7X0-8Z533-AG8DP-RBN5T-BPQ6D-YH09G")
  await expect(page.locator(".verdict.bad")).toContainText("This is a name code")
  await expect(page.getByText("Restore in Your names")).toBeVisible()
  await page.getByLabel("Close").click()

  const label = uniqueLabel("k7")
  await page.getByLabel("Name", { exact: true }).fill(label.slice(0, 7))
  await page.getByLabel("Name", { exact: true }).press("Enter")
  await page.getByRole("button", { name: "Register" }).click()
  await page.getByText("I have a code").click()
  await page.getByRole("textbox", { name: "Code", exact: true }).fill(code)
  await expect(page.getByText(/This code covers names of 8 or more letters; .* has 7/)).toBeVisible()
  await shot(page, "K7-code-too-short")
})

test("a code added under Your names is listed, used, and forgotten", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 7 }) as { code: string }
  await page.goto("/#/names")
  await page.getByRole("button", { name: "Add a code" }).click()
  await page.getByRole("textbox", { name: "Code", exact: true }).fill(code)
  await expect(page.locator(".verdict.ok")).toBeVisible()
  await shot(page, "N12a-add-code")
  await page.getByRole("button", { name: "Add to your codes" }).click()
  const row = page.locator(".row-item", { hasText: code })
  await expect(row.locator(".chip")).toHaveText("Unused")
  await row.getByText("Use", { exact: true }).click()
  await expect(page).toHaveURL(/#\/$/)
  await page.getByLabel("Name", { exact: true }).fill("sixsix")
  await page.getByLabel("Name", { exact: true }).press("Enter")
  await expect(page.getByText("Your code covers names of 7 or more letters.")).toBeVisible()

  await page.goto("/#/names")
  await page.getByText("Forget everything in this browser").click()
  await shot(page, "N12c-forget")
  await page.getByRole("button", { name: "Forget everything" }).click()
  await expect(page.getByText("No codes in this browser yet.")).toBeVisible()
})

test("an owner code shown at checkout is kept in Your names until its order exists", async ({ page }) => {
  const label = uniqueLabel("pend")
  await page.goto("/")
  await page.getByLabel("Name", { exact: true }).fill(label)
  await page.getByLabel("Name", { exact: true }).press("Enter")
  await page.getByRole("button", { name: "Register" }).click()
  await page.getByRole("button", { name: "Continue" }).click()
  await expect(page.getByTestId("owner-code")).toBeVisible()
  await page.goto("/#/names")
  const row = page.locator(".row-item", { hasText: `${label}.simplex` })
  await expect(row.locator(".chip")).toHaveText("Checkout not finished")
  await row.getByText("Find the order").click()
  await expect(row.locator(".chip")).toHaveText("No order was made")
  await shot(page, "N12d-unfinished-checkout")
  await row.getByText("Remove").click()
  await expect(page.locator(".row-item", { hasText: `${label}.simplex` })).toHaveCount(0)
})

test("a code order taken first gives its code back, ready for another name", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  const label = uniqueLabel("ctk")
  await page.goto("/")
  await page.getByText("Check a code").click()
  await page.getByRole("textbox", { name: "Code", exact: true }).fill(code)
  await page.getByRole("button", { name: "Use this code" }).click()
  await control(request, "take", { label })
  await page.getByLabel("Name", { exact: true }).fill(label)
  await page.getByLabel("Name", { exact: true }).press("Enter")
  await page.getByRole("button", { name: "Register with code" }).click()
  await page.getByRole("button", { name: "Continue" }).click()
  await savedCode(page)
  await page.getByRole("button", { name: "Register" }).click()
  await expect(page.getByRole("heading", { name: "Someone registered it first" })).toBeVisible({ timeout: 120_000 })
  await expect(page.locator(".status .code-display")).toHaveText(code)
  await shot(page, "K9-code-released")
  await page.goto("/#/names")
  await expect(page.locator(".row-item", { hasText: code }).locator(".chip")).toHaveText("Unused")
})

test("a code used on an order page leads to search, and a search opened from the app refuses it", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  const useIt = async () => {
    await page.getByText("Check a code").click()
    await page.getByRole("textbox", { name: "Code", exact: true }).fill(code)
    await expect(page.locator(".verdict.ok")).toBeVisible()
    await page.getByRole("button", { name: "Use this code" }).click()
  }
  await startOrder(page, uniqueLabel("cpo"), { method: "btc" })
  await useIt()
  await page.waitForURL((url) => url.search === "" && url.hash === "#/")
  await expect(page.getByText("Code applied: names of 6 or more letters, for 2 years. Search a name to use it.")).toBeVisible()
  await page.getByLabel("Name", { exact: true }).fill(uniqueLabel("cpn"))
  await page.getByLabel("Name", { exact: true }).press("Enter")
  await expect(page.getByText("Code applied")).toBeVisible()

  await page.goto(`/#/?name=${uniqueLabel("cpa")}&owner=0x${"11".repeat(20)}`)
  await useIt()
  await expect(page.locator(".verdict.bad")).toContainText("An order opened from SimpleX is paid here, not with a code.")
})

test("a code applied from the header popup at checkout gives focus back to the redrawn header's Check a code", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  await page.goto(`/#/?name=${uniqueLabel("cfo")}`)
  await page.getByRole("button", { name: "Register" }).click()
  await expect(page.getByRole("heading", { name: "Check your order" })).toBeVisible()
  await page.getByText("Check a code").click()
  await page.getByRole("textbox", { name: "Code", exact: true }).fill(code)
  await expect(page.locator(".verdict.ok")).toBeVisible()
  await page.keyboard.press("Enter")
  await expect(page.getByText("Paid with your code")).toBeVisible()
  await expect(page.getByRole("link", { name: "Check a code" })).toBeFocused()
})

test("removing an applied code returns focus to the search box", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  await page.goto("/#/names")
  await page.getByText("Check a code").click()
  await page.getByRole("textbox", { name: "Code", exact: true }).fill(code)
  await expect(page.locator(".verdict.ok")).toBeVisible()
  await page.getByRole("button", { name: "Use this code" }).click()
  await page.getByRole("link", { name: "Remove" }).click()
  await expect(page.getByText(/^Code applied/)).toHaveCount(0)
  await expect(page.getByLabel("Name", { exact: true })).toBeFocused()
})

test("a device clock three minutes slow signs as soon as the service allows", async ({ page, request }) => {
  await page.clock.install({ time: Date.now() - 3 * 60_000 })
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  await page.goto("/")
  await page.getByText("Check a code").click()
  await page.getByRole("textbox", { name: "Code", exact: true }).fill(code)
  await expect(page.locator(".verdict.ok")).toBeVisible()
  await page.getByRole("button", { name: "Use this code" }).click()
  const label = uniqueLabel("skew")
  await page.getByLabel("Name", { exact: true }).fill(label)
  await page.getByLabel("Name", { exact: true }).press("Enter")
  await page.getByRole("button", { name: "Register with code" }).click()
  await page.getByRole("button", { name: "Continue" }).click()
  await savedCode(page)
  await page.getByRole("button", { name: "Register" }).click()
  await page.waitForURL(/\?registration=/)
  // the commitment waits about 10 s; a page reading the service's times by its own slow clock would wait three minutes more
  await expect(page.getByRole("heading", { name: `${label}.simplex is yours` })).toBeVisible({ timeout: 60_000 })
})

test("restore on a fresh page works at once with the device clock 15 minutes off", async ({ page, browser }) => {
  const { ownerCode } = await startOrder(page, uniqueLabel("fresh"), { method: "btc" })
  const other = await browser.newContext()
  const fresh = await other.newPage()
  await fresh.clock.install({ time: Date.now() + 15 * 60_000 })
  await fresh.goto("/#/restore")
  await fresh.getByLabel("Name code").fill(ownerCode)
  await fresh.getByRole("button", { name: "Restore" }).click()
  await fresh.waitForURL(/\?order=/)
  await other.close()
})

test("a rate-limited code check says how long to wait", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  await page.route("**/api/code/check", (route) => route.fulfill({ status: 429, headers: { "retry-after": "40" }, json: { error: "rate_limited" } }))
  await page.goto("/")
  await page.getByText("Check a code").click()
  await page.getByRole("textbox", { name: "Code", exact: true }).fill(code)
  await expect(page.locator(".verdict.bad")).toContainText("Too many checks just now")
  await expect(page.locator(".verdict.bad")).toContainText("Try again in 40 seconds")
})

test("Your names reads a revoked code as not valid and offers no Use", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 6, state: "revoked" }) as { code: string }
  await page.goto("/")
  await page.evaluate((c) => localStorage.setItem(`simplex-names:code:${c}`, JSON.stringify({ code: c, minLength: 6, years: 2, addedAt: new Date().toISOString() })), code)
  await page.goto("/#/names")
  const row = page.locator(".row-item", { hasText: code })
  await expect(row.locator(".chip")).toHaveText("Not valid")
  await expect(row.getByText("Use", { exact: true })).toHaveCount(0)
})

test("Your names keeps keyboard focus when another tab saves", async ({ page, request }) => {
  await startOrder(page, uniqueLabel("focus"), { method: "btc" })
  await page.goto("/#/names")
  const open = page.locator(".row-item").first().getByText("Open", { exact: true })
  await open.focus()
  const other = await page.context().newPage()
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  await other.goto("/")
  await other.evaluate((c) => localStorage.setItem(`simplex-names:code:${c}`, JSON.stringify({ code: c, minLength: 6, years: 2, addedAt: new Date().toISOString() })), code)
  await expect(page.locator(".row-item", { hasText: code })).toBeVisible()
  await expect(page.locator(".row-item").first().getByText("Open", { exact: true })).toBeFocused()
  await other.close()
})

test("a restore that fails on the network gives focus back to its button", async ({ page }) => {
  const { ownerCode } = await startOrder(page, uniqueLabel("rfocus"), { method: "btc" })
  await page.goto("/#/restore")
  await page.getByLabel("Name code").fill(ownerCode)
  await page.route("**/api/registration/find", (route) => route.abort())
  await page.getByRole("button", { name: "Restore" }).focus()
  await page.keyboard.press("Enter")
  await expect(page.getByText("The service could not be asked now")).toBeVisible()
  await expect(page.getByRole("button", { name: "Restore" })).toBeFocused()
})

