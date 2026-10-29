// The page's frame: theme switch and navigation between views; index.html draws the header and footer.
import { alertBox, announce, btn, copyButton, el, fitNames, icon, type Kid, liveRegion, reducedMotion, refill, type Tone, waitOut } from "../dom.ts"
import type { IconName } from "../icons.ts"
import type { Hold } from "../screens/hold.ts"
import * as session from "../session.ts"
import * as store from "../store.ts"
import { secondsLeft } from "./hold.ts"

export const CONTACT_EMAIL = "chat@simplex.chat"

let rerender: () => void = () => undefined

export const setRenderer = (render: () => void) => { rerender = render }

let route = 0
const leaving: (() => void)[] = []
const pageLeft: (() => void)[] = []
const drawnHooks: (() => void)[] = []
const dropping: (() => void)[] = []
let redrawing = false
// the route the screen on show was drawn on; a redraw of the same page carries it to the redrawn route
let drawnRoute = -1
let shownKind: string | null = null
let shownScreen: HTMLElement | null = null
let screenStop: AbortController | null = null
// nodes a reader types into, or what holds them, kept for the route so a redraw moves them rather than rebuilding them
const keptNodes = new Map<string, unknown>()

// A new route ends the last one's polls and timers: async work checks its token with isRoute before drawing.
export function nextRoute(): void {
  leaving.splice(0).forEach((f) => f())
  const samePage = redrawing && drawnRoute === route
  route += 1
  if (samePage) drawnRoute = route
  else {
    dropping.splice(0).forEach((f) => f())
    pageLeft.forEach((f) => f())
    keptNodes.clear()
    screenStop?.abort()
    screenStop = null
    // the last screen stays in sight, out of reach, until the new route draws
    frame().inert = true
  }
}

export const isRedraw = () => drawnRoute === route

export const isRoute = (token: number) => token === route
export const currentRoute = () => route

export const whenLeaving = (f: () => void) => { leaving.push(f) }

// once the page is left for another, rather than drawn again, as its kept nodes are dropped
export const whenDropped = (f: () => void) => { dropping.push(f) }
// each time any page is left for another, or drawn
export const onPageLeft = (f: () => void) => { pageLeft.push(f) }
export const onDrawn = (f: () => void) => { drawnHooks.push(f) }

const nextAt = () => Math.max(-1, ...Object.keys(session.scrolled()).map(Number)) + 1
let historyAt = typeof history.state?.at === "number" ? history.state.at as number : nextAt()
if (history.state?.at !== historyAt) history.replaceState({ ...history.state, at: historyAt }, "")
history.scrollRestoration = "manual"
// a tab a phone puts away may be dropped without unloading, so the place is kept as it is hidden too
const keepScrolled = () => session.setScrolled(historyAt, leftAt())
addEventListener("pagehide", keepScrolled)
document.addEventListener("visibilitychange", () => { if (document.hidden) keepScrolled() })
// a page reached by Back or Forward rather than by a link, until it is drawn
let popped = false
export const throughHistory = () => popped
let scrollTarget: number | null = session.scrolled()[historyAt] ?? null
const leftAt = () => scrollTarget ?? scrollY
// the entry this document was loaded at; Back to an entry before it would load an earlier document again
const loadedAt = historyAt
let landing: string | null = null
export const historyPlace = () => historyAt

// Opens `url` after the entry at `at`, so Back lands there once; where that would leave the document, this entry becomes `back`.
export function goFrom(at: number, back: string, url: string): void {
  if (at < loadedAt || at >= historyAt) {
    history.replaceState(history.state, "", back)
    return go(url)
  }
  keepScrolled()
  landing = url
  history.go(at - historyAt)
}

// false when the move was a jump back that opened its page itself
export function historyMoved(e: PopStateEvent): boolean {
  if (landing !== null && typeof e.state?.at === "number") {
    const url = landing
    landing = null
    historyAt = e.state.at as number
    scrollTarget = session.scrolled()[historyAt] ?? 0
    go(url)
    return false
  }
  keepScrolled()
  if (typeof e.state?.at !== "number") {
    historyAt = nextAt()
    history.replaceState({ ...e.state, at: historyAt }, "")
    popped = false
    scrollTarget = 0
    return true
  }
  const at = e.state.at as number
  popped = true
  historyAt = at
  scrollTarget = session.scrolled()[at] ?? 0
  return true
}

export function go(url: string): void {
  keepScrolled()
  historyAt += 1
  history.pushState({ at: historyAt }, "", url)
  popped = false
  scrollTarget = 0
  rerender()
}

export const searchLink = (label: string) => `/#/?${new URLSearchParams({ name: label })}`

// for a page that sends the buyer elsewhere: replacing the entry keeps Back and Forward usable
export function redirect(url: string): void {
  history.replaceState({ at: historyAt }, "", url)
  rerender()
}

export function refresh(): void {
  redrawing = true
  try {
    rerender()
  } finally {
    redrawing = false
  }
}

export type Builder<S> = (state: S, signal: AbortSignal) => HTMLElement
// a screen's main action and its text-link alternative, which a step holds at one place on every step
interface Actions { action?: Node | null; alt?: Node | null }
interface ScreenHead extends Actions { title: Kid; lead?: Kid; back?: string }
interface Outcome extends Actions { tone: Tone; icon: IconName; title: string; text: Kid; reference?: string; extra?: Kid; agreement?: Kid; back?: string }

export function kept<T>(key: string, make: () => T): T {
  const known = keptNodes.get(key)
  if (known) return known as T
  const made = make()
  keptNodes.set(key, made)
  return made
}

// a live region stays one node for the route, so a screen reader hears what each draw puts in it
export const keptLive = (key: string, cls: string | undefined, ...kids: Kid[]) => refill(kept(key, () => liveRegion(cls)), ...kids)

const LOADING = "loading"
// What a redraw draws again is marked shown, so only what it adds comes in (styles.css). A node is known by its tag, its
// classes and how many before it share them, not by its words, which a countdown changes each second.
const ARRIVING = ".answer > *, .notice, .entity, .other-order, .field-error, .verdict:not(:empty)"
const SHOWN = "shown"
const ENTER = "enter"
function arrivals(screen: Element): [Element, string][] {
  const seen = new Map<string, number>()
  return [...screen.querySelectorAll(ARRIVING)].map((node) => {
    const kind = [node.tagName, ...[...node.classList].filter((c) => c !== SHOWN)].join(".")
    seen.set(kind, (seen.get(kind) ?? 0) + 1)
    return [node, `${kind}#${seen.get(kind)}`]
  })
}
// a node put in the place held for it, as a preview in its skeleton's, is there already rather than arriving
export const inPlace = <T extends Element>(node: T) => { node.classList.add(SHOWN); return node }
// the key of a control a redraw turned off, whose focus dropped to the page: a later redraw that offers it gives it back
let lostKey: string | null = null

export function draw(kind: string, build: (signal: AbortSignal) => HTMLElement): void {
  const main = frame()
  showConnection()
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const caret = active instanceof HTMLInputElement ? [active.selectionStart, active.selectionEnd] as const : null
  const focusKey = active === null || active === document.body ? lostKey : active.dataset.focus ?? null
  const first = shownKind === null
  const redrawn = kind === shownKind && drawnRoute === route
  // the heading the last draw focused is replaced with its screen, so the redrawn screen's heading takes focus
  const toHeading = !redrawn || (active !== null && active === shownScreen?.querySelector("h1"))
  // read before the build, which moves the kept nodes out of the screen on show
  const drawn = redrawn && shownScreen ? new Set(arrivals(shownScreen).map(([, key]) => key)) : null
  screenStop?.abort()
  screenStop = new AbortController()
  const next = build(screenStop.signal)
  for (const [node, key] of arrivals(next)) if (!drawn || drawn.has(key)) node.classList.add(SHOWN)
  main.replaceChildren(next)
  fitNames(next)
  if (!redrawn && !first) next.classList.add(ENTER)
  shownScreen = next
  main.inert = false
  shownKind = kind
  drawnRoute = route
  popped = false
  document.title = titleOf(next)
  drawnHooks.forEach((f) => f())
  lostKey = null
  if (!first) settleFocus(active, caret, toHeading, focusKey)
  // a new screen whose heading did not take focus, as with focus on the header, is still said
  const heading = next.querySelector("h1")
  if (!redrawn && !first && heading && document.activeElement !== heading) announce(heading.textContent ?? "")
  // the place a page was left at is kept for the page itself, not for the loading line before it
  if (scrollTarget !== null && kind !== LOADING) {
    scrollTo(0, scrollTarget)
    scrollTarget = null
  }
}

const keyed = (key: string | null | undefined) => key ? shownScreen?.querySelector<HTMLElement>(`[data-focus="${CSS.escape(key)}"]:not([disabled])`) : null

export const focusOn = (key: string) => keyed(key)?.focus({ preventScroll: true })

export function focusHeading(): void {
  const heading = shownScreen?.querySelector<HTMLElement>("h1")
  if (!heading) return
  heading.tabIndex = -1
  heading.focus({ preventScroll: true })
}

// A new kind of screen, or one whose heading had focus, focuses its heading; a redraw returns focus to its keyed control or leaves it.
function settleFocus(active: HTMLElement | null, caret: readonly [number | null, number | null] | null, toHeading: boolean, focusKey: string | null): void {
  if (active?.isConnected && shownScreen?.contains(active)) {
    active.focus({ preventScroll: true })
    if (caret && active instanceof HTMLInputElement) active.setSelectionRange(caret[0], caret[1])
    return
  }
  // focus on the header, the footer or a dialog stays there; focus that was in main, even in a screen now inert, goes to the new heading
  if (active && active !== document.body && active.isConnected && !active.closest("body > main")) return
  if (toHeading) return focusHeading()
  const same = keyed(focusKey)
  if (!same) {
    lostKey = focusKey
    return
  }
  // the control found again, or the answer that took its key, stays in sight, as a phone may have it below the fold
  same.focus({ preventScroll: true })
  same.scrollIntoView({ block: "nearest" })
}

const SITE_TITLE = "SimpleX names"
const titleOf = (next: HTMLElement) => {
  const heading = next.querySelector("h1")?.textContent?.trim()
  return heading ? `${heading} · ${SITE_TITLE}` : SITE_TITLE
}

// Back as the badges store draws it, a chevron and its word, beside the heading; the lead under both
const screenHead = (title: Kid, back: string | undefined, lead?: Kid) => el("div", { class: "screen-head" },
  back ? el("a", { class: "back", href: back, "aria-label": "Back" }, icon("chevron"), el("span", { "aria-hidden": "true" }, "Back")) : null, el("h1", {}, title),
  lead ? el("p", { class: "lead" }, lead) : null)

const actionsOf = ({ action, alt }: Actions) => action || alt ? el("div", { class: "actions-row" }, alt ? el("div", { class: "alt" }, alt) : null, action) : null

export function screen(head: ScreenHead, ...body: Kid[]): HTMLElement {
  return el("section", { class: "screen" }, screenHead(head.title, head.back, head.lead), el("div", { class: "screen-body" }, ...body), actionsOf(head))
}

// A purchase step, an outcome or a screen like them is a frame of one height: its heading block, its content, and its
// actions' row, so Back, the heading and the main button stand at one place on every step; without actions its content
// takes the row's room.
export function asStep(screen: HTMLElement): HTMLElement {
  screen.classList.add("step")
  return screen
}

export function outcome(o: Outcome): HTMLElement {
  return el("section", { class: "screen outcome" }, screenHead(o.title, o.back),
    el("div", { class: "screen-body" }, alertBox(o.tone, o.icon, null, o.text), o.extra ?? null, o.reference ? referenceLine(o.reference) : null, o.agreement ?? null),
    actionsOf(o))
}

const LIMITED = "Too many orders were tried from here."

export function limitScreen(hold: Hold | null, again: () => void, back: string, signal: AbortSignal): HTMLElement {
  const line = el("span", {}, `${LIMITED} Nothing was charged.`)
  const tryAgain = btn("Try again", "", again)
  tryAgain.disabled = hold !== null
  const shown = outcome({ tone: "warn", icon: "clock", title: "Too many attempts", text: line, action: tryAgain, back })
  // the count goes in once the line is in its notice, where its spoken copy goes beside it
  if (hold) waitOut(line, Math.max(1, secondsLeft(hold)), (left) => `${LIMITED} Try again in ${left}.`, () => undefined, signal)
  return shown
}

// the heading of the popup on show, which names it
export const POPUP_TITLE = "popup-title"
// the popup's return value when the page it was opened on is left, which takes focus elsewhere
const LEFT = "left"
let shownDialog: HTMLDialogElement | null = null
pageLeft.push(() => shownDialog?.close(LEFT))

// A popup over the whole window, with its heading's id POPUP_TITLE, closed by its Close or its backdrop; `first` takes
// focus as it opens, and the control keyed `key` takes it back as it closes.
export function showPopup(key: string, kids: Kid[], first: HTMLElement | null): void {
  const dialog = el("dialog", { class: "modal", "aria-labelledby": POPUP_TITLE })
  const close = () => dialog.close()
  dialog.append(el("div", { class: "modal-backdrop", onclick: close }),
    el("div", { class: "pop" }, ...kids, el("button", { class: "text-link", type: "button", onclick: close }, "Close")))
  dialog.addEventListener("close", () => {
    shownDialog = null
    dialog.remove()
    if (dialog.returnValue !== LEFT) focusOn(key)
  })
  shownDialog = dialog
  document.body.append(dialog)
  dialog.showModal()
  first?.focus()
}

// Support refunds a balance by hand, on a message that quotes the order's reference.
export function showRefund(reference: string, key: string): void {
  const copy = copyButton(reference, "field-copy", "Copy reference")
  showPopup(key, [
    el("h2", { id: POPUP_TITLE }, "Refund"),
    el("p", {}, "Write to ", el("a", { class: "nowrap", href: `mailto:${CONTACT_EMAIL}` }, CONTACT_EMAIL),
      " with your order reference. Support refunds what is left of your balance."),
    el("div", { class: "code-display" }, el("span", { class: "code-text" }, reference), el("span", { class: "code-buttons" }, copy)),
  ], copy)
}

// a balance this tab pays with from now on, for a name the search finds
export function useBalance(balance: session.AppliedBalance): void {
  session.setActiveBalance(balance)
  go("/#/")
}

export const referenceLine = (reference: string) => el("p", { class: "note ref" }, "Reference ", el("span", { class: "mono" }, reference))

// shown only before a document's first draw, placed as the screen after it will be, so its heading stays put
export function drawLoading(title: string, place = (screen: HTMLElement) => screen): void {
  if (frame().childElementCount) return
  draw(LOADING, () => place(screen({ title })))
}

const isDark = () => document.documentElement.classList.contains("dark")

// The browser's own bars, as a phone's or an installed app's, take the ground of the theme on screen, which may not be the system's.
function paintBars(): void {
  const ground = getComputedStyle(document.documentElement).getPropertyValue("--page-color").trim()
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) meta.content = ground
}

const THEMING = "theming"
const DARK_SYSTEM = "(prefers-color-scheme: dark)"
// a frame after the ground has faded, once the controls have drawn the tokens' last colours, so they do not ease to them
const themed = () => requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.classList.remove(THEMING)))
const themeFollowers = new Set<(dark: boolean) => void>()

// the page's theme, which Stripe's card form follows
export const pageTheme = {
  dark: isDark,
  watch(follow: (dark: boolean) => void): () => void {
    themeFollowers.add(follow)
    return () => { themeFollowers.delete(follow) }
  },
}

function showTheme(dark: boolean): void {
  // Chromium starts a control's own colour transition anew each frame the tokens move, so controls follow the tokens until the ground fades
  document.documentElement.classList.toggle(THEMING, !reducedMotion())
  document.documentElement.classList.toggle("dark", dark)
  paintBars()
  for (const follow of themeFollowers) follow(dark)
}

function toggleTheme(): void {
  const dark = !isDark()
  store.setTheme(dark ? "dark" : "light")
  showTheme(dark)
}

// with no theme chosen, the page follows the system's as it changes
function followSystem(e: MediaQueryListEvent): void {
  if (!store.chosenTheme() && e.matches !== isDark()) showTheme(e.matches)
}

export const OFFLINE_NOTE = "You are offline. Searches, payments and order updates need the connection."

// In the invest note's place, or at the window's foot above a longer page; it stays and only its words change, which a reader hears.
const offlineText = el("span", {})
const offline = el("div", { class: "offline", role: "status" }, el("div", { class: "offline-note" }, icon("offline"), offlineText))
function showConnection(): void {
  const text = navigator.onLine ? "" : OFFLINE_NOTE
  if (offlineText.textContent !== text) offlineText.textContent = text
}

// Checked whenever the page is drawn or looked at, as Firefox does not always tell a page opened offline that the network is back.
for (const event of ["online", "offline", "focus"]) addEventListener(event, showConnection)
document.addEventListener("visibilitychange", showConnection)

function frame(): HTMLElement {
  const main = document.querySelector<HTMLElement>("body > main")!
  if (document.body.dataset.framed) return main
  document.body.dataset.framed = "1"
  for (const button of document.querySelectorAll(".theme-switch")) button.addEventListener("click", toggleTheme)
  matchMedia(DARK_SYSTEM).addEventListener("change", followSystem)
  document.body.addEventListener("transitionend", (e) => { if (e.target === document.body && e.pseudoElement === "::after") themed() })
  paintBars()
  document.body.append(offline)
  // the names on show fit their lines again as the window changes their room, or a font that loads their letters' widths
  const refit = () => { if (shownScreen) fitNames(shownScreen) }
  addEventListener("resize", refit)
  document.fonts.addEventListener("loadingdone", refit)
  return main
}
