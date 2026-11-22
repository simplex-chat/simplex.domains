// Contract Appendix C: the order and name messages with `terms`, as the service records them in its vectors. The
// page's message format is checked against them, and its builders sign the same inputs, which only the same message bytes
// give the same signatures for.
import { readFileSync } from "node:fs"
import { join } from "node:path"
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

type Kind = "order" | "name"
type Vector = { kind: Kind; terms: string; text: string; digest: Hex; signature: Hex }
interface Recorded {
  owner: string
  order: { label: string; labelHash: string; length: number; duration: number; commitment: string; sealed: string; sealedHash: string; resolver: string; registrationId: string; timestamp: number }
  messages: (Omit<Vector, "kind" | "terms"> & { kind: Kind | "find"; terms: string | null })[]
}

const DIR = process.env.STORE_FIXTURES
const RECORDED: Recorded | null = DIR ? JSON.parse(readFileSync(join(DIR, "vectors-signatures.json"), "utf8")) as Recorded : null
const OWNER = RECORDED?.owner ?? ""
const { label: LABEL, duration: DURATION, resolver: RESOLVER, registrationId: REGISTRATION_ID, timestamp: TIMESTAMP, labelHash: LABEL_HASH, commitment: COMMITMENT, sealed: SEALED, sealedHash: SEALED_HASH } =
  RECORDED?.order ?? { label: "", duration: 0, resolver: "", registrationId: "", timestamp: 0, labelHash: "", commitment: "", sealed: "", sealedHash: "" }
const VECTORS: Vector[] = (RECORDED?.messages ?? []).flatMap((m) => m.kind === "find" || m.terms === null ? [] : [{ ...m, kind: m.kind, terms: m.terms }])
const PLAIN = VECTORS.find((v) => !v.terms.startsWith("community/"))?.terms ?? ""

// The contract's formats: `simplex.domains order <labelHash> <length> <duration> <commitment> <sha256(sealed)> <terms> <timestamp>`,
// and for name the registration id after the kind.
function messageText(kind: Kind, terms: string): string {
  const fields = `${LABEL_HASH} ${LABEL.length} ${DURATION} ${COMMITMENT} ${SEALED_HASH} ${terms} ${TIMESTAMP}`
  return kind === "order" ? `simplex.domains order ${fields}` : `simplex.domains ${kind} ${REGISTRATION_ID} ${fields}`
}

afterEach(() => vi.restoreAllMocks())

describe.skipIf(!RECORDED)("Appendix C inputs", () => {
  it("derives the owner from the fixture owner code", () => {
    expect(formatOwnerCode(ENTROPY)).toBe(OWNER_CODE)
    expect(checksumAddress(WALLET.address)).toBe(OWNER)
  })

  it("hashes the label and builds the commitment with no links at the service's fixture resolver", () => {
    expect(hex(labelHash(LABEL))).toBe(LABEL_HASH)
    const commitment = makeCommitment({
      label: LABEL, tld: "simplex", owner: WALLET.address, duration: BigInt(DURATION), secret: commitmentSecret(WALLET.seed, LABEL),
      resolver: fromHex(RESOLVER), contactLink: null, channelLink: null,
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

describe.skipIf(!RECORDED)("Appendix C vectors", () => {
  const account = privateKeyToAccount(hex(WALLET.privateKey) as Hex)

  it.each(VECTORS)("$kind with terms $terms", async ({ kind, terms, text, digest, signature }) => {
    expect(messageText(kind, terms)).toBe(text)
    expect(hashMessage(text)).toBe(digest)
    expect(await account.signMessage({ message: text })).toBe(signature)
    expect(hex(signDigest(WALLET.privateKey, personalDigest(text)))).toBe(signature)
    expect(await recoverMessageAddress({ message: text, signature })).toBe(OWNER)
  })
})

describe.skipIf(!RECORDED)("the page's builders reproduce Appendix C", () => {
  const YEARS = 2
  const CHAIN = { resolver: RESOLVER, sponsor: "0x9a676e781a523b5d0c0e43731313a708cb607508", chainId: 31337, tld: "simplex" }
  // the term's start that leaves the vector's free days at its timestamp
  const TERM_START = TIMESTAMP + DURATION - YEARS * YEAR_S
  const NO_LINKS = { contact: "", channel: "" }
  const vector = (kind: Kind, terms: string) => VECTORS.find((v) => v.kind === kind && v.terms === terms)!
  const TERMS = [...new Set(VECTORS.map((v) => v.terms))]
  let sent: Record<string, unknown>[]
  const TO_SIGN = { type: "read", intentNonce: 0, acceptance: { community: false, policy: CHAIN.sponsor, termsHash: `0x${PLAIN}`, nonce: 0 } }

  // the vector's clock and zero IV, storage for the order kept, and a service that answers a selection with its view
  async function builders() {
    vi.useFakeTimers({ toFake: ["Date"], now: TIMESTAMP * 1000 })
    vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => array)
    const data = new Map<string, string>()
    vi.stubGlobal("window", { localStorage: {
      get length() { return data.size }, key: (i: number) => [...data.keys()][i] ?? null, getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k),
    } })
    sent = []
    vi.stubGlobal("fetch", async (path: string, init?: RequestInit) => {
      if (path === "/api/config") return new Response(JSON.stringify({ stripePublishableKey: null, names: { codesOnly: false, ...CHAIN, termStart: TERM_START } }), { status: 200 })
      if (path.startsWith(`/api/name/${LABEL_HASH}/sign?`)) return new Response(JSON.stringify(TO_SIGN), { status: 200 })
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      sent.push(body)
      return new Response(JSON.stringify({
        id: REGISTRATION_ID, version: 2, phase: { type: "queued" }, label: null, owner: OWNER, years: YEARS, price: 10000, payment: { type: "invoice", method: "btc" }, balance: null,
        latePayment: null, commitTx: null, registerTx: null, community: null, ...body.fields as Record<string, unknown>,
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

  it.each(TERMS)("order with terms %s", async (terms) => {
    const { flow } = await builders()
    const { request: { reveal, ...request } } = await flow.orderRequest(draft(terms))
    expect(request).toEqual({ labelHash: LABEL_HASH, length: LABEL.length, duration: DURATION, owner: OWNER, commitment: COMMITMENT, sealed: SEALED, terms, timestamp: TIMESTAMP, signature: vector("order", terms).signature })
    expect(reveal.label).toBe(LABEL)
  })

  it.each(TERMS)("name with terms %s", async (terms) => {
    const { flow, store } = await builders()
    const built = await flow.orderRequest(draft(terms))
    const record = flow.recordFor(draft(terms), built, "btc", 10000, { registrationId: REGISTRATION_ID, invoiceId: "inv" })
    store.saveOrder(record)
    await flow.selectName(record, draft(terms), built)
    const agreed = { communityName: terms.startsWith("community/"), termsHash: `0x${terms.replace("community/", "")}` }
    const { reveal, ...name } = sent[0]
    expect(name).toEqual({ fields: { labelHash: LABEL_HASH, length: LABEL.length, duration: DURATION, commitment: COMMITMENT, sealed: SEALED, terms: agreed }, timestamp: TIMESTAMP, signature: vector("name", terms).signature })
    expect(reveal).toMatchObject({ label: LABEL })
  })
})
