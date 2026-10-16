// The page's frame: header, footer, popups, and navigation between views.
import { el, icon, navLink } from "../dom.ts"
import * as focus from "../focus.ts"
import { compare, EASE, fadeIn, fadeOut, moving, settle, swapPage, transition, transitions } from "../motion.ts"
import { methodMark } from "../icons.ts"
import * as store from "../store.ts"

export const BADGES_URL = "https://badges.simplex.chat"
export const WEFUNDER_URL = "https://wefunder.com/simplex.chat?utm_source=domains"
export const CONTACT_EMAIL = "chat@simplex.chat"
export const INVEST_AMOUNT = "$500"
export const INVEST_LINE = `Invest ${INVEST_AMOUNT}+ in SimpleX Chat and get a free SimpleX name.`

let rerender: () => void = () => undefined
let openCodePopup: () => void = () => undefined

export function setRenderer(render: () => void, codePopup: () => void): void {
  rerender = render
  openCodePopup = codePopup
}

let route = 0
const leaving: (() => void)[] = []
// An open popup belongs to the route it was opened on; a redraw of the same page carries it to the redrawn route.
let popupRoute = -1
let redrawing = false
// the route the page on screen was drawn on; a redraw of the same page keeps keyboard focus where it was
let drawnRoute = -1

// A new route ends the last one's polls and timers: async work checks its token with isRoute before drawing.
export function nextRoute(): number {
  leaving.splice(0).forEach((f) => f())
  const keepPopup = redrawing && popupRoute === route
  const samePage = redrawing && drawnRoute === route
  route += 1
  if (keepPopup) popupRoute = route
  if (samePage) drawnRoute = route
  else focus.drop()
  return route
}

// drawing the same page again, as a redraw in place does without a new route
export const isRedraw = () => drawnRoute === route

export const isRoute = (token: number) => token === route
export const currentRoute = () => route

export function whenLeaving(f: () => void): void {
  leaving.push(f)
}

// Each history entry's place, so a move through the history is known to go back or forward.
let historyAt = typeof history.state?.at === "number" ? history.state.at as number : 0
if (history.state?.at !== historyAt) history.replaceState({ ...history.state, at: historyAt }, "")
// the way the last move through the history went, for the page it draws
let popped: Way | null = null
export function wentBack(e: PopStateEvent): void {
  const at = typeof e.state?.at === "number" ? e.state.at as number : 0
  popped = at < historyAt ? "back" : "forward"
  historyAt = at
}

// A page opened by a link starts at the top, scrolled there once it takes the old page's place, so the old page leaves
// from where it was read; a route that draws no page at once is scrolled at once.
let toTop = false
export function go(url: string): void {
  historyAt += 1
  history.pushState({ at: historyAt }, "", url)
  popped = null
  toTop = true
  rerender()
  if (!toTop) return
  toTop = false
  window.scrollTo(0, 0)
}

// a search for the name, still opened from the app when it was: a name found there registers to the app's wallet
export const searchLink = (label: string, appOwner: string | null) =>
  `/#/?${new URLSearchParams({ name: label, ...(appOwner ? { owner: appOwner } : {}) })}`

// for a page that sends the buyer elsewhere: replacing the entry keeps Back and Forward usable
export function redirect(url: string): void {
  history.replaceState({ at: historyAt }, "", url)
  rerender()
}

// the same page drawn again, keeping a popup open over it
export function refresh(): void {
  redrawing = true
  try {
    rerender()
  } finally {
    redrawing = false
  }
}

// the logo is drawn by CSS for the theme, and index.html draws the same before the script
function brand(): HTMLAnchorElement {
  return el("a", { class: "brand", href: "/#/", "aria-label": "SimpleX" }, el("span", { class: "logo" }))
}

export function isDark(): boolean {
  return document.documentElement.classList.contains("dark")
}

// The browser's own bars, as a phone's or an installed app's, in the page's background for the theme on screen, which
// the reader may have chosen over the one their system prefers.
const BAR_COLOURS = { light: "#FAFCFF", dark: "#020A26" }
function paintBars(): void {
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) meta.content = BAR_COLOURS[isDark() ? "dark" : "light"]
}

// outlasts the colours' .3s easing in styles.css, which taking the class away would cut short
const THEME_EASE_MS = 400

function toggleTheme(): void {
  const root = document.documentElement
  const dark = !isDark()
  const apply = () => {
    root.classList.toggle("dark", dark)
    paintBars()
    turnIn(dark ? ".when-dark svg" : ".when-light svg")
  }
  store.setTheme(dark ? "dark" : "light")
  if (!moving()) return apply()
  // the page cross-fades to the other theme where the browser's view transitions run; elsewhere its colours ease
  if (transitions()) return transition("theme", apply)
  root.classList.add("theme-easing")
  apply()
  clearTimeout(themeEased)
  themeEased = setTimeout(() => root.classList.remove("theme-easing"), THEME_EASE_MS)
}
let themeEased: ReturnType<typeof setTimeout> | undefined

// both icons are drawn and CSS shows the one for the current theme, so a theme switch needs no redraw
function themeIcons(): HTMLElement[] {
  return [el("span", { class: "when-light" }, icon("moon")), el("span", { class: "when-dark" }, icon("sun"))]
}

type Active = "search" | "names" | null
// the header's sections in its order, for the way a move between them goes
const SECTIONS: Active[] = ["search", "names"]
let drawnActive: Active = null

// A page another one replaces goes forward or back: through the steps of an order, along the header's sections, or as
// the history moved; a page that moves on by itself, as an order does, goes forward.
type Way = "forward" | "back"
const stepOf = (root: ParentNode, active: Active) => {
  const on = root.querySelector<HTMLElement>(".crumb.on")
  return on ? Number(on.dataset.step) : active === "search" ? 0 : null
}
function wayTo(old: HTMLElement, main: HTMLElement, active: Active): Way {
  const [from, to] = [stepOf(old, drawnActive), stepOf(main, active)]
  if (from !== null && to !== null && from !== to) return to > from ? "forward" : "back"
  if (drawnActive && active && drawnActive !== active) return SECTIONS.indexOf(active) > SECTIONS.indexOf(drawnActive) ? "forward" : "back"
  return popped ?? "forward"
}

function header(): HTMLElement {
  const nav = (text: string, key: string, href: string) => {
    const link = navLink(text, href)
    link.dataset.nav = key
    return link
  }
  const menu = el("nav", {},
    nav("Search", "search", "/#/"), nav("Your names", "names", "/#/names"),
    el("a", { href: BADGES_URL, target: "_blank", rel: "noopener" }, "SimpleX badges"))
  const top = el("header", { class: "top" }, el("div", { class: "wrap" },
    brand(),
    menu,
    el("span", { class: "grow" }),
    el("a", { class: "ghost-btn", href: "#", onclick: (e: Event) => { e.preventDefault(); openCodePopup() } }, icon("key"), "Check a code"),
    el("a", { class: "icon-btn", href: "#", "aria-label": "Switch light or dark theme", onclick: (e: Event) => { e.preventDefault(); toggleTheme() } }, themeIcons()),
    el("a", { class: "icon-btn menu-btn", href: "#", role: "button", "aria-label": "Menu", "aria-expanded": "false", onclick: (e: Event) => {
      e.preventDefault()
      if (top.classList.contains("menu-open")) return closeMenu(false)
      top.classList.remove("menu-closing")
      top.classList.add("menu-open")
      ;(e.currentTarget as HTMLElement).setAttribute("aria-expanded", "true")
      fadeMenu(top, true)
      // the menu's links come before this button, so Tab alone would pass them by
      menu.querySelector("a")!.focus()
    },
    // a link acting as a button answers Space as a button does
    onkeydown: (e: Event) => {
      const key = e as KeyboardEvent
      if (key.key !== " ") return
      e.preventDefault()
      if (!key.repeat) (e.currentTarget as HTMLElement).click()
    } },
      el("span", { class: "when-closed" }, icon("menu")), el("span", { class: "when-open" }, icon("x")))))
  return top
}

const MENU_MS = 180

// The phone menu's links and its "Check a code" come and go together, from wherever a fade the other way has got to; the
// toggle's icon turns as it changes. Closing, they stay drawn, as "menu-closing", until they have faded out.
function fadeMenu(top: HTMLElement, open: boolean): void {
  if (!moving()) return
  const parts = [top.querySelector<HTMLElement>("nav")!, top.querySelector<HTMLElement>(".ghost-btn")!]
  for (const part of parts) {
    // a closed menu's parts are not drawn, and read as whole; a fade under way says where it has got to
    const fading = part.getAnimations().length > 0
    const from = fading ? Number(getComputedStyle(part).opacity) : open ? 0 : 1
    part.getAnimations().forEach((a) => a.cancel())
    part.animate([{ opacity: from, translate: `0 ${(1 - from) * -6}px` }, { opacity: open ? 1 : 0, translate: open ? "0 0" : "0 -6px" }],
      { duration: MENU_MS, easing: EASE, fill: open ? "none" : "forwards" })
  }
  if (!open) {
    parts[0].getAnimations()[0].addEventListener("finish", () => {
      top.classList.remove("menu-closing")
      for (const part of parts) part.getAnimations().forEach((a) => a.cancel())
    })
  }
  turnIn(open ? ".menu-btn .when-open svg" : ".menu-btn .when-closed svg")
}

// a toggle's icon for its new state turns in
function turnIn(selector: string): void {
  if (moving()) document.querySelector(`.top ${selector}`)?.animate({ opacity: [0, 1], rotate: ["-90deg", "0deg"] }, { duration: MENU_MS, easing: EASE })
}

// The open phone menu closes on Escape or a click outside it, wherever focus has gone meanwhile.
function closeMenu(refocus: boolean): void {
  const top = document.querySelector<HTMLElement>(".top.menu-open")
  if (!top) return
  const toggle = top.querySelector<HTMLElement>(".menu-btn")!
  top.classList.remove("menu-open")
  toggle.setAttribute("aria-expanded", "false")
  if (refocus) toggle.focus()
  if (moving()) top.classList.add("menu-closing")
  fadeMenu(top, false)
}
// Escape in a popup closes the popup alone: the menu it was opened from stays, with its opener
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !document.querySelector(OVERLAY)) closeMenu(true) })
// a click in a popup opened from the menu is not outside it: the menu stays, with the popup's opener in it
document.addEventListener("click", (e) => {
  const top = document.querySelector(".top.menu-open")
  const target = e.target as Element
  if (top && !top.contains(target) && !target.closest(".modal-overlay")) closeMenu(false)
})

function footer(): HTMLElement {
  return el("footer", { class: "foot" }, el("div", { class: "wrap" },
    brand(),
    el("div", { class: "links" },
      el("a", { href: WEFUNDER_URL, target: "_blank", rel: "noopener" }, "Wefunder"),
      el("a", { href: "/#/trademarks" }, "Trademark owners"),
      el("a", { href: `mailto:${CONTACT_EMAIL}` }, "Contact")),
    el("span", { class: "grow" }),
    el("div", { class: "pays" }, "We accept", ...(["card", "btc", "xmr"] as const).map((m) => methodMark(m)))))
}

export const OFFLINE_NOTE = "You are offline. Pages show what this browser keeps; searches and payments need the connection."

// Shown while the browser has no network, fixed over the page's foot, so nothing under it moves.
function showConnection(): void {
  const shown = document.querySelector<HTMLElement>(".offline-note:not(.closing)")
  if (navigator.onLine) {
    if (!shown) return
    shown.classList.add("closing")
    return fadeOut(shown, () => shown.remove(), { alone: true })
  }
  if (shown) return
  const note = el("div", { class: "offline-note", role: "status" }, icon("offline"), el("span", {}, OFFLINE_NOTE))
  document.body.append(note)
  fadeIn(note)
}
// Checked again whenever the page is drawn or looked at, as Firefox does not always tell a page opened offline that
// the network is back.
for (const event of ["online", "offline", "focus"]) addEventListener(event, showConnection)
document.addEventListener("visibilitychange", showConnection)

// The header and footer are drawn once and stay; index.html draws the header's bar and logo before the script runs.
function frame(): { top: HTMLElement; main: HTMLElement | null } {
  const top = document.querySelector<HTMLElement>("body > header.top")
  const main = document.querySelector<HTMLElement>("body > main:not(.pending)")
  if (top?.dataset.drawn) return { top, main }
  const drawn = header()
  drawn.dataset.drawn = "1"
  if (top) top.replaceWith(drawn)
  else document.body.prepend(drawn)
  const foot = footer()
  document.body.append(foot)
  paintBars()
  // what the static bar did not have eases in
  for (const node of [...drawn.querySelectorAll(".wrap > :not(.brand)"), foot]) fadeIn(node)
  return { top: drawn, main }
}

export function page(active: Active, sections: Node[]): void {
  // a page still waiting for its transition takes its place first, as this one replaces it
  settle()
  const overlay = document.querySelector(OVERLAY)
  // a popup opened on this page stays over its redraw; one that led to another page closes
  const keep = overlay !== null && popupRoute === route
  if (overlay && !keep) closePopup(false)
  const samePage = isRedraw()
  if (samePage) focus.keep(document.activeElement)
  const { top, main: old } = frame()
  showConnection()
  // the highlight eases to the page's own link; the phone menu stays open over a redraw, as a popup does
  for (const link of top.querySelectorAll<HTMLElement>("nav a[data-nav]")) link.classList.toggle("on", link.dataset.nav === active)
  if (!samePage) closeMenu(false)
  const main = el("main", { class: "page" }, ...sections)
  // A page drawn over a placeholder comes in as a page opened does, and so does a page whose heading changed: another
  // stage of the page, such as an order moving on, where morphing every block at once would print one over another.
  const heading = (root: ParentNode) => root.querySelector("h1")?.textContent ?? ""
  const filled = old?.querySelector("[data-placeholder]") != null
  const opened = !samePage || !old || filled || heading(old) !== heading(main)
  const comparison = opened ? null : compare(main, old)
  // what a placeholder held the place of fades in over it; a page from nothing, as the first, comes the same way
  const change = comparison ? "redraw" : filled || !old?.childElementCount ? "fill" : wayTo(old, main, active)
  const scroll = toTop
  toTop = false
  popped = null
  drawnRoute = route
  drawnActive = active
  const swap = () => {
    swapPage(old, main)
    if (scroll) window.scrollTo(0, 0)
    if (samePage && focus.restore()) return
    // a popup that led to this page has no opener left to give focus back to
    if (overlay && !keep) focus.focusHeading()
  }
  // the new page is laid out at once, for the code drawing it to measure, and shown when it takes the old one's place
  main.classList.add("pending")
  ;(old ?? top).after(main)
  // a page drawn again exactly as it was swaps without a trace
  if (comparison && !comparison.differs) return swap()
  transition(change, swap, comparison)
}

// Escape closes the popup, and Tab cycles within it
function popupKeys(e: KeyboardEvent): void {
  if (e.key === "Escape") return closePopup()
  const modal = document.querySelector<HTMLElement>(`${OVERLAY} .modal`)
  if (e.key !== "Tab" || !modal) return
  const focusable = [...modal.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input")]
  if (focusable.length === 0) return
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  const inside = modal.contains(document.activeElement)
  if (e.shiftKey && (!inside || document.activeElement === first)) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && (!inside || document.activeElement === last)) {
    e.preventDefault()
    first.focus()
  }
}

// where focus returns when the popup closes: the control that opened it, or the one drawn in its place
let opener: ReturnType<typeof focus.markOf> | null = null

// a popup on its way out stays on screen for its fade, out of the way of the page and of the next popup
const OVERLAY = ".modal-overlay:not(.closing)"
const POPUP_IN_MS = 200
const POPUP_OUT_MS = 150

export function popup(content: HTMLElement): void {
  shut(true, false)
  popupRoute = route
  const active = document.activeElement
  opener = active instanceof HTMLElement && active !== document.body ? focus.markOf(active) : null
  const overlay = el("div", { class: "modal-overlay", onclick: (e: Event) => { if (e.target === overlay) closePopup() } }, content)
  // a popup opened while the last one fades out takes over from where that fade has got to
  const closing = document.querySelector<HTMLElement>(".modal-overlay.closing")
  const from = closing ? Number(getComputedStyle(closing).opacity) : 0
  closing?.remove()
  document.body.append(overlay)
  document.documentElement.classList.add("modal-open")
  if (moving()) {
    overlay.animate({ opacity: [from, 1] }, { duration: POPUP_IN_MS, easing: EASE })
    content.animate({ opacity: [from, 1], translate: ["0 10px", "0 0"], scale: [0.98, 1] }, { duration: POPUP_IN_MS, easing: EASE })
  }
  // focus moves into the dialog; a popup with a field focuses that field itself afterwards
  content.querySelector<HTMLElement>("a[href], button:not([disabled]), input")?.focus()
  document.addEventListener("keydown", popupKeys)
}

// refocus false: the caller draws a new page and puts focus on it itself
export function closePopup(refocus = true): void {
  shut(refocus, true)
}

function shut(refocus: boolean, fade: boolean): void {
  document.removeEventListener("keydown", popupKeys)
  const overlay = document.querySelector<HTMLElement>(OVERLAY)
  if (!overlay) return
  // a click on the backdrop has already moved focus to the page itself
  const hadFocus = overlay.contains(document.activeElement) || document.activeElement === document.body
  if (fade && moving()) {
    // inert lets go of focus and clicks at once, as removing it would
    overlay.classList.add("closing")
    overlay.inert = true
    overlay.querySelector(".modal")?.animate({ translate: ["0 0", "0 6px"], scale: [1, 0.98] }, { duration: POPUP_OUT_MS, easing: EASE, fill: "forwards" })
    fadeOut(overlay, () => overlay.remove(), { ms: POPUP_OUT_MS, alone: true })
  } else overlay.remove()
  document.documentElement.classList.remove("modal-open")
  // An opener the page redrew under the popup is found again in the redrawn page; failing that, the heading takes focus,
  // unless the redrawn page has already put focus somewhere of its own.
  const back = opener && (opener.node.isConnected || refocus) ? focus.found(opener) : null
  back?.focus()
  if (refocus && hadFocus && document.activeElement !== back) focus.focusHeading()
  opener = null
}

export function pageHead(title: Node | string | (Node | string)[], lead: Node | string | (Node | string)[] | null = null, crumbs: Node | null = null): HTMLElement {
  return el("section", { class: "page-head" }, el("div", { class: "wrap" },
    crumbs, el("h1", { class: "display" }, title), lead ? el("p", { class: "lead" }, lead) : null))
}

// opened from the app there is no owner code to save; a prepaid code leaves nothing to pay
// The steps an order goes through. Each step, and the line filled up to each reached, keeps its name across pages, so a
// move to the next step is drawn as the ring going over to it and the line to it filling, rather than another row.
export function crumbs(step: "Details" | "Name code" | "Payment" | "Registration", { fromApp = false, prepaid = false } = {}): HTMLElement {
  const names = ["Search", "Details", fromApp ? null : "Name code", prepaid ? null : "Payment", "Registration"].filter((n): n is string => n !== null)
  const at = names.indexOf(step)
  const named = <T extends HTMLElement>(node: T, name: string, kind: string) => Object.assign(node.style, { viewTransitionName: name, viewTransitionClass: kind }) && node
  const out: Node[] = []
  names.forEach((n, i) => {
    const slug = n.toLowerCase().replace(" ", "-")
    if (i) out.push(el("span", { class: "crumb-sep" }, i <= at ? named(el("i", { class: "crumb-line" }), `step-line-${slug}`, "line") : null))
    out.push(named(el("span", { class: "crumb" + (i < at ? " done" : i === at ? " on" : ""), "data-step": String(i) },
      el("i", {}, i < at ? "✓" : String(i + 1)), n, i === at ? el("span", { class: "crumb-ring", "aria-hidden": "true" }) : null), `step-${slug}`, "part"))
  })
  return el("div", { class: "crumbs" }, ...out)
}

// A page still being read shows where its heading and panels will be, shimmering, rather than a blank page.
export function placeholder(): Node[] {
  const panels = twoCols(el("div", { class: "panel skeleton tall" }), el("div", { class: "panel skeleton" }))
  panels.dataset.placeholder = ""
  return [
    el("section", { class: "page-head", "data-placeholder": "", "aria-busy": "true" }, el("div", { class: "wrap" },
      el("span", { class: "sr-only" }, "Loading…"), el("div", { class: "skeleton line" }), el("div", { class: "skeleton line short" }))),
    panels,
  ]
}

export function twoCols(main: Node, side: Node): HTMLElement {
  return el("div", { class: "wrap" }, el("div", { class: "cols" }, main, side))
}

// a single outcome, centred, as the badge store's endings are
export function status(tone: string, ic: Parameters<typeof icon>[0], title: string, text: Node | string | (Node | string)[], actions: Node[] = [], extra: { reference?: string; extra?: Node | Node[] } = {}): HTMLElement {
  return el("div", { class: "status-wrap" }, el("div", { class: "panel status" },
    el("div", { class: `orb ${tone}` }, icon(ic)),
    el("h1", { class: "display" }, title),
    el("p", {}, text),
    extra.extra ?? null,
    actions.length ? el("div", { class: "actions" }, ...actions) : null,
    extra.reference ? el("div", { class: "ref" }, el("span", {}, "Reference"), el("span", { class: "mono" }, extra.reference)) : null))
}
