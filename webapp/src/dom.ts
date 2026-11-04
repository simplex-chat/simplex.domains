// Building blocks for the views, as the mockups (plans/names-codes/mockups/domains.js) draw them.
import { seconds } from "./format.ts"
import { icon, type IconName } from "./icons.ts"
import { qrSvg } from "./qr.ts"

export type Kid = Node | string | null | undefined | false | Kid[]
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

// A field for a name, a code or a link: no browser autofill, correction or capitals, and no password manager's offer to fill it
export const NO_AUTOFILL = {
  autocomplete: "off", autocorrect: "off", autocapitalize: "none", spellcheck: "false",
  "data-1p-ignore": true, "data-lpignore": "true", "data-bwignore": true, "data-form-type": "other",
} as const

export function refill<T extends Element>(node: T, ...kids: Kid[]): T {
  node.replaceChildren()
  append(node, kids)
  return node
}

export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches

function append(node: Node, kids: Kid[]): void {
  for (const kid of kids) {
    if (kid === null || kid === undefined || kid === false) continue
    if (Array.isArray(kid)) append(node, kid)
    else node.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid)
  }
}

const COUNT_MARK = "\u0000"

// Counts a wait down in node until signal ends it, then runs done; a screen reader hears a still copy once rather than every second.
export function waitOut(node: HTMLElement, waitSeconds: number, text: (left: string) => string, done: () => void, signal: AbortSignal): void {
  node.setAttribute("aria-hidden", "true")
  node.before(el("span", { class: "sr-only" }, text(seconds(waitSeconds))))
  const [before, after] = text(COUNT_MARK).split(COUNT_MARK)
  const count = el("span", {})
  const unit = document.createTextNode("")
  node.replaceChildren(before, count, unit, after)
  const until = Date.now() + waitSeconds * 1000
  // a count started before its notice goes into the page writes its first line at once, so the notice comes in whole
  const tick = () => {
    const left = Math.ceil((until - Date.now()) / 1000)
    if (left > 0) {
      count.textContent = String(left)
      unit.textContent = seconds(left).slice(String(left).length)
      return
    }
    clearInterval(timer)
    // a wait already over ends after the caller has put its notice in, so the end clears it
    queueMicrotask(done)
  }
  if (signal.aborted) return
  const timer = setInterval(tick, 1000)
  signal.addEventListener("abort", () => clearInterval(timer), { once: true })
  tick()
}

export function btn(text: Kid, cls = "", onclick?: () => void, ...extra: Kid[]): HTMLButtonElement {
  return el("button", { class: `btn ${cls}`.trim(), type: "button", onclick }, text, ...extra)
}

export function link(text: Kid, onclick: () => void): HTMLAnchorElement {
  return el("a", { href: "#", role: "button", onclick: (e: Event) => { e.preventDefault(); onclick() } }, text)
}

export function chip(text: string, cls = "", dot = false): HTMLSpanElement {
  return el("span", { class: `chip ${cls}`.trim() }, dot ? el("span", { class: "dot" }) : null, text)
}

export type Tone = "ok" | "warn" | "danger" | "info"

// a line of its own, lighter than a notice: its icon, then its words
export const line = (tone: string, ic: IconName, ...text: Kid[]) => el("p", { class: `line ${tone}` }, icon(ic), el("span", {}, ...text))

export function alertBox(tone: Tone, ic: IconName, title: string | null, text: Kid): HTMLDivElement {
  return el("div", { class: `notice ${tone}` }, icon(ic), el("div", {}, title ? el("b", {}, title) : null, text))
}

// A name's last letters and its TLD stay on one line, so ".simplex" never starts a line alone; the rest of a name too
// long for its line breaks between any two letters.
const TAIL = 3
const nameHead = (label: string) => label.slice(0, -TAIL)
const nameTail = (label: string) => label.slice(-TAIL)

// `after` is the punctuation that follows the name, kept on its line
export function nameText(label: string, tld: string, after = ""): HTMLSpanElement {
  return el("span", { class: "nt" }, nameHead(label), el("span", { class: "nowrap" }, `${nameTail(label)}.${tld}${after}`))
}

// `after` is a label that belongs to the name, kept with its last letters, so it never starts a line alone
export function nameTitle(label: string, cls = "name", tld = "simplex", ...after: Kid[]): HTMLDivElement {
  return el("div", { class: cls }, nameHead(label), el("span", { class: "nowrap" }, nameTail(label), el("span", { class: "tld" }, `.${tld}`), ...after))
}

export function gradName(label: string, tld = "simplex"): HTMLSpanElement {
  return el("span", { class: "grad nt" }, nameHead(label), el("span", { class: "nowrap" }, `${nameTail(label)}.${tld}`))
}

// what a name's letters take on one line, which the parts of a name broken over lines still add up to
function lettersWidth(name: Element): number {
  const range = document.createRange()
  const walker = document.createTreeWalker(name, NodeFilter.SHOW_TEXT, { acceptNode: (text) => text.parentElement?.closest("button") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT })
  let width = 0
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    range.selectNodeContents(text)
    for (const part of range.getClientRects()) width += part.width
  }
  for (const label of name.querySelectorAll("button")) width += label.getBoundingClientRect().width + parseFloat(getComputedStyle(label).marginLeft)
  return width
}

const WHOLE = "whole"

// Marks each name in a row or a heading that fits its line whole; a heading's at the heading's own size, which styles.css
// draws smaller for a name that does not.
export function fitNames(root: Element): void {
  for (const name of root.querySelectorAll(".row > .name, h1 .nt")) {
    const line = name.closest(".row, h1")!
    const style = getComputedStyle(line)
    const room = line.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
    const scale = line.tagName === "H1" ? parseFloat(getComputedStyle(line.closest(".screen")!).getPropertyValue("--fs-h1")) / parseFloat(getComputedStyle(name).fontSize) : 1
    name.classList.toggle(WHOLE, lettersWidth(name) * scale <= room)
  }
}

export function liveRegion(cls?: string): HTMLDivElement {
  return el("div", { class: cls, role: "status", "aria-live": "polite" })
}

export function disabled<T extends HTMLElement>(node: T): T {
  node.setAttribute("disabled", "")
  return node
}

export function setAction(button: HTMLButtonElement, busy: boolean, held: boolean): HTMLButtonElement {
  button.disabled = busy || held
  if (busy) button.setAttribute("aria-busy", "true")
  else button.removeAttribute("aria-busy")
  return button
}

const COPIED_MS = 1500
const COPIED_FADE_MS = 200
const copiedTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>[]>()
// Firefox ends no line at a hyphen before a digit, so a break opportunity follows each hyphen past the first; no line starts with one.
function codeText(code: string): Kid[] {
  const groups = code.split("-")
  return groups.flatMap((group, i) => {
    const text = i < groups.length - 1 ? `${group}-` : group
    return i > 1 ? [el("wbr"), text] : [text]
  })
}

const MASK = "\u2022"
// the code's prefix, its groups drawn as dots, so it can be copied without being seen
const masked = (code: string) => code.split("-").map((group, i) => i ? MASK.repeat(group.length) : group).join("-")

// A name code is shown only on Show, as anyone who sees it can take the name; Copy copies it either way. `onShown` hears
// each Show and Hide.
export function codeDisplay(code: string, testId?: string, hidden = false, onShown?: (shown: boolean) => void): HTMLElement {
  const text = el("span", { class: "code-text", "data-testid": testId }, ...(hidden ? [masked(code)] : codeText(code)))
  const buttons = el("span", { class: "code-buttons" }, copyButton(code, "field-copy", "Copy code"))
  if (hidden) {
    const show = el("button", { class: "field-copy", type: "button", onclick: () => {
      const shown = text.classList.contains("masked")
      refill(text, ...(shown ? codeText(code) : [masked(code)]))
      text.classList.toggle("masked", !shown)
      show.textContent = shown ? "Hide" : "Show"
      onShown?.(shown)
    } }, "Show")
    text.classList.add("masked")
    buttons.prepend(show)
  }
  return el("div", { class: "code-display" }, text, buttons)
}

// a name code's QR code, holding the code as it is typed, for another device to scan into its code field
export const nameCodeQr = (code: string) => el("div", { class: "qr" }, qrSvg(code, "QR code of the name code"))

// one visually hidden status region outside main, for what a screen reader would not hear otherwise
let announcer: HTMLElement | null = null
export function announce(text: string): void {
  announcer ??= document.body.appendChild(el("div", { class: "sr-only", role: "status" }))
  announcer.textContent = ""
  // the text is set after the region is emptied, so the same words said again are read again
  requestAnimationFrame(() => { if (announcer) announcer.textContent = text })
}

let lastCopied: { button: HTMLElement; note: HTMLElement } | null = null
function uncopy(button: HTMLElement, note: HTMLElement): void {
  copiedTimers.get(button)?.forEach(clearTimeout)
  button.classList.remove("copied")
  copiedTimers.set(button, [setTimeout(() => { note.textContent = ""; if (lastCopied?.button === button) lastCopied = null }, COPIED_FADE_MS)])
}

const COPY = "Copy"
export function copyButton(value: string, cls: string, name = COPY, text = COPY): HTMLButtonElement {
  const note = el("span", { class: "copied-note", "aria-hidden": "true" })
  const button = el("button", { class: `copy-btn ${cls}`.trim(), type: "button", "aria-label": name }, text, note)
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(value)
    } catch {
      return
    }
    if (lastCopied && lastCopied.button !== button) uncopy(lastCopied.button, lastCopied.note)
    lastCopied = { button, note }
    copiedTimers.get(button)?.forEach(clearTimeout)
    note.textContent = "Copied!"
    button.classList.add("copied")
    announce("Copied")
    copiedTimers.set(button, [setTimeout(() => uncopy(button, note), COPIED_MS)])
  })
  return button
}

export { icon }
