// A page drawn in a mode the service no longer serves loads again from the service: at once when that loses nothing,
// otherwise at its next route, which leaves the screen on show anyway.
import { changeOnItsWay } from "../api.ts"
import { readConfig } from "../config.ts"
import { type Mode, pageMode } from "../mode.ts"
import * as session from "../session.ts"
import * as store from "../store.ts"

// Past the HTTP cache; the worker answers from the network while it is there.
async function servedMode(): Promise<Mode | null> {
  return (await readConfig({ cache: "no-store" }))?.mode ?? null
}

// a field typed into since it was drawn holds what the page has not kept
const typedInto = () => [...document.querySelectorAll("input")].some((i) => i.type === "text" && i.value !== i.defaultValue)
// a tick that only the page's memory holds, as an order page's terms agreed to again
export const UNKEPT_TICKS = "data-unkept-ticks"
const tickedUnkept = () => document.querySelector(`body > main [${UNKEPT_TICKS}] input[type=checkbox]:checked`) !== null
// Stripe's card form, whose card a reload would drop, maybe mid-confirmation
const cardForm = () => document.querySelector("body > main iframe") !== null
// what a reload would lose besides the screen: an order or change on its way, or what storage did not take
const reloadKeeps = () => !changeOnItsWay() && !session.anySending() && session.allKept() && store.canPersist() && !cardForm()

let afresh = false

// The page at its next route, as the screen on show is left: true when it loads the document again instead of drawing it.
export function reloadedForRoute(): boolean {
  if (!afresh || !reloadKeeps()) return false
  location.reload()
  return true
}

// for a screen that says what the service refused, which stays until it is left
export function loadNextRouteAfresh(): void {
  afresh = true
}

async function compare(): Promise<void> {
  const served = await servedMode()
  if (served === null) return
  afresh = served !== pageMode()
  if (afresh && reloadKeeps() && !typedInto() && !tickedUnkept()) location.reload()
}

let comparing: Promise<void> | null = null
function check(): void {
  comparing ??= compare().finally(() => { comparing = null })
}

// A load reads the mode before the page draws (src/config.ts), so only a return to a page drawn earlier checks it.
export function followServedMode(): void {
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") check() })
  addEventListener("pageshow", (e) => { if (e.persisted) check() })
}
