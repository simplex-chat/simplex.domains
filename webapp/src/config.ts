import type { Terms } from "./api.ts"

export const CONFIG_PATH = "/api/config"

export interface Deployment {
  chainId: number
  tld: string
  sponsor: string
  resolver: string
  namePolicy: string
  termStart: number
  paidYears: number
  communityYears: number
  minCodeYears: number
  maxCodeYears: number
  codesOnly: boolean
  priceBaseCentsPerYear: number
  priceExceptions: PriceException[]
  currency: "usd"
  generalTerms: Terms[]
  communityTerms: Terms[]
  stripeKey: string
  stripeLive: boolean
  cardOrigin: string
  pageOrigins: string[]
  bitcoinHrp: string
  bitcoinReceiveKeys: string[]
  moneroSubaddressPrefix: number
  moneroPrimaryAddresses: string[]
}

export interface PriceException {
  labelLength: number
  centsPerYear: number
}

export const MAINNET: Deployment = {
  chainId: 1,
  tld: "simplex",
  sponsor: "0xeC9a522C756e46FB3E44d3405FFDd9368501Eb78",
  resolver: "0x9BDa37F19b59Cbc58BA75932B3c598947fD88B0A",
  namePolicy: "0x5147b65F547b766DBaf520127e8f59834475021E",
  termStart: 1798761600,
  paidYears: 2,
  communityYears: 2,
  minCodeYears: 2,
  maxCodeYears: 10,
  codesOnly: true,
  priceBaseCentsPerYear: 5000,
  priceExceptions: [],
  currency: "usd",
  generalTerms: [{
    hash: "0x70e0396b0a83f6c4e624b2e43d537b7c9816c6868bf705080237d93f5aa2541d",
    link: "https://raw.githubusercontent.com/simplex-chat/simplex-chat/7cfd522f0f26454fc913f978a45f5f6028017b10/docs/NAMES-CONDITIONS.md#sha256=6871119c6e4088d2b6f2d7890443a82a4b8e65dd1ccb73456ce8f13c3434e6ee",
  }],
  communityTerms: [{
    hash: "0x70e0396b0a83f6c4e624b2e43d537b7c9816c6868bf705080237d93f5aa2541d",
    link: "https://raw.githubusercontent.com/simplex-chat/simplex-chat/7cfd522f0f26454fc913f978a45f5f6028017b10/docs/NAMES-CONDITIONS.md#sha256=6871119c6e4088d2b6f2d7890443a82a4b8e65dd1ccb73456ce8f13c3434e6ee",
  }],
  stripeKey: "",
  stripeLive: true,
  cardOrigin: "https://pay.simplex.domains",
  pageOrigins: ["https://simplex.domains"],
  bitcoinHrp: "bc",
  bitcoinReceiveKeys: [],
  moneroSubaddressPrefix: 42,
  moneroPrimaryAddresses: [],
}

export const LOCAL: Deployment = {
  chainId: 31337,
  tld: "simplex",
  sponsor: "0x0B306BF915C4d645ff596e518fAf3F9669b97016",
  resolver: "0x8A791620dd6260079BF849Dc5567aDC3F2FdC318",
  namePolicy: "0x68B1D87F95878fE05B998F19b66F4baba5De1aed",
  termStart: 1798761600,
  paidYears: 2,
  communityYears: 2,
  minCodeYears: 2,
  maxCodeYears: 10,
  codesOnly: false,
  priceBaseCentsPerYear: 5000,
  priceExceptions: [{ labelLength: 7, centsPerYear: 10000 }, { labelLength: 6, centsPerYear: 20000 }],
  currency: "usd",
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
  }, {
    hash: "0x43c5f541d45cc6b0430acd28d29255eb65f90ac414d448f3f06be712a59a8788",
    link: "https://git.simplex.chat/simplex-chat/simplex-chat/raw/commit/4cb24444a1f2e3d4c5b6a7980716253443526170/docs/community-terms.md#sha256=a081d9e2a2eb4c63f9dfa01f092724323ed8d24f8459f1626226e33d6198e8ab",
  }, {
    hash: "0xda08ab458b060f08de0ebe328d20d10b6f1d275237f1b3c03d2cc1177f5e3ba8",
    link: "https://raw.githubusercontent.com/simplex-chat/simplex-chat/4cb24444a1f2e3d4c5b6a7980716253443526170/docs/community-terms.md#sha256=a081d9e2a2eb4c63f9dfa01f092724323ed8d24f8459f1626226e33d6198e8ab",
  }],
  stripeKey: "",
  stripeLive: false,
  cardOrigin: "http://127.0.0.1:5180",
  pageOrigins: ["http://127.0.0.1", "http://localhost"],
  bitcoinHrp: "bcrt",
  bitcoinReceiveKeys: ["0x036bf340760eb0da07d4d2bbb9d9aee7b7c27891cb72b6388cc0ee8d2a82d33e46"],
  moneroSubaddressPrefix: 36,
  moneroPrimaryAddresses: ["52jzuBBUMty3xPL3JsQxGP74LDuV6E1LS8Zda1PbdqQjGzFmH6N9ep9McbFKMALujVT9S5mKpbEgC5VPhfoAiVj8LdAqbp6"],
}

declare const __MAINNET__: boolean

export const SITE: Deployment = typeof __MAINNET__ === "undefined" ? LOCAL
  : __MAINNET__ ? MAINNET
  : { ...LOCAL, codesOnly: import.meta.env?.VITE_CODES_ONLY === "true", stripeKey: import.meta.env?.VITE_STRIPE_KEY ?? "" }

export const heldPrice = (length: number) => (SITE.priceExceptions.find((e) => e.labelLength === length)?.centsPerYear ?? SITE.priceBaseCentsPerYear) * SITE.paidYears

export interface SiteConfig { downtime: boolean }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null

export function configOf(body: unknown): SiteConfig | null {
  if (!isObject(body) || !("stripePublishableKey" in body) || !("names" in body)) return null
  const { names } = body
  if (names !== null && !isObject(names)) return null
  return { downtime: names?.downtime === true }
}

export async function readConfig(init?: RequestInit): Promise<SiteConfig | null> {
  try {
    const res = await fetch(CONFIG_PATH, init)
    return res.ok ? configOf(await res.json()) : null
  } catch {
    return null
  }
}
