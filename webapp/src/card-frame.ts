import { SITE } from "./config.ts"
import { el } from "./dom.ts"
import { CONFIRM_FAILED, type ConfirmOutcome, type FromCard, type MountedCard, type Theme, type ToCard, UNCHECKED } from "./stripe.ts"

export const CARD_FRAME_TIMEOUT_MS = 25_000

const isFromCard = (m: unknown): m is FromCard => typeof m === "object" && m !== null && "type" in m && (
  m.type === "mounted" || m.type === "invalid"
  || (m.type === "height" && "px" in m && typeof m.px === "number" && Number.isFinite(m.px) && m.px >= 0)
  || (m.type === "paid" && "id" in m && typeof m.id === "string")
  || (m.type === "declined" && "message" in m && typeof m.message === "string")
  || (m.type === "failed" && "reason" in m && (m.reason === UNCHECKED || m.reason === "unloaded")))

const outcomeOf = (m: FromCard): ConfirmOutcome => m.type === "paid" ? { kind: "submitted", id: m.id } : m.type === "invalid" ? { kind: "invalid" }
  : { kind: "error", message: m.type === "declined" ? m.message : CONFIRM_FAILED }

export function mountCardFrame(clientSecret: string, amount: number, target: HTMLElement, theme: Theme): Promise<MountedCard | typeof UNCHECKED | null> {
  const frame = el("iframe", { src: `${SITE.cardOrigin}/`, title: "Card form", class: "card-frame" })
  const post = (message: ToCard) => frame.contentWindow?.postMessage(message, SITE.cardOrigin)
  let answer: ((m: FromCard) => void) | null = null
  let unwatch: () => void = () => undefined
  const stop = () => {
    removeEventListener("message", onMessage)
    unwatch()
    answer?.({ type: "failed", reason: "unloaded" })
    frame.remove()
  }
  const card: MountedCard = {
    confirm: () => new Promise<ConfirmOutcome>((done) => {
      answer = (m) => {
        answer = null
        done(outcomeOf(m))
      }
      post({ type: "confirm" })
    }),
    destroy: stop,
  }
  let settle: (result: MountedCard | typeof UNCHECKED | null) => void = () => undefined
  function onMessage(e: MessageEvent<unknown>): void {
    const m = e.data
    if (e.origin !== SITE.cardOrigin || e.source !== frame.contentWindow || !isFromCard(m)) return
    if (m.type === "height") frame.style.height = `${m.px}px`
    else if (m.type === "mounted") settle(card)
    else if (m.type === "failed" && answer === null) settle(m.reason === UNCHECKED ? UNCHECKED : null)
    else answer?.(m)
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => settle(null), CARD_FRAME_TIMEOUT_MS)
    settle = (result) => {
      settle = () => undefined
      clearTimeout(timer)
      if (result !== card) stop()
      resolve(result)
    }
    addEventListener("message", onMessage)
    frame.addEventListener("load", () => post({ type: "mount", clientSecret, amount, dark: theme.dark() }), { once: true })
    unwatch = theme.watch((dark) => post({ type: "theme", dark }))
    target.append(frame)
  })
}
