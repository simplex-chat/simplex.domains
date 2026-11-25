// What differs between deployments, which the service answers at GET /api/config, so the same build serves every one.
// index.html preloads it, so its answer is normally in before the page's modules have loaded.
import { ApiError, type ChainInfo, type Terms } from "./api.ts"
import { setPageMode } from "./mode.ts"
import { setPublishableKey } from "./stripe.ts"

export const CONFIG_PATH = "/api/config"

export interface Deployment {
  chainId: number
  tld: string
  sponsor: string
  resolver: string
  namePolicy: string
  termStart: number
  codesOnly: boolean
  generalTerms: Terms[]
  communityTerms: Terms[]
}

export const MAINNET: Deployment = {
  chainId: 1,
  tld: "simplex",
  sponsor: "0xeC9a522C756e46FB3E44d3405FFDd9368501Eb78",
  resolver: "0x9BDa37F19b59Cbc58BA75932B3c598947fD88B0A",
  namePolicy: "0x5147b65F547b766DBaf520127e8f59834475021E",
  termStart: 1798761600,
  codesOnly: true,
  generalTerms: [{
    hash: "0x70e0396b0a83f6c4e624b2e43d537b7c9816c6868bf705080237d93f5aa2541d",
    link: "https://raw.githubusercontent.com/simplex-chat/simplex-chat/7cfd522f0f26454fc913f978a45f5f6028017b10/docs/NAMES-CONDITIONS.md#sha256=6871119c6e4088d2b6f2d7890443a82a4b8e65dd1ccb73456ce8f13c3434e6ee",
  }],
  communityTerms: [{
    hash: "0x70e0396b0a83f6c4e624b2e43d537b7c9816c6868bf705080237d93f5aa2541d",
    link: "https://raw.githubusercontent.com/simplex-chat/simplex-chat/7cfd522f0f26454fc913f978a45f5f6028017b10/docs/NAMES-CONDITIONS.md#sha256=6871119c6e4088d2b6f2d7890443a82a4b8e65dd1ccb73456ce8f13c3434e6ee",
  }],
}

export const LOCAL: Deployment = {
  chainId: 31337,
  tld: "simplex",
  sponsor: "0x0B306BF915C4d645ff596e518fAf3F9669b97016",
  resolver: "0x8A791620dd6260079BF849Dc5567aDC3F2FdC318",
  namePolicy: "0x9A9f2CCfdE556A7E9Ff0848998Aa4a0CFD8863AE",
  termStart: 1798761600,
  codesOnly: false,
  generalTerms: [{
    hash: "0xb0ecf1bb8f71f387d7d56ea055cb44378c91a8ad2e66b9c0c6497adccaa599e9",
    link: "http://127.0.0.1:8098/terms/00516a11b53ad775b7a51fc8a96c9199529e7b53424eec791df0755a15645bda.md#sha256=00516a11b53ad775b7a51fc8a96c9199529e7b53424eec791df0755a15645bda",
  }, {
    hash: "0x79cb2cc4c33ab80f0883865eba393feb50383eadbd09c7d6fa9320213f1003d9",
    link: "http://127.0.0.1:8098/terms/e40ffc052d26e9921b7a871fa2b2158e2c91fb0c5418bca2762285f5da13a726.md#sha256=e40ffc052d26e9921b7a871fa2b2158e2c91fb0c5418bca2762285f5da13a726",
  }],
  communityTerms: [{
    hash: "0xca7e84166f00dac5e40e8a0cbcd2a3ff5328d2d2a7fbb64c369c35b2c75f3f0f",
    link: "http://127.0.0.1:8098/terms/7124c441467db09240c476e0347251fbe1f305d7d18bf3479af442c5587283f4.md#sha256=7124c441467db09240c476e0347251fbe1f305d7d18bf3479af442c5587283f4",
  }, {
    hash: "0xc84fc8765b05721378152c7f369ce2e3fb8ce48f37d3abe888347274e5d41897",
    link: "http://127.0.0.1:8098/terms/c4aa8c69a695870643ceb72badbd1fcbfd866879379eb3c38ea0b9f17b2a1a59.md#sha256=c4aa8c69a695870643ceb72badbd1fcbfd866879379eb3c38ea0b9f17b2a1a59",
  }],
}

declare const __MAINNET__: boolean

export const SITE: Deployment = typeof __MAINNET__ === "undefined" ? LOCAL
  : __MAINNET__ ? MAINNET
  : { ...LOCAL, codesOnly: import.meta.env.VITE_CODES_ONLY === "true" }

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
