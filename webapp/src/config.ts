// What differs between deployments, which the service answers at GET /api/config, so the same build serves every one.
// index.html preloads it, so its answer is normally in before the page's modules have loaded.
import { type Mode, modeOf, setPageMode } from "./mode.ts"
import { setPublishableKey } from "./stripe.ts"

export const CONFIG_PATH = "/api/config"

export interface SiteConfig { mode: Mode; stripePublishableKey: string }

export function configOf(body: unknown): SiteConfig | null {
  if (typeof body !== "object" || body === null || !("mode" in body)) return null
  const { mode, stripePublishableKey } = body as Record<string, unknown>
  return { mode: modeOf(mode), stripePublishableKey: typeof stripePublishableKey === "string" ? stripePublishableKey.trim() : "" }
}

export async function readConfig(init?: RequestInit): Promise<SiteConfig | null> {
  try {
    const res = await fetch(CONFIG_PATH, init)
    return res.ok ? configOf(await res.json()) : null
  } catch {
    return null
  }
}

// Unread, the page stays in open mode with no card form, as a page with nothing to pay with.
export async function loadConfig(): Promise<void> {
  const config = await readConfig()
  if (!config) return
  setPageMode(config.mode)
  setPublishableKey(config.stripePublishableKey)
}
