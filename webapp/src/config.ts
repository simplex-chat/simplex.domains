// What differs between deployments, which the service answers at GET /api/config, so the same build serves every one.
// index.html preloads it, so its answer is normally in before the page's modules have loaded.
import { ApiError, type ChainInfo } from "./api.ts"
import { setPageMode } from "./mode.ts"
import { setPublishableKey } from "./stripe.ts"

export const CONFIG_PATH = "/api/config"

export interface NamesSite extends ChainInfo {
  codesOnly: boolean
  termStart: number
}

export interface SiteConfig { stripePublishableKey: string; names: NamesSite | null }

const isText = (v: unknown) => typeof v === "string"
const isSeconds = (v: unknown) => Number.isInteger(v) && (v as number) >= 0
const isNamesSite = (v: unknown): v is NamesSite => typeof v === "object" && v !== null && typeof (v as NamesSite).codesOnly === "boolean"
  && isSeconds((v as NamesSite).chainId) && isText((v as NamesSite).resolver) && isText((v as NamesSite).sponsor) && isText((v as NamesSite).tld) && isSeconds((v as NamesSite).termStart)

export function configOf(body: unknown): SiteConfig | null {
  if (typeof body !== "object" || body === null || !("stripePublishableKey" in body) || !("names" in body)) return null
  const { stripePublishableKey, names } = body as Record<string, unknown>
  if (names !== null && !isNamesSite(names)) return null
  return { stripePublishableKey: typeof stripePublishableKey === "string" ? stripePublishableKey.trim() : "", names }
}

export async function readConfig(init?: RequestInit): Promise<SiteConfig | null> {
  try {
    const res = await fetch(CONFIG_PATH, init)
    return res.ok ? configOf(await res.json()) : null
  } catch {
    return null
  }
}

let site: NamesSite | null = null

// Unread, the page stays in open mode with no card form, as a page with nothing to pay with, until namesSite reads it.
export async function loadConfig(): Promise<void> {
  const config = await readConfig()
  if (!config) return
  site = config.names
  setPageMode(site?.codesOnly ? "codes" : "open")
  setPublishableKey(config.stripePublishableKey)
}

export async function namesSite(): Promise<NamesSite> {
  if (!site) await loadConfig()
  if (!site) throw new ApiError("network", 0, null, {})
  return site
}

export const loadedSite = (): NamesSite | null => site

export function readSite(): NamesSite {
  if (!site) throw new Error("the names deployment is unread")
  return site
}
