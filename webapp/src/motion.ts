// Motion: what changes on the page eases in rather than cutting in. Parts of a page that change in place fade their new
// content in and ease to their new height; a page opened or drawn again is the browser's view transition. Nothing moves
// for a reader who asked for reduced motion.

export const EASE = "cubic-bezier(.2, .7, .2, 1)"
// what fades out holds on and goes late, as what fades in comes early, so between them the page never thins
const EASE_OUT = "cubic-bezier(.5, 0, .75, .55)"
const ENTER_MS = 220
const RESIZE_MS = 240
const LEAVE_MS = 180
// a little over half a fade out that goes early, by when the node has mostly gone
const SLIDE_DELAY_MS = 100
// the individual translate property, so a node's own transform is left as it is
const RISE = "0 6px"

const reduced = matchMedia("(prefers-reduced-motion: reduce)")
export const moving = () => !reduced.matches

export function fadeIn(node: Element): void {
  if (moving()) node.animate({ opacity: [0, 1], translate: [RISE, "0 0"] }, { duration: ENTER_MS, easing: EASE })
}

// Nodes put into a live part once never fade in again, so a part moved into a redrawn page keeps still.
const shown = new WeakSet<Node>()
export function still<T extends Node>(node: T): T {
  shown.add(node)
  return node
}

new MutationObserver((records) => {
  for (const record of records) {
    for (const node of record.addedNodes) {
      if (!(node instanceof Element)) continue
      // a live part is watched for its height while it is in the page: observed again when a redraw moves it back in
      if (node.classList.contains("live")) sizes.observe(node)
      for (const part of node.querySelectorAll(".live")) sizes.observe(part)
      if (!(record.target instanceof HTMLElement) || !record.target.classList.contains("live") || shown.has(node)) continue
      shown.add(node)
      fadeIn(node)
    }
  }
}).observe(document.body, { childList: true, subtree: true })

// A live part's height follows its content over a moment; while it eases, its own resizes are the easing's.
const heights = new WeakMap<Element, number>()
// a Map, not a WeakMap, so a part can ask whether one inside it is easing; release() takes each out
const easing = new Map<HTMLElement, Animation>()
const sizes = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const node = entry.target as HTMLElement
    // A part taken out of the page keeps the height it had, for a redraw that puts it back; it is no longer watched, so
    // the observer does not hold parts that are gone for good.
    if (!node.isConnected) {
      sizes.unobserve(node)
      continue
    }
    if (easing.has(node)) continue
    const height = entry.borderBoxSize[0].blockSize
    const before = heights.get(node)
    heights.set(node, height)
    if (!moving()) continue
    // a part laid out for the first time inside one that eases, as a part filled while its page fades in, is taken in
    if (before === undefined) carryOuter(node)
    // a part easing inside this one moves it already, frame by frame
    const inner = [...easing.keys()].some((other) => other !== node && node.contains(other))
    if (before !== undefined && !inner) easeHeight(node, before, height)
  }
})

// The old height is held inline at once, so no frame shows the new height before the easing starts.
// The easing holds its end height until the node is let go: without the fill, the frame between its end and the release
// would show the held start height again.
function easeHeight(node: HTMLElement, from: number, to: number): void {
  heights.set(node, to)
  if (Math.abs(to - from) < 1) return
  // read before this one is held at its old height
  carryOuter(node)
  node.style.height = `${from}px`
  // clipped across only, so content fading out beside the part, where it was, still shows
  node.style.overflowY = "clip"
  const ease = node.animate({ height: [`${from}px`, `${to}px`] }, { duration: RESIZE_MS, easing: EASE, fill: "forwards" })
  easing.set(node, ease)
  // finish and cancel arrive as events, after a newer easing may have taken over the node
  ease.addEventListener("finish", () => {
    if (easing.get(node) !== ease) return
    release(node)
    ease.cancel()
    // content that grew inside the held height, as a part easing within it, is eased on to rather than jumped to; a
    // part no longer in the page keeps the height it had
    const now = node.getBoundingClientRect().height
    if (moving() && node.isConnected && Math.abs(now - to) >= 1) easeHeight(node, to, now)
  })
  ease.addEventListener("cancel", () => { if (easing.get(node) === ease) release(node) })
}

// A part easing around this one is held at its own height, so it eases on to take this one's new height in.
function carryOuter(node: HTMLElement): void {
  for (const outer of [...easing.keys()]) if (outer !== node && outer.contains(node)) settleHeight(outer, outer.getBoundingClientRect().height)
}

function release(node: HTMLElement): void {
  node.style.removeProperty("height")
  node.style.removeProperty("overflow-y")
  easing.delete(node)
}

// The faded node stays invisible until it is gone: without the fill, the frame between the end and the removal shows it
// whole again.
// A fade starts from where the node's opacity is, as one interrupted while it fades in is not yet whole. What fades with
// nothing fading in for it, as a closing popup, goes early, so it has thinned out even when frames come slowly.
interface Fade { ms?: number; from?: number; alone?: boolean }
export function fadeOut(node: Element, done: () => void, { ms = LEAVE_MS, from = node.isConnected ? Number(getComputedStyle(node).opacity) : 1, alone = false }: Fade = {}): void {
  const fade = node.animate({ opacity: [from, 0] }, { duration: ms, easing: alone ? EASE : EASE_OUT, fill: "forwards" })
  fade.addEventListener("finish", () => {
    done()
    fade.cancel()
  })
}

// What a live part replaces fades out where it was, over the new content fading in, rather than vanishing. It is out of
// the page for people and for assistive technology at once; parts kept in the new content stay as they are.
function crossFade(part: HTMLElement, given: (Node | string)[]): void {
  const outgoing = [...part.children].filter((n) => n.classList.contains("outgoing"))
  // text comes in a span of its own, as only an element can fade in
  const next = given.map(textSpan)
  if (!moving() || !part.isConnected) return Element.prototype.replaceChildren.call(part, ...next, ...outgoing)
  const going = [...part.childNodes].filter((n) => !outgoing.includes(n as Element) && !next.includes(n))
  const seen = going.some((n) => n instanceof HTMLElement || n.textContent?.trim())
  const from = paintedHeight(part)
  // what stays is put back by the replacement, which is not what arriving is
  for (const node of next) if (typeof node !== "string" && node.parentNode === part) still(node)
  const slideRow = slideRowOf(part)
  if (!seen) {
    Element.prototype.replaceChildren.call(part, ...next, ...outgoing)
    slideRow()
    if (from !== null) settleHeight(part, from)
    return
  }
  // the old content keeps its own width as it fades, so it does not wrap again inside a narrower part
  const was = part.getBoundingClientRect()
  const layer = still(document.createElement("div"))
  layer.className = "outgoing"
  Object.assign(layer.style, { width: `${was.width}px`, right: "auto" })
  layer.inert = true
  layer.setAttribute("aria-hidden", "true")
  // focus on what goes moves to what replaces it, as an inert layer would drop it to the page
  const focused = going.some((n) => n.contains(document.activeElement))
  layer.append(...going)
  Element.prototype.replaceChildren.call(part, ...next, ...outgoing, layer)
  shiftBack(layer, was, part.getBoundingClientRect())
  slideRow()
  if (focused) focusIn(part)
  // Text goes early, so old and new words barely print over each other; a card holds on and goes late, so between it
  // and the card replacing it the part never thins.
  fadeOut(layer, () => layer.remove(), { alone: !layer.querySelector(CARDS) })
  if (from !== null) settleHeight(part, from)
}

const CARDS = ".skeleton, .entity, .panel, .alert, .result, .verdict"

// A node taken out of a live part fades where it stands while what follows it slides into its place.
export function removeFrom(part: HTMLElement, node: Node): void {
  if (node.parentNode !== part) return
  if (!moving() || !(node instanceof HTMLElement) || !part.isConnected) {
    part.removeChild(node)
    return
  }
  const wasHeight = paintedHeight(part)
  const slide = [slideOthers(part, node, { out: true }), slideRowOf(part, true)]
  const at = node.getBoundingClientRect()
  const focused = node.contains(document.activeElement)
  node.classList.add("outgoing")
  node.inert = true
  node.setAttribute("aria-hidden", "true")
  Object.assign(node.style, { width: `${at.width}px`, right: "auto", margin: "0" })
  shiftBack(node, at, node.getBoundingClientRect())
  fadeOut(node, () => node.remove(), { alone: true })
  slide.forEach((f) => f())
  if (focused) focusIn(part)
  if (wasHeight !== null) settleHeight(part, wasHeight)
}

// A node put into a live part fades in, as anything new in one does, while what follows it slides aside for it.
export function addTo(part: HTMLElement, node: HTMLElement, before: Node | null): void {
  const slide = [slideOthers(part, node), slideRowOf(part)]
  part.insertBefore(node, before)
  slide.forEach((f) => f())
}

// The part's other children, read where they are now; the function returned slides each from there to where it is
// after the change, while what fades out inside each stays where it was, and what fades out in the part itself too.
// Making way for a node that fades out, they wait until it has mostly gone, so none slides over it.
function slideOthers(part: HTMLElement, changed: Node, { out = false, across = false } = {}): () => void {
  if (!moving()) return () => undefined
  const children = [...part.children].filter((n): n is HTMLElement => n !== changed && n instanceof HTMLElement)
  const fading = children.filter((n) => n.classList.contains("outgoing"))
  const others = children.filter((n) => !fading.includes(n))
  const [fadingAt, before] = [fading, others].map((nodes) => nodes.map((n) => n.getBoundingClientRect()))
  return () => {
    fading.forEach((n, i) => shiftBack(n, fadingAt[i], n.getBoundingClientRect()))
    others.forEach((n, i) => {
      const now = n.getBoundingClientRect()
      const dx = before[i].left - now.left
      const dy = across ? 0 : before[i].top - now.top
      if (!dx && !dy) return
      const timing = { duration: RESIZE_MS, delay: out ? SLIDE_DELAY_MS : 0, easing: EASE }
      n.animate({ translate: [`${dx}px ${dy}px`, "0 0"] }, { ...timing, fill: "backwards" })
      for (const layer of n.querySelectorAll<HTMLElement>(":scope > .outgoing")) layer.animate({ translate: ["0 0", `${dx}px ${dy}px`] }, { ...timing, fill: "both" })
    })
  }
}

// A part sized to its content in a row moves the row's other boxes when it changes width, and a box around it sized the
// same way moves its own row in turn; each row whose box changed width slides its boxes across, as what moves them down
// is a height, which eases on its own.
function slideRowOf(part: HTMLElement, out = false): () => void {
  if (!moving()) return () => undefined
  const rows: { box: HTMLElement; width: number; slide: () => void }[] = []
  for (let box = part; box.parentElement && !box.matches("main"); box = box.parentElement) {
    rows.push({ box, width: box.getBoundingClientRect().width, slide: slideOthers(box.parentElement, box, { out, across: true }) })
  }
  return () => {
    for (const { box, width, slide } of rows) {
      if (Math.abs(box.getBoundingClientRect().width - width) < 1) break
      slide()
    }
  }
}

// An outgoing layer goes back to where its content was on screen: a part sized to its content in a row moves when what
// it holds changes.
function shiftBack(layer: HTMLElement, was: DOMRect, now: DOMRect): void {
  layer.style.left = `${(parseFloat(layer.style.left) || 0) + was.left - now.left}px`
  layer.style.top = `${(parseFloat(layer.style.top) || 0) + was.top - now.top}px`
}

// focus that was on what goes moves to the part's next control, though never onto one that destroys something
const CONTROLS = ":is(a[href], button:not([disabled]), input):not([data-destructive], .danger)"
function focusIn(part: HTMLElement): void {
  ;[...part.querySelectorAll<HTMLElement>(CONTROLS)].find((n) => !n.closest(".outgoing"))?.focus()
}

// text put into a live part, as an element of its own
export const textSpan = (n: Node | string) => typeof n === "string" && n ? Object.assign(document.createElement("span"), { textContent: n }) : n

// what a live part shows now, leaving out what is fading out of it
export function current<T extends Element>(part: ParentNode, selector: string): T | null {
  return [...part.querySelectorAll<T>(selector)].find((n) => !n.closest(".outgoing")) ?? null
}

// The height a part shows now, to ease a change from: mid-easing, where the easing has got to; otherwise the height last
// painted, as layout read now already holds changes made earlier in this task, such as a neighbour narrowing. A part not
// yet laid out, as one filled while its page is drawn, has no height to ease from.
function paintedHeight(part: HTMLElement): number | null {
  if (easing.has(part)) return part.getBoundingClientRect().height
  return heights.get(part) ?? null
}

function settleHeight(part: HTMLElement, from: number): void {
  const running = easing.get(part)
  if (running) {
    release(part)
    running.cancel()
  }
  easeHeight(part, from, part.getBoundingClientRect().height)
}

// a part of the page whose content changes in place
export function live<T extends HTMLElement>(node: T): T {
  node.classList.add("live")
  node.replaceChildren = (...next: (Node | string)[]) => crossFade(node, next)
  sizes.observe(node)
  return node
}


// A node a redraw keeps as it is, as a field being typed in, stays in the old page until the browser has its picture of
// it; the new page holds a stand-in for it until then.
const STAND_IN = "[data-stand-in]"
const carried = new WeakMap<Element, HTMLElement>()
export function carry(node: HTMLElement): HTMLElement {
  if (!node.isConnected) return node
  const standIn = document.createElement(node.tagName)
  standIn.dataset.standIn = ""
  carried.set(standIn, node)
  return standIn
}
const real = (el: Element) => carried.get(el) ?? el

function placeCarried(root: Element): void {
  for (const standIn of root.querySelectorAll(STAND_IN)) standIn.replaceWith(real(standIn))
}

// Elements among their siblings by what they are: a keyed row by its key; anything else by its kind, its tag and first
// class, and its place among its kind. State classes that come after it, as a stage's "active" turning "done", leave
// it the same element, and so does a part made live.
function slotsOf(siblings: Element[]): Map<string, Element> {
  const count = new Map<string, number>()
  const slots = new Map<string, Element>()
  for (const el of siblings) {
    const key = (real(el) as HTMLElement).dataset?.key
    if (key) {
      slots.set(`key ${key}`, el)
      continue
    }
    const kind = `${el.tagName}.${[...real(el).classList].find((c) => c !== "live") ?? ""}`
    const n = count.get(kind) ?? 0
    count.set(kind, n + 1)
    slots.set(`${n}#${kind}`, el)
  }
  return slots
}

// Where view transitions run and motion is wanted, the browser draws each change of the page: it takes a picture of
// the page before and after, and moves between them.
const VIEW_TRANSITIONS = "startViewTransition" in document
export const transitions = () => moving() && VIEW_TRANSITIONS

// a page of many rows names its first parts only, as each name costs the browser a layer
const MOST_MORPHED = 60

// styles.css draws each kind of change: another page slides forward or back, a page filling a placeholder fades in over
// it, a page drawn again morphs, a theme cross-fades
export type Change = "forward" | "back" | "fill" | "redraw" | "theme"

// Names given for the transition running, taken off once it ends or a newer one starts, giving back a name a part has
// of its own, as an order's step has.
interface Named { node: HTMLElement; name: string; kind: string }
let named: Named[] = []
let running: ViewTransition | null = null
// the change of the transition still waiting for the browser's picture of the old page
let waiting: (() => void) | null = null

function name(el: Element, id: string, kind: string): void {
  const node = real(el) as HTMLElement
  named.push({ node, name: node.style.viewTransitionName, kind: node.style.viewTransitionClass })
  Object.assign(node.style, { viewTransitionName: id, viewTransitionClass: kind })
}

function unname(): void {
  // the last first, so a part named twice gets back the name it had before either
  for (const { node, name, kind } of named.reverse()) Object.assign(node.style, { viewTransitionName: name, viewTransitionClass: kind })
  named = []
}

// A change still waiting for its transition is made now, so what comes next starts from the page as it will be.
export function settle(): void {
  waiting?.()
}

// The change is made once the browser has its picture of the page as it is. For a page drawn again, each part it kept,
// and each part that changed, takes the name of its match in the old page, so the browser moves and sizes it
// from the old box to the new and cross-fades what it shows in one place; a part only the old page had fades out on its
// own, and one only the new page has fades in on its own. Names go on the old parts before the picture, and on the new
// ones once they are in the page, as two parts of one name in the page at once would stop the transition.
export function transition(change: Change, update: () => void, comparison: Comparison | null = null): void {
  settle()
  if (!transitions()) return update()
  unname()
  const pairs = comparison ? pairsOf(comparison.matches).slice(0, MOST_MORPHED) : []
  const gone = comparison ? comparison.gone.slice(0, MOST_MORPHED) : []
  const fresh = comparison ? freshOf(comparison.matches).slice(0, MOST_MORPHED) : []
  pairs.forEach(([old], i) => name(old, `part-${i}`, "part"))
  gone.forEach((old, i) => name(old, `gone-${i}`, "gone"))
  const run = () => {
    if (waiting !== run) return
    waiting = null
    update()
    pairs.forEach(([, el], i) => name(el, `part-${i}`, "part"))
    fresh.forEach((el, i) => name(el, `fresh-${i}`, "fresh"))
  }
  waiting = run
  const started = document.startViewTransition({ update: run, types: [change] })
  running = started
  // a transition cut short by a newer one rejects ready; the change itself is made either way
  started.ready.catch(() => undefined)
  void started.finished.catch(() => undefined).finally(() => {
    if (running !== started) return
    running = null
    unname()
  })
}

// The page's change: the new page takes the old one's place, the nodes it keeps moving into it.
export function swapPage(old: HTMLElement | null, main: HTMLElement): void {
  main.classList.remove("pending")
  placeCarried(main)
  old?.remove()
  // the page's height eases on any later change, such as a part that fills in once it is read
  sizes.observe(main)
}

// the old part and the new of each part kept whole, and of each part that changed, outermost first
function pairsOf(matches: Match[]): [Element, Element][] {
  return matches.flatMap((m) => [...(m.place ? [[m.place, m.el] as [Element, Element]] : []), ...(m.kept ? [] : pairsOf(m.inside))])
}

// the outermost new parts with nothing in the old page, inside parts that changed or at the page's top
function freshOf(matches: Match[]): Element[] {
  return matches.flatMap((m) => m.place ? (m.kept ? [] : freshOf(m.inside)) : [m.el])
}

// An element's signature: its kind, the attributes that show its state, and all it holds. Two elements alike in all of
// that are the same part of a page, drawn again. Fading layers are left out; an icon is signed whole; a stand-in signs
// as the node it holds the place of.
const SIGNED = ["class", "href", "src", "disabled", "aria-disabled", "aria-expanded", "aria-invalid", "data-state"]
function signatures(root: Element): Map<Element, string> {
  const out = new Map<Element, string>()
  const sign = (el: Element): string => {
    const node = real(el)
    if (node.classList.contains("outgoing")) return ""
    let inner = ""
    if (node instanceof SVGElement) inner = node.innerHTML
    else for (const n of node.childNodes) inner += n instanceof Element ? sign(n) : n.nodeType === Node.TEXT_NODE ? n.textContent : ""
    const signature = `<${node.tagName} ${SIGNED.map((a) => node.getAttribute(a) ?? "").join("|")}>${inner}</>`
    out.set(el, signature)
    return signature
  }
  for (const child of root.children) sign(child)
  return out
}

// Each element's key: its signature, numbered among elements alike in the page's order, as a list of like rows has;
// and how many elements share each signature.
function keysOf(root: Element): { keys: Map<Element, string>; counts: Map<string, number> } {
  const counts = new Map<string, number>()
  const keys = new Map<Element, string>()
  for (const [el, signature] of signatures(root)) {
    const n = counts.get(signature) ?? 0
    counts.set(signature, n + 1)
    keys.set(el, `${n}#${signature}`)
  }
  return { keys, counts }
}
const signatureOf = (key: string) => key.slice(key.indexOf("#") + 1)

// the smallest part of a page that changes as a whole: an icon, an element with nothing inside, or one with text of its own
const leaf = (el: Element) => el instanceof SVGElement || el.children.length === 0 || [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim())

// What a page drawn again has of the old one, still on screen: the largest parts it still has, kept; parts that changed,
// matched to the old part in their slot under the old part their parent matched, with what is inside them matched in
// turn, so a label or an icon that changed cross-fades where it is; and the parts that are new, with no place. Alike parts, as a list's buttons, count as kept
// only where the old page had as many: one added or gone would pair each with its neighbour. It differs from the old
// page if anything is new or anything of the old page is gone.
export interface Match { el: Element; place: Element | null; kept: boolean; inside: Match[] }
export interface Comparison { matches: Match[]; differs: boolean; gone: Element[] }
export function compare(main: HTMLElement, old: HTMLElement): Comparison {
  const before = keysOf(old)
  const places = new Map([...before.keys].map(([el, key]) => [key, el]))
  const oldChildren = (el: Element) => [...el.children].filter((c) => before.keys.has(c))
  const { keys, counts } = keysOf(main)
  const kept = new Set<Element>()
  let changed = false
  const visit = (el: Element): Match => {
    // a stand-in holds the place of the old page's own node
    if (carried.has(el) && old.contains(real(el))) {
      kept.add(real(el))
      return { el, place: real(el), kept: true, inside: [] }
    }
    const key = keys.get(el) ?? ""
    const place = places.get(key)
    if (place && before.counts.get(signatureOf(key)) === counts.get(signatureOf(key))) {
      kept.add(place)
      return { el, place, kept: true, inside: [] }
    }
    if (leaf(real(el))) {
      changed = true
      return { el, place: null, kept: false, inside: [] }
    }
    return { el, place: null, kept: false, inside: [...el.children].filter((c) => keys.has(c)).map(visit) }
  }
  const matches = [...main.children].filter((c) => keys.has(c)).map(visit)
  const covered = (el: Element) => { for (let a: Element | null = el; a; a = a.parentElement) if (kept.has(a)) return true; return false }
  // once every kept part has taken its own place, a part that changed takes its slot's
  const taken = new Set<Element>()
  // old parts a new leaf took, which cross-fade whole, with all they held
  const wholeTaken = new Set<Element>()
  const placeSlots = (siblings: Match[], olds: Element[]) => {
    const slots = slotsOf(olds.filter((el) => !covered(el)))
    const mine = slotsOf(siblings.map((m) => m.el))
    for (const [slot, el] of mine) {
      const match = siblings.find((m) => m.el === el)!
      if (match.kept) continue
      const counterpart = slots.get(slot)
      if (counterpart && !taken.has(counterpart)) {
        taken.add(counterpart)
        if (match.inside.length === 0) wholeTaken.add(counterpart)
        match.place = counterpart
      }
      placeSlots(match.inside, match.place ? oldChildren(match.place) : [])
    }
  }
  placeSlots(matches, oldChildren(old))
  // a new part holding nothing of the old page comes in whole, its own box with it, rather than its text alone
  const placed = (m: Match): boolean => m.place !== null || m.inside.some(placed)
  const whole = (m: Match) => {
    if (m.place === null && !placed(m)) m.inside = []
    else m.inside.forEach(whole)
  }
  matches.forEach(whole)
  // the outermost old parts with nothing in the new page: neither kept, nor in a kept part, nor a changed part's match
  const matched = (el: Element) => covered(el) || taken.has(el)
  const gone = [...before.keys.keys()].filter((el) => !matched(el)
    && (el.parentElement === old || (el.parentElement !== null && taken.has(el.parentElement) && !wholeTaken.has(el.parentElement))))
  return { matches, differs: changed || gone.length > 0, gone }
}
