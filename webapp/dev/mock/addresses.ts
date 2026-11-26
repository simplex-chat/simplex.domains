// Each invoice its own address, as the service gives one, with the proof the page checks it by: derived from the dev keys
// of the store service's recorded fixtures (simplex-chat tests/fixtures/store-service/rest-api/deployment.json), which
// LOCAL in src/config.ts holds.
import { createHash } from "node:crypto"
import { ed25519 } from "@noble/curves/ed25519"
import { bytesToNumberLE, numberToBytesBE, numberToBytesLE } from "@noble/curves/utils"
import { hmac } from "@noble/hashes/hmac"
import { sha256, sha512 } from "@noble/hashes/sha2"
import { keccak_256 } from "@noble/hashes/sha3"
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils"
import { base58xmr } from "@scure/base"
import { HDKey } from "@scure/bip32"
import type { AddressProof } from "../../src/api.ts"
import { hashToScalar, moneroKeys, p2wpkh } from "../../src/crypto/payees.ts"

export const DEV_XPUB = "tpubDC8msFGeGuwnKG9Upg7DM2b4DaRqg3CUZa5g8v2SRQ6K4NSkxUgd7HsL2XVWbVm39yBA4LAxysQAm397zwQSQoQgewGiYZqrA9DsP4zbQ1M"
export const TESTNET_VERSIONS = { private: 0x04358394, public: 0x043587cf }
const DEV_HRP = "bcrt"
export const DEV_MONERO_PRIMARY = "52jzuBBUMty3xPL3JsQxGP74LDuV6E1LS8Zda1PbdqQjGzFmH6N9ep9McbFKMALujVT9S5mKpbEgC5VPhfoAiVj8LdAqbp6"
const DEV_VIEW_KEY = hexToBytes("fd5c0d25f8f994268079a4f7844274dc870a7c2b88fbfc24ba318375e1d9430f")
const STAGENET_SUBADDRESS = 36
const INDEX_BYTES = 4
const KEY_BYTES = 32
const CHECKSUM_BYTES = 4
const NON_HARDENED = 2 ** 31
const G = ed25519.Point.BASE

type BitcoinProof = Extract<AddressProof, { type: "btc" }>
type MoneroProof = Extract<AddressProof, { type: "xmr" }>
export interface Payee<P extends AddressProof = AddressProof> { address: string; addressProof: P }

export function bitcoinPayee(branch: HDKey, hrp: string, index: number): Payee<BitcoinProof> {
  const il = hmac(sha512, branch.chainCode!, concatBytes(branch.publicKey!, numberToBytesBE(index, INDEX_BYTES))).slice(0, KEY_BYTES)
  return { address: p2wpkh(hrp, branch.deriveChild(index).publicKey!), addressProof: { type: "btc", keyTweak: bytesToHex(il) } }
}

export const devReceiving = HDKey.fromExtendedKey(DEV_XPUB, TESTNET_VERSIONS).deriveChild(0)
const otherReceiving = HDKey.fromMasterSeed(sha256(utf8ToBytes("another Bitcoin wallet")), TESTNET_VERSIONS).deriveChild(0)

const scalarHex = (v: bigint) => bytesToHex(numberToBytesLE(v, KEY_BYTES))
interface MoneroWallet { spendKey: typeof G; viewKey: Uint8Array }
const devWallet: MoneroWallet = { spendKey: ed25519.Point.fromBytes(moneroKeys(DEV_MONERO_PRIMARY)!.spend), viewKey: DEV_VIEW_KEY }
const otherMonero: MoneroWallet = {
  spendKey: G.multiply(hashToScalar(utf8ToBytes("another Monero wallet's spend key"))),
  viewKey: numberToBytesLE(hashToScalar(utf8ToBytes("another Monero wallet's view key")), KEY_BYTES),
}

export function moneroPayee(account: number, index: number, { spendKey, viewKey } = devWallet): Payee<MoneroProof> {
  const viewSecret = bytesToNumberLE(viewKey)
  const m = hashToScalar(utf8ToBytes("SubAddr\0"), viewKey, numberToBytesLE(account, INDEX_BYTES), numberToBytesLE(index, INDEX_BYTES))
  const D = spendKey.add(G.multiply(m))
  const C = D.multiply(viewSecret)
  const k = hashToScalar(utf8ToBytes("simplex.domains view proof nonce"), viewKey, D.toBytes())
  const c = hashToScalar(utf8ToBytes("simplex.domains view proof"), G.multiply(viewSecret).toBytes(), D.toBytes(), C.toBytes(), G.multiply(k).toBytes(), D.multiply(k).toBytes())
  const s = ed25519.Point.Fn.create(k - c * viewSecret)
  const body = concatBytes(new Uint8Array([STAGENET_SUBADDRESS]), D.toBytes(), C.toBytes())
  return {
    address: base58xmr.encode(concatBytes(body, keccak_256(body).slice(0, CHECKSUM_BYTES))),
    addressProof: { type: "xmr", spendTweak: scalarHex(m), viewProof: { challenge: scalarHex(c), response: scalarHex(s) } },
  }
}

export function payeeFor(method: "btc" | "xmr", invoiceId: string, otherWallet = false): Payee {
  const index = createHash("sha256").update(invoiceId).digest().readUInt32BE(0) % (NON_HARDENED - 1) + 1
  return method === "btc" ? bitcoinPayee(otherWallet ? otherReceiving : devReceiving, DEV_HRP, index) : moneroPayee(0, index, otherWallet ? otherMonero : devWallet)
}
