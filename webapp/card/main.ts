import { SITE } from "../src/config.ts"
import { type FromCard, type MountedCard, mountCard, type Theme, type ToCard, MISMATCHED } from "../src/stripe.ts"

declare const __MAINNET__: boolean
declare global {
  interface Window { stripeTestKey?: string }
}

const STAND_IN = "Test card form: no Stripe key is set, so Pay simulates a payment."
const form = document.getElementById("form")!
const fromPage = (origin: string) => SITE.pageOrigins.some((page) => origin === page || (!(typeof __MAINNET__ !== "undefined" && __MAINNET__) && origin.startsWith(`${page}:`)))
const keyOf = () => SITE.stripeKey || (typeof __MAINNET__ !== "undefined" && __MAINNET__ ? "" : window.stripeTestKey ?? "")

let page: string | null = null
let card: MountedCard | null = null
let dark = false
const followers = new Set<(dark: boolean) => void>()
const theme: Theme = {
  dark: () => dark,
  watch: (follow) => {
    followers.add(follow)
    return () => { followers.delete(follow) }
  },
}

const send = (message: FromCard) => { if (page) parent.postMessage(message, page) }

function shade(next: boolean): void {
  dark = next
  document.documentElement.classList.toggle("dark", dark)
  document.documentElement.style.colorScheme = dark ? "dark" : "light"
  for (const follow of followers) follow(dark)
}

function standIn(): MountedCard {
  const field = (text: string, value: string) => {
    const label = document.createElement("label")
    label.className = "f"
    label.append(Object.assign(document.createElement("span"), { textContent: text }), Object.assign(document.createElement("div"), { className: "box", textContent: value }))
    return label
  }
  const cols = Object.assign(document.createElement("div"), { className: "cols" })
  cols.append(field("Expiry", "12 / 30"), field("CVC", "123"), field("Country", "Portugal"))
  const box = Object.assign(document.createElement("div"), { className: "stand-in" })
  box.append(Object.assign(document.createElement("p"), { className: "label", textContent: STAND_IN }), field("Card number", "4242 4242 4242 4242"), cols)
  form.append(box)
  return { confirm: async () => ({ kind: "submitted", id: "pi_stand_in" }), destroy: () => box.remove() }
}

async function mount(clientSecret: string, amount: number): Promise<void> {
  const key = keyOf()
  if (!key) {
    if (!import.meta.env.DEV) return send({ type: "failed", reason: "unloaded" })
    card = standIn()
    return send({ type: "mounted" })
  }
  const mounted = await mountCard(key, clientSecret, { amount, currency: SITE.currency, live: SITE.stripeLive }, form, theme)
  if (mounted === null || mounted === MISMATCHED) return send({ type: "failed", reason: mounted ?? "unloaded" })
  card = mounted
  send({ type: "mounted" })
}

async function confirm(): Promise<void> {
  if (!card) return
  const outcome = await card.confirm()
  send(outcome.kind === "submitted" ? { type: "paid", id: outcome.id } : outcome.kind === "invalid" ? { type: "invalid" } : { type: "declined", message: outcome.message })
}

const isToCard = (m: unknown): m is ToCard => typeof m === "object" && m !== null && "type" in m && (
  (m.type === "mount" && "clientSecret" in m && typeof m.clientSecret === "string" && "amount" in m && Number.isInteger(m.amount) && "dark" in m && typeof m.dark === "boolean")
  || (m.type === "theme" && "dark" in m && typeof m.dark === "boolean") || m.type === "confirm")

addEventListener("message", (e: MessageEvent<unknown>) => {
  const m = e.data
  if (e.source !== parent || !fromPage(e.origin) || !isToCard(m)) return
  if (m.type === "mount") {
    if (page !== null) return
    page = e.origin
    shade(m.dark)
    void mount(m.clientSecret, m.amount)
    return
  }
  if (e.origin !== page) return
  if (m.type === "theme") shade(m.dark)
  else void confirm()
})

new ResizeObserver(() => send({ type: "height", px: Math.ceil(form.getBoundingClientRect().height) })).observe(form)
