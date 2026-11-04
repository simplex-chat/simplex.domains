import { expect } from "@playwright/test"
import { codeField, lineStarts, onStep, recordedFrames, recordFrames, registrationOf, search, shot, startOrder, test, toCodeStep, uniqueLabel } from "./helpers.ts"

// Firefox reports a preload not used about ten seconds after its page loads
const PRELOAD_REPORT_MS = 12_000
const FONT_PRELOADS = 4

test("no page leaves a font preload unused in Firefox, whether a tab's first page or a later one", async ({ page, request, browser, baseURL, browserName }) => {
  test.skip(browserName !== "firefox", "only Firefox takes a tab's fonts from its own cache, past the preloads")
  const { invoiceId } = await startOrder(page, uniqueLabel("font"))
  const registrationId = await registrationOf(request, invoiceId)
  const fresh = await browser.newContext({ baseURL })
  try {
    const unused: string[] = []
    fresh.on("console", (m) => { if (m.type() === "warning" && m.text().includes("preloaded with link preload was not used")) unused.push(`${m.page()?.url()}: ${m.text()}`) })
    const tabs = await Promise.all(["/", `/?order=${invoiceId}`, `/#/edit/${registrationId}`].map(async (url) => {
      const tab = await fresh.newPage()
      await tab.goto(url)
      return tab
    }))
    expect(await tabs[0].locator("link[rel=preload][as=font]").count(), "the fonts preloaded on the tab's first page").toBe(FONT_PRELOADS)
    await tabs[0].reload()
    expect(await tabs[0].locator("link[rel=preload][as=font]").count(), "the fonts preloaded on the tab's later page").toBe(0)
    await tabs[0].waitForTimeout(PRELOAD_REPORT_MS)
    expect(unused).toEqual([])
  } finally {
    await fresh.close()
  }
})

test("a name code is drawn on one line inside its box on a phone, shown or hidden, down to 360 px", async ({ page }) => {
  await search(page, uniqueLabel("wrap"))
  await toCodeStep(page)
  const code = onStep(page).getByTestId("owner-code")
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 800 })
    for (const shown of [false, true]) {
      if (shown) await onStep(page).getByRole("button", { name: "Show" }).click()
      expect((await lineStarts(code)).length, `${shown ? "shown" : "hidden"} at ${width} px: its lines`).toBe(1)
      const [text, box] = [(await code.boundingBox())!, (await onStep(page).locator(".code-display").boundingBox())!]
      expect(text.x >= box.x && text.x + text.width <= box.x + box.width, `${shown ? "shown" : "hidden"} at ${width} px: inside its box`).toBe(true)
      if (shown) await onStep(page).getByRole("button", { name: "Hide" }).click()
    }
  }
})

// a laptop's, a phone's and a small phone's window
const NOTE_SIZES = [{ width: 1280, height: 900 }, { width: 390, height: 844 }, { width: 360, height: 740 }]
test("on a phone, Forget's two answers are an equal pair, both in view", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await search(page, uniqueLabel("pair"))
  await toCodeStep(page)
  // a code under the name makes the list reach past the window, as a browser that has bought some has
  await page.evaluate(() => localStorage.setItem("simplex-names:code:SN6-PAIR", JSON.stringify({ code: "SN6-Z6VPA-7YPF0-XN8B4-9S1ZD", minLength: 6, years: 2, addedAt: new Date().toISOString() })))
  await page.goto("/#/names")
  await page.getByText("Forget everything in this browser").click()
  const boxes = await Promise.all(["Forget everything", "Keep them"].map(async (name) => (await page.getByRole("button", { name }).boundingBox())!))
  expect(boxes[0].width, "the two answers' widths").toBeCloseTo(boxes[1].width, 0)
  const height = await page.evaluate(() => innerHeight)
  for (const box of boxes) expect(box.y >= 0 && box.y + box.height <= height, `an answer at ${box.y}-${box.y + box.height} in a window ${height} high`).toBe(true)
  await shot(page, "N12f-forget-ask")
})

test("offline, the footer scrolls clear of the note, and its last link takes a click there", async ({ page, context }) => {
  await page.goto("/")
  await page.getByRole("heading", { name: "Your SimpleX domain" }).waitFor()
  await context.setOffline(true)
  try {
    await expect(page.locator(".offline-note")).toBeVisible()
    const lastLink = page.locator("body > footer").getByRole("link", { name: "Trademark owners" })
    for (const size of NOTE_SIZES) {
      await page.setViewportSize(size)
      // how far each of the footer's items reaches into the note, scrolled to the end once the window has its new
      // size (Firefox takes it after Playwright's call returns), the note has its own and the frame has caught up
      const overlaps = () => page.evaluate(({ width, height: windowHeight }) => {
        const bottom = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().bottom + scrollY
        // the window holds the page down to its invest note once its size has reached the page's layout
        const settled = innerWidth === width && innerHeight === windowHeight && Math.abs(bottom("body > .invest") - windowHeight) < 1
        scrollTo(0, document.documentElement.scrollHeight)
        const note = document.querySelector(".offline-note")!.getBoundingClientRect()
        return { settled, overlaps: [...document.querySelectorAll("body > footer > *")].map((n) => n.getBoundingClientRect())
          .map((b) => Math.max(0, Math.ceil(Math.min(b.bottom, note.bottom) - Math.max(b.top, note.top)))) }
      }, size)
      await expect.poll(overlaps, { message: `the footer's items under the note at ${size.width}x${size.height}` }).toEqual({ settled: true, overlaps: [0, 0] })
      // WebKit hit-tests a mouse event against the last frame it drew, so the scroll is drawn first
      await page.evaluate(() => new Promise((drawn) => requestAnimationFrame(() => requestAnimationFrame(drawn))))
      const box = (await lastLink.boundingBox())!
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      await expect(page.getByRole("heading", { name: "Trademark owners" })).toBeVisible()
      await page.goBack()
      await expect(page.getByRole("heading", { name: "Your SimpleX domain" })).toBeVisible()
    }
  } finally {
    await context.setOffline(false)
  }
})

const LOOKUP_RTT_MS = 500

test("Add to Your names keeps its place while it reads the code's orders, saying so on the button", async ({ page }) => {
  const { ownerCode } = await startOrder(page, uniqueLabel("restbusy"), { method: "btc" })
  await page.goto("/#/code")
  await codeField(page).fill(ownerCode)
  const add = page.getByRole("button", { name: "Add to Your names" })
  const top = (await add.boundingBox())!.y
  // the order's read takes a moment, as one over a network does, so frames are drawn while it is busy
  await page.route("**/api/invoice/*", async (route) => {
    await new Promise((answered) => setTimeout(answered, LOOKUP_RTT_MS))
    await route.continue()
  })
  // the button's top and words in each frame it says it is busy
  await recordFrames(page, () => {
    const button = document.querySelector<HTMLElement>("main .actions-row .btn")
    return button?.getAttribute("aria-busy") === "true" ? [Math.round(button.getBoundingClientRect().top), button.textContent] : null
  })
  await add.click()
  await expect(onStep(page).getByRole("heading", { name: "Your names" })).toBeVisible()
  const busy = await recordedFrames<[number, string]>(page)
  expect(busy.length, "frames drawn while it looked").toBeGreaterThan(0)
  expect([...new Set(busy.map(([at]) => at))], "the button's top while it looked").toEqual([Math.round(top)])
  expect([...new Set(busy.map(([, words]) => words))]).toEqual(["Finding the code's orders…"])
})

test("on a phone, Forget's question glides into view rather than jumping there", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/#/trademarks")
  // codes enough that the question opens below the window's foot
  await page.evaluate(() => {
    for (const n of [1, 2, 3]) localStorage.setItem(`simplex-names:code:SN6-GLIDE${n}`, JSON.stringify({ code: `SN6-Z6VPA-7YPF0-XN8B4-9S1Z${n}`, minLength: 6, years: 2, addedAt: new Date().toISOString() }))
  })
  await page.goto("/#/names")
  // the list is drawn again as each code is read, which replaces the link
  await expect(page.locator(".list-row .chip", { hasText: "Checking" })).toHaveCount(0)
  const ask = page.getByText("Forget everything in this browser")
  await ask.scrollIntoViewIfNeeded()
  // sampled from before the click, so a jump at the click shows between two samples
  await recordFrames(page, () => scrollY)
  // a pointer's own click, as Playwright's scrolls the link into view first
  const box = (await ask.boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await expect(page.getByRole("button", { name: "Keep them" })).toBeInViewport({ ratio: 1 })
  // until the page has stood still for a few frames
  const still = async () => {
    const at = await recordedFrames<number>(page)
    return at.length > 5 && new Set(at.slice(-5)).size === 1
  }
  await expect.poll(still).toBe(true)
  const scrolled = await recordedFrames<number>(page)
  const moves = scrolled.slice(1).map((y, i) => y - scrolled[i]).filter((d) => d !== 0)
  expect(moves.length, `the frames the page scrolled in: ${scrolled.join(",")}`).toBeGreaterThan(2)
})

const THEMES = ["light", "dark"] as const
// styles.css's --page-color in each theme
const GROUND = { light: "rgb(243, 250, 255)", dark: "rgb(0, 8, 50)" }
const LOGO_WIDTH = 168
// index.html's images a laptop's window shows in each theme, by class, at their styles.css widths
const STATIC_IMAGES: Record<string, Record<string, number>> = {
  light: { "logo-light": LOGO_WIDTH, moon: 22, wefunder: 81 },
  dark: { "logo-dark": LOGO_WIDTH, sun: 22, wefunder: 81 },
}
// long enough that a page drawn before its stylesheet shows in several frames
const STYLESHEET_DELAY_MS = 500
const isStylesheet = (url: URL) => url.pathname.endsWith(".css")

interface Painted { ground: string; images: [string, number][] }
// the page's ground, and the images of index.html's header, invest note and footer with their widths, as the frame paints them
const painted = (): Painted => ({
  ground: getComputedStyle(document.documentElement).backgroundColor,
  images: [...document.querySelectorAll("body > :is(header, .invest, footer) :is(img, svg)")].flatMap((n): [string, number][] => {
    const width = Math.round(n.getBoundingClientRect().width)
    return width ? [[n.getAttribute("class") ?? n.tagName, width]] : []
  }),
})
// each run of like frames on one line, from its first frame's index
const frameLog = (frames: Painted[]) => frames.map((f, i) => `${i}: ${f.ground} ${JSON.stringify(f.images)}`)
  .filter((line, i, lines) => i === 0 || line.slice(line.indexOf(" ")) !== lines[i - 1].slice(lines[i - 1].indexOf(" "))).join("\n")

test("the page's first frame is styled, on its ground with index.html's images at their sizes, on load and on reload in both themes", async ({ page }) => {
  await page.route(isStylesheet, async (route) => {
    await new Promise((arrived) => setTimeout(arrived, STYLESHEET_DELAY_MS))
    await route.continue()
  })
  await recordFrames(page, painted, true)
  for (const theme of THEMES) {
    await page.emulateMedia({ colorScheme: theme })
    for (const load of ["load", "reload"]) {
      await (load === "load" ? page.goto("/") : page.reload())
      await expect(page.locator("body > main h1")).toBeVisible()
      const frames = await recordedFrames<Painted>(page)
      const what = `${theme}, ${load}, every frame:\n${frameLog(frames)}`
      expect(frames.some((f) => f.images.length), what).toBe(true)
      for (const frame of frames) {
        expect(frame.ground, what).toBe(GROUND[theme])
        for (const [image, width] of frame.images) expect(width, `${image}'s width; ${what}`).toBe(STATIC_IMAGES[theme][image])
      }
    }
  }
})

test("a page whose stylesheet fails draws index.html's images at their own small sizes, on its theme's ground", async ({ page }) => {
  await page.route(isStylesheet, (route) => route.abort())
  await recordFrames(page, painted, true)
  for (const theme of THEMES) {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto("/")
    await page.evaluate(() => new Promise((drawn) => requestAnimationFrame(() => requestAnimationFrame(drawn))))
    const frames = await recordedFrames<Painted>(page)
    const what = `${theme}, every frame:\n${frameLog(frames)}`
    expect(frames.some((f) => f.images.length), what).toBe(true)
    for (const frame of frames) {
      expect(frame.ground, what).toBe(GROUND[theme])
      for (const [image, width] of frame.images) expect(width, `${image}'s width; ${what}`).toBeLessThanOrEqual(LOGO_WIDTH)
    }
  }
})
