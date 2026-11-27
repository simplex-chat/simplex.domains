import { ed25519 } from "@noble/curves/ed25519"
import { secp256k1 } from "@noble/curves/secp256k1"
import { bytesToNumberLE, numberToBytesLE } from "@noble/curves/utils"
import { keccak_256 } from "@noble/hashes/sha3"
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils"
import { base58xmr } from "@scure/base"
import { describe, expect, it } from "vitest"
import { type AddressProof, addressProven, type InvoiceView } from "../src/api.ts"
import { LOCAL } from "../src/config.ts"
import { bitcoinProven, hashToScalar, moneroKeys, moneroProven, p2wpkh, type ViewProof } from "../src/crypto/payees.ts"
import { BIP173, BIP84, DEV_BITCOIN, DEV_MONERO } from "./payee-vectors.ts"

const L = ed25519.Point.Fn.ORDER
const G = ed25519.Point.BASE
const SECP256K1_ORDER = "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"
const VIEW_PROOF = utf8ToBytes("simplex.domains view proof")
const STAGENET_SUBADDRESS = 36
const MAINNET_SUBADDRESS = 42

const devBitcoin = (address: string, keyTweak: string) => bitcoinProven(address, keyTweak, LOCAL.bitcoinReceiveKeys, LOCAL.bitcoinHrp)
const devMonero = (address: string, spendTweak: string, viewProof: ViewProof, prefix = LOCAL.moneroSubaddressPrefix) =>
  moneroProven(address, spendTweak, viewProof, LOCAL.moneroPrimaryAddresses, prefix)
const scalarHex = (v: bigint) => bytesToHex(numberToBytesLE(v, 32))
const plus = (hex: string, n: bigint) => scalarHex(bytesToNumberLE(hexToBytes(hex)) + n)
const subaddress = (D: Uint8Array, C: Uint8Array) => {
  const body = concatBytes(new Uint8Array([STAGENET_SUBADDRESS]), D, C)
  return base58xmr.encode(concatBytes(body, keccak_256(body).slice(0, 4)))
}

describe("a Bitcoin address", () => {
  it.each(BIP173.addresses)("is BIP-173's P2WPKH of a public key under its prefix ($hrp)", ({ hrp, address }) => {
    expect(p2wpkh(hrp, hexToBytes(BIP173.publicKey))).toBe(address)
  })

  it("is proven by its tweak from BIP-84's receiving key, for the first two addresses BIP-32 derives from it", () => {
    for (const { address, keyTweak } of BIP84.invoices) expect(bitcoinProven(address, keyTweak, [BIP84.receiveKey], "bc"), address).toBe(true)
  })

  it("is proven by its tweak from one of the page's receiving keys, for each of the dev wallet's recorded invoices", () => {
    expect([LOCAL.bitcoinHrp, LOCAL.bitcoinReceiveKeys]).toEqual(["bcrt", [DEV_BITCOIN.receiveKey]])
    for (const { address, keyTweak } of DEV_BITCOIN.invoices) expect(devBitcoin(address, keyTweak), address).toBe(true)
    const other = `0x${secp256k1.Point.BASE.multiply(7n).toHex(true)}`
    expect(bitcoinProven(DEV_BITCOIN.invoices[0].address, DEV_BITCOIN.invoices[0].keyTweak, [other, DEV_BITCOIN.receiveKey], "bcrt"), "a key among others").toBe(true)
  })

  it("is not proven by another invoice's tweak, under another prefix, by another wallet's key, or without keys", () => {
    const [one, two] = DEV_BITCOIN.invoices
    expect(devBitcoin(one.address, two.keyTweak)).toBe(false)
    expect(bitcoinProven(one.address, one.keyTweak, [DEV_BITCOIN.receiveKey], "bc")).toBe(false)
    expect(bitcoinProven(one.address, one.keyTweak, [BIP84.receiveKey], "bcrt")).toBe(false)
    expect(bitcoinProven(one.address, one.keyTweak, [], "bcrt")).toBe(false)
  })

  it("is not proven by a tweak that is not 32 bytes of lowercase hex below the curve's order, or zero", () => {
    const { address, keyTweak } = DEV_BITCOIN.invoices[0]
    for (const bad of [`0x${keyTweak}`, keyTweak.toUpperCase(), keyTweak.slice(1), `${keyTweak}00`, SECP256K1_ORDER, "f".repeat(64), "0".repeat(64)]) {
      expect(devBitcoin(address, bad), bad).toBe(false)
    }
  })
})

describe("a Monero subaddress", () => {
  it("is of the page's primary address, which is the dev wallet's", () => {
    expect([LOCAL.moneroSubaddressPrefix, LOCAL.moneroPrimaryAddresses]).toEqual([STAGENET_SUBADDRESS, [DEV_MONERO.primaryAddress]])
  })

  it.each(DEV_MONERO.invoices)("is proven by its spend tweak and view proof from the page's primary address ($accountIndex, $addressIndex)", ({ address, spendTweak, viewProof }) => {
    expect(devMonero(address, spendTweak, viewProof)).toBe(true)
  })

  it("is not proven under the mainnet's prefix, without the page's primary address, or with another invoice's tweak or proof", () => {
    const [one, two] = DEV_MONERO.invoices
    expect(devMonero(one.address, one.spendTweak, one.viewProof, MAINNET_SUBADDRESS)).toBe(false)
    expect(moneroProven(one.address, one.spendTweak, one.viewProof, [], STAGENET_SUBADDRESS)).toBe(false)
    expect(devMonero(one.address, two.spendTweak, one.viewProof)).toBe(false)
    expect(devMonero(one.address, one.spendTweak, two.viewProof)).toBe(false)
    expect(devMonero(one.address, one.spendTweak, { ...one.viewProof, challenge: two.viewProof.challenge })).toBe(false)
  })

  it("is not proven by scalars that are not canonical, nor by an address whose checksum fails, nor by the primary address", () => {
    const { address, spendTweak, viewProof } = DEV_MONERO.invoices[0]
    expect(devMonero(address, plus(spendTweak, L), viewProof)).toBe(false)
    expect(devMonero(address, spendTweak, { ...viewProof, response: plus(viewProof.response, L) })).toBe(false)
    expect(devMonero(address, spendTweak, { ...viewProof, challenge: plus(viewProof.challenge, L) })).toBe(false)
    expect(devMonero(address, spendTweak.toUpperCase(), viewProof)).toBe(false)
    const bytes = base58xmr.decode(address)
    bytes[bytes.length - 1] ^= 1
    expect(moneroKeys(base58xmr.encode(bytes)), "a broken checksum").toBeNull()
    expect(devMonero(base58xmr.encode(bytes), spendTweak, viewProof)).toBe(false)
    expect(devMonero(DEV_MONERO.primaryAddress, spendTweak, viewProof)).toBe(false)
  })

  it("is not proven when its view key has a part of small order, though the proof's equation holds for it", () => {
    const a = bytesToNumberLE(hexToBytes(DEV_MONERO.viewKey))
    const A = ed25519.Point.fromBytes(moneroKeys(DEV_MONERO.primaryAddress)!.view)
    expect(G.multiply(a).equals(A), "the dev view key is the primary's").toBe(true)
    const { address, spendTweak } = DEV_MONERO.invoices[0]
    const D = ed25519.Point.fromBytes(moneroKeys(address)!.spend)
    const T = ed25519.Point.fromBytes(hexToBytes(`ec${"ff".repeat(30)}7f`))
    expect([T.is0(), T.double().is0()], "a point of order 2").toEqual([false, true])
    const proofFor = (C: typeof G) => {
      for (let k = 1n; ; k++) {
        const c = hashToScalar(VIEW_PROOF, A.toBytes(), D.toBytes(), C.toBytes(), G.multiply(k).toBytes(), D.multiply(k).toBytes())
        if (c % 2n === 0n) return { c, s: ed25519.Point.Fn.create(k - c * a) }
      }
    }
    const clean = D.multiply(a)
    const honest = proofFor(clean)
    expect(devMonero(subaddress(D.toBytes(), clean.toBytes()), spendTweak, { challenge: scalarHex(honest.c), response: scalarHex(honest.s) }), "a prime-order view key").toBe(true)
    const dirty = clean.add(T)
    const { c, s } = proofFor(dirty)
    const R1 = G.multiplyUnsafe(s).add(A.multiplyUnsafe(c))
    const R2 = D.multiplyUnsafe(s).add(dirty.multiplyUnsafe(c))
    expect(hashToScalar(VIEW_PROOF, A.toBytes(), D.toBytes(), dirty.toBytes(), R1.toBytes(), R2.toBytes()), "the equation holds").toBe(c)
    expect(devMonero(subaddress(D.toBytes(), dirty.toBytes()), spendTweak, { challenge: scalarHex(c), response: scalarHex(s) })).toBe(false)
  })
})

describe("addressProven", () => {
  const btc = DEV_BITCOIN.invoices[0]
  const xmr = DEV_MONERO.invoices[0]
  const btcProof = { type: "btc", keyTweak: btc.keyTweak } as const
  const xmrProof = { type: "xmr", spendTweak: xmr.spendTweak, viewProof: xmr.viewProof } as const
  const invoice = (change: Partial<InvoiceView>): InvoiceView =>
    ({ invoiceId: "inv", status: "open", amount: 10000, currency: "usd", expiresAt: "2026-10-17T12:30:00Z", kind: "name", registration: {} as InvoiceView["registration"], ...change })

  it("takes the proof of the invoice's coin, in the shape the service sends it", () => {
    expect(addressProven(invoice({ cryptoCurrency: "btc", address: btc.address, addressProof: btcProof }))).toBe(true)
    expect(addressProven(invoice({ cryptoCurrency: "xmr", address: xmr.address, addressProof: xmrProof }))).toBe(true)
    expect(addressProven(invoice({ clientSecret: "pi_1_secret_2" })), "a card invoice has no address").toBe(true)
  })

  it("refuses an address without a proof, or with one of another coin", () => {
    const cases: [InvoiceView["cryptoCurrency"], string, AddressProof | undefined][] = [
      ["btc", btc.address, undefined], ["xmr", btc.address, btcProof], ["xmr", xmr.address, undefined], ["btc", xmr.address, xmrProof],
    ]
    for (const [coin, address, addressProof] of cases) {
      expect(addressProven(invoice({ cryptoCurrency: coin, address, addressProof })), JSON.stringify([coin, addressProof])).toBe(false)
    }
  })
})
