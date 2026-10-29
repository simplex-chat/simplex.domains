// Contract Appendix C: the order, name and spend messages with `terms`, built from the contract's formats rather than
// src/flow.ts, so the page's builders are checked against these values and not the other way round. The builders then
// sign the same inputs, which only the same message bytes give the same signatures for.
import { hashMessage, recoverMessageAddress, type Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { afterEach, describe, expect, it, vi } from "vitest"
import { formatOwnerCode } from "../src/crypto/code.ts"
import { commitmentSecret, labelHash, makeCommitment, YEAR_S } from "../src/crypto/registration.ts"
import { seal, unseal } from "../src/crypto/seal.ts"
import { checksumAddress, hex, personalDigest, signDigest, walletFromEntropy } from "../src/crypto/wallet.ts"

const fromHex = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"))
const ENTROPY = fromHex("6f2d1c9a4b7e3f80d15a2c6e9b04f7a3")
const WALLET = walletFromEntropy(ENTROPY)
const OWNER_CODE = "SN-DWPHS-6JBFR-ZR1MA-T5HQ9-P17QM-F5GM5"
const OWNER = "0x014f9c09CcEeDEF1B713110d04D3a07d5B5D9b73"

const LABEL = "alicebakery"
const DURATION = 69292800
const RESOLVER = "0x2279b7a0a67db372996a5fab50d91eaa73d2ebe6"
const REGISTRATION_ID = "t2Jk8RmQ4vXw9NcP3yLb6g"
const TIMESTAMP = 1792828800

const LABEL_HASH = "0xbcc46b7948ff6be55bc3ff4db5bc4be16638f29e818a89244dae11caaed7c9c6"
const COMMITMENT = "0x5e62a4cb7da596cb38169a6a552b5f69db2acee279b53be6693a78e03c3dfaa5"
const SEALED = "AAAAAAAAAAAAAAAACWgxqMk-UKfpra_Zh6vc4KNBR6SX1WYpGb4COoWCCbM0bisYCH14WLzghp8hqi_-KyXSi4qf_DAdP_M4bFetD0s"
const SEALED_HASH = "0x22709445157a2a1f7cb7e284e3ccf6c7ebc3b4d857002af452853c4a65907fe2"

type Kind = "order" | "name" | "spend"
type Vector = { kind: Kind; terms: string; text: string; digest: Hex; signature: Hex }

const VECTORS: Vector[] = [
  {
    kind: "order", terms: "2026-10-23",
    text: "simplex.domains order 0xbcc46b7948ff6be55bc3ff4db5bc4be16638f29e818a89244dae11caaed7c9c6 11 69292800 0x5e62a4cb7da596cb38169a6a552b5f69db2acee279b53be6693a78e03c3dfaa5 0x22709445157a2a1f7cb7e284e3ccf6c7ebc3b4d857002af452853c4a65907fe2 2026-10-23 1792828800",
    digest: "0x50dfb031e558f78b83fa07c7ea0207c02a98d73751e43bc754dd26b7bc92b840",
    signature: "0x17107b11494e25098efc348aca64a2469ffb832bcc79dc57377a1b26a4004b6701ad73648f50af8b39d4079820a3de7e681ddf15f8cf15b5cff02b4a48cf1fe61c",
  },
  {
    kind: "order", terms: "2026-10-23/community",
    text: "simplex.domains order 0xbcc46b7948ff6be55bc3ff4db5bc4be16638f29e818a89244dae11caaed7c9c6 11 69292800 0x5e62a4cb7da596cb38169a6a552b5f69db2acee279b53be6693a78e03c3dfaa5 0x22709445157a2a1f7cb7e284e3ccf6c7ebc3b4d857002af452853c4a65907fe2 2026-10-23/community 1792828800",
    digest: "0xf8521525761939c4cef8979cb54217e9e32b1a57999fc2f03e486f4eb1903802",
    signature: "0x03eccb591b79ab4e3e6f22ccbeb77a6ac32c6dad8cb318557836258c390bc31d78852a3279c6c8cc2ef8d1025641d45ba4101f54dfd84c264deb2ab391c1cbc61c",
  },
  {
    kind: "name", terms: "2026-10-23",
    text: "simplex.domains name t2Jk8RmQ4vXw9NcP3yLb6g 0xbcc46b7948ff6be55bc3ff4db5bc4be16638f29e818a89244dae11caaed7c9c6 11 69292800 0x5e62a4cb7da596cb38169a6a552b5f69db2acee279b53be6693a78e03c3dfaa5 0x22709445157a2a1f7cb7e284e3ccf6c7ebc3b4d857002af452853c4a65907fe2 2026-10-23 1792828800",
    digest: "0x01eda78f875428396a940b658b910b6eb6dc0bce82860c17d59f8f16e7767d25",
    signature: "0x1d29abf2489da963d59d0982074b5af770efbaf96be3c756afbd6a7fea672b507e756944da0901724e2a5d7cfe2419ccb7573310ae65e65f4fd35d7c6fe494b51c",
  },
  {
    kind: "name", terms: "2026-10-23/community",
    text: "simplex.domains name t2Jk8RmQ4vXw9NcP3yLb6g 0xbcc46b7948ff6be55bc3ff4db5bc4be16638f29e818a89244dae11caaed7c9c6 11 69292800 0x5e62a4cb7da596cb38169a6a552b5f69db2acee279b53be6693a78e03c3dfaa5 0x22709445157a2a1f7cb7e284e3ccf6c7ebc3b4d857002af452853c4a65907fe2 2026-10-23/community 1792828800",
    digest: "0x4f1af02904f9f8863e92169f6e1a1d6733a3a25c5d22ffde7ac00f09a660c022",
    signature: "0x30d027224b85cd9ac638edec1266748f21f46279eda72e68448f97b8fce73ca06c401035ad5416fc1e48f39646d0637fcaad1588ec74562ff842821b33e299361b",
  },
  {
    kind: "spend", terms: "2026-10-23",
    text: "simplex.domains spend t2Jk8RmQ4vXw9NcP3yLb6g 0xbcc46b7948ff6be55bc3ff4db5bc4be16638f29e818a89244dae11caaed7c9c6 11 69292800 0x5e62a4cb7da596cb38169a6a552b5f69db2acee279b53be6693a78e03c3dfaa5 0x22709445157a2a1f7cb7e284e3ccf6c7ebc3b4d857002af452853c4a65907fe2 2026-10-23 1792828800",
    digest: "0x109f0bd4f5eb1aa054f17c82a0b04dbd5d1e7b23c5ee91cf69464fb1435eb034",
    signature: "0x20e930097b35350861332afa4b0b5dcff746aa879875269cc784575e6bb871711d3f6b1e11437d0a616a37a8b5b1ebbdd4c98aee04e09405ac3fa55a6af6ff831b",
  },
  {
    kind: "spend", terms: "2026-10-23/community",
    text: "simplex.domains spend t2Jk8RmQ4vXw9NcP3yLb6g 0xbcc46b7948ff6be55bc3ff4db5bc4be16638f29e818a89244dae11caaed7c9c6 11 69292800 0x5e62a4cb7da596cb38169a6a552b5f69db2acee279b53be6693a78e03c3dfaa5 0x22709445157a2a1f7cb7e284e3ccf6c7ebc3b4d857002af452853c4a65907fe2 2026-10-23/community 1792828800",
    digest: "0xd114398466a7a6d7d9a183feb4624e06c41d1dcdfb6b69e896ff9d74c70845c3",
    signature: "0x90d2ab549b2cf5fd51442ac3f410b934e7fa45bd12853cfbfa2f8ab4876ed5600b9fe3a90459140f180949353e7dc3f56cd1447de31ae5c05e12f7bf6a113f061c",
  },
]

// The contract's formats: `simplex.domains order <labelHash> <length> <duration> <commitment> <sha256(sealed)> <terms> <timestamp>`,
// and for name and spend the registration id after the kind.
function messageText(kind: Kind, terms: string): string {
  const fields = `${LABEL_HASH} ${LABEL.length} ${DURATION} ${COMMITMENT} ${SEALED_HASH} ${terms} ${TIMESTAMP}`
  return kind === "order" ? `simplex.domains order ${fields}` : `simplex.domains ${kind} ${REGISTRATION_ID} ${fields}`
}

afterEach(() => vi.restoreAllMocks())

describe("Appendix C inputs", () => {
  it("derives the owner from the fixture owner code", () => {
    expect(formatOwnerCode(ENTROPY)).toBe(OWNER_CODE)
    expect(checksumAddress(WALLET.address)).toBe(OWNER)
  })

  it("hashes the label and builds the commitment with no links at the service's fixture resolver", () => {
    expect(hex(labelHash(LABEL))).toBe(LABEL_HASH)
    const commitment = makeCommitment({
      label: LABEL, tld: "simplex", owner: WALLET.address, duration: BigInt(DURATION), secret: commitmentSecret(WALLET.seed, LABEL),
      resolver: fromHex(RESOLVER), contactLinks: [], channelLinks: [],
    })
    expect(hex(commitment)).toBe(COMMITMENT)
  })

  it("seals the label with no links under a zero IV, and hashes the sealed text's ASCII bytes", async () => {
    // getRandomValues only fills the IV here, so returning the array untouched leaves it zero
    vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => array)
    expect(await seal(WALLET.seed, { label: LABEL, contact: "", channel: "" })).toBe(SEALED)
    expect(await unseal(WALLET.seed, SEALED)).toEqual({ label: LABEL, contact: "", channel: "" })
    const digest = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(SEALED))).toString("hex")
    expect(`0x${digest}`).toBe(SEALED_HASH)
  })
})

describe("Appendix C vectors", () => {
  const account = privateKeyToAccount(hex(WALLET.privateKey) as Hex)

  it.each(VECTORS)("$kind with terms $terms", async ({ kind, terms, text, digest, signature }) => {
    expect(messageText(kind, terms)).toBe(text)
    expect(hashMessage(text)).toBe(digest)
    expect(await account.signMessage({ message: text })).toBe(signature)
    expect(hex(signDigest(WALLET.privateKey, personalDigest(text)))).toBe(signature)
    expect(await recoverMessageAddress({ message: text, signature })).toBe(OWNER)
  })
})

describe("the page's builders reproduce Appendix C", () => {
  const YEARS = 2
  const CHAIN = { resolver: RESOLVER, sponsor: "0x9a676e781a523b5d0c0e43731313a708cb607508", chainId: 31337, tld: "simplex" }
  // the term's start that leaves the vector's free days at its timestamp
  const TERM_START = TIMESTAMP + DURATION - YEARS * YEAR_S
  const NO_LINKS = { contact: "", channel: "" }
  const vector = (kind: Kind, terms: string) => VECTORS.find((v) => v.kind === kind && v.terms === terms)!
  const TERMS = [...new Set(VECTORS.map((v) => v.terms))]
  let sent: Record<string, unknown>[]

  // the vector's clock and zero IV, storage for the order kept, and a service that answers a move with its view
  async function builders() {
    vi.useFakeTimers({ toFake: ["Date"], now: TIMESTAMP * 1000 })
    vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => array)
    const data = new Map<string, string>()
    vi.stubGlobal("window", { localStorage: {
      get length() { return data.size }, key: (i: number) => [...data.keys()][i] ?? null, getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k),
    } })
    sent = []
    vi.stubGlobal("fetch", async (_: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      sent.push(body)
      return new Response(JSON.stringify({
        id: REGISTRATION_ID, version: 2, moves: 1, phase: "queued", label: null, owner: OWNER, years: YEARS, price: 10000, fromBalance: 0, balance: null, latePayment: null,
        commitTx: null, registerTx: null, revealAfter: null, revealBefore: null, intentNonce: null, unread: [], expiresAt: null, error: null, linksRefused: false,
        community: null, ...CHAIN, ...body,
      }), { status: 200 })
    })
    vi.resetModules()
    return { flow: await import("../src/flow.ts"), store: await import("../src/store.ts") }
  }
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const draft = (terms: string) => ({ label: LABEL, links: NO_LINKS, chain: CHAIN, years: YEARS, termStart: TERM_START, ownerCode: OWNER_CODE, terms })
  const quote = { status: "available" as const, price: 10000, currency: "usd", years: YEARS, termStart: TERM_START, community: null, terms: { version: "2026-10-23", url: "https://simplex.chat/" }, ...CHAIN }

  it.each(TERMS)("order with terms %s", async (terms) => {
    const { flow } = await builders()
    const { request } = await flow.orderRequest(draft(terms))
    expect(request).toEqual({ labelHash: LABEL_HASH, length: LABEL.length, duration: DURATION, owner: OWNER, commitment: COMMITMENT, sealed: SEALED, terms, timestamp: TIMESTAMP, signature: vector("order", terms).signature })
  })

  it.each(TERMS)("name with terms %s", async (terms) => {
    const { flow, store } = await builders()
    const built = await flow.orderRequest(draft(terms))
    const record = flow.recordFor(draft(terms), built, "btc", 10000, { registrationId: REGISTRATION_ID, invoiceId: "inv" })
    store.saveOrder(record)
    await flow.retargetOrder(record, LABEL, NO_LINKS, quote, terms)
    expect(sent[0]).toEqual({ labelHash: LABEL_HASH, length: LABEL.length, duration: DURATION, commitment: COMMITMENT, sealed: SEALED, terms, timestamp: TIMESTAMP, signature: vector("name", terms).signature })
  })

  it.each(TERMS)("spend with terms %s", async (terms) => {
    const { flow } = await builders()
    const source = { registrationId: REGISTRATION_ID, ownerCode: OWNER_CODE }
    const { spend } = await flow.spendRequest(source, flow.spendDraft(source, LABEL, NO_LINKS, quote, terms), 10000, 20000, "btc")
    expect(spend).toEqual({ labelHash: LABEL_HASH, length: LABEL.length, duration: DURATION, commitment: COMMITMENT, sealed: SEALED, price: 10000, balance: 20000, terms, timestamp: TIMESTAMP, signature: vector("spend", terms).signature })
  })
})
