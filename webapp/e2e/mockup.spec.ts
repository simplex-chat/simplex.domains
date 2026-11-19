import { expect, type Page } from "@playwright/test"
import { labelHash } from "../src/crypto/registration.ts"
import { hex } from "../src/crypto/wallet.ts"
import {
  brokenNames, CHAIN, channelLink, codeField, contactLink, control, keepOrder, LINKS_HEADING, onStep, previewsShown, registrationView, search, test, toReview, uniqueLabel, useCode,
} from "./helpers.ts"

const PHONE = { width: 390, height: 844 }
const LAPTOP = { width: 1280, height: 800 }
// 1 January 2029, a registered name's end
const EXPIRES_AT = 1861833600

// A registered name this browser holds, with the links its records answer.
async function registeredName(page: Page, id: string, label: string, links: { contact: string; channel: string }): Promise<void> {
  const order = await keepOrder(page, id, null, label, links)
  await page.route(`**/api/registration/${id}*`, (route) => route.fulfill({ json: registrationView(order, { phase: "registered", commitTx: "0x02", registerTx: "0x03", expiresAt: EXPIRES_AT }) }))
  await page.route(`**/api/name/${hex(labelHash(label))}*`, (route) => route.fulfill({ json: { status: "registered", entities: [], owner: order.owner, resolver: CHAIN.resolver,
    chainId: CHAIN.chainId, records: links, recordsNonce: 0, expiresAt: EXPIRES_AT, tld: "simplex", community: null } }))
}

// Each focus stop from the page's start, with whether it draws a ring: on itself, on the pill of the field it is in,
// or on the box that stands for its checkbox.
async function focusStops(page: Page): Promise<string[]> {
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur()
    for (const seen of document.querySelectorAll<HTMLElement>("[data-stop-seen]")) delete seen.dataset.stopSeen
  })
  const stops: string[] = []
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press("Tab")
    const stop = await page.evaluate(() => {
      const e = document.activeElement as HTMLElement | null
      if (!e || e === document.body || e.dataset.stopSeen) return null
      e.dataset.stopSeen = "1"
      const ringed = (n: Element | null) => n !== null && getComputedStyle(n).outlineStyle !== "none" && parseFloat(getComputedStyle(n).outlineWidth) > 0
      const host = e.tagName === "INPUT" ? e.matches("[type=checkbox]") ? e.nextElementSibling : e.closest(".field") : e
      return `${e.tagName.toLowerCase()} "${(e.getAttribute("aria-label") ?? e.textContent ?? "").trim().slice(0, 30)}": ${ringed(host) ? "ring" : "none"}`
    })
    if (stop === null) break
    stops.push(stop)
  }
  return stops
}

// The controls in view whose look stays the same under the pointer.
async function stillOnHover(page: Page): Promise<string[]> {
  // a chosen method, a ticked box and a field whose colour says its verdict keep their look
  const controls = page.locator("body a[href]:visible, body button:visible:enabled, body [role=radio][aria-checked=false]:visible, body .check:not(:has(input:checked)):visible, body .field:not(.ok, .bad):visible")
  const style = (i: number) => controls.nth(i).evaluate((e) => {
    const cs = getComputedStyle(e)
    const box = e.querySelector(".box")
    return [cs.backgroundColor, cs.borderColor, cs.color, cs.textDecorationLine, cs.filter, cs.opacity, box ? getComputedStyle(box).borderColor : ""].join(" ")
  })
  const still: string[] = []
  for (let i = 0; i < await controls.count(); i++) {
    await page.mouse.move(0, 0)
    const before = await style(i)
    await controls.nth(i).hover()
    await expect.poll(() => style(i), { timeout: 1000 }).not.toBe(before).catch(() => undefined)
    if (await style(i) === before) still.push((await controls.nth(i).evaluate((e) => e.getAttribute("aria-label") ?? e.textContent ?? "")).trim().slice(0, 30))
  }
  await page.mouse.move(0, 0)
  return still
}

test("every control draws a focus ring on its focus stop and changes under the pointer, on the home, the steps and Your names", async ({ page, request }) => {
  await page.setViewportSize(LAPTOP)
  const pages: [string, () => Promise<unknown>][] = [
    ["a taken name's answer", async () => {
      await search(page, "bakery")
      await expect(page.locator(".answer .chat")).toHaveCount(2)
    }],
    ["the links step", async () => {
      await search(page, uniqueLabel("rings"))
      await onStep(page).getByRole("button", { name: "Register" }).click()
      await expect(onStep(page).getByRole("heading", { name: LINKS_HEADING })).toBeVisible()
      await onStep(page).getByRole("textbox", { name: "Link", exact: true }).fill(contactLink("R4"))
      await previewsShown(page)
    }],
    ["Check your order", async () => {
      await search(page, uniqueLabel("rings"))
      await toReview(page)
    }],
    ["Check your code", () => page.goto("/#/code")],
    ["Your names", async () => {
      await registeredName(page, "reg-rings", uniqueLabel("rings"), { contact: contactLink("R5"), channel: "" })
      await page.goto("/#/names")
      await expect(page.getByRole("button", { name: "Edit links" })).toBeVisible()
    }],
  ]
  for (const [name, open] of pages) {
    await open()
    await page.evaluate(() => document.fonts.ready)
    const stops = await focusStops(page)
    expect(stops.length, `${name}: focus stops`).toBeGreaterThan(3)
    expect(stops.filter((s) => s.endsWith(": none")), `${name}: stops without a ring`).toEqual([])
    expect(await stillOnHover(page), `${name}: controls the pointer does not change`).toEqual([])
  }
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  await useCode(page, code)
  expect(await stillOnHover(page), "the header with a code: controls the pointer does not change").toEqual([])
})

test("Your names with nothing kept leads to finding a name or adding a name code, from the main button's place", async ({ page }) => {
  for (const size of [LAPTOP, PHONE]) {
    await page.setViewportSize(size)
    await page.goto("/#/names")
    await expect(onStep(page).locator(".card.none")).toHaveText(/^No names in this browser yet/)
    await expect(onStep(page).locator(".card.none")).toContainText("To see a name you registered in another browser, add its name code.")
    const find = onStep(page).getByRole("button", { name: "Find a name" })
    const tops = await Promise.all([find, onStep(page).locator(".actions-row .alt", { hasText: "Add a name code" })].map((l) => l.evaluate((n) => Math.round(n.getBoundingClientRect().top))))
    // the link's top is its row's, as every step's link under the main button
    expect(tops, `Find a name and its link at ${size.width}x${size.height}`).toEqual(size === LAPTOP ? [587, 641] : [636, 690])
  }
  await onStep(page).getByRole("link", { name: "Add a name code" }).click()
  await expect(page.getByRole("heading", { name: "Check your code" })).toBeVisible()
  await page.goBack()
  await onStep(page).getByRole("button", { name: "Find a name" }).click()
  await expect(page.getByLabel("Name", { exact: true })).toBeVisible()
})

test("a name without links offers Add links, one with links Edit links, its actions at the row's right on a phone", async ({ page }) => {
  const bare = uniqueLabel("bare")
  const linked = uniqueLabel("linked")
  await registeredName(page, "reg-bare", bare, { contact: "", channel: "" })
  await registeredName(page, "reg-linked", linked, { contact: contactLink("L1"), channel: channelLink("L2") })
  await page.setViewportSize(PHONE)
  await page.goto("/#/names")
  const row = (label: string) => page.locator(".list-row", { hasText: `${label}.simplex` })
  await expect(row(bare).getByRole("button", { name: "Add links" })).toBeVisible()
  await expect(row(linked).getByRole("button", { name: "Edit links" })).toBeVisible()
  for (const label of [bare, linked]) {
    const [rowBox, actsBox, nameBox] = await Promise.all([row(label), row(label).locator(".acts"), row(label).locator(".name")].map(async (l) => (await l.boundingBox())!))
    const padding = await row(label).evaluate((r) => parseFloat(getComputedStyle(r).paddingRight))
    expect(Math.round(actsBox.x + actsBox.width), `${label}: the actions end at the row's padding`).toBe(Math.round(rowBox.x + rowBox.width - padding))
    expect(actsBox.y, `${label}: the actions under the name`).toBeGreaterThanOrEqual(nameBox.y + nameBox.height)
  }
  await row(bare).getByRole("button", { name: "Add links" }).click()
  await expect(page.getByRole("heading", { name: "Edit links" })).toBeVisible()
})

test("text that is not a link is refused under its field on the links step and in Edit links, and goes on with no link", async ({ page }) => {
  const NOT_A_LINK = "This is not a SimpleX contact address or channel link."
  await search(page, uniqueLabel("notlink"))
  await onStep(page).getByRole("button", { name: "Register" }).click()
  await onStep(page).getByRole("textbox", { name: "Link", exact: true }).fill("https://bakery.example/menu")
  await expect(onStep(page).locator(".field-error")).toHaveText(NOT_A_LINK)
  await expect(onStep(page).getByRole("button", { name: "Continue" })).toBeDisabled()
  await expect(onStep(page).getByRole("button", { name: "Skip for now" })).toBeVisible()
  for (const size of [LAPTOP, PHONE]) {
    await page.setViewportSize(size)
    expect(await onStep(page).locator(".field-error").evaluate((e) => e.getClientRects().length === 1 && Math.round(e.getBoundingClientRect().height) <= 20), `one line at ${size.width}`).toBe(true)
  }
  await page.setViewportSize(LAPTOP)
  await registeredName(page, "reg-notlink", uniqueLabel("notlink"), { contact: "", channel: "" })
  await page.goto("/#/edit/reg-notlink")
  await onStep(page).getByRole("textbox", { name: "Link", exact: true }).fill("https://bakery.example/menu")
  await expect(onStep(page).locator(".field-error")).toHaveText(NOT_A_LINK)
})

test("on a phone, the tab's code shows in the header, saying what it pays for, and the open menu's header is the menu's own colour", async ({ page, request }) => {
  await page.setViewportSize(PHONE)
  const { code } = await control(request, "code", { minLength: 8, years: 5 }) as { code: string }
  await useCode(page, code)
  const chip = page.locator(".code-chip")
  await expect(chip).toBeVisible()
  // "Code" is said, not drawn, on a phone
  await expect(chip.locator(".what")).toHaveText("Code: 8+ letters, 5 years")
  expect(await chip.locator(".code-word").evaluate((w) => w.getBoundingClientRect().width), "the drawn width of \"Code\"").toBeLessThanOrEqual(1)
  const chipBox = (await chip.boundingBox())!
  expect(chipBox.x + chipBox.width, "the chip inside the window").toBeLessThanOrEqual(PHONE.width)
  // the headline, at the phone's size, on one line
  const lines = await page.locator(".home h1").evaluate((h) => Math.round(h.getBoundingClientRect().height / parseFloat(getComputedStyle(h).lineHeight)))
  expect(lines, "the headline's lines").toBe(1)
  await page.getByRole("button", { name: "Menu" }).click()
  await expect(page.locator("#menu")).toBeVisible()
  const [header, menu] = await Promise.all(["body > header", "#menu"].map((s) => page.locator(s).evaluate((n) => getComputedStyle(n).backgroundColor)))
  expect(header, "the header behind the open menu").toBe(menu)
  await page.getByRole("button", { name: "Close menu" }).click()
  await expect(page.locator("#menu")).toBeHidden()
  expect(await page.locator("body > header").evaluate((n) => getComputedStyle(n).backgroundColor), "the header once the menu is closed").toBe("rgba(0, 0, 0, 0)")
})

test("Check your code checks a code from its button: a code cut short is not a code, a whole one is judged at once", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  await page.goto("/#/code")
  await codeField(page).fill("SN-HELLO-WORLD")
  await onStep(page).getByRole("button", { name: "Check" }).click()
  await expect(onStep(page).locator(".verdict.bad")).toHaveText("This is not a SimpleX names code. Check it and try again.")
  await expect(onStep(page).getByRole("button", { name: "Find a name" })).toBeDisabled()
  await codeField(page).fill(code)
  await onStep(page).getByRole("button", { name: "Check" }).click()
  await expect(onStep(page).locator(".verdict.ok")).toContainText("This code allows you to register a free name")
  await expect(onStep(page).getByRole("button", { name: "Find a name" })).toBeEnabled()
})

// Names whose letters fit a heading's line whole at both sizes, at a laptop's only, and at neither, with the heading's
// size each draws at a laptop's and a phone's: the full size, or the smaller one of a name too long for a line at it.
const HEADING_NAMES: [string, string[]][] = [["bakeryhouse", ["40px", "30px"]], ["w".repeat(12), ["40px", "22px"]], ["w".repeat(20), ["26px", "22px"]]]

test("a heading's name too long for a line at the heading's size draws it smaller, across the column, its TLD on its last letters' line", async ({ page }) => {
  for (const [i, [label, sizes]] of HEADING_NAMES.entries()) {
    const order = await keepOrder(page, `reg-h${i}`, null, label)
    await page.route(`**/api/registration/reg-h${i}*`, (route) => route.fulfill({ json: registrationView(order, { phase: "registered", commitTx: "0x02", registerTx: "0x03", expiresAt: EXPIRES_AT }) }))
    await page.goto(`/?registration=reg-h${i}`)
    const heading = page.getByRole("heading", { name: `${label}.simplex is yours` })
    await expect(heading).toBeVisible()
    for (const [j, size] of [LAPTOP, PHONE].entries()) {
      await page.setViewportSize(size)
      const drawn = await heading.evaluate((h) => {
        const tail = h.querySelector(".nowrap")!
        return { size: getComputedStyle(h).fontSize, across: Math.round(h.getBoundingClientRect().width) === Math.round(h.parentElement!.getBoundingClientRect().width),
          tailLines: new Set([...tail.getClientRects()].map((r) => Math.round(r.top))).size }
      })
      expect(drawn, `${label} at ${size.width}`).toEqual({ size: sizes[j], across: true, tailLines: 1 })
      expect(await brokenNames(page), `${label} at ${size.width}: broken though it fits its line`).toEqual([])
    }
    await page.setViewportSize(LAPTOP)
  }
})
