import { expect, type Page } from "@playwright/test"
import {
  agreeToTerms, CODE_HEADING, contactLink, control, LINKS_HEADING, onStep, payButton, recordedFrames, recordFrames, REGISTRATION_MS, SAVED, search, startOrder,
  takenHeading, test, toFullReview, toReview, uniqueLabel,
} from "./helpers.ts"

// the swaps run at full length, as for a reader who has not asked for less movement
test.use({ reducedMotion: "no-preference" })

// The main column is sampled on a grid each frame. A frame whose drawn points fall below this share of the fewer of its
// two ends is near empty.
const COLUMNS = 12
const ROWS = 24
const NEAR_EMPTY_SHARE = 0.4
// boxes that only lay the screens out; a point where one of them is the topmost box shows nothing of a screen
const LAYOUT_BOXES = "main, .screen, .home"

interface Recorder { stopRecording: () => number[] }

// Resolves once the first frame is sampled, so the change recorded starts after it.
async function startRecording(page: Page): Promise<void> {
  await page.evaluate(([columns, rows, layout]) => new Promise<void>((started) => {
    // each recording keeps its own frames and flag, so a frame still due from the last one never adds to this one
    const frames: number[] = []
    let recording = true
    const w = window as unknown as Recorder
    w.stopRecording = () => {
      recording = false
      return frames
    }
    const main = document.querySelector<HTMLElement>("body > main")!
    // a point counts by the topmost box hit there, not by its pixels: a box drawn with nothing visible counts as drawn
    const drawn = (x: number, y: number) => {
      const hit = document.elementFromPoint(x, y)
      return hit !== null && main.contains(hit) && !hit.matches(layout)
    }
    const look = () => {
      if (!recording) return
      // hit testing skips inert content, which is still drawn, so main's inert is lifted for the reads and put back before anything else runs
      const inert = main.inert
      main.inert = false
      const box = main.getBoundingClientRect()
      const top = Math.max(box.top, 0)
      const bottom = Math.min(box.bottom, innerHeight)
      let hits = 0
      for (let i = 0; i < columns; i++) {
        for (let j = 0; j < rows; j++) if (drawn(box.left + (i + 0.5) * box.width / columns, top + (j + 0.5) * (bottom - top) / rows)) hits++
      }
      main.inert = inert
      frames.push(hits)
      if (frames.length === 1) started()
      requestAnimationFrame(look)
    }
    requestAnimationFrame(look)
  }), [COLUMNS, ROWS, LAYOUT_BOXES] as const)
}

// A swap is a CSS animation, which the document lists among its animations until it ends; a check that the new screen
// is visible has already made the browser start it. An animation that repeats for ever, as the waiting payment's dot, never ends.
async function stopRecording(page: Page): Promise<number[]> {
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))))
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
  return page.evaluate(() => (window as unknown as Recorder).stopRecording())
}

async function expectNoEmptyFrame(page: Page, change: string, act: () => Promise<void>): Promise<void> {
  await startRecording(page)
  await act()
  const frames = await stopRecording(page)
  expect(frames.length, `${change}: frames recorded`).toBeGreaterThan(1)
  const floor = Math.min(frames[0], frames[frames.length - 1]) * NEAR_EMPTY_SHARE
  expect(Math.min(...frames), `${change}: drawn points per frame ${frames.join(",")}`).toBeGreaterThanOrEqual(floor)
}

const heading = (page: Page, name: string | RegExp) => expect(onStep(page).getByRole("heading", { name })).toBeVisible()
const headingTop = (page: Page) => page.evaluate(() => Math.round(document.querySelector("body > main h1")!.getBoundingClientRect().top))

test("the purchase steps and other screens swap without a near-empty frame", async ({ page, request }) => {
  await search(page, uniqueLabel("frames"))
  const register = page.getByRole("button", { name: "Register" })
  await expect(register).toBeEnabled()

  await expectNoEmptyFrame(page, "search to links", async () => {
    await register.click()
    await heading(page, LINKS_HEADING)
  })
  await expectNoEmptyFrame(page, "links to name code", async () => {
    await onStep(page).getByRole("button", { name: "Skip for now" }).click()
    await heading(page, CODE_HEADING)
  })
  await onStep(page).getByText(SAVED).click()
  await expectNoEmptyFrame(page, "name code to review", async () => {
    await onStep(page).getByRole("button", { name: "Continue" }).click()
    await heading(page, "Check your order")
  })
  await expectNoEmptyFrame(page, "review back to name code", async () => {
    await page.goBack()
    await heading(page, CODE_HEADING)
  })
  await expectNoEmptyFrame(page, "name code forward to review", async () => {
    await page.goForward()
    await heading(page, "Check your order")
  })
  await agreeToTerms(page)
  await expectNoEmptyFrame(page, "review to payment", async () => {
    await payButton(page).click()
    await heading(page, "Pay with Bitcoin")
  })

  const invoiceId = new URL(page.url()).searchParams.get("order")!
  await expectNoEmptyFrame(page, "payment to confirming", async () => {
    await control(request, `confirming/${invoiceId}`)
    await expect(page.getByRole("heading", { name: "Confirming your payment" })).toBeVisible()
  })
  await expectNoEmptyFrame(page, "order to Your names", async () => {
    await page.locator("body > header").getByRole("link", { name: "Your names" }).click()
    await expect(page.getByRole("heading", { name: "Your names" })).toBeVisible()
  })
  await expectNoEmptyFrame(page, "Your names back to the order", async () => {
    await page.goBack()
    await expect(page.getByRole("heading", { name: "Confirming your payment" })).toBeVisible()
  })
})

test("a name taken first, its balance's search and Your names swap without a near-empty frame", async ({ page, request }) => {
  const label = uniqueLabel("frbal")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  await control(request, "take", { label })
  await expectNoEmptyFrame(page, "payment to taken", async () => {
    await control(request, `settle/${invoiceId}`)
    await expect(page.getByRole("heading", { name: takenHeading(label) })).toBeVisible({ timeout: REGISTRATION_MS })
  })
  await expectNoEmptyFrame(page, "taken to the search with the balance", async () => {
    await onStep(page).getByRole("button", { name: "Choose another name" }).click()
    await heading(page, "Your SimpleX domain")
  })
  await expectNoEmptyFrame(page, "search to Your names with the balance", async () => {
    await page.locator("body > header").getByRole("link", { name: "Your names" }).click()
    await expect(onStep(page).locator(".list-row[data-key^='balance-']")).toBeVisible()
  })
})

test("terms changed while ordering show their notice without a near-empty frame", async ({ page, request }) => {
  await search(page, uniqueLabel("frterms"))
  await toReview(page)
  await control(request, "general-terms", { text: "# SimpleX general terms\n\nChanged while ordering.\n" })
  try {
    await expectNoEmptyFrame(page, "review to its terms notice", async () => {
      await payButton(page).click()
      await expect(onStep(page).getByText("The terms changed. Agree to them again.")).toBeVisible()
    })
  } finally {
    await control(request, "general-terms", { text: null })
  }
})

// a profile's name of letters past Latin-1, which the page has drawn in no font face yet
const NON_LATIN_NAME = "Łukasz Żak"

test("a font face that a step's change loads leaves the step where it holds, after a refused link", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.route("**/api/link/preview", (route) => route.fulfill({ json: { type: "address", kind: "contact", displayName: NON_LATIN_NAME, fullName: "", image: null, subscribers: null, profile: "ok" } }))
  await search(page, uniqueLabel("face"))
  await onStep(page).getByRole("button", { name: "Register" }).click()
  await heading(page, LINKS_HEADING)
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))))
  const loadedFaces = () => page.evaluate(() => [...document.fonts].filter((f) => f.status === "loaded").length)
  const [before, faces] = [await headingTop(page), await loadedFaces()]
  await onStep(page).getByRole("textbox", { name: "Link", exact: true }).fill("https://smp8.simplex.im/x#fc")
  await expect(onStep(page).locator(".field-error")).toBeVisible()
  await onStep(page).getByRole("textbox", { name: "Link", exact: true }).fill(contactLink("fc"))
  await onStep(page).getByRole("textbox", { name: "Link", exact: true }).blur()
  await expect(onStep(page).locator(".entity", { hasText: NON_LATIN_NAME })).toBeVisible()
  await page.evaluate(() => document.fonts.ready.then(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))))
  expect(await loadedFaces(), "faces loaded for the profile's name").toBeGreaterThan(faces)
  expect(await headingTop(page), "the heading's top once the face is in").toBe(before)
})

test.describe("a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test("going offline on the fullest review lays out no frame taller than the window, and leaves nothing to scroll", async ({ page, context }) => {
    await toFullReview(page, uniqueLabel("offframe"))
    const before = await headingTop(page)
    // how far each frame's layout reaches past the window, less the footer below the fold, from just before the network goes
    await recordFrames(page, () => document.scrollingElement!.scrollHeight - innerHeight - Math.round(document.querySelector("body > footer")!.getBoundingClientRect().height))
    await context.setOffline(true)
    try {
      await expect(page.locator(".offline-note")).toBeVisible()
      await page.evaluate(() => new Promise((done) => { let n = 0; const next = () => (++n > 10 ? done(null) : requestAnimationFrame(next)); requestAnimationFrame(next) }))
      const over = await recordedFrames<number>(page)
      expect(Math.max(...over), `each frame's overflow: ${over.join(",")}`).toBe(0)
      expect(await headingTop(page), "the heading's top offline").toBe(before)
    } finally {
      await context.setOffline(false)
    }
  })
})
