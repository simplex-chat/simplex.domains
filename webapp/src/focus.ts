// Keyboard focus kept over a redraw of the same page: the focused control, or the one drawn in its place, gets it back
// with its caret, so typing and Tab carry on.

type Caret = [number | null, number | null]
type Mark = { node: HTMLElement; tag: string; name: string; row: string | null; index: number; caret: Caret | null }

// a row's controls are drawn after its own reads answer; focus waits this long on the heading for them
const APPEAR_MS = 3000
const TEXT_INPUTS = ["text", "search", "url", "tel", "password", "email"]

// a copy button reading "Copied" for a moment keeps its own label
const nameOf = (node: HTMLElement) => node.dataset.label?.trim() ?? node.getAttribute("aria-label") ?? node.textContent?.trim() ?? ""
const rowOf = (node: HTMLElement) => node.closest<HTMLElement>("[data-key]")?.dataset.key ?? null

// a control inside a part fading out, or a page not yet shown, is not the page's, though it is in the document
const fading = (node: Element) => node.closest(".pending, .outgoing") !== null

function alike(mark: Pick<Mark, "tag" | "name" | "row">): HTMLElement[] {
  const root = mark.row === null ? document : [...document.querySelectorAll(`[data-key="${CSS.escape(mark.row)}"]`)].find((n) => !fading(n))
  return root ? [...root.querySelectorAll<HTMLElement>(mark.tag)].filter((n) => nameOf(n) === mark.name && !fading(n)) : []
}

// a control is found again by its kind, its name, the row it is in and its place there among the controls named the same
export function markOf(node: HTMLElement): Mark {
  const mark = { node, tag: node.tagName, name: nameOf(node), row: rowOf(node) }
  const caret: Caret | null = node instanceof HTMLInputElement && TEXT_INPUTS.includes(node.type) ? [node.selectionStart, node.selectionEnd] : null
  return { ...mark, index: alike(mark).indexOf(node), caret }
}

export function found(mark: Mark): HTMLElement | null {
  if (mark.node.isConnected && !fading(mark.node)) return mark.node
  return alike(mark)[mark.index] ?? null
}

const headingOf = () => document.querySelector<HTMLElement>("main:not(.pending) h1")

function focusOn(heading: HTMLElement, preventScroll = false): void {
  heading.tabIndex = -1
  heading.focus({ preventScroll })
}

export function focusHeading(): void {
  const heading = headingOf()
  if (heading) focusOn(heading)
}

let kept: Mark | null = null
let watch: MutationObserver | null = null
let giveUp: ReturnType<typeof setTimeout> | undefined
// the heading focus waits on while the kept control is still to be drawn
let waitingOn: HTMLElement | null = null

const waiting = () => document.activeElement === null || document.activeElement === document.body || document.activeElement === waitingOn

// Noted before the redraw takes the control out of the page, or before a disabled button drops focus to the page.
export function keep(node: Element | null): void {
  // the heading focus waits on stands in for the control still noted
  if (node instanceof HTMLElement && node !== document.body && node !== waitingOn) kept = markOf(node)
}

function stopWatching(): void {
  watch?.disconnect()
  watch = null
  clearTimeout(giveUp)
  giveUp = undefined
  waitingOn = null
}

export function drop(): void {
  kept = null
  stopWatching()
}

// Once focus lands anywhere, or the person clicks, types or scrolls (a click in Safari focuses nothing), a noted
// control is past; giving it focus later would pull focus and the page's scroll away from them.
document.addEventListener("focusin", (e) => { if (e.target !== waitingOn) drop() })
document.addEventListener("pointerdown", drop, true)
document.addEventListener("keydown", drop, true)
document.addEventListener("wheel", drop, { capture: true, passive: true })

function focusKept(mark: Mark): boolean {
  const target = found(mark)
  if (!target) return false
  // a disabled or hidden control refuses focus; the page stays scrolled where its reader left it
  target.focus({ preventScroll: true })
  if (document.activeElement !== target) return false
  drop()
  if (mark.caret && target instanceof HTMLInputElement && TEXT_INPUTS.includes(target.type)) target.setSelectionRange(mark.caret[0], mark.caret[1])
  return true
}

// Focus waits on the heading, where reading and Tab start, for a while; a page still loading has no heading yet. The
// page stays scrolled where it is, as the control is likely drawn where it was.
function waitOnHeading(): void {
  const heading = headingOf()
  if (giveUp !== undefined || !heading) return
  waitingOn = heading
  focusOn(heading, true)
  giveUp = setTimeout(drop, APPEAR_MS)
}

// After the page is drawn the kept control takes focus. A control drawn a moment later (a row still reading, an order
// still loading) takes it from the heading when it appears. False when nothing was kept.
export function restore(): boolean {
  const mark = kept
  if (!mark) return false
  stopWatching()
  if (focusKept(mark)) return true
  // a removed row's controls are not handed to the row after it; the row in a page fading out is gone too
  if (mark.row !== null && ![...document.querySelectorAll(`[data-key="${CSS.escape(mark.row)}"]`)].some((n) => !fading(n))) {
    drop()
    focusHeading()
    return true
  }
  watch = new MutationObserver(() => {
    if (!waiting()) return drop()
    if (!focusKept(mark)) waitOnHeading()
  })
  watch.observe(document.body, { childList: true, subtree: true })
  waitOnHeading()
  return true
}
