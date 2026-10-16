import type { Page } from "@playwright/test"

// What the page does that a person sees as a cut rather than motion: content shown and gone within a blink, content
// that appears or goes without easing, a height that jumps for one frame or snaps to a new one, a layout jump, a scroll
// jump, a view transition the browser refused. While a view transition runs, the browser draws the page from its
// pictures, so what changes under it is no cut.
export interface Cut { kind: "flash" | "cut-in" | "cut-out" | "spike" | "jump" | "shift" | "scroll-jump" | "refused" | "mark"; what: string; step: string }
// a view transition the page ran: its kinds, and the names of the parts the browser moved in it
export interface Transition { types: string[]; groups: string[] }

// Runs in the page before the app, through addInitScript; it records into window.__cuts.
export function recordCuts(): void {
  type Seen = Element & { wasVisible?: boolean; fade?: Animation }
  type Raw = { kind: string; what: string; t: number }
  const cuts: Raw[] = []
  const transitions: { types: string[]; groups: string[] }[] = []
  const w = window as unknown as { __cuts: Raw[]; __mark: (label: string) => void; __transitions: typeof transitions }
  w.__cuts = cuts
  w.__transitions = transitions
  w.__mark = (label) => cuts.push({ kind: "mark", what: label, t: performance.now() })
  // each view transition from its start to a frame after its end, when the page is drawn as it is again
  const periods: [number, number][] = []
  const drawnByTransition = (t = performance.now()) => periods.some(([from, to]) => t >= from && t <= to + 20)
  const start = document.startViewTransition?.bind(document)
  if (start) {
    document.startViewTransition = ((arg: ViewTransitionUpdateCallback | StartViewTransitionOptions) => {
      const t = start(arg)
      const period: [number, number] = [performance.now(), Infinity]
      periods.push(period)
      const entry = { types: typeof arg === "function" ? [] : [...(arg.types ?? [])], groups: [] as string[] }
      transitions.push(entry)
      t.ready.then(() => {
        // a part on one side only has no group animation, only its picture's
        entry.groups = [...new Set(document.getAnimations().map((a) => /^::view-transition-(?:group|old|new)\((.+)\)$/.exec((a.effect as KeyframeEffect | null)?.pseudoElement ?? "")?.[1])
          .filter((name): name is string => name !== undefined))]
      }, (e: Error) => {
        // one cut short by a newer transition gives way to it; any other refusal leaves the change drawn at once
        if (e.name !== "AbortError") cuts.push({ kind: "refused", what: `${e.name}: ${e.message}`, t: performance.now() })
      })
      void t.finished.catch(() => undefined).finally(() => { period[1] = performance.now() })
      return t
    }) as typeof document.startViewTransition
  }
  const describe = (n: Element) => `${n.tagName.toLowerCase()}.${[...n.classList].join(".")} "${(n.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 50)}"`
  const visible = (n: Element) => {
    if (!n.isConnected) return false
    const r = n.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return false
    const s = getComputedStyle(n)
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05 && !n.closest("[hidden], .sr-only")
  }
  // something on the way from the node up to the page is fading it in; a height easing alone does not soften what appears
  const fading = (x: Animation) => (x.effect as KeyframeEffect | null)?.getKeyframes().some((k) => "opacity" in k) ?? false
  const easing = (n: Element) => {
    for (let a: Element | null = n; a && a !== document.body; a = a.parentElement) {
      if (a.getAnimations().some((x) => x.playState === "running" && fading(x))) return true
    }
    return false
  }
  const addedAt = new Map<Element, number>()
  let userAt = -Infinity
  for (const type of ["pointerdown", "keydown", "wheel", "touchstart"]) {
    addEventListener(type, () => {
      userAt = performance.now()
      // a test's click scrolls its target into view just before pressing it, as a person would scroll to it
      for (let i = cuts.length - 1; i >= 0; i--) if (cuts[i].kind === "scroll-jump" && userAt - cuts[i].t < 1000) cuts.splice(i, 1)
    }, true)
  }
  const watch = new MutationObserver((records) => {
    const now = performance.now()
    // a node taken out and put back in the same change stays on screen: it does not come in
    const moved = new Set(records.flatMap((r) => [...r.removedNodes]))
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (!(n instanceof Element) || moved.has(n)) continue
        addedAt.set(n, now)
        // checked a frame later, when its own easing has started
        requestAnimationFrame(() => {
          if (!n.isConnected || n.closest(".outgoing, .pending") || !visible(n) || drawnByTransition(now)) return
          // content identical to what fades out over it shows no cut
          const twin = [...(n.parentElement?.querySelectorAll(":scope > .outgoing") ?? [])].some((o) => o.textContent === n.textContent)
          if (!twin && !easing(n)) cuts.push({ kind: "cut-in", what: describe(n), t: now })
        })
      }
      for (const n of r.removedNodes) {
        if (!(n instanceof Element) || !(n as Seen).wasVisible) continue
        const at = addedAt.get(n)
        // checked once this task is over: a node moved elsewhere is still in the page
        queueMicrotask(() => {
          if (n.isConnected || drawnByTransition(now)) return
          // a page swapped for the same page without a transition is no change; any other page swapped without one is a cut
          if (n.matches("main")) {
            const shown = document.querySelector("body > main:not(.pending)")
            if (shown?.textContent !== n.textContent) cuts.push({ kind: "cut-out", what: describe(n), t: performance.now() })
            return
          }
          // a popup closing gives way to one opened at once, which takes over from its opacity
          if (n.matches(".modal-overlay.closing") && document.querySelector(".modal-overlay:not(.closing)")) return
          // A fading layer is removed once its fade is over; cut off before its end, it is a cut. The fade is read as it
          // stands at the removal, by time, not by its eased progress, which a fade that holds on and goes late keeps low.
          if (n.matches(".outgoing, .modal-overlay.closing")) {
            const fade = (n as Seen).fade
            const length = Number(fade?.effect?.getComputedTiming().duration ?? 0)
            const done = fade && length ? Number(fade.currentTime ?? length) / length : 1
            if (done < 0.9) cuts.push({ kind: "cut-out", what: describe(n), t: now })
          } else if (at !== undefined && now - at < 400) cuts.push({ kind: "flash", what: describe(n), t: now })
          else cuts.push({ kind: "cut-out", what: describe(n), t: now })
        })
      }
    }
  })
  // which nodes were visible before each frame, for removals
  const sample = () => {
    for (const n of document.querySelectorAll("main *, header *, .modal-overlay, .modal-overlay *")) {
      if (n.children.length <= 40) (n as Seen).wasVisible = visible(n)
    }
    // each fading layer's fade, to read where it stands when the layer goes
    for (const n of document.querySelectorAll(".outgoing, .modal-overlay.closing")) (n as Seen).fade ??= n.getAnimations().find(fading)
    requestAnimationFrame(sample)
  }
  addEventListener("DOMContentLoaded", () => {
    watch.observe(document.body, { childList: true, subtree: true })
    requestAnimationFrame(sample)
  })
  // A height that jumps for a frame and comes back, or snaps to a new one in a frame with no easing to carry it. Read in a
  // resize observer made after the app's own, which runs after it in the same frame: what this reads is what is painted.
  // An easing moves a height by less than a third of its change in a frame; a window resized moves it at once.
  const SNAP_PX = 60
  let resizedAt = -Infinity
  addEventListener("resize", () => { resizedAt = performance.now() })
  const easingHeight = (n: Element) => n.getAnimations().some((a) => (a.effect as KeyframeEffect | null)?.getKeyframes().some((k) => "height" in k))
  addEventListener("load", () => {
    // each observed node's recent heights, by time
    const heights = new WeakMap<Element, { h: number; t: number }[]>()
    const heightAt = (n: Element, t: number) => [...(heights.get(n) ?? [])].reverse().find((s) => s.t <= t)?.h
    const sizes = new ResizeObserver((entries) => {
      const now = performance.now()
      const stepped: { node: Element; from: { h: number; t: number }; h: number }[] = []
      for (const e of entries) {
        const before = heights.get(e.target) ?? []
        const seen = [...before, { h: Math.round(e.target.getBoundingClientRect().height), t: now }].slice(-10)
        heights.set(e.target, seen)
        // a node taken out of the page, or a page not yet shown, is not laid out where it will be
        if (before.length && e.target.isConnected && !e.target.matches(".pending")) stepped.push({ node: e.target, from: before[before.length - 1], h: seen[seen.length - 1].h })
        const last3 = seen.slice(-3)
        if (last3.length < 3 || now - last3[0].t > 100 || drawnByTransition(now)) continue
        const [a, b, c] = last3.map((s) => s.h)
        if (Math.abs(b - a) > 8 && Math.abs(c - a) < Math.abs(b - a) / 2) cuts.push({ kind: "spike", what: `${describe(e.target)} ${a}→${b}→${c}`, t: now })
      }
      if (now - resizedAt < 500 || drawnByTransition(now)) return
      // What the outermost parts easing inside a node moved since the node last moved moves the node too; the rest of
      // its step is its own.
      for (const { node, from, h } of stepped) {
        if (easingHeight(node)) continue
        const inside = [...node.querySelectorAll(".live")].filter(easingHeight)
        const carried = inside.filter((inner) => !inside.some((mid) => mid !== inner && mid.contains(inner)))
          .reduce((sum, inner) => sum + Math.round(inner.getBoundingClientRect().height) - (heightAt(inner, from.t) ?? Math.round(inner.getBoundingClientRect().height)), 0)
        const step = h - from.h
        // a page held at the window's height does not move with what eases inside it
        if (Math.abs(step) <= SNAP_PX || Math.abs(step - carried) <= SNAP_PX) continue
        // WebKit can run this observer before the app's in a frame, so the app may still hold the node at its old
        // height before the frame is painted: a jump is one the next frame still shows, with no easing carrying it
        requestAnimationFrame(() => {
          const shown = Math.round(node.getBoundingClientRect().height)
          if (Math.abs(shown - h) < 2 && !easingHeight(node) && ![...node.querySelectorAll(".live")].some(easingHeight)) {
            cuts.push({ kind: "jump", what: `${describe(node)} ${step > 0 ? "+" : ""}${step}px, ${carried}px of it carried`, t: now })
          }
        })
      }
    })
    const observe = (root: ParentNode) => root.querySelectorAll(".live, body > main").forEach((n) => sizes.observe(n))
    observe(document)
    new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) if (n instanceof Element) { if (n.matches(".live, body > main")) sizes.observe(n); observe(n) }
    }).observe(document.body, { childList: true, subtree: true })
  })
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as (PerformanceEntry & { hadRecentInput: boolean; value: number; sources?: { node?: Node | null }[] })[]) {
        const moved = (e.sources ?? []).map((s) => s.node instanceof Element ? describe(s.node) : "").filter(Boolean).join(" | ")
        if (!e.hadRecentInput && !drawnByTransition(e.startTime)) cuts.push({ kind: "shift", what: `${e.value} ${moved}`, t: e.startTime })
      }
    }).observe({ type: "layout-shift", buffered: true })
  } catch {
    // Firefox has no layout-shift entries; the other records still apply there
  }
  let lastY = 0
  addEventListener("scroll", () => {
    const now = performance.now()
    // a page opened goes to its top under its view transition
    if (Math.abs(scrollY - lastY) > 40 && now - userAt > 1000 && !drawnByTransition(now)) cuts.push({ kind: "scroll-jump", what: `${lastY} to ${scrollY}`, t: now })
    lastY = scrollY
  }, true)
}

// the smallest layout shift a person can see, as a share of the viewport
const SEEN_SHIFT = 0.001

export const markStep = (page: Page, step: string) => page.evaluate((s) => (window as unknown as { __mark: (s: string) => void }).__mark(s), step)

// The cuts recorded since the last call, each with the step it happened in. A run of three or more layout shifts in one
// step is a height easing, which moves what is under it smoothly, not a jump; a lone shift that rounds to nothing is a
// subpixel settling.
export async function takeCuts(page: Page): Promise<Cut[]> {
  const raw = await page.evaluate(() => (window as unknown as { __cuts: { kind: string; what: string }[] }).__cuts.splice(0))
  let step = "load"
  const out: Cut[] = []
  for (const c of raw) {
    if (c.kind === "mark") step = c.what
    else out.push({ kind: c.kind as Cut["kind"], what: c.what, step })
  }
  const shifts = new Map<string, number>()
  for (const c of out) if (c.kind === "shift") shifts.set(c.step, (shifts.get(c.step) ?? 0) + 1)
  return out.filter((c) => c.kind !== "shift" || ((shifts.get(c.step) ?? 0) < 3 && parseFloat(c.what) >= SEEN_SHIFT))
}

// The view transitions run since the last call.
export const takeTransitions = (page: Page) => page.evaluate(() => (window as unknown as { __transitions: Transition[] }).__transitions.splice(0))
