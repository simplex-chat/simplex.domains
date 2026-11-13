import { ApiError, LIMITED_WAIT_S, serviceNow } from "../api.ts"
import { alertBox, el, waitOut } from "../dom.ts"
import { type Hold, NO_LEAD } from "../screens/hold.ts"
import { after } from "./effects.ts"

// The tab's wait after a rate limit outlives the page that met it, so a redraw or Back draws its action held again.
let heldUntil = 0
export const holding = () => Date.now() < heldUntil
export const startHold = (waitSeconds: number) => { heldUntil = Math.max(heldUntil, Date.now() + waitSeconds * 1000) }
export const holdLeft = () => Math.max(0, Math.ceil((heldUntil - Date.now()) / 1000))

export function holdFrom(e: unknown): boolean {
  if (!(e instanceof ApiError) || e.code !== "rate_limited") return false
  startHold(e.retryAfter ?? LIMITED_WAIT_S)
  return true
}

export const holdEnd = () => serviceNow() + holdLeft() * 1000

export const tabHold = (): Hold | null => holding() ? { until: holdEnd(), lead: NO_LEAD } : null

export function holdEnder(signal: AbortSignal, ended: () => void): (held: boolean) => void {
  let stop: (() => void) | null = null
  const wait = () => {
    stop = after(holdLeft() * 1000, () => {
      if (holding()) return wait()
      stop = null
      ended()
    }, signal)
  }
  return (held) => {
    if (!held) {
      stop?.()
      stop = null
    } else if (!stop) wait()
  }
}

export const secondsLeft = (hold: Hold) => Math.ceil((hold.until - serviceNow()) / 1000)

export function holdNotice(hold: Hold, signal: AbortSignal): HTMLElement {
  const line = el("span", {})
  const notice = el("div", { class: "left mt-14" }, alertBox("warn", "clock", "Too many attempts", line))
  waitOut(line, secondsLeft(hold), (left) => `${hold.lead}Try again in ${left}.`, () => undefined, signal)
  return notice
}
