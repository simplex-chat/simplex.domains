// Stripe's Payment Element for card orders, as the badges webapp mounts it (apps/simplex-badge-service/web/src/stripe.ts).

// Stripe.js must load from js.stripe.com and may not be bundled or self-hosted, so this is a script tag.
const STRIPE_JS_URL = "https://js.stripe.com/dahlia/stripe.js"
const KEY_META = "stripe-publishable-key"
const CONFIRM_FAILED = "The card was not accepted. Check the details and try again."
// a form that neither loads nor fails, as on a stalled network, has failed once this long has gone by
export const CARD_FORM_TIMEOUT_MS = 20_000

interface PaymentElement {
  mount(target: HTMLElement): void
  on(event: "ready" | "loaderror", handler: () => void): void
  destroy(): void
}
interface StripeElements {
  create(kind: "payment", options: { wallets: Record<"applePay" | "googlePay" | "link", "never"> }): PaymentElement
  update(options: { appearance: Appearance }): void
}
interface StripeInstance {
  elements(options: { clientSecret: string; appearance: Appearance }): StripeElements
  confirmPayment(options: { elements: StripeElements; confirmParams: { return_url: string }; redirect: "if_required" }): Promise<{ paymentIntent?: { status?: string }; error?: { type?: string; message?: string } }>
}
type StripeGlobal = (publishableKey: string) => StripeInstance
interface Appearance {
  theme: "flat"
  variables: Record<string, string>
  rules: Record<string, Record<string, string>>
}

declare global {
  interface Window {
    Stripe?: StripeGlobal
  }
}

export function publishableKey(): string {
  return document.querySelector(`meta[name="${KEY_META}"]`)?.getAttribute("content")?.trim() ?? ""
}

let loading: Promise<StripeGlobal> | null = null

// Firefox holds a page's load event for a script added before it, so a Stripe that never answers would keep the page loading
const pageLoaded = () => document.readyState === "complete" ? Promise.resolve() : new Promise<void>((done) => addEventListener("load", () => done(), { once: true }))

function loadStripeJs(): Promise<StripeGlobal> {
  if (loading) return loading
  loading = pageLoaded().then(() => new Promise<StripeGlobal>((resolve, reject) => {
    const tag = document.createElement("script")
    tag.setAttribute("src", STRIPE_JS_URL)
    tag.setAttribute("async", "")
    tag.addEventListener("load", () => {
      if (window.Stripe) return resolve(window.Stripe)
      loading = null
      reject(new Error("stripe: no global"))
    })
    tag.addEventListener("error", () => {
      loading = null
      // a failed script tag never loads again, so a retry needs a new one
      tag.remove()
      reject(new Error("stripe: the script did not load"))
    })
    document.head.append(tag)
  }))
  return loading
}

// Stripe's iframe cannot read the page's CSS variables; these copy styles.css's --primary, --primary-ink, --ink, --page-color, --surface, --surface-line, --ink-soft and --danger-fg.
const LIGHT = { accent: "#0053D0", onAccent: "#ffffff", ink: "#0D1B3A", bg: "#F3FAFF", surface: "#ffffff", line: "rgba(0, 83, 208, .14)", muted: "rgba(13, 27, 58, .651)", danger: "#b3261e" }
const DARK = { accent: "#70F0F9", onAccent: "#041038", ink: "#EAF2FF", bg: "#000832", surface: "#0A1C44", line: "rgba(112, 240, 249, .18)", muted: "rgba(234, 242, 255, .735)", danger: "#FF9F98" }

const STRIPE_FONTS = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"

function appearance(dark: boolean): Appearance {
  const p = dark ? DARK : LIGHT
  return {
    theme: "flat",
    variables: {
      colorPrimary: p.accent, colorBackground: p.surface, colorText: p.ink, colorTextSecondary: p.muted, colorTextPlaceholder: p.muted,
      colorDanger: p.danger, accessibleColorOnColorPrimary: p.onAccent, iconColor: p.ink, iconHoverColor: p.ink, iconCardCvcColor: p.muted,
      iconCardCvcErrorColor: p.danger, iconCardErrorColor: p.danger, iconChevronDownColor: p.muted, iconChevronDownHoverColor: p.ink,
      // Stripe's logo comes in two tones only; its frame cannot load the page's own fonts, so it uses the system's
      iconLoadingIndicatorColor: p.accent, tabIconColor: p.muted, tabIconSelectedColor: p.accent, logoColor: dark ? "light" : "dark",
      fontFamily: STRIPE_FONTS, fontSizeBase: "16px", borderRadius: "12px", spacingUnit: "4px",
    },
    rules: {
      ".Input": { backgroundColor: p.bg, color: p.ink, border: `1px solid ${p.line}`, boxShadow: "none" },
      ".Input:focus": { border: `1px solid ${p.accent}`, boxShadow: `0 0 0 1px ${p.accent}` },
      ".Input--invalid": { border: `1px solid ${p.danger}`, boxShadow: "none" },
      ".Label": { color: p.ink },
      ".Tab": { backgroundColor: p.surface, color: p.ink, border: `1px solid ${p.line}`, boxShadow: "none" },
      ".Tab--selected": { color: p.ink, border: `1px solid ${p.line}`, boxShadow: "none" },
    },
  }
}

type ConfirmOutcome = { kind: "submitted" } | { kind: "invalid" } | { kind: "error"; message: string }
export type MountedCard = { confirm: () => Promise<ConfirmOutcome>; destroy: () => void }
// the page's theme: whether it is dark, and its changes, heard until the returned stop is called
export interface Theme {
  dark(): boolean
  watch(follow: (dark: boolean) => void): () => void
}

// The form once ready, or null when the script, the SDK or the form fails or is not ready within the bound. The form
// follows the page's theme in place, as mounting it again would lose what was typed.
export async function mountCard(key: string, clientSecret: string, target: HTMLElement, theme: Theme): Promise<MountedCard | null> {
  let stalled: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<false>((done) => { stalled = setTimeout(done, CARD_FORM_TIMEOUT_MS, false) })
  let unwatch: () => void = () => undefined
  try {
    const stripe = await Promise.race([loadStripeJs(), late])
    if (!stripe) return null
    const sdk = stripe(key)
    const elements = sdk.elements({ clientSecret, appearance: appearance(theme.dark()) })
    unwatch = theme.watch((dark) => elements.update({ appearance: appearance(dark) }))
    const element = elements.create("payment", { wallets: { applePay: "never", googlePay: "never", link: "never" } })
    element.mount(target)
    const loaded = await Promise.race([new Promise<boolean>((done) => { element.on("ready", () => done(true)); element.on("loaderror", () => done(false)) }), late])
    if (!loaded) {
      unwatch()
      element.destroy()
      return null
    }
    return {
      confirm: async () => {
        try {
          // a card stays in the frame with redirect "if_required", so the return URL is never visited
          const r = await sdk.confirmPayment({ elements, confirmParams: { return_url: location.href }, redirect: "if_required" })
          // Stripe draws a mistake in a field beside the field
          if (r.error?.type === "validation_error") return { kind: "invalid" }
          if (r.error) return { kind: "error", message: r.error.message ?? CONFIRM_FAILED }
          const status = r.paymentIntent?.status
          return status === "succeeded" || status === "processing" ? { kind: "submitted" } : { kind: "error", message: CONFIRM_FAILED }
        } catch {
          return { kind: "error", message: CONFIRM_FAILED }
        }
      },
      destroy: () => {
        unwatch()
        try { element.destroy() } catch { /* already gone */ }
      },
    }
  } catch {
    unwatch()
    return null
  } finally {
    clearTimeout(stalled)
  }
}
