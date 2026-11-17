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

const PLAIN = "67b989cccc7ae150142daa4029304c7b7e78ab0a4ccebeba2ec1ef8a30f8147e"
const COMMUNITY = "community/bbc52157d9b12f23af62ae8a7eacf2ea11e7db311fa2ed5bd48ea9ba01f77c4d"

const VECTORS: Vector[] = [
  {
    kind: "order", terms: PLAIN,
    text: `simplex.domains order 0xbcc46b7948ff6be55bc3ff4db5bc4be16638f29e818a89244dae11caaed7c9c6 11 69292800 0x5e62a4cb7da596cb38169a6a552b5f69db2acee279b53be6693a78e03c3dfaa5 0x22709445157a2a1f7cb7e284e3ccf6c7ebc3b4d857002af452853c4a65907fe2 ${PLAIN} 1792828800`,
    digest: "0x2687afde089cba36f420243154bfdd22fe44e8f07c8cfee652bd61cd6d9271fe",
    signature: "0x9fb22e344357679a4deffdd3d75d6bfb6be860e4d2d307661445812dc4e134c051b726fc8ae16aaf4df17c615b2eeac4e10953524691b186bff2e6b68268d0b31b",
  },
  {
    kind: "order", terms: COMMUNITY,
    text: `simplex.domains order 0xbcc46b7948ff6be55bc3ff4db5bc4be16638f29e818a89244dae11caaed7c9c6 11 69292800 0x5e62a4cb7da596cb38169a6a552b5f69db2acee279b53be6693a78e03c3dfaa5 0x22709445157a2a1f7cb7e284e3ccf6c7ebc3b4d857002af452853c4a65907fe2 ${COMMUNITY} 1792828800`,
    digest: "0x456ec129e7612ef629f004f3beaf82a58ebf01d59cc7c4e2616e01a72ca01c65",
    signature: "0x11ade94c79f14bdfde60b23f60f217206b7fd6b29504a2e3020eaef5dabbf24c39330b92099ce6564c36c0a2e484c91a5a9cfa341285a05a169bafbb1dfd1cb01c",
  },
  {
    kind: "name", terms: PLAIN,
    text: `simplex.domains name t2Jk8RmQ4vXw9NcP3yLb6g 0xbcc46b7948ff6be55bc3ff4db5bc4be16638f29e818a89244dae11caaed7c9c6 11 69292800 0x5e62a4cb7da596cb38169a6a552b5f69db2acee279b53be6693a78e03c3dfaa5 0x22709445157a2a1f7cb7e284e3ccf6c7ebc3b4d857002af452853c4a65907fe2 ${PLAIN} 1792828800`,
    digest: "0x9545b17da4a1fcc96d66f53b8358629c5987ec2a67d16e44f4e0a298194dc0e9",
    signature: "0xa1ae312f7178440aaf5a04789d7ed388af7215624b214ea7aa98d43209f0c98e10b64a1c553053e88c3ecd6d21769d34ff9b6a3485e04e2d23bd4b0faabb1dc01c",
  },
  {
    kind: "name", terms: COMMUNITY,
    text: `simplex.domains name t2Jk8RmQ4vXw9NcP3yLb6g 0xbcc46b7948ff6be55bc3ff4db5bc4be16638f29e818a89244dae11caaed7c9c6 11 69292800 0x5e62a4cb7da596cb38169a6a552b5f69db2acee279b53be6693a78e03c3dfaa5 0x22709445157a2a1f7cb7e284e3ccf6c7ebc3b4d857002af452853c4a65907fe2 ${COMMUNITY} 1792828800`,
    digest: "0x5a798c69de346efc5ede90d1b4ff30854ab0eb326539ba9b60eddea1ab08005f",
    signature: "0xdd8794dd1c65c8e11955127408e44cd63cfc8d4b7050d5fee05b65d5abfb8a3b62f6648c2a337183adc822d129b2aba3030c8812cf87b7e969c690fb160a805f1c",
  },
  {
    kind: "spend", terms: PLAIN,
    text: `simplex.domains spend t2Jk8RmQ4vXw9NcP3yLb6g 0xbcc46b7948ff6be55bc3ff4db5bc4be16638f29e818a89244dae11caaed7c9c6 11 69292800 0x5e62a4cb7da596cb38169a6a552b5f69db2acee279b53be6693a78e03c3dfaa5 0x22709445157a2a1f7cb7e284e3ccf6c7ebc3b4d857002af452853c4a65907fe2 ${PLAIN} 1792828800`,
    digest: "0xf643f32bd75923423f92eeee3dc46c6503f4969ad37b66bddfab5587b7e7d62e",
    signature: "0x584dfddcbd6f5a1ccaa0dd60b8f2929f629da471aa4ecae270bd429243f2853c77eff724a4820e95765ca006302c834fdb247d3b1c69c5db4074045c89957f541c",
  },
  {
    kind: "spend", terms: COMMUNITY,
    text: `simplex.domains spend t2Jk8RmQ4vXw9NcP3yLb6g 0xbcc46b7948ff6be55bc3ff4db5bc4be16638f29e818a89244dae11caaed7c9c6 11 69292800 0x5e62a4cb7da596cb38169a6a552b5f69db2acee279b53be6693a78e03c3dfaa5 0x22709445157a2a1f7cb7e284e3ccf6c7ebc3b4d857002af452853c4a65907fe2 ${COMMUNITY} 1792828800`,
    digest: "0x1c02a90eaa2073c155b816d9597ddbe694dfa5ded03caafeb88feb9ed9a077e1",
    signature: "0x61f25926cf4250e6924cfbc63748cc60e01486434984988e8904a655c893afd22f9efabc4587890f522ec91a124f066ba0d9b8acfbba9c836009d8a41609624a1b",
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
        commitTx: null, registerTx: null, revealAfter: null, revealBefore: null, intentNonce: null, acceptance: null, unread: [], expiresAt: null, error: null, linksRefused: false,
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
  const quote = { status: "available" as const, price: 10000, currency: "usd", years: YEARS, termStart: TERM_START, community: null, terms: {
    hash: `0x${PLAIN}`,
    link: "https://git.simplex.chat/simplex-chat/simplex-chat/raw/commit/5fb3fb63fa5a059abf6e397621ba4d7c3618c702/docs/terms.md#sha256=8b6cf03192081aa7b2cd3a82fd665fdd0f28c1ced65792837a5ac2492e6a8070",
  }, ...CHAIN }

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
