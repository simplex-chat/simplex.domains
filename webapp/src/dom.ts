// Building blocks for the views, as the mockups (plans/names-codes/mockups/domains.js) draw them.
import { ApiError, LIMITED_WAIT_S } from "./api.ts"
import { keep } from "./focus.ts"
import { EASE, live, moving } from "./motion.ts"
import { seconds } from "./format.ts"
import { icon, type IconName } from "./icons.ts"

type Kid = Node | string | null | undefined | false | Kid[]
type Attrs = Record<string, string | boolean | ((e: Event) => void) | undefined>

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue
    if (typeof v === "function") node.addEventListener(k.replace(/^on/, ""), v)
    else node.setAttribute(k, v === true ? "" : v)
  }
  append(node, kids)
  return node
}

function append(node: Node, kids: Kid[]): void {
  for (const kid of kids) {
    if (kid === null || kid === undefined || kid === false) continue
    if (Array.isArray(kid)) append(node, kid)
    else node.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid)
  }
}

// A wait the service asked for, counted down in node; done runs when it is over. It stops once node leaves the page.
// A screen reader hears the wait once rather than every second: the countdown is hidden from it, a still copy is not.
export function waitOut(node: HTMLElement, waitSeconds: number, text: (left: string) => string, done: () => void): void {
  node.setAttribute("aria-hidden", "true")
  node.before(el("span", { class: "sr-only" }, text(seconds(waitSeconds))))
  const until = Date.now() + waitSeconds * 1000
  // a count started before its notice goes into the page writes its first line at once, so the notice comes in whole;
  // one taken out of the page stops
  let shown = false
  const tick = () => {
    if (node.isConnected) shown = true
    else if (shown) return clearInterval(timer)
    const left = Math.ceil((until - Date.now()) / 1000)
    if (left > 0) return void (node.textContent = text(seconds(left)))
    clearInterval(timer)
    // a wait already over ends after the caller has put its notice in, so the end clears it
    queueMicrotask(done)
  }
  const timer = setInterval(tick, 1000)
  tick()
}

// A rate limit's wait outlives the page that met it: a redraw, or Back to an earlier step, draws its action again.
let heldUntil = 0
export const holding = () => Date.now() < heldUntil
// a shorter wait met meanwhile does not cut a longer one
export const startHold = (waitSeconds: number) => { heldUntil = Math.max(heldUntil, Date.now() + waitSeconds * 1000) }

// An action's button is turned on again after it failed; focus a disabled button dropped to the page comes back to it.
export function release(button: HTMLButtonElement): void {
  button.removeAttribute("disabled")
  if (button.isConnected && document.activeElement === document.body) button.focus()
}
export const holdLeft = () => Math.max(0, Math.ceil((heldUntil - Date.now()) / 1000))

// The action's button stays off for the wait, counted down in its note. Focus left on the page itself, as a disabled
// button leaves it, comes back to the button when the wait is over.
// release lets the button go; an action with conditions of its own (a ticked box) checks them there.
function countHold(button: HTMLButtonElement | null, note: HTMLElement, wait: number, text: (left: string) => string, letGo?: () => void): void {
  if (button) disabled(button)
  const line = el("span", {})
  const notice = el("div", { class: "left mt-14" }, alertBox("warn", "clock", "Too many attempts", line))
  waitOut(line, wait, text, () => {
    note.replaceChildren()
    if (!button) return
    if (letGo) letGo()
    else button.removeAttribute("disabled")
    if (button.isConnected && !button.disabled && document.activeElement === document.body) button.focus()
  })
  note.replaceChildren(notice)
}

// A rate limit holds the action's button for the wait it names; true when it did.
export function holdFor(e: unknown, button: HTMLButtonElement | null, note: HTMLElement, text: (left: string) => string, release?: () => void): boolean {
  if (!(e instanceof ApiError) || e.code !== "rate_limited") return false
  const wait = e.retryAfter ?? LIMITED_WAIT_S
  startHold(wait)
  countHold(button, note, holdLeft(), text, release)
  return true
}

// An action drawn during a wait starts held, with the countdown in its note once the page is drawn.
export function respectHold<T extends HTMLButtonElement | null>(button: T, note: HTMLElement, release?: () => void): T {
  if (!holding()) return button
  if (button) disabled(button)
  const letGo = () => { if (button) (release ?? (() => button.removeAttribute("disabled")))() }
  setTimeout(() => {
    const wait = Math.ceil((heldUntil - Date.now()) / 1000)
    if (wait <= 0) return letGo()
    if (note.isConnected) return countHold(button, note, wait, (left) => `Try again in ${left}.`, release)
    setTimeout(letGo, wait * 1000)
  })
  return button
}

export function btn(text: Kid, cls = "", onclick?: () => void, ...extra: Kid[]): HTMLButtonElement {
  return el("button", { class: `btn ${cls}`.trim(), type: "button", onclick }, text, ...extra)
}

export function link(text: Kid, onclick: () => void): HTMLAnchorElement {
  return el("a", { href: "#", onclick: (e: Event) => { e.preventDefault(); onclick() } }, text)
}

export function navLink(text: Kid, href: string, cls = ""): HTMLAnchorElement {
  return el("a", { href, class: cls || undefined }, text)
}

export function chip(text: string, cls = "", dot = false): HTMLSpanElement {
  return el("span", { class: `chip ${cls}`.trim() }, dot ? el("span", { class: "dot" }) : null, text)
}

export function alertBox(tone: string, ic: IconName, title: string | null, text: Kid): HTMLDivElement {
  return el("div", { class: `alert ${tone}` }, icon(ic), el("div", {}, title ? el("b", {}, title) : null, text))
}

// punctuation after the name is kept on its line
export function nameText(label: string, tld: string, after = ""): HTMLSpanElement {
  return el("span", { class: "inline-name" }, label, el("wbr"), `.${tld}${after}`)
}

// a long name breaks before its top-level domain first
export function nameTitle(label: string, cls = "name", tld = "simplex"): HTMLDivElement {
  return el("div", { class: cls }, label, el("wbr"), el("span", {}, `.${tld}`))
}

// a long name breaks before its top-level domain rather than inside a word
export function gradName(label: string, tld = "simplex"): HTMLSpanElement {
  return el("span", { class: "grad" }, label, el("wbr"), `.${tld}`)
}

// where a page writes the answer to an action, announced by screen readers when it changes
export function liveRegion(cls?: string): HTMLDivElement {
  return live(el("div", { class: cls, role: "status", "aria-live": "polite" }))
}

export function disabled<T extends HTMLElement>(node: T, off = true): T {
  // a button turned off drops focus to the page; a redraw of the page gives it back to the button or its successor
  if (off && node === document.activeElement) keep(node)
  if (off) node.setAttribute("disabled", "")
  return node
}

const COPIED_MS = 1500
const COPIED_EASE_MS = 160
const copiedTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>()

export async function copyText(text: string, button: HTMLElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    // the label is taken once, so a second click while it reads "Copied" does not keep that for good
    button.dataset.label ??= button.textContent ?? ""
    const label = button.dataset.label
    const before = button.offsetWidth
    // the new label fades in from nothing rather than swapping at once
    const relabel = (text: string) => {
      button.childNodes.forEach((n) => { if (n.nodeType === Node.TEXT_NODE) n.textContent = text })
      if (moving()) button.animate({ color: ["transparent", getComputedStyle(button).color] }, { duration: COPIED_EASE_MS, easing: EASE })
    }
    relabel("Copied")
    // the button keeps the wider of its two widths, easing into it once, so its icon does not jump back and forth
    const after = button.offsetWidth
    button.style.minWidth = `${Math.max(before, after)}px`
    if (after > before && moving()) button.animate({ width: [`${before}px`, `${after}px`] }, { duration: COPIED_EASE_MS, easing: EASE })
    clearTimeout(copiedTimers.get(button))
    // a button gone with its page meanwhile is left alone
    copiedTimers.set(button, setTimeout(() => { if (button.isConnected) relabel(label) }, COPIED_MS))
  } catch {
    // the clipboard can be refused; the text stays on screen to copy by hand
  }
}

export { icon }
