import { changeOnItsWay } from "../api.ts"
import { readConfig, type SiteConfig } from "../config.ts"
import * as session from "../session.ts"
import * as store from "../store.ts"

// a field typed into since it was drawn holds what the page has not kept
const typedInto = () => [...document.querySelectorAll("input")].some((i) => i.type === "text" && i.value !== i.defaultValue)
// a tick that only the page's memory holds, as an order page's terms agreed to again
export const UNKEPT_TICKS = "data-unkept-ticks"
const tickedUnkept = () => document.querySelector(`body > main [${UNKEPT_TICKS}] input[type=checkbox]:checked`) !== null
// Stripe's card form, whose card a reload would drop, maybe mid-confirmation
const cardForm = () => document.querySelector("body > main iframe") !== null
// what a reload would lose besides the screen: an order or change on its way, or what storage did not take
const reloadKeeps = () => !changeOnItsWay() && !session.anySending() && session.allKept() && store.canPersist() && !cardForm()

export const NEW_ORDERS_SOON = "New orders open again soon"
export const PAYMENT_SOON = "Payment opens again soon"

let downtime = false
let afresh = false

export const inDowntime = () => downtime

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

function served(config: SiteConfig | null): void {
  if (config === null) return
  afresh ||= downtime && !config.downtime
  downtime = config.downtime
  if (afresh && reloadKeeps() && !typedInto() && !tickedUnkept()) location.reload()
}

let comparing: Promise<void> | null = null
function check(): void {
  comparing ??= readConfig({ cache: "no-store" }).then(served).finally(() => { comparing = null })
}

export function followServedMode(loaded: SiteConfig | null): void {
  served(loaded)
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") check() })
  addEventListener("pageshow", (e) => { if (e.persisted) check() })
}
