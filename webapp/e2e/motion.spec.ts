import { expect, test, type Page } from "@playwright/test"
import { markStep, recordCuts, takeCuts, takeTransitions } from "./cuts.ts"
import { channelLink, contactLink, control, registrationOf, startOrder, uniqueLabel, waitRegistered } from "./helpers.ts"

// The other specs run with reduced motion, which the page honours; these watch the motion itself.
test.use({ reducedMotion: "no-preference" })

const settle = (page: Page, ms = 700) => page.waitForTimeout(ms)
// within a page's 260 ms fade in
const PREVIEW_LAG_MS = 120
// within a part's 240 ms height easing
const NESTED_LAG_MS = 100
// past a page's 300 ms view transition, which waits a frame or more for the browser's picture of the old page
const CHECK_LAG_MS = 800

// A press made from inside the page, and whether what it shows is fading a frame later: an opacity animation or
// transition running on it, or on its pseudo-element, whatever the frames' pace
const fadesAfterPress = (page: Page, press: string, watch: string, pseudo: string | null = null) => page.evaluate(([press, watch, pseudo]) => new Promise<boolean>((done) => {
  document.querySelector<HTMLElement>(press)!.click()
  requestAnimationFrame(() => done(document.querySelector(watch)!.getAnimations({ subtree: true }).some((a) => {
    const effect = a.effect as KeyframeEffect | null
    return a.playState === "running" && (effect?.pseudoElement ?? null) === pseudo && (effect?.getKeyframes().some((k) => "opacity" in k) ?? false)
  })))
}), [press, watch, pseudo] as const)

test.beforeEach(async ({ page }) => {
  await page.addInitScript(recordCuts)
})

test.afterEach(async ({ request }) => {
  await control(request, "search", { chainDown: false, limitSeconds: 0, invoiceError: null, cancelStillOpen: false, findLimitSeconds: 0 })
})

test("searching eases results in and out, a repeated search keeps still, and a pause comes and goes smoothly", async ({ page, request }) => {
  await page.goto("/")
  await settle(page, 1000)
  const name = page.getByLabel("Name", { exact: true })
  await markStep(page, "first search")
  await name.fill(uniqueLabel("mfirst"))
  await name.press("Enter")
  await page.locator(".result").waitFor()
  await settle(page)
  await markStep(page, "second search")
  await name.fill(uniqueLabel("msecond"))
  await name.press("Enter")
  await settle(page)
  await markStep(page, "same search")
  await name.press("Enter")
  await settle(page)
  await markStep(page, "taken name")
  await name.fill("bakery")
  await name.press("Enter")
  await settle(page, 1200)
  await control(request, "search", { limitSeconds: 2 })
  await markStep(page, "rate limit")
  await name.fill(uniqueLabel("mlimit"))
  await name.press("Enter")
  await settle(page, 3500)
  expect(await takeCuts(page)).toEqual([])
})

test("popups, the theme switch and the phone menu ease in and out", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")
  await settle(page, 1000)
  await markStep(page, "menu")
  expect(await fadesAfterPress(page, ".menu-btn", "header nav"), "the menu fades in").toBe(true)
  await settle(page)
  await markStep(page, "popup")
  await page.locator(".ghost-btn", { hasText: "Check a code" }).click()
  await settle(page)
  await page.getByRole("textbox", { name: "Code", exact: true }).fill("SN6-")
  await settle(page, 400)
  await page.keyboard.press("Escape")
  await settle(page)
  await markStep(page, "theme")
  // the other theme's logo fades in over the old one
  expect(await fadesAfterPress(page, ".top .icon-btn:not(.menu-btn)", ".top .brand .logo", "::after"), "the other theme's logo fades in").toBe(true)
  await settle(page, 900)
  await page.getByLabel("Switch light or dark theme").click()
  await settle(page, 900)
  expect(await takeCuts(page)).toEqual([])
})

test("checkout eases its link previews, method and code entry, and each page opens with a cross-fade", async ({ page }) => {
  await page.goto(`/#/?name=${uniqueLabel("mcheck")}`)
  await page.getByRole("button", { name: "Register" }).waitFor()
  await markStep(page, "to checkout")
  await page.getByRole("button", { name: "Register" }).click()
  await page.getByRole("heading", { name: "Check your order" }).waitFor()
  await settle(page)
  await markStep(page, "link preview")
  await page.getByLabel("Address").fill("https://smp8.simplex.im/a#Y8m3qT0vLw2Ab7cD9eF1gH3jK5mN7pQ9rS")
  await settle(page, 1200)
  await markStep(page, "link error")
  await page.getByLabel("Channel").fill("hello")
  await settle(page)
  await page.getByLabel("Channel").fill("")
  await settle(page)
  await markStep(page, "method")
  await page.locator(".method", { hasText: "Monero" }).click()
  await settle(page, 400)
  await markStep(page, "code entry")
  await page.getByText("I have a code").click()
  await settle(page)
  await markStep(page, "to name code")
  await page.getByRole("button", { name: "Continue" }).click()
  await page.getByRole("heading", { name: "Save your name code" }).waitFor()
  await settle(page)
  await page.getByText("I have saved my code").click()
  await settle(page, 400)
  await markStep(page, "to payment")
  await page.getByRole("button", { name: "Continue to payment" }).click()
  await page.getByRole("heading", { name: "Pay with Monero" }).waitFor()
  await settle(page)
  await markStep(page, "back and forward")
  await page.goBack()
  await settle(page, 1000)
  await page.goForward()
  await settle(page, 1000)
  expect(await takeCuts(page)).toEqual([])
})

test("an order's page eases through each stage to registered, Your names keeps still when another tab writes, and its edit page opened cold eases to its previews", async ({ page, request }) => {
  const label = uniqueLabel("mstage")
  const { invoiceId } = await startOrder(page, label, { method: "btc", contact: contactLink("M1"), channel: channelLink("M2") })
  await settle(page)
  await takeCuts(page)
  await markStep(page, "copy")
  await page.getByText("Copy", { exact: true }).first().click()
  await settle(page, 1800)
  await markStep(page, "partial")
  await control(request, `partial/${invoiceId}`)
  await settle(page, 2500)
  await markStep(page, "confirming")
  await control(request, `confirming/${invoiceId}`)
  await settle(page, 2500)
  await markStep(page, "registering")
  await control(request, `settle/${invoiceId}`)
  await waitRegistered(page, label)
  await settle(page, 1500)
  await markStep(page, "to Your names")
  await page.getByRole("link", { name: "Your names" }).click()
  await settle(page, 1500)
  await markStep(page, "another tab")
  const other = await page.context().newPage()
  await other.goto("/")
  await other.evaluate(() => localStorage.setItem("simplex-names:code:SN6-MOTION", JSON.stringify({ code: "SN6-Z6VPA-7YPF0-XN8B4-9S1ZD", minLength: 6, years: 2, addedAt: new Date().toISOString() })))
  await settle(page, 1500)
  await other.close()
  await markStep(page, "show code")
  await page.getByText("Show code").first().click()
  await settle(page)
  await page.keyboard.press("Escape")
  await settle(page)
  await markStep(page, "forget")
  await page.getByText("Forget everything in this browser").click()
  await settle(page)
  await page.getByRole("button", { name: "Keep them" }).click()
  await settle(page)
  expect(await takeCuts(page)).toEqual([])
  // the link previews come in while the page itself still eases in
  await page.setViewportSize({ width: 390, height: 844 })
  await page.route("**/api/link/preview", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, PREVIEW_LAG_MS))
    await route.continue()
  })
  await page.goto(`/#/edit/${await registrationOf(request, invoiceId)}`)
  await markStep(page, "edit opened cold")
  await expect(page.locator(".link-field .entity:not(.skeleton)")).toHaveCount(2)
  await settle(page, 1000)
  expect(await takeCuts(page)).toEqual([])
})

test("a page opened slides the way the reader goes and a page drawn again morphs its parts, as the browser's view transitions", async ({ page, request }) => {
  await page.goto("/")
  await settle(page, 1000)
  await takeTransitions(page)
  await page.locator("nav a[data-nav=names]").click()
  await settle(page)
  const [opened] = await takeTransitions(page)
  // along the header's sections; the header stays and the footer moves, each apart from the page that slides
  expect(opened.types).toEqual(["forward"])
  expect(opened.groups.sort()).toEqual(["page-foot", "page-top", "root"])
  await page.locator("nav a[data-nav=search]").click()
  await settle(page)
  expect((await takeTransitions(page)).map((t) => t.types)).toEqual([["back"]])
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  await page.goto(`/#/?name=${uniqueLabel("mmorph")}`)
  await page.getByRole("button", { name: "Register" }).click()
  await page.getByRole("heading", { name: "Check your order" }).waitFor()
  await page.getByText("I have a code").click()
  await settle(page)
  await takeTransitions(page)
  await page.locator(".code-entry input").fill(code)
  await expect(page.getByText("Remove the code")).toBeVisible()
  await settle(page)
  const redraws = (await takeTransitions(page)).filter((t) => t.types.includes("redraw"))
  expect(redraws).toHaveLength(1)
  const parts = redraws[0].groups.filter((g) => g.startsWith("part-"))
  // the order's card, its rows and the button morph from where they were, rather than the page fading whole
  expect(parts.length, redraws[0].groups.join(" ")).toBeGreaterThan(5)
  expect(await takeCuts(page)).toEqual([])
})

test("the next step of an order slides forward with its steps and card going over, its ring moving on and the line to it filling; Back slides back", async ({ page }) => {
  await page.goto(`/#/?name=${uniqueLabel("mstep")}`)
  await page.getByRole("button", { name: "Register" }).click()
  await page.getByRole("heading", { name: "Check your order" }).waitFor()
  await settle(page)
  await takeTransitions(page)
  await page.getByRole("button", { name: "Continue" }).click()
  await page.getByRole("heading", { name: "Save your name code" }).waitFor()
  await settle(page)
  const [next] = await takeTransitions(page)
  expect(next.types).toEqual(["forward"])
  // the ring goes over and the line to the step just reached fills, as a part only the new page has
  for (const part of ["order-steps", "order-card", "step-ring", "step-details", "step-name-code", "step-line-details", "step-line-name-code"]) expect(next.groups, part).toContain(part)
  await page.goBack()
  await page.getByRole("heading", { name: "Check your order" }).waitFor()
  await settle(page)
  const [back] = await takeTransitions(page)
  expect(back.types).toEqual(["back"])
  // the line to the step left empties: a part only the old page had
  expect(back.groups).toContain("step-line-name-code")
  expect(await takeCuts(page)).toEqual([])
})

test("codes applied and removed at checkout and on search fade across, with nothing left out of the old page", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  const useCode = async () => {
    await page.locator(".ghost-btn", { hasText: "Check a code" }).click()
    await page.getByRole("textbox", { name: "Code", exact: true }).fill(code)
    await expect(page.locator(".verdict.ok")).toBeVisible()
    await page.getByRole("button", { name: "Use this code" }).click()
    await settle(page)
  }
  await page.goto(`/#/?name=${uniqueLabel("mcode")}`)
  await page.getByRole("button", { name: "Register" }).waitFor()
  await settle(page)
  await markStep(page, "code on search")
  await useCode()
  await markStep(page, "remove on search")
  await page.locator(".covered").getByText("Remove").click()
  await settle(page)
  await page.getByRole("button", { name: "Register" }).click()
  await page.getByRole("heading", { name: "Check your order" }).waitFor()
  await page.getByLabel("Address").fill("https://smp8.simplex.im/a#Y8m3qT0vLw2Ab7cD9eF1gH3jK5mN7pQ9rS")
  await settle(page, 1200)
  await takeCuts(page)
  await markStep(page, "code at checkout")
  await useCode()
  await markStep(page, "remove at checkout")
  await page.getByText("Remove the code").click()
  await settle(page)
  expect(await takeCuts(page)).toEqual([])
})

test("Your names fades out what it takes away: a pending row, a Find link with nothing to find, everything forgotten", async ({ page }) => {
  for (const prefix of ["mpend", "mfind"]) {
    await page.goto(`/#/?name=${uniqueLabel(prefix)}`)
    await page.getByRole("button", { name: "Register" }).click()
    await page.getByRole("button", { name: "Continue" }).click()
    await page.getByRole("heading", { name: "Save your name code" }).waitFor()
  }
  await page.goto("/#/names")
  await settle(page, 1200)
  await takeCuts(page)
  await markStep(page, "find with nothing to find")
  await page.locator(".row-item").first().getByText("Find the order").click()
  await settle(page, 1200)
  await markStep(page, "remove a pending row")
  await page.locator(".row-item").first().getByText("Remove", { exact: true }).click()
  await settle(page)
  await markStep(page, "forget everything")
  await page.getByText("Forget everything in this browser").click()
  await settle(page)
  await page.getByRole("button", { name: "Forget everything" }).click()
  await settle(page, 1000)
  expect(await takeCuts(page)).toEqual([])
})

// Each frame after Find the order is pressed in the first row that has it: where Remove, the fading Find and the old chip are.
interface FindFrame { remove: number; find: number | null; findOpacity: number; chip: number | null }
const findFrames = (page: Page) => page.evaluate(() => new Promise<{ before: { find: number; chip: number }; frames: FindFrame[] }>((done) => {
  const isFind = (b: Element) => b.textContent?.trim() === "Find the order"
  const row = [...document.querySelectorAll(".row-item")].find((r) => [...r.querySelectorAll(".small-btn")].some(isFind))!
  const left = (n: Element | null | undefined) => n ? n.getBoundingClientRect().left : null
  const buttons = () => [...row.querySelectorAll<HTMLElement>(".small-btn")]
  const find = buttons().find(isFind)!
  const before = { find: left(find)!, chip: left(row.querySelector(".chip"))! }
  const frames: FindFrame[] = []
  const start = performance.now()
  find.click()
  const sample = () => {
    const going = row.querySelector(".small-btn.outgoing")
    frames.push({
      remove: left(buttons().find((b) => b.textContent?.trim() === "Remove" && !b.classList.contains("outgoing")))!,
      find: left(going), findOpacity: going ? Number(getComputedStyle(going).opacity) : 0, chip: left(row.querySelector(".outgoing .chip")),
    })
    if (performance.now() - start < 2000) requestAnimationFrame(sample)
    else done({ before, frames })
  }
  requestAnimationFrame(sample)
}))

test("a Find link with nothing to find fades where it stood, and what was beside it moves only once it has mostly gone", async ({ page }) => {
  for (const prefix of ["mwide", "mphone"]) {
    await page.goto(`/#/?name=${uniqueLabel(prefix)}`)
    await page.getByRole("button", { name: "Register" }).click()
    await page.getByRole("button", { name: "Continue" }).click()
    await page.getByRole("heading", { name: "Save your name code" }).waitFor()
  }
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto("/#/names")
    await settle(page, 1200)
    await takeCuts(page)
    const { before, frames } = await findFrames(page)
    const fading = frames.filter((f) => f.find !== null)
    expect(fading.length, `${width}px: Find fades out`).toBeGreaterThan(2)
    for (const f of fading) expect(Math.abs(f.find! - before.find), `${width}px: Find stays where it stood`).toBeLessThan(1)
    const oldChip = frames.find((f) => f.chip !== null)
    expect(Math.abs(oldChip!.chip! - before.chip), `${width}px: the old chip fades from where it was`).toBeLessThan(1)
    const moved = frames.find((f) => Math.abs(f.remove - frames[0].remove) > 1)
    // in one row Remove is at its end, where it stays; rows wrap their buttons onto a line of their own at 760 px
    if (width > 760) expect(moved, `${width}px: Remove stays where it is`).toBeUndefined()
    else if (moved) expect(moved.findOpacity, `${width}px: Remove moves only once Find has mostly gone`).toBeLessThan(0.5)
    await settle(page)
    expect(await takeCuts(page)).toEqual([])
  }
})

test("a code's Use coming back slides Copy and the chip aside rather than jumping them there", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 6, state: "reserved" }) as { code: string }
  await page.goto("/")
  await page.evaluate((code) => localStorage.setItem(`simplex-names:code:${code}`, JSON.stringify({ code, minLength: 6, years: 2, addedAt: new Date().toISOString() })), code)
  await page.goto("/#/names")
  const row = page.locator(".code-row", { hasText: code })
  await expect(row.locator(".chip:not(.outgoing .chip)")).toHaveText("In use")
  await expect(row.getByText("Use", { exact: true })).toHaveCount(0)
  await control(request, "code/state", { code, state: "unused" })
  await page.getByRole("link", { name: "Search" }).click()
  await settle(page)
  await takeCuts(page)
  // the service answers once Your names is on screen, as a slower one would; a quick answer draws Use with the page
  await page.route("**/api/code/check", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, CHECK_LAG_MS))
    await route.continue()
  })
  await markStep(page, "Use comes back")
  // Your names opened again shows the code as read last time, without Use, until the service answers it is unused
  const frames = await page.evaluate((code) => new Promise<{ copy: number; chip: number }[]>((done) => {
    const out: { copy: number; chip: number }[] = []
    document.querySelector<HTMLElement>("nav a[data-nav=names]")!.click()
    const start = performance.now()
    const sample = () => {
      const row = [...document.querySelectorAll("main:not(.pending) .code-row")].find((r) => r.textContent!.includes(code))
      const copy = row && [...row.querySelectorAll(".small-btn")].find((b) => b.textContent!.trim() === "Copy" && !b.closest(".outgoing"))
      const chip = row?.querySelector(".chip:not(.outgoing .chip)")
      if (copy && chip) out.push({ copy: copy.getBoundingClientRect().left, chip: chip.getBoundingClientRect().left })
      if (performance.now() - start < 2000) requestAnimationFrame(sample)
      else done(out)
    }
    requestAnimationFrame(sample)
  }), code)
  await expect(row.getByText("Use", { exact: true })).toBeVisible()
  // Use goes in before Copy, at the row's end, so Copy stays and the chip makes room: it must move, over frames
  const xs = frames.map((f) => Math.round(f.chip))
  const [first, last] = [xs[0], xs[xs.length - 1]]
  expect(Math.abs(last - first), `the chip moves ${first}→${last}`).toBeGreaterThan(10)
  expect(xs.filter((x) => (x - first) * (last - x) > 0).length, `the chip eases over frames ${xs.join(",")}`).toBeGreaterThan(2)
  expect(new Set(frames.map((f) => Math.round(f.copy))).size, "Copy stays where it is").toBe(1)
  expect(await takeCuts(page)).toEqual([])
})

test("a part that grows while the part around it eases carries it on, rather than snapping when that easing ends", async ({ page }) => {
  await page.goto("/#/trademarks")
  await settle(page, 1000)
  type Parts = { outer: HTMLElement; inner: HTMLElement; block: (height: number) => HTMLElement }
  // the app's own copy of the motion module, as a second copy would watch the same parts and fight over them
  await page.evaluate(async () => {
    const url = performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("/src/motion.ts"))!
    const { live } = await import(url) as typeof import("../src/motion.ts")
    const block = (height: number) => Object.assign(document.createElement("div"), { textContent: `${height} px` }, { style: `height: ${height}px` })
    const outer = live(document.createElement("div"))
    const inner = live(document.createElement("div"))
    inner.append(block(50))
    outer.append(inner, block(100))
    document.querySelector("main")!.prepend(outer)
    ;(window as unknown as { parts: Parts }).parts = { outer, inner, block }
  })
  await settle(page)
  await takeCuts(page)
  await markStep(page, "nested growth")
  await page.evaluate(async (lagMs) => {
    const { outer, inner, block } = (window as unknown as { parts: Parts }).parts
    outer.replaceChildren(inner, block(300))
    await new Promise((resolve) => setTimeout(resolve, lagMs))
    inner.replaceChildren(block(250))
  }, NESTED_LAG_MS)
  await settle(page, 1000)
  expect(await takeCuts(page)).toEqual([])
})

test("the phone menu and a popup opened again while they fade carry on from where they were", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")
  await settle(page, 1000)
  // Pressed from inside the page, 60 ms apart, as a test click would wait for the fade to end first; the opacity just
  // before the second press and a frame after it, which goes on up from there rather than starting again from nothing.
  const pressAgainMidFade = (close: string, open: string, watch: string) => page.evaluate(([close, open, watch]) => new Promise<number[]>((done) => {
    document.querySelector<HTMLElement>(close)!.click()
    setTimeout(() => {
      const before = Number(getComputedStyle(document.querySelector(watch)!).opacity)
      document.querySelector<HTMLElement>(open)!.click()
      requestAnimationFrame(() => done([before, Number(getComputedStyle(document.querySelector(`${watch}:not(.closing)`)!).opacity)]))
    }, 60)
  }), [close, open, watch])
  const carriesOn = ([before, after]: number[]) => expect(after).toBeGreaterThanOrEqual(before - 0.02)
  await markStep(page, "menu again mid-fade")
  await page.getByLabel("Menu").click()
  await settle(page)
  carriesOn(await pressAgainMidFade(".menu-btn", ".menu-btn", "header nav"))
  await settle(page)
  await markStep(page, "popup again mid-fade")
  await page.locator(".ghost-btn", { hasText: "Check a code" }).click()
  await settle(page)
  carriesOn(await pressAgainMidFade(".modal-overlay .icon-btn", ".ghost-btn", ".modal-overlay"))
  await settle(page)
  await page.keyboard.press("Escape")
  await settle(page)
  expect(await takeCuts(page)).toEqual([])
})

test("an edit page opened cold and a paused order keep their shape: no placeholder flash, no button that resizes", async ({ page, request }) => {
  await page.route("**/api/invoice", (route) => route.request().method() === "POST" ? route.fulfill({ status: 429, headers: { "retry-after": "12" }, json: { error: "rate_limited" } }) : route.continue())
  await page.goto(`/#/?name=${uniqueLabel("mwait")}&owner=0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed`)
  await page.getByRole("button", { name: "Register" }).click()
  await page.getByRole("button", { name: "Continue" }).click()
  const again = page.getByRole("button", { name: /Try again in/ })
  await again.waitFor()
  const widths = new Set<number>()
  for (let i = 0; i < 3; i++) {
    widths.add(Math.round((await again.boundingBox())!.width))
    await page.waitForTimeout(1000)
  }
  expect([...widths]).toHaveLength(1)
  await page.unroute("**/api/invoice")
  await control(request, "search", { chainDown: false, limitSeconds: 0, invoiceError: null, cancelStillOpen: false, findLimitSeconds: 0 })
  expect(await takeCuts(page)).toEqual([])
})
