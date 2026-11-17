import { type APIRequestContext, expect, type Locator, type Page } from "@playwright/test"
import { MAX_LABEL_LENGTH } from "../src/names.ts"
import { TX_STALL_MS } from "../src/screens/order.ts"
import {
  agreeToTerms, AVAILABLE_BRIEF, brokenNames, CHAIN, channelLink, CHECKOUT_KEY, CODE_HEADING, codeField, contactLink, control, fakeRegisteredName, fillLinks, FIT_SIZES, keepOrder, type KeptOrder, LINKS_HEADING, onStep, payButton, previewsShown, SAVED,
  lineStarts, offCentre, recordedFrames, recordFrames, REGISTRATION_MS, registrationOf, registrationView, rowFit, savedToReview, search, sevenLetters, shot, startOrder, takenOrder, TERMS, test, toCodeStep,
  TAKEN_BRIEF, toFullReview, toReview, uniqueLabel, useCode, waitRegistered, withStripeKey,
} from "./helpers.ts"

test("the purchase steps swap the whole page, one screen at a time rising in, and Back walks them in reverse", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await search(page, uniqueLabel("swap"))
  const steps: [string, () => Promise<unknown>][] = [
    [LINKS_HEADING, () => page.getByRole("button", { name: "Register" }).click()],
    [CODE_HEADING, () => onStep(page).getByRole("button", { name: "Skip for now" }).click()],
    // the box ticked with a click on its words, which leaves focus where the new step puts it
    ["Check your order", async () => {
      await onStep(page).getByText(SAVED).click()
      await onStep(page).getByRole("button", { name: "Continue" }).click()
    }],
  ]
  for (const [heading, move] of steps) {
    await move()
    await expect(page.getByRole("heading", { name: heading }), `${heading}: its heading takes focus`).toBeFocused()
    await expect(page.locator("body > main > *"), `${heading}: the screens in main`).toHaveCount(1)
    await expect(onStep(page), `${heading}: rises in`).toHaveClass(/\benter\b/)
  }
  for (const heading of [CODE_HEADING, LINKS_HEADING]) {
    await page.goBack()
    await expect(page.getByRole("heading", { name: heading })).toBeVisible()
    await expect(page.locator("body > main > *"), `${heading} again: the screens in main`).toHaveCount(1)
  }
  await page.goBack()
  await expect(page.getByLabel("Name", { exact: true })).toBeVisible()
})

// Where the heading of the screen in view starts, once it has risen in.
async function headingAt(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(async () => {
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
    await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)))
    const box = document.querySelector("body > main h1")!.getBoundingClientRect()
    return { x: Math.round(box.left), y: Math.round(box.top) }
  })
}

// how far the page reaches past the window, less the footer the badges store keeps below the fold
const overflow = (page: Page) => page.evaluate(() => document.scrollingElement!.scrollHeight - innerHeight - Math.round(document.querySelector("body > footer")!.getBoundingClientRect().height))

interface Frame { heading: number; actions: number | null; button: number | null; link: number | null; back: number | null; investGap: number | null }
type Place = Exclude<keyof Frame, "investGap">
// where the mockup draws a step's heading, its actions' row, its main button, the link under it and Back's word, at each
// window size; a step without a main button keeps its link at the link's place
const MOCKUP_FRAMES: Record<Place, number>[] = [{ heading: 125, actions: 587, button: 587, link: 641, back: 137 }, { heading: 106, actions: 636, button: 636, link: 690, back: 74 }]
// the least room on a laptop between a step's last link and the invest note under it
const INVEST_GAP = 48

// the height of a payment method's tile at each size, as the mockup draws it, whatever else the review holds
const METHOD_TILES = [66, 72]

// The screen in view fits the window at each size, its content above its actions' row, its methods' tiles at their
// height and no name broken that fits its line whole; a step's heading and actions' row stand where every step's do,
// which the caller compares. Captured for review when shots are asked for.
async function fitsWindow(page: Page, name: string, frames?: Record<string, Frame[]>): Promise<void> {
  for (const [i, size] of FIT_SIZES.entries()) {
    await page.setViewportSize(size)
    const measured = async () => ({ broken: await brokenNames(page), ...await page.evaluate((tile) => {
      const shown = document.querySelector("body > main > section")!
      // a step with no action gives its content the action row's room, down to the step's foot; one with only a link,
      // the empty place of a main button above it
      const row = shown.querySelector(":scope > .actions-row")
      const only = row && !row.querySelector(":scope > .btn") ? row.querySelector(":scope > .alt") : null
      const actions = (only ?? row)?.getBoundingClientRect() ?? (shown.classList.contains("step") ? { top: shown.getBoundingClientRect().bottom } : undefined)
      const content = [...shown.querySelectorAll(":scope > .screen-body > *")].map((k) => k.getBoundingClientRect()).filter((b) => b.height > 0)
      const footer = Math.round(document.querySelector("body > footer")!.getBoundingClientRect().height)
      // what is kept whole, as a name's end with its TLD, a price with its term and a name code, drawn on more than one line
      const split = [...shown.querySelectorAll(".nowrap, .deal, .code-text")].filter((n) => new Set([...n.getClientRects()].map((r) => Math.round(r.top))).size > 1)
      return {
        overflow: Math.max(0, document.scrollingElement!.scrollHeight - innerHeight - footer),
        overlap: actions && content.length ? Math.max(0, Math.round(Math.max(...content.map((b) => b.bottom)) - actions.top)) : 0,
        split: split.map((n) => n.textContent),
        tiles: [...shown.querySelectorAll(".method")].map((m) => Math.round(m.getBoundingClientRect().height)).filter((h) => h !== tile),
      }
    }, METHOD_TILES[i]) })
    await expect.poll(measured, { message: `${name} at ${size.width}x${size.height}` }).toEqual({ broken: [], overflow: 0, overlap: 0, split: [], tiles: [] })
    if (frames) {
      const at = await page.evaluate(() => {
        const top = (selector: string) => {
          const node = document.querySelector(selector)
          return node ? Math.round(node.getBoundingClientRect().top) : null
        }
        const links = [...document.querySelectorAll("body > main a")].map((a) => a.getBoundingClientRect()).filter((b) => b.height > 0)
        const invest = top("body > .invest p")
        return {
          heading: top("body > main h1")!,
          actions: top("body > main > section > .actions-row"),
          button: top("body > main > section > .actions-row > .btn"),
          link: top("body > main > section > .actions-row > .alt"),
          back: top("body > main .back span"),
          investGap: links.length && invest !== null ? Math.round(invest - Math.max(...links.map((b) => b.bottom))) : null,
        }
      })
      ;(frames[name] ??= [])[i] = at
    }
  }
  await page.setViewportSize(FIT_SIZES[0])
  await shot(page, `names-u1-${name}`)
}

// The card page's actions follow Stripe's form, which may be taller than the room it holds, so only its heading and
// Back stand where every step's do; cardFits checks its actions.
function headOnly(frames: Record<string, Frame[]>, name: string): void {
  for (const frame of frames[name]) Object.assign(frame, { actions: null, button: null, link: null })
}

// every step's heading, actions' row, main button, link and Back, where it has them, at the mockup's place for each
// window size; on a laptop its last link keeps its room above the invest note
function oneFrame(frames: Record<string, Frame[]>): void {
  for (const [i, size] of FIT_SIZES.entries()) {
    const at = Object.fromEntries(Object.entries(frames).map(([name, f]) => [name, f[i]]))
    const mockup = MOCKUP_FRAMES[i]
    const places = Object.keys(mockup) as Place[]
    const off = Object.entries(at).filter(([, f]) => places.some((place) => f[place] !== null && f[place] !== mockup[place]))
    expect(off, `the steps' heading, actions, button, link and Back at ${size.width}x${size.height}, the mockup's ${JSON.stringify(mockup)}`).toEqual([])
  }
  const cramped = Object.entries(frames).filter(([, f]) => f[0].investGap !== null && f[0].investGap < INVEST_GAP)
  expect(cramped, `the steps' last link at least ${INVEST_GAP} px above the invest note at ${FIT_SIZES[0].width}x${FIT_SIZES[0].height}`).toEqual([])
}

test("every purchase step fits a laptop's and a phone's window, its heading and main button at one place on every step", async ({ page, request }) => {
  await page.goto("/")
  await fitsWindow(page, "1-home")
  // a taken name with both its links
  await search(page, "bakery")
  await expect(page.locator(".answer .chat")).toHaveCount(2)
  await fitsWindow(page, "1b-home-taken")
  const label = uniqueLabel("fit")
  await search(page, label)
  await page.getByRole("button", { name: "Register" }).click()
  const step = onStep(page)
  const frames: Record<string, Frame[]> = {}
  await expect(step.getByRole("heading", { name: LINKS_HEADING })).toBeFocused()
  await fitsWindow(page, "2a-links-empty", frames)
  const linksAt = await headingAt(page)
  await fillLinks(page, contactLink("F2"), channelLink("G2"))
  await previewsShown(page)
  expect(await headingAt(page), "the links step as its previews come").toEqual(linksAt)
  await fitsWindow(page, "2-links", frames)
  await backInView(page, "links")
  await step.getByRole("button", { name: "Continue" }).click()
  await expect(step.getByRole("heading", { name: CODE_HEADING })).toBeVisible()
  await fitsWindow(page, "3-code", frames)
  await savedToReview(page)
  await fitsWindow(page, "4-review", frames)
  await backInView(page, "review")
  await payButton(page).click()
  await page.waitForURL(/\?order=/)
  await expect(page.getByRole("heading", { name: "Pay with Bitcoin" })).toBeVisible()
  await fitsWindow(page, "5-pay-bitcoin", frames)
  const invoiceId = new URL(page.url()).searchParams.get("order")
  await control(request, `confirming/${invoiceId}`)
  await expect(page.getByRole("heading", { name: "Confirming your payment" })).toBeVisible()
  await fitsWindow(page, "5c-confirming", frames)
  await control(request, `settle/${invoiceId}`)
  await expect(page.locator(".stage.active", { hasText: "Waiting" })).toBeVisible({ timeout: REGISTRATION_MS })
  await fitsWindow(page, "6-registering", frames)
  await waitRegistered(page, label)
  await fitsWindow(page, "7-registered", frames)
  await page.goto("/#/code")
  await fitsWindow(page, "8-check-code", frames)
  await startOrder(page, uniqueLabel("fitcard"), { method: "card" })
  await expect(page.getByRole("heading", { name: "Pay by card" })).toBeVisible()
  await expect(page.locator(".name-check:not(.unchecked)")).toBeVisible()
  await fitsWindow(page, "5b-pay-card", frames)
  headOnly(frames, "5b-pay-card")
  oneFrame(frames)
})

test("the balance's steps fit both windows, their heading, main button and link where every step's are", async ({ page, request }) => {
  const frames: Record<string, Frame[]> = {}
  await takenOrder(page, request, uniqueLabel("fitbal"))
  await fitsWindow(page, "b1-taken", frames)
  await page.getByRole("button", { name: "Choose another name" }).click()
  await search(page, uniqueLabel("fitbal2"))
  await toReview(page)
  const register = onStep(page).getByRole("button", { name: "Register with your balance" })
  await expect(register).toBeVisible()
  await fitsWindow(page, "b2-review-balance", frames)
  // another tab's invoice for a dearer name holds the balance, which the review says until that invoice is cancelled
  const other = await page.context().newPage()
  await other.goto("/#/names")
  await other.locator(".list-row[data-key^='balance-']").getByRole("button", { name: "Use" }).click()
  await search(other, sevenLetters())
  await toReview(other)
  await payButton(other).click()
  await other.waitForURL(/\?order=/)
  await register.click()
  await expect(onStep(page).locator(".line", { hasText: "Your balance is in use by" })).toBeVisible()
  await fitsWindow(page, "b2b-review-balance-held", frames)
  await onStep(other).getByRole("button", { name: "Cancel this invoice" }).click()
  await expect(register).toBeEnabled()
  await other.close()
  await search(page, sevenLetters())
  await toReview(page)
  await expect(payButton(page)).toHaveText("Pay $100 with Bitcoin")
  await fitsWindow(page, "b3-review-balance-more", frames)
  await payButton(page).click()
  await page.waitForURL(/\?order=/)
  await expect(page.getByRole("heading", { name: "Pay with Bitcoin" })).toBeVisible()
  await expect(page.locator(".name-check:not(.unchecked)")).toBeVisible()
  await fitsWindow(page, "b4-pay-difference", frames)
  // the same difference by card, whose lead takes a second line on a phone
  await onStep(page).getByRole("button", { name: "Cancel this invoice" }).click()
  await onStep(page).getByRole("button", { name: "Order the name again" }).click()
  await expect(onStep(page).getByRole("heading", { name: "Check your order" })).toBeVisible()
  await page.getByRole("radio", { name: "Card" }).click()
  await agreeToTerms(page)
  await payButton(page).click()
  await expect(onStep(page).getByRole("heading", { name: "Pay by card" })).toBeVisible()
  await expect(onStep(page).locator(".screen-head .lead")).toContainText("$100 from your balance")
  await expect(page.locator(".name-check:not(.unchecked)")).toBeVisible()
  await fitsWindow(page, "b5-pay-difference-card", frames)
  headOnly(frames, "b5-pay-difference-card")
  oneFrame(frames)
})

// Stripe's card form as Stripe.js dahlia draws it, its least and greatest height: 221-230 px on the 600 px column and
// 306-320 px on a phone's. A column from 489 px, a 521 px window's, is taken to draw as the 600 px one.
const STRIPE_FORM_PX = { wide: [221, 230], narrow: [306, 320] } as const
const STRIPE_WIDE_COLUMN = 489
// forms taller than the room held for Stripe's, as with a country's postcode field or a longer locale
const TALL_FORM_PX = [450, 600]
// the forms each window loads: Stripe's least and greatest, then the tall ones
type FormPx = { wide: number; narrow: number }
const FORMS_PX: FormPx[] = [...[0, 1].map((at) => ({ wide: STRIPE_FORM_PX.wide[at], narrow: STRIPE_FORM_PX.narrow[at] })), ...TALL_FORM_PX.map((px) => ({ wide: px, narrow: px }))]
// an error line Stripe draws under a field once the form has loaded
const ERROR_LINE_PX = 24
// the least room between the form's foot and Pay
const FORM_TO_PAY = 16
// Stripe's answer to a card it declines, which the page says as Stripe words it
const DECLINED = "Your card was declined."
// A Stripe.js whose card form comes when the test calls __loadCard, `px` tall for the column, and grows by __growCard;
// it declines every card when asked to. It counts its mounts in __mounts, and keeps in __logos Stripe's logo tone of
// each appearance the form is given once made.
const stripeOnCue = (px: FormPx, declines = false) => `window.Stripe = () => ({
  confirmPayment: async () => (${declines} ? { error: { type: "card_error", message: "${DECLINED}" } } : { paymentIntent: { status: "processing" } }),
  elements: () => ({ update: ({ appearance }) => { (window.__logos ??= []).push(appearance.variables.logoColor) }, create: () => {
    const handlers = {}
    return { on: (event, handler) => { handlers[event] = handler }, destroy: () => undefined, mount: (target) => {
      window.__mounts = (window.__mounts ?? 0) + 1
      window.__loadCard = () => {
        const form = document.createElement("div")
        form.style.height = (target.clientWidth >= ${STRIPE_WIDE_COLUMN} ? ${px.wide} : ${px.narrow}) + "px"
        target.append(form)
        window.__growCard = (by) => { form.style.height = (parseFloat(form.style.height) + by) + "px" }
        handlers.ready?.()
      }
    } }
  } }),
})`
const loadCard = (page: Page) => page.evaluate(() => (window as unknown as { __loadCard: () => void }).__loadCard())
const cardSeen = (page: Page) => page.evaluate(() => {
  const w = window as unknown as { __logos?: string[]; __mounts?: number }
  return { logos: w.__logos ?? [], mounts: w.__mounts ?? 0 }
})
const growCard = (page: Page, by: number) => page.evaluate((px) => (window as unknown as { __growCard: (by: number) => void }).__growCard(px), by)
// the card page's windows: a laptop's, a narrow desktop window's, and two phones'
const CARD_SIZES = [{ width: 1280, height: 800 }, { width: 600, height: 800 }, { width: 390, height: 844 }, { width: 360, height: 780 }]
// the widest window drawn as a phone (styles.css)
const PHONE_WIDTH = 520
// the least room between Stripe's note under Cancel and the invest note under the step
const ROOM_ABOVE_INVEST = 16
const FORGETFUL = /^This browser cannot remember a card payment\. After paying, keep this page open until it moves on\. Reloading would show the card form again\.$/

// the card page's parts top to bottom, as the eye reads them
const CARD_PARTS = ["heading", "lead", "notice", "form", "button", "cancel", "stripeNote", "invest"] as const

// where the card page draws each of its parts in the document, the lines of its notes, and the room its step's rows keep between them
const cardPage = (page: Page) => page.evaluate(() => {
  const shown = (selector: string) => [...document.querySelectorAll<HTMLElement>(`body > main ${selector}`)].find((n) => n.getClientRects().length > 0) ?? null
  const place = (b: DOMRect | undefined) => b ? { top: Math.round(b.top + scrollY), bottom: Math.round(b.bottom + scrollY) } : null
  const box = (selector: string) => place(shown(selector)?.getBoundingClientRect())
  const body = [...document.querySelectorAll("body > main .screen-body > *")].map((n) => n.getBoundingClientRect()).filter((b) => b.height > 0)
  return {
    heading: box("h1"), lead: box(".screen-head .lead"), notice: box(".name-check"), form: box(".stripe"), button: box(".actions-row > .btn"), link: box(".actions-row > .alt"),
    cancel: box(".actions-row .alt a"), stripeNote: box(".actions-row .stripe-note"), invest: place(document.querySelector("body > .invest p")!.getBoundingClientRect()),
    parts: body.length, content: Math.round(Math.max(...body.map((b) => b.bottom)) + scrollY), rowGap: parseFloat(getComputedStyle(document.querySelector("body > main > section")!).rowGap),
  }
})

// Pay at least FORM_TO_PAY under the form, and every part of the card page under the one before it, none overlapping
function cardFollows(drawn: Awaited<ReturnType<typeof cardPage>>, where: string): void {
  const { form, button } = drawn
  expect(button!.top - form!.bottom, `${where}: the room between the form's foot and Pay`).toBeGreaterThanOrEqual(FORM_TO_PAY)
  const parts = CARD_PARTS.map((name) => [name, drawn[name]] as const)
  const overlaps = parts.slice(1).filter(([, b], i) => b!.top < parts[i][1]!.bottom).map(([name], i) => `${parts[i][0]} over ${name}`)
  expect(overlaps, `${where}: every part under the one before it, ${JSON.stringify(Object.fromEntries(parts))}`).toEqual([])
}

// The card page at each window, its form loaded at Stripe's least and greatest height and taller, then grown by an
// error line, in light and dark: the form holds its room from the start, so a form that fits it moves nothing as it
// loads; Pay, Cancel and Stripe's note follow the form, at least FORM_TO_PAY under it, and nothing overlaps; its one
// notice stays above the form; Stripe's note is under Cancel, centred, clear of the invest note. With `declines`, Pay is
// pressed once the form loads, and Stripe declines the card. A page that `scrolls`, for a name of the most wide letters,
// may reach past a laptop's window, as its actions take their whole height under the form.
async function cardFits(page: Page, notice: RegExp, open: () => Promise<void>, { declines = false, scrolls = false } = {}): Promise<void> {
  for (const size of CARD_SIZES) {
    for (const px of FORMS_PX) {
      const wide = size.width > PHONE_WIDTH
      const formPx = wide ? px.wide : px.narrow
      const room = wide ? STRIPE_FORM_PX.wide[1] : STRIPE_FORM_PX.narrow[1]
      const where = `${size.width}x${size.height}, a form of ${formPx} px`
      await page.setViewportSize(size)
      await page.unroute("https://js.stripe.com/**")
      await page.route("https://js.stripe.com/**", (route) => route.fulfill({ contentType: "text/javascript", body: stripeOnCue(px, declines) }))
      await open()
      await expect(onStep(page).getByRole("heading", { name: "Pay by card" }), where).toBeVisible()
      await expect(onStep(page).locator(".name-check:not(.unchecked)"), `${where}: the notice`).toBeVisible()
      await page.evaluate(() => document.fonts.ready)
      const before = await cardPage(page)
      await loadCard(page)
      await expect(onStep(page).locator(".stripe > div"), where).toHaveCount(1)
      if (declines) await payButton(page).click()
      await expect(onStep(page).locator(".name-check > :not(.sizer)"), `${where}: the notice`).toHaveText(notice)
      const loaded = await cardPage(page)
      for (const dark of [false, true]) {
        await page.evaluate((d) => document.documentElement.classList.toggle("dark", d), dark)
        const drawn = await cardPage(page)
        const at = `${where}${dark ? ", dark" : ""}`
        if (formPx <= room) expect(drawn, `${at}: every part where it was before the form loaded`).toEqual(before)
        expect(drawn, `${at}: every part where it was in light`).toEqual(loaded)
        cardFollows(drawn, at)
      }
      await page.evaluate(() => document.documentElement.classList.remove("dark"))
      const { form, button, link, cancel, stripeNote, invest, parts, content, rowGap } = loaded
      expect(parts, `${where}: the notice and the form, nothing else above Pay`).toBe(2)
      expect(form!.top, `${where}: the notice above the form`).toBeGreaterThanOrEqual(loaded.notice!.bottom)
      expect(form!.bottom - form!.top, `${where}: the form's height, at least the room held for Stripe's`).toBe(Math.max(formPx, room))
      expect(content + rowGap, `${where}: the content above Pay, the step's row gap between`).toBeLessThanOrEqual(button!.top)
      expect(link!.top, `${where}: Cancel under Pay`).toBeGreaterThanOrEqual(button!.bottom)
      expect(stripeNote!.top, `${where}: Stripe's note under Cancel`).toBeGreaterThanOrEqual(cancel!.bottom)
      expect(invest!.top - stripeNote!.bottom, `${where}: the room between Stripe's note and the invest note`).toBeGreaterThanOrEqual(ROOM_ABOVE_INVEST)
      expect(await offCentre(onStep(page).locator(".stripe-note")), `${where}: Stripe's note centred`).toBeLessThanOrEqual(1)
      if (!scrolls && formPx <= room && FIT_SIZES.some((fit) => fit.width === size.width && fit.height === size.height)) expect(await overflow(page), where).toBe(0)
      // an error line under a field: the form grows past its room by the line, and Pay and what follows move down with it
      await growCard(page, ERROR_LINE_PX)
      for (const dark of [false, true]) {
        await page.evaluate((d) => document.documentElement.classList.toggle("dark", d), dark)
        const grown = await cardPage(page)
        const at = `${where}, grown by an error line${dark ? ", dark" : ""}`
        const by = Math.max(formPx + ERROR_LINE_PX, room) - Math.max(formPx, room)
        expect(grown.form!.bottom - grown.form!.top, `${at}: the form's height`).toBe(Math.max(formPx + ERROR_LINE_PX, room))
        expect([grown.button!.top, grown.stripeNote!.bottom], `${at}: Pay and Stripe's note moved down with the form`).toEqual([button!.top + by, stripeNote!.bottom + by])
        cardFollows(grown, at)
      }
      await page.evaluate(() => document.documentElement.classList.remove("dark"))
    }
  }
}

const CARD_INVOICE = "inv-cardfit"
const CARD_REGISTRATION = "reg-cardfit"
interface CardOrder { label: string; price: number; fromBalance: number; taken?: boolean; forgetful?: boolean }

// A card order of this browser's, answered by routes, whose page opens at `/?order=`; the name is available or taken,
// and the browser can keep a record or not.
async function routedCardOrder(page: Page, o: CardOrder): Promise<() => Promise<void>> {
  const order = await keepOrder(page, CARD_REGISTRATION, CARD_INVOICE, o.label)
  await page.evaluate((r) => localStorage.setItem(`simplex-names:order:${r.registrationId}`, JSON.stringify({ ...r, method: "card" })), order)
  const registration = registrationView(order, { price: o.price, fromBalance: o.fromBalance })
  const invoice = { invoiceId: CARD_INVOICE, status: "open", amount: o.price - o.fromBalance, currency: "usd", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), kind: "name",
    registration, clientSecret: "pi_cardfit_secret" }
  await page.route(`**/api/invoice/${CARD_INVOICE}*`, (route) => route.fulfill({ json: invoice }))
  await page.route(`**/api/registration/${CARD_REGISTRATION}*`, (route) => route.fulfill({ json: registration }))
  await page.route("**/api/name/**", (route) => route.fulfill({ json: o.taken ? { status: "registered", entities: [], tld: "simplex", community: null } : homeAnswers(order.owner).available }))
  if (o.forgetful) await page.addInitScript(() => {
    const keep = Storage.prototype.setItem
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === "simplex-names-probe") throw new DOMException("full", "QuotaExceededError")
      return keep.call(this, key, value)
    }
  })
  await withStripeKey(page)
  return () => page.goto(`/?order=${CARD_INVOICE}`).then(() => undefined)
}

// a production build's service worker answers the page itself, past the route that gives it a Stripe key
test.describe(() => {
  test.use({ serviceWorkers: "block" })

  test("a card invoice opened in place of a new Bitcoin one says why in the card page's one notice, above the form", async ({ page }) => {
    await search(page, uniqueLabel("cardinst"))
    await toReview(page)
    await page.getByRole("radio", { name: "Card" }).click()
    const checkout = await page.evaluate((key) => sessionStorage.getItem(key)!, CHECKOUT_KEY)
    await payButton(page).click()
    await page.waitForURL(/\?order=/)
    // a copy of the tab, with its checkout and name code, pays with Bitcoin, and the order's card invoice opens instead
    const copy = await page.context().newPage()
    await copy.addInitScript(([key, value]) => { if (!sessionStorage.getItem(key)) sessionStorage.setItem(key, value) }, [CHECKOUT_KEY, checkout])
    await withStripeKey(copy)
    await cardFits(copy, /^This name already has a card invoice from an earlier try, so it opened instead of a new Bitcoin one\.$/, async () => {
      await copy.goto("/#/checkout")
      await copy.getByRole("radio", { name: "Bitcoin" }).click()
      await payButton(copy).click()
      await copy.waitForURL(/\?order=/)
    })
  })
})

// the service worker of a production build answers these pages before Playwright's routes in WebKit
test.describe(() => {
  test.use({ serviceWorkers: "block" })
  const tenLetters = { label: "cardfitabc", price: 10000, fromBalance: 0 }
  const sixWide = { label: "w".repeat(6), price: 10000, fromBalance: 0 }
  const longFromBalance = { label: "w".repeat(MAX_LABEL_LENGTH), price: 20000, fromBalance: 10000 }
  const CARD_CASES: [string, CardOrder, RegExp][] = [
    ["a name of 10 letters", tenLetters, AVAILABLE_BRIEF],
    ["a name of 6 wide letters", sixWide, AVAILABLE_BRIEF],
    [`a name of ${MAX_LABEL_LENGTH} wide letters part paid from its balance`, longFromBalance, AVAILABLE_BRIEF],
    [`a name of ${MAX_LABEL_LENGTH} wide letters part paid from its balance, taken meanwhile`, { ...longFromBalance, taken: true }, TAKEN_BRIEF],
    ["a browser that cannot remember a card payment", { ...tenLetters, forgetful: true }, FORGETFUL],
    ["a browser that cannot remember a card payment, the name taken meanwhile", { ...tenLetters, forgetful: true, taken: true }, TAKEN_BRIEF],
  ]
  for (const [name, order, notice] of CARD_CASES) {
    test(`the card page draws Pay under Stripe's form as it loads and grows, its one notice above it, for ${name}`, async ({ page }) => {
      await cardFits(page, notice, await routedCardOrder(page, order), { scrolls: order.label.length === MAX_LABEL_LENGTH })
    })
  }

  test("a card Stripe declines is said in the card page's one notice, Pay under the form", async ({ page }) => {
    await cardFits(page, new RegExp(`^${DECLINED}$`), await routedCardOrder(page, tenLetters), { declines: true })
    await expect(onStep(page).locator(".name-check")).toHaveClass(/\bdanger\b/)
  })

  test("a card Stripe declines in a browser that cannot remember a card payment takes the warning's place, Pay under the form", async ({ page }) => {
    await cardFits(page, new RegExp(`^${DECLINED}$`), await routedCardOrder(page, { ...tenLetters, forgetful: true }), { declines: true })
  })

  // Stripe's logo tone stands for the appearance: light on the dark theme, dark on the light one
  test("the card form follows the system's theme while none is chosen, and the theme switch, in place", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" })
    const open = await routedCardOrder(page, tenLetters)
    await page.route("https://js.stripe.com/**", (route) => route.fulfill({ contentType: "text/javascript", body: stripeOnCue(FORMS_PX[1]) }))
    await open()
    await expect(onStep(page).getByRole("heading", { name: "Pay by card" })).toBeVisible()
    await loadCard(page)
    await expect(onStep(page).locator(".stripe > div")).toHaveCount(1)
    expect(await cardSeen(page), "made in the light theme").toEqual({ logos: [], mounts: 1 })
    const html = page.locator("html")
    await page.emulateMedia({ colorScheme: "dark" })
    await expect(html, "the page follows the system's theme").toHaveClass(/\bdark\b/)
    await expect.poll(() => cardSeen(page), "the form follows it").toEqual({ logos: ["light"], mounts: 1 })
    await page.emulateMedia({ colorScheme: "light" })
    await expect(html).not.toHaveClass(/\bdark\b/)
    await expect.poll(() => cardSeen(page)).toEqual({ logos: ["light", "dark"], mounts: 1 })
    const toggle = page.getByRole("button", { name: "Switch light or dark theme" })
    await toggle.click()
    await expect(html).toHaveClass(/\bdark\b/)
    await expect.poll(() => cardSeen(page), "the form follows the switch").toEqual({ logos: ["light", "dark", "light"], mounts: 1 })
    // a theme chosen holds against the system's
    await page.emulateMedia({ colorScheme: "light" })
    await page.emulateMedia({ colorScheme: "dark" })
    await page.emulateMedia({ colorScheme: "light" })
    await expect(html, "the chosen theme holds").toHaveClass(/\bdark\b/)
    await toggle.click()
    await expect(html).not.toHaveClass(/\bdark\b/)
    await expect.poll(() => cardSeen(page)).toEqual({ logos: ["light", "dark", "light", "dark"], mounts: 1 })
  })
})

const FIT_INVOICE = "inv-fitall"
// an invoice of a kept order, as the service answers it, for a page to draw
const invoiceOf = (o: KeptOrder, status: string, reg: Record<string, unknown>, change: Record<string, unknown> = {}) => ({
  invoiceId: FIT_INVOICE, status, amount: 10000, currency: "usd", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), kind: "name", registration: registrationView(o, reg),
  cryptoCurrency: "btc", cryptoAmount: "0.00156", address: "bcrt1qjhmc6927ct4w4vnas0g70pg3sdhgfdhcl8pd7s", ...change,
})
// the money that reached an invoice short of its amount
const PART = { cryptoAmountPaid: "0.0005", cryptoAmountDue: "0.00106", paidInFull: false }

// the service worker of a production build answers these pages before Playwright's routes in WebKit
test.describe(() => {
  test.use({ serviceWorkers: "block" })

  test(`every outcome and refusal of an order fits both windows for a name of ${MAX_LABEL_LENGTH} wide letters, its heading and main button where every step's are`, async ({ page, browser, request }) => {
    const label = wideLabel(MAX_LABEL_LENGTH)
    const frames: Record<string, Frame[]> = {}
    const order = await keepOrder(page, "reg-fitall", FIT_INVOICE, label)
    let invoice = invoiceOf(order, "open", {}, PART)
    await page.route(`**/api/invoice/${FIT_INVOICE}*`, (route) => route.fulfill({ json: invoice }))
    await page.route("**/api/registration/reg-fitall*", (route) => route.fulfill({ json: invoice.registration }))
    const shown = async (name: string, next: typeof invoice, heading: string | RegExp) => {
      invoice = next
      await page.goto("/#/trademarks")
      await page.goto(`/?order=${FIT_INVOICE}`)
      await expect(onStep(page).getByRole("heading", { name: heading })).toBeVisible()
      await fitsWindow(page, name, frames)
    }
    await shown("o1-partial-bitcoin", invoice, "Pay with Bitcoin")
    await shown("o2-closed-part-paid", invoiceOf(order, "expired", {}, PART), "Invoice closed")
    // as BTCPay keeps an invoice paid after it closed
    await shown("o2b-paid-late", invoiceOf(order, "expired", { balance: { amount: 10000, held: false, heldUntil: null, refunded: 0 } },
      { cryptoAmountPaid: "0.00156", cryptoAmountDue: "0", paidInFull: true }), "Invoice closed")
    await expect(onStep(page).getByRole("button", { name: "Get a refund" })).toBeVisible()
    await shown("o3-paid-not-registered", invoiceOf(order, "paid", { phase: "failed", commitTx: "0x02", error: "The registration transaction reverted on chain" }), "Paid, not registered")
    await page.route("**/api/registration/reg-fitall/retry", (route) => route.fulfill({ status: 500, json: { error: "internal" } }))
    await onStep(page).getByRole("button", { name: "Try again" }).click()
    await expect(onStep(page).getByText("That did not go through")).toBeVisible()
    await fitsWindow(page, "o3b-not-registered-retry-refused", frames)
    await shown("o4-taken", invoiceOf(order, "paid", { phase: "taken", commitTx: "0x02", balance: { amount: 10000, held: false, heldUntil: null, refunded: 0 } }), /was taken$/)
    await expect(onStep(page).getByRole("button", { name: "Get a refund" })).toBeVisible()
    // a taken order seen in a browser without its code, which says where to add the code
    const elsewhere = await browser.newContext()
    const stranger = await elsewhere.newPage()
    await stranger.route(`**/api/invoice/${FIT_INVOICE}*`, (route) => route.fulfill({ json: invoiceOf(order, "paid", { phase: "taken", commitTx: "0x02" }) }))
    await stranger.goto(`/?order=${FIT_INVOICE}`)
    await expect(onStep(stranger).getByText("The name code is not in this browser")).toBeVisible()
    await fitsWindow(stranger, "o5-taken-without-code", frames)
    await elsewhere.close()

    // Check your order turning down a code and a method, then the price changed and too many attempts
    const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
    await useCode(page, code)
    await search(page, label)
    await toReview(page)
    await page.route("**/api/name/register", (route) => route.fulfill({ status: 400, json: { error: "code_used" } }))
    await onStep(page).getByRole("button", { name: "Register with your code" }).click()
    await expect(onStep(page).getByText("This code was already used.")).toBeVisible()
    await page.getByRole("radio", { name: "Card" }).click()
    await page.route("**/api/invoice", (route) => route.request().method() === "POST" ? route.fulfill({ status: 503, json: { error: "provider_unavailable" } }) : route.continue())
    await payButton(page).click()
    await expect(onStep(page).getByText("Card is temporarily unavailable")).toBeVisible()
    await fitsWindow(page, "o6-review-code-and-method-refused", frames)
    await page.unroute("**/api/invoice")
    await page.route("**/api/invoice", (route) => route.request().method() === "POST" ? route.fulfill({ status: 409, json: { error: "catalog_changed", price: 12345 } }) : route.continue())
    await payButton(page).click()
    await expect(onStep(page).getByRole("heading", { name: "The price changed" })).toBeVisible()
    await fitsWindow(page, "o7-price-changed", frames)
    // the review opened again takes the new price
    await page.reload()
    await page.unroute("**/api/invoice")
    await page.route("**/api/invoice", (route) => route.request().method() === "POST" ? route.fulfill({ status: 429, headers: { "retry-after": "60" }, json: { error: "rate_limited" } }) : route.continue())
    await payButton(page).click()
    await expect(onStep(page).getByRole("heading", { name: "Too many attempts" })).toBeVisible()
    await fitsWindow(page, "o8-too-many", frames)
    oneFrame(frames)
  })
})

test(`Edit links fits both windows with its answer, for a name of ${MAX_LABEL_LENGTH} wide letters`, async ({ page }) => {
  const label = wideLabel(MAX_LABEL_LENGTH)
  const links = { contact: contactLink("E1"), channel: channelLink("E2") }
  // the chain moves on to a newer save as this one is refused
  let saved = 0
  const { registrationId } = await fakeRegisteredName(page, label, links, () => saved ? { links: { ...links, contact: contactLink("E3") }, nonce: 1 } : { links, nonce: 0 })
  await page.route("**/api/name/records", (route) => {
    saved += 1
    return route.fulfill({ status: 400, json: { error: "bad_request" } })
  })
  await page.goto(`/#/edit/${registrationId}`)
  await previewsShown(page)
  const frames: Record<string, Frame[]> = {}
  await fitsWindow(page, "e1-edit-links", frames)
  await onStep(page).getByRole("textbox", { name: "Link", exact: true }).fill(contactLink("E4"))
  await previewsShown(page)
  await onStep(page).getByRole("button", { name: "Save links" }).click()
  await expect(onStep(page).getByText("An earlier save got there first")).toBeVisible()
  await previewsShown(page)
  await fitsWindow(page, "e2-edit-links-moved", frames)
  oneFrame(frames)
})

// widths a laptop's or a tablet's window has, from where the column first leaves margins beside it
const BACK_WIDTHS = [900, 1024, 1280]

// Back stays inside the window, beside the heading or above it
async function backInView(page: Page, name: string): Promise<void> {
  for (const width of BACK_WIDTHS) {
    await page.setViewportSize({ width, height: FIT_SIZES[0].height })
    const back = onStep(page).locator(".back")
    await expect.poll(async () => {
      const box = (await back.boundingBox())!
      return box.x >= 0 && box.x + box.width <= width
    }, { message: `${name}: Back at ${width} px wide` }).toBe(true)
  }
  await page.setViewportSize(FIT_SIZES[0])
}

// the tops of the home's headline and search
const homeTops = (page: Page) => page.evaluate(() => ["h1", ".search-field"].map((s) => Math.round(document.querySelector(`.home ${s}`)!.getBoundingClientRect().top)))

test("a step's lead breaks where the mockup does on a laptop: in two even lines, or at its line break", async ({ page }) => {
  await search(page, uniqueLabel("lead"))
  await page.getByRole("button", { name: "Register" }).click()
  await expect(lineStarts(onStep(page).locator(".lead"))).resolves.toEqual(["P", "o"])
  await page.goto("/#/code")
  await expect(lineStarts(onStep(page).locator(".lead"))).resolves.toEqual(["A", "A"])
})

// the headline's distance under the header, a laptop's and a phone's, as the mockup draws it
const HEADLINE_GAPS = [32, 48]

test("the home keeps its headline and search still as each kind of answer comes, at a laptop's and a phone's size", async ({ page, request }) => {
  for (const [i, size] of FIT_SIZES.entries()) {
    await page.setViewportSize(size)
    await page.goto("/")
    await page.evaluate(() => document.fonts.ready.then(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))))
    const before = await homeTops(page)
    const header = Math.round((await page.locator("body > header").boundingBox())!.height)
    expect(before[0] - header, `the headline under the header at ${size.width}x${size.height}`).toBe(HEADLINE_GAPS[i])
    // each search on the same page, whose fonts have loaded: taken, taken without links, reserved, a rule, available, and no answer
    const answers: [string, string, () => Promise<unknown>][] = [["bakery", ".chat", async () => undefined], ["harbour", ".row", async () => undefined],
      ["support", ".line", async () => undefined], ["abc", ".line", async () => undefined], [uniqueLabel("still"), ".price", async () => undefined],
      [uniqueLabel("down"), ".line.warn", () => control(request, "search", { chainDown: true })]]
    for (const [name, answer, before_] of answers) {
      await before_()
      await page.getByLabel("Name", { exact: true }).fill(name)
      await page.getByLabel("Name", { exact: true }).press("Enter")
      await expect(page.locator(`.answer ${answer}`).first()).toBeVisible()
      expect(await homeTops(page), `${name} at ${size.width}x${size.height}: headline and search`).toEqual(before)
      expect(await overflow(page), `${name} at ${size.width}x${size.height}`).toBe(0)
    }
    await control(request, "search", { chainDown: false })
  }
})

const linked = (kind: "contact" | "channel") => ({ type: kind === "contact" ? "address" : "channel", kind, displayName: kind, fullName: "", image: null,
  subscribers: kind === "channel" ? 12 : null, link: kind === "contact" ? contactLink("H1") : channelLink("H2"), deepLink: "simplex:/a#x", profile: "ok" })
// the search's answers for a name: available, taken with two chats, and this browser's, of `owner`, with two chats
const homeAnswers = (owner: string) => ({
  available: { status: "available", price: 10000, currency: "usd", years: 2, termStart: Date.UTC(2027, 0, 1) / 1000, ...CHAIN, community: null, terms: TERMS },
  taken: { status: "registered", entities: [linked("contact"), linked("channel")], owner: `0x${"00".repeat(19)}01`, tld: "simplex", community: null },
  yours: { status: "registered", entities: [linked("contact"), linked("channel")], owner, tld: "simplex", community: null },
})

// a name of six letters that fits one row beside two chats on a phone, as most do
const SHORT_NAME = "udumhd"
// a row's least height, and the room above and under its content inside its border, whatever the name's length, as the
// mockup draws them: a phone's buy row has less
const ROW_MIN_HEIGHT = 72
const ROW_ROOM = 16
const PHONE_BUY_ROW_ROOM = 14

// the service worker of a production build answers these pages before Playwright's routes in WebKit
test.describe(() => {
  test.use({ serviceWorkers: "block" })

  test("each home answer holds its name inside its row with the same room above and under it, and a name of six letters on one line, at a laptop's and a phone's size", async ({ page }) => {
    for (const label of [SHORT_NAME, wideLabel(6), wideLabel(MAX_LABEL_LENGTH)]) {
      const { owner } = await keepOrder(page, "reg-rowfit", null, label)
      await page.route("**/api/registration/reg-rowfit*", (route) => route.fulfill({ status: 404, json: { error: "not_found" } }))
      for (const [state, answer] of Object.entries(homeAnswers(owner))) {
        await page.unroute("**/api/name/**")
        await page.route("**/api/name/**", (route) => route.fulfill({ json: answer }))
        for (const size of FIT_SIZES) {
          await page.setViewportSize(size)
          await page.goto("/#/trademarks")
          await page.goto("/")
          await page.evaluate(() => document.fonts.ready)
          const empty = await homeTops(page)
          await page.getByLabel("Name", { exact: true }).fill(label)
          await page.getByLabel("Name", { exact: true }).press("Enter")
          await expect(page.locator(".answer .row")).toContainText(state === "yours" ? "Your name" : state === "taken" ? "Taken" : "Register")
          const at = `${state}, ${label.length} letters, ${size.width}x${size.height}`
          expect(await homeTops(page), `${at}: headline and search`).toEqual(empty)
          const fit = await rowFit(page)
          expect(fit.spill, `${at}: past its row`).toBe(0)
          const room = state === "available" && size === FIT_SIZES[1] ? PHONE_BUY_ROW_ROOM : ROW_ROOM
          expect(fit.room, `${at}: the room above and under its content`).toEqual([room, room])
          expect(fit.height, `${at}: the row's height`).toBeGreaterThanOrEqual(ROW_MIN_HEIGHT)
          expect(fit.clipped, `${at}: too narrow for their content`).toEqual([])
          expect(await brokenNames(page), `${at}: broken though it fits its line`).toEqual([])
          if (label.length < 8) expect(fit.nameLines, `${at}: the name's lines`).toBe(1)
          if (label === SHORT_NAME && state !== "available") expect(fit.height, `${at}: the row's height`).toBe(ROW_MIN_HEIGHT)
          // a name too long for its row takes a line of its own, its chats and whose it is under it
          if (label.length === MAX_LABEL_LENGTH) expect(fit.ownLine, `${at}: the name's own line`).toBe(state !== "available" || size === FIT_SIZES[1])
          expect(await overflow(page), at).toBe(0)
        }
      }
    }
  })
})

test("the registering page keeps its heading still on a phone from the commit to the name being registered", async ({ page, request }) => {
  await page.setViewportSize(FIT_SIZES[1])
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  const label = uniqueLabel("regstill")
  await useCode(page, code)
  await search(page, label)
  await toReview(page)
  // each frame's heading top and the words under the clock, while the heading is the registering page's
  await recordFrames(page, () => {
    const heading = document.querySelector("body > main h1")
    const note = document.querySelector(".countdown p")?.firstChild?.textContent ?? ""
    return heading?.textContent!.startsWith("Registering") ? [Math.round(heading.getBoundingClientRect().top), note] : null
  })
  await onStep(page).getByRole("button", { name: "Register with your code" }).click()
  await waitRegistered(page, label)
  const frames = await recordedFrames<[number, string]>(page)
  expect(new Set(frames.map(([, note]) => note)).size, "the page went through more than one stage").toBeGreaterThan(1)
  expect([...new Set(frames.map(([top]) => top))], "the heading's top in each frame").toHaveLength(1)
})

// A code order held at its commit while no transaction goes out, until the mock's resends (MOCK_RESEND_MS × MOCK_RESENDS)
// run out; `stuck` runs within them.
async function heldAtCommit(page: Page, request: APIRequestContext, prefix: string, stuck: () => Promise<void>): Promise<void> {
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  await useCode(page, code)
  await search(page, uniqueLabel(prefix))
  await toReview(page)
  await control(request, "search", { unsentSeconds: REGISTRATION_MS / 1000 })
  try {
    await onStep(page).getByRole("button", { name: "Register with your code" }).click()
    await expect(page.locator(".stage.active", { hasText: "Committing" })).toBeVisible()
    await stuck()
  } finally {
    await control(request, "search", { unsentSeconds: 0 })
  }
}

// The vertical middle of what the countdown shows: its icon, and the lines of its words in view, whose box is the whole
// cell it shares with the hidden longest words.
const countdownMiddles = (page: Page) => page.locator(".countdown").evaluate((box) => {
  const words = document.createRange()
  words.selectNodeContents(box.querySelector("p > :not(.sizer)")!)
  const lines = [...words.getClientRects()]
  const icon = box.querySelector("b > svg")!.getBoundingClientRect()
  return { icon: (icon.top + icon.bottom) / 2, note: (Math.min(...lines.map((r) => r.top)) + Math.max(...lines.map((r) => r.bottom))) / 2 }
})

test("the words under the registering page's clock are centred on its icon", async ({ page, request }) => {
  await heldAtCommit(page, request, "centre", async () => {
    for (const size of FIT_SIZES) {
      await page.setViewportSize(size)
      const { icon, note } = await countdownMiddles(page)
      expect(Math.abs(icon - note), `the words' middle from the icon's at ${size.width}x${size.height}`).toBeLessThanOrEqual(1)
    }
  })
})

// the phone window whose page under the header is shorter than a step's frame
const SHORT_PHONE = { width: 390, height: 823 }

test("a page loaded directly on a phone draws its invest note where its first frame painted it", async ({ page }) => {
  test.skip(!process.env.BASE_URL, "the dev server styles the page from its script, so only the build paints a frame before the page is drawn")
  await page.setViewportSize(SHORT_PHONE)
  await recordFrames(page, () => document.querySelector("body > .invest")?.getBoundingClientRect().top ?? null, true)
  for (const route of ["/", "/#/names", "/#/namesx", "/#/code", "/#/codes", "/#/trademarks", "/#/edit/nosuchname", "/#/checkout/links", "/?order=nosuchorder", "/?order="]) {
    // a document of its own each time, as a route reached by its hash alone is drawn in the page already there
    await page.goto("about:blank")
    await page.goto(route)
    await expect(onStep(page).locator("h1")).toBeVisible()
    await page.evaluate(() => new Promise((drawn) => requestAnimationFrame(() => requestAnimationFrame(drawn))))
    expect([...new Set(await recordedFrames<number>(page))], `${route}: the invest note's top in each frame`).toHaveLength(1)
  }
})

// how far ahead the service's clock is put, past a commit's stall
const AHEAD_MS = 2 * TX_STALL_MS

// where the registering page's parts stand: its heading, the countdown and its words' cell, and the reference under them
const registeringPlaces = (page: Page) => page.locator("body > main").evaluate((main) => [
  main.querySelector("h1")!, main.querySelector(".countdown")!, main.querySelector(".countdown p")!, main.querySelector(".screen-body > .ref")!,
].map((n) => {
  const r = n.getBoundingClientRect()
  return [r.top, r.height]
}))

// the service worker of a production build sends the page's reads past Playwright's routes in WebKit
test.describe(() => {
  test.use({ serviceWorkers: "block" })

  test("a commit that does not move on for longer than usual says so in its words' place, and nothing moves", async ({ page, request }) => {
    await heldAtCommit(page, request, "stall", async () => {
      const words = page.locator(".countdown p > :not(.sizer)")
      await expect(words).toHaveText("Placing your order. The wait starts once it is in.")
      const before = await registeringPlaces(page)
      // the page reads the time by the service's Date header, which now says the commit has stood still past its margin
      await page.route("**/api/registration/*", async (route) => {
        const response = await route.fetch()
        await route.fulfill({ response, headers: { ...response.headers(), date: new Date(Date.now() + AHEAD_MS).toUTCString() } })
      })
      await expect(words).toHaveText("This is taking longer than usual. It continues by itself.")
      expect(await registeringPlaces(page), "the heading, the countdown, its words' cell and the reference").toEqual(before)
      // a long poll the route still holds would fail once the test ends
      await page.unrouteAll({ behavior: "ignoreErrors" })
    })
  })
})

// A name of the widest letters breaks its lines as early as any name of its length can; drawn at random from two
// letters, it is still new to the chain on each run.
const wideLabel = (length: number) => Array.from({ length }, () => (Math.random() < 0.5 ? "m" : "w")).join("")

for (const length of [15, 25, MAX_LABEL_LENGTH]) {
  test(`every purchase step fits both windows for a name of ${length} wide letters`, async ({ page, request }) => {
    const label = wideLabel(length)
    const shots = `long-${length}`
    const frames: Record<string, Frame[]> = {}
    await search(page, label)
    await expect(page.getByRole("button", { name: "Register" })).toBeEnabled()
    await fitsWindow(page, `${shots}-1-home`)
    await page.getByRole("button", { name: "Register" }).click()
    const step = onStep(page)
    await fillLinks(page, contactLink("W1"), channelLink("W2"))
    await previewsShown(page)
    await fitsWindow(page, `${shots}-2-links`, frames)
    await step.getByRole("button", { name: "Continue" }).click()
    await expect(step.getByRole("heading", { name: CODE_HEADING })).toBeVisible()
    await fitsWindow(page, `${shots}-3-code`, frames)
    await savedToReview(page)
    await fitsWindow(page, `${shots}-4-review`, frames)
    await payButton(page).click()
    await page.waitForURL(/\?order=/)
    await expect(page.getByRole("heading", { name: "Pay with Bitcoin" })).toBeVisible()
    await fitsWindow(page, `${shots}-5-pay-bitcoin`, frames)
    await control(request, `settle/${new URL(page.url()).searchParams.get("order")}`)
    await expect(page.locator(".stage.active", { hasText: "Waiting" })).toBeVisible({ timeout: REGISTRATION_MS })
    await fitsWindow(page, `${shots}-6-registering`)
    await waitRegistered(page, label)
    await fitsWindow(page, `${shots}-7-registered`)
    // a heading with the name in it may take more lines; the main button stays where every step's is
    for (const [i, size] of FIT_SIZES.entries()) {
      expect(new Set(Object.values(frames).map((f) => f[i].actions)).size, `the actions' row at ${size.width}x${size.height}: ${JSON.stringify(frames)}`).toBe(1)
    }
    oneFrame(frames)
  })
}

// A random mix of m and w misses this widest name in most runs, whose lines on the name-is-yours screen are the most.
test(`the name-is-yours screen fits both windows for a name of ${MAX_LABEL_LENGTH} m letters`, async ({ page }) => {
  const label = "m".repeat(MAX_LABEL_LENGTH)
  const { registrationId } = await fakeRegisteredName(page, label, { contact: contactLink("Y1"), channel: "" })
  await page.goto(`/?registration=${registrationId}`)
  await expect(page.getByRole("heading", { name: `${label}.simplex is yours` })).toBeVisible()
  await expect(onStep(page).getByRole("button", { name: "Edit links" })).toBeVisible()
  await fitsWindow(page, `long-${MAX_LABEL_LENGTH}-m-registered`)
})

test("a part paid takes the name's note with its notice, the payment keeping its heading still and fitting both windows", async ({ page, request }) => {
  for (const size of FIT_SIZES) {
    await page.setViewportSize(size)
    const { invoiceId } = await startOrder(page, uniqueLabel("part"), { method: "btc" })
    await expect(onStep(page).getByText("The name is available")).toBeVisible()
    const before = await headingAt(page)
    await control(request, `partial/${invoiceId}`)
    await expect(onStep(page).locator(".notice.warn", { hasText: "Part of the payment arrived" })).toBeVisible()
    expect(await headingAt(page), `the heading at ${size.width}x${size.height}`).toEqual(before)
    expect(await overflow(page), `the page's overflow at ${size.width}x${size.height}`).toBe(0)
    await expect(onStep(page).getByText(/^Part of the payment arrived: [\d.]+ of [\d.]+ BTC is seen\./)).toBeVisible()
    await expect(onStep(page).locator(".name-check")).toHaveCount(0)
  }
  await shot(page, "names-u1-part-paid")
})

test("Check your code keeps its heading and main button still as a verdict comes and goes, at both sizes", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  for (const size of FIT_SIZES) {
    await page.setViewportSize(size)
    await page.goto("/#/code")
    const at = () => page.evaluate(() => ["body > main h1", "body > main .actions-row .btn"].map((s) => Math.round(document.querySelector(s)!.getBoundingClientRect().top)))
    const before = await at()
    for (const [typed, verdict] of [["Q", ".verdict.bad"], [code, ".verdict.ok"], ["SN-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA", ".verdict.bad"], ["", ".verdict:empty"]]) {
      await codeField(page).fill(typed)
      await expect(onStep(page).locator(verdict)).toHaveCount(1)
      expect(await at(), `the heading and the button with "${typed}" at ${size.width}x${size.height}`).toEqual(before)
      expect(await overflow(page), `the page's overflow with "${typed}" at ${size.width}x${size.height}`).toBe(0)
    }
  }
})

// the page's height, and what of it shows under the offline note
const underNote = (page: Page) => page.evaluate(() => {
  const note = document.querySelector(".offline-note")!.getBoundingClientRect()
  const under = [...document.querySelectorAll("body > :is(main, .invest, footer) :is(a, button, h1, p, span, svg)")].filter((n) => {
    const b = n.getBoundingClientRect()
    return n.checkVisibility({ visibilityProperty: true }) && b.width > 0 && b.left < note.right && b.right > note.left && b.top < note.bottom && b.bottom > note.top
  })
  return { height: document.scrollingElement!.scrollHeight, under: under.map((n) => n.textContent!.trim() || n.tagName) }
})

test("going offline and back moves neither the home's heading nor the review's, and scrolls neither, at both sizes", async ({ page, context }) => {
  const offlineAndBack = async (where: string) => {
    const before = await headingAt(page)
    const { height } = await underNote(page)
    await context.setOffline(true)
    try {
      await expect(page.locator(".offline-note")).toBeVisible()
      expect(await headingAt(page), `${where}'s heading offline`).toEqual(before)
      expect(await overflow(page), `${where}'s overflow offline`).toBe(0)
      expect(await underNote(page), `${where}'s height, and what shows under the note`).toEqual({ height, under: [] })
    } finally {
      await context.setOffline(false)
    }
    await expect(page.locator(".offline-note")).toBeHidden()
    expect(await headingAt(page), `${where}'s heading back online`).toEqual(before)
    expect(await overflow(page), `${where}'s overflow back online`).toBe(0)
  }
  for (const size of FIT_SIZES) {
    await page.setViewportSize(size)
    await page.goto("/")
    await page.evaluate(() => document.fonts.ready)
    await offlineAndBack(`the home at ${size.width}`)
    await toFullReview(page, uniqueLabel("offline"))
    await offlineAndBack(`the review at ${size.width}`)
  }
  await context.setOffline(true)
  await expect(page.locator(".offline-note")).toBeVisible()
  await shot(page, "names-u1-review-offline")
  await context.setOffline(false)
})

test("a line on another order waiting comes into the review below its heading, the review fitting both windows", async ({ page }) => {
  await startOrder(page, uniqueLabel("waiting"), { method: "btc" })
  // the review heading's top in each frame of every page from here on
  await recordFrames(page, () => {
    const heading = document.querySelector("body > main h1")
    return heading?.textContent === "Check your order" ? Math.round(heading.getBoundingClientRect().top) : null
  }, true)
  for (const size of FIT_SIZES) {
    await page.setViewportSize(size)
    await toFullReview(page, uniqueLabel("other"))
    await expect(onStep(page).getByText("Another order is waiting for its payment.")).toBeVisible()
    await headingAt(page)
    const tops = [...new Set(await recordedFrames<number>(page))]
    expect(tops, `the review heading's tops at ${size.width}x${size.height}`).toHaveLength(1)
    expect(await overflow(page), `the page's overflow at ${size.width}x${size.height}`).toBe(0)
    await fitsWindow(page, "4c-review-other-order")
    // its link stays whole on one line, a phone putting the line's words above it
    const link = onStep(page).getByRole("link", { name: "Open that order" })
    expect(await link.evaluate((a) => a.getClientRects().length), `the link's lines at ${size.width}x${size.height}`).toBe(1)
  }
})

// An order of ours found for the name, and a refused link, are each their page's biggest change: the page keeps its
// heading through it and fits both windows.
for (const length of [10, MAX_LABEL_LENGTH]) {
  test(`an order of ours for a name of ${length} wide letters keeps the home still and fitting both windows`, async ({ page }) => {
    const label = wideLabel(length)
    await startOrder(page, label, { method: "btc" })
    for (const size of FIT_SIZES) {
      await page.setViewportSize(size)
      await page.goto("/")
      await page.evaluate(() => document.fonts.ready.then(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))))
      const before = await homeTops(page)
      await page.getByLabel("Name", { exact: true }).fill(label)
      await page.getByLabel("Name", { exact: true }).press("Enter")
      await expect(page.locator(".answer").getByRole("link", { name: "Open that order" })).toBeVisible()
      await expect(page.locator(".answer").getByText("You already have an order for this name")).toBeVisible()
      expect(await homeTops(page), `headline and search at ${size.width}x${size.height}`).toEqual(before)
      expect(await overflow(page), `the page's overflow at ${size.width}x${size.height}`).toBe(0)
      expect((await rowFit(page)).clipped, `the row's parts too narrow for their content at ${size.width}x${size.height}`).toEqual([])
    }
    await shot(page, `names-u1-home-own-order-${length}`)
  })
}

test(`Edit links keeps still and fits both windows as it saves, for a name of ${MAX_LABEL_LENGTH} wide letters, and Check your code fits them refusing a code`, async ({ page, request }) => {
  const label = wideLabel(MAX_LABEL_LENGTH)
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  await control(request, `settle/${invoiceId}`)
  await waitRegistered(page, label)
  await page.goto(`/#/edit/${await registrationOf(request, invoiceId)}`)
  const save = page.getByRole("button", { name: "Save links" })
  await expect(save).toBeEnabled()
  await fitsWindow(page, "8-edit-links")
  for (const [i, size] of FIT_SIZES.entries()) {
    await page.setViewportSize(size)
    await page.reload()
    await expect(save).toBeEnabled()
    const before = await headingAt(page)
    // each frame's overflow and heading top, from the change through the save to its answer
    await recordFrames(page, () => [document.scrollingElement!.scrollHeight - innerHeight - Math.round(document.querySelector("body > footer")!.getBoundingClientRect().height),
      Math.round(document.querySelector("main h1")!.getBoundingClientRect().top)])
    const field = page.getByRole("textbox", { name: i ? "Channel" : "Link", exact: true })
    if (i) await page.getByRole("button", { name: "Add a channel link" }).click()
    await field.fill(i ? channelLink(`E${i}`) : contactLink(`E${i}`))
    await field.blur()
    await save.click()
    await expect(page.getByText("Links saved")).toBeVisible({ timeout: 30_000 })
    expect(await headingAt(page), `the heading once saved at ${size.width}x${size.height}`).toEqual(before)
    const frames = await recordedFrames<[number, number]>(page)
    expect(Math.max(...frames.map(([over]) => over)), `each frame's overflow at ${size.width}x${size.height}`).toBe(0)
    expect([...new Set(frames.map(([, top]) => top))], `the heading's tops at ${size.width}x${size.height}`).toEqual([before.y])
  }
  await shot(page, "names-u1-edit-links-saved")
  await page.goto("/#/code")
  await fitsWindow(page, "9-check-code")
  await codeField(page).fill("SN-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA")
  await expect(onStep(page).getByText("This code is not valid")).toBeVisible()
  await fitsWindow(page, "9b-check-code-refused")
})

test(`a name of ${MAX_LABEL_LENGTH} wide letters in a sentence starts a line of its own, at the sentence's size, its TLD on its last letters' line`, async ({ page }) => {
  await search(page, wideLabel(MAX_LABEL_LENGTH))
  await toCodeStep(page)
  const lead = onStep(page).locator(".lead")
  for (const size of FIT_SIZES) {
    await page.setViewportSize(size)
    const drawn = await lead.evaluate((node) => {
      const name = node.querySelector(".nt")!
      const words = document.createRange()
      words.selectNodeContents(node.firstChild!)
      const tail = name.querySelector(".nowrap")!
      return { size: getComputedStyle(name).fontSize === getComputedStyle(node).fontSize, ownLine: Math.round(name.getClientRects()[0].top) > Math.round(words.getClientRects()[0].top),
        tail: tail.textContent, tailLines: new Set([...tail.getClientRects()].map((r) => Math.round(r.top))).size }
    })
    expect(drawn, `the name in the lead at ${size.width}x${size.height}`).toEqual({ size: true, ownLine: true, tail: expect.stringMatching(/^[mw]{3}\.simplex\.$/), tailLines: 1 })
  }
})

test("a refused link reads as a line under its field, and a refused code in a box under its own, at both sizes", async ({ page }) => {
  for (const size of FIT_SIZES) {
    await page.setViewportSize(size)
    await search(page, uniqueLabel("refusal"))
    const step = onStep(page)
    await step.getByRole("button", { name: "Register" }).click()
    const link = step.getByRole("textbox", { name: "Link", exact: true })
    await link.fill("https://example.com/x#nothing")
    const refusal = step.locator(".field-error")
    await expect(refusal).toHaveText("This is not a SimpleX contact address or channel link.")
    const [drawn, box] = [(await refusal.boundingBox())!, (await step.locator(".link-field .field").boundingBox())!]
    expect({ under: Math.round(drawn.y - box.y - box.height), icon: await refusal.locator("svg").count() }, `the refused link at ${size.width}x${size.height}`).toEqual({ under: 8, icon: 0 })
    await page.goto("/#/code")
    await codeField(page).fill("SN-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA")
    const verdict = onStep(page).locator(".verdict.bad")
    await expect(verdict).toHaveText(/This code is not valid/)
    expect(await verdict.evaluate((v) => getComputedStyle(v).borderTopStyle), `the refused code's box at ${size.width}x${size.height}`).toBe("solid")
  }
})

// The payment's line of name, term and amount: how many separator dots it has, and how many start a line, drawn on
// another line than the character before them.
const separatorsOf = (line: Locator) => line.evaluate((node) => {
  const top = (text: Node, i: number) => { const range = document.createRange(); range.setStart(text, i); range.setEnd(text, i + 1); return Math.round(range.getBoundingClientRect().top) }
  let dots = 0
  let starting = 0
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    for (let i = text.textContent!.indexOf("\u00b7"); i >= 0; i = text.textContent!.indexOf("\u00b7", i + 1)) {
      dots += 1
      if (i === 0 || top(text, i - 1) !== top(text, i)) starting += 1
    }
  }
  return { dots, starting }
})

test("the payment's line keeps its separator dot at the end of a line, never starting one, for long names on a phone", async ({ page }) => {
  await page.setViewportSize(FIT_SIZES[1])
  for (const length of [25, MAX_LABEL_LENGTH]) {
    await startOrder(page, wideLabel(length), { method: "btc" })
    const line = onStep(page).locator(".screen-head .lead")
    await expect(line).toBeVisible()
    const { dots, starting } = await separatorsOf(line)
    expect(dots, `the dots of a name of ${length} letters`).toBe(1)
    expect(starting, `dots starting a line, for a name of ${length} letters`).toBe(0)
  }
})

// the share of its field a focused link's text has, all but the field's icon and padding
const FOCUSED_INPUT_SHARE = 0.7

test("a link field focused shows its link alone, from its start, across the field, at both sizes", async ({ page }) => {
  await search(page, uniqueLabel("focuslink"))
  const step = onStep(page)
  await step.getByRole("button", { name: "Register" }).click()
  await fillLinks(page, contactLink("FL"), channelLink("FL"))
  await previewsShown(page)
  for (const size of FIT_SIZES) {
    await page.setViewportSize(size)
    for (const name of ["Link", "Channel"]) {
      const input = step.getByRole("textbox", { name, exact: true })
      const field = step.locator(".link-field .field", { has: page.getByRole("textbox", { name, exact: true }) })
      // a person's click on the profile the field shows
      await field.locator(".entity").click()
      await expect(input).toBeFocused()
      await expect(field.locator(".preview")).toBeHidden()
      const drawn = await input.evaluate((node) => ({ scrolled: node.scrollLeft, share: node.getBoundingClientRect().width / node.closest(".field")!.getBoundingClientRect().width }))
      expect(drawn.scrolled, `${name} at ${size.width}x${size.height}: the link scrolled from its start`).toBe(0)
      expect(drawn.share, `${name} at ${size.width}x${size.height}: the link's share of its field`).toBeGreaterThan(FOCUSED_INPUT_SHARE)
      await input.blur()
      await expect(field.locator(".entity:not(.skeleton)"), `${name}: the profile once the field is left`).toBeVisible()
    }
  }
})

for (const length of [25, MAX_LABEL_LENGTH]) {
  test(`a refused link keeps the links step still and fitting both windows, for a name of ${length} wide letters`, async ({ page }) => {
    for (const size of FIT_SIZES) {
      await page.setViewportSize(size)
      await search(page, wideLabel(length))
      const step = onStep(page)
      await step.getByRole("button", { name: "Register" }).click()
      await step.getByRole("textbox", { name: "Link", exact: true }).fill(contactLink("V3"))
      await step.getByRole("textbox", { name: "Link", exact: true }).blur()
      await expect(step.locator(".link-field .entity:not(.skeleton)")).toBeVisible()
      await step.getByRole("button", { name: "Add a channel link" }).click()
      const before = await headingAt(page)
      await step.getByRole("textbox", { name: "Channel" }).fill(contactLink("V3"))
      await expect(step.locator(".field-error")).toHaveText("This is a contact address. Paste a channel link here.")
      expect(await headingAt(page), `the heading at ${size.width}x${size.height}`).toEqual(before)
      expect(await overflow(page), `the page's overflow at ${size.width}x${size.height}`).toBe(0)
      await fitsWindow(page, `links-refused-${length}`)
    }
  })

  test(`a code shows the review of a free name fitting both windows, for a name of ${length} wide letters`, async ({ page, request }) => {
    const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
    await useCode(page, code)
    await toFullReview(page, wideLabel(length))
    await expect(onStep(page).locator(".trow.total")).toHaveText("Free SimpleX name")
    await expect(onStep(page).getByRole("radio")).toHaveCount(0)
    await fitsWindow(page, `review-code-paid-${length}`)
  })
}
