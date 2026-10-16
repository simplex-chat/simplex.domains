// Stripe's Payment Element for card orders, as the badges webapp mounts it (apps/simplex-badge-service/web/src/stripe.ts).

// Stripe.js must load from js.stripe.com and may not be bundled or self-hosted, so this is a script tag.
export const STRIPE_JS_URL = "https://js.stripe.com/dahlia/stripe.js"
const KEY_META = "stripe-publishable-key"
const CONFIRM_FAILED = "The card was not accepted. Check the details and try again."

interface PaymentElement {
  mount(target: HTMLElement): void
  destroy(): void
}
interface StripeElements {
  create(kind: "payment"): PaymentElement
}
interface StripeInstance {
  elements(options: { clientSecret: string; appearance: Appearance }): StripeElements
  confirmPayment(options: { elements: StripeElements; confirmParams: { return_url: string }; redirect: "if_required" }): Promise<{ paymentIntent?: { status?: string }; error?: { message?: string } }>
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

function loadStripeJs(): Promise<StripeGlobal> {
  if (loading) return loading
  loading = new Promise<StripeGlobal>((resolve, reject) => {
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
  })
  return loading
}

// Stripe's iframe cannot read the page's CSS variables, so these copy styles.css by hand.
const LIGHT = { accent: "#0053D0", onAccent: "#FFFFFF", ink: "#0B1733", bg: "#F3F7FD", surface: "#FFFFFF", line: "rgba(11, 23, 51, .14)", muted: "rgba(11, 23, 51, .60)", danger: "#BF2D3F" }
const DARK = { accent: "#70F0F9", onAccent: "#020A26", ink: "#EEF4FF", bg: "#0B1B42", surface: "#071433", line: "rgba(238, 244, 255, .14)", muted: "rgba(238, 244, 255, .52)", danger: "#FF8A96" }

function appearance(dark: boolean): Appearance {
  const p = dark ? DARK : LIGHT
  return {
    theme: "flat",
    variables: {
      colorPrimary: p.accent, colorBackground: p.surface, colorText: p.ink, colorTextSecondary: p.muted, colorTextPlaceholder: p.muted,
      colorDanger: p.danger, accessibleColorOnColorPrimary: p.onAccent, iconColor: p.ink, iconHoverColor: p.ink, iconCardCvcColor: p.muted,
      iconCardCvcErrorColor: p.danger, iconCardErrorColor: p.danger, iconChevronDownColor: p.muted, iconChevronDownHoverColor: p.ink,
      iconLoadingIndicatorColor: p.accent, tabIconColor: p.muted, tabIconSelectedColor: p.accent, logoColor: p.ink,
      fontFamily: "Manrope, sans-serif", fontSizeBase: "16px", borderRadius: "12px", spacingUnit: "4px",
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

export type ConfirmOutcome = { kind: "submitted" } | { kind: "error"; message: string }
export type MountedCard = { confirm: () => Promise<ConfirmOutcome>; destroy: () => void }

// Null when the script or the SDK fails: the page then shows that the card form did not load.
export async function mountCard(key: string, clientSecret: string, target: HTMLElement, dark: boolean): Promise<MountedCard | null> {
  try {
    const sdk = (await loadStripeJs())(key)
    const elements = sdk.elements({ clientSecret, appearance: appearance(dark) })
    const element = elements.create("payment")
    element.mount(target)
    return {
      confirm: async () => {
        try {
          // a card stays in the frame with redirect "if_required", so the return URL is never visited
          const r = await sdk.confirmPayment({ elements, confirmParams: { return_url: location.href }, redirect: "if_required" })
          if (r.error) return { kind: "error", message: r.error.message ?? CONFIRM_FAILED }
          const status = r.paymentIntent?.status
          return status === "succeeded" || status === "processing" ? { kind: "submitted" } : { kind: "error", message: CONFIRM_FAILED }
        } catch {
          return { kind: "error", message: CONFIRM_FAILED }
        }
      },
      destroy: () => {
        try { element.destroy() } catch { /* already gone */ }
      },
    }
  } catch {
    return null
  }
}
