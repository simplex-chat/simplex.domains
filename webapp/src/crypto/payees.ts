import { ed25519 } from "@noble/curves/ed25519"
import { secp256k1 } from "@noble/curves/secp256k1"
import { bytesToNumberLE, equalBytes } from "@noble/curves/utils"
import { ripemd160 } from "@noble/hashes/legacy"
import { sha256 } from "@noble/hashes/sha2"
import { keccak_256 } from "@noble/hashes/sha3"
import { concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils"
import { base58xmr, bech32 } from "@scure/base"

const SCALAR = /^[0-9a-f]{64}$/
const WITNESS_V0 = 0
const KEY_BYTES = 32
const CHECKSUM_BYTES = 4
const MONERO_ADDRESS_BYTES = 1 + 2 * KEY_BYTES + CHECKSUM_BYTES
const VIEW_PROOF = utf8ToBytes("simplex.domains view proof")
const L = ed25519.Point.Fn.ORDER
const G = ed25519.Point.BASE

export interface ViewProof { challenge: string; response: string }

export const p2wpkh = (hrp: string, publicKey: Uint8Array) => bech32.encode(hrp, [WITNESS_V0, ...bech32.toWords(ripemd160(sha256(publicKey)))])

export function bitcoinProven(address: string, keyTweak: string, receiveKeys: string[], hrp: string): boolean {
  if (!SCALAR.test(keyTweak)) return false
  const t = BigInt(`0x${keyTweak}`)
  if (t === 0n || t >= secp256k1.Point.Fn.ORDER) return false
  const tweak = secp256k1.Point.BASE.multiply(t)
  return receiveKeys.some((key) => {
    const derived = secp256k1.Point.fromHex(key.slice(2)).add(tweak)
    return !derived.is0() && p2wpkh(hrp, derived.toBytes(true)) === address
  })
}

export const hashToScalar = (...parts: Uint8Array[]) => bytesToNumberLE(keccak_256(concatBytes(...parts))) % L

const scalarOf = (hex: string) => {
  if (!SCALAR.test(hex)) return null
  const value = bytesToNumberLE(hexToBytes(hex))
  return value < L ? value : null
}

const pointOf = (bytes: Uint8Array) => {
  try {
    return ed25519.Point.fromBytes(bytes)
  } catch {
    return null
  }
}

export function moneroKeys(address: string): { prefix: number; spend: Uint8Array; view: Uint8Array } | null {
  let bytes: Uint8Array
  try {
    bytes = base58xmr.decode(address)
  } catch {
    return null
  }
  if (bytes.length !== MONERO_ADDRESS_BYTES) return null
  const body = bytes.slice(0, -CHECKSUM_BYTES)
  if (!equalBytes(keccak_256(body).slice(0, CHECKSUM_BYTES), bytes.slice(-CHECKSUM_BYTES))) return null
  return { prefix: bytes[0], spend: body.slice(1, 1 + KEY_BYTES), view: body.slice(1 + KEY_BYTES) }
}

export function moneroProven(address: string, spendTweak: string, viewProof: ViewProof, primaryAddresses: string[], subaddressPrefix: number): boolean {
  const sub = moneroKeys(address)
  const [m, c, s] = [scalarOf(spendTweak), scalarOf(viewProof.challenge), scalarOf(viewProof.response)]
  if (sub === null || sub.prefix !== subaddressPrefix || m === null || c === null || s === null) return false
  const [D, C] = [pointOf(sub.spend), pointOf(sub.view)]
  if (D === null || C === null || C.is0() || !C.isTorsionFree()) return false
  return primaryAddresses.some((primary) => {
    const keys = moneroKeys(primary)!
    const [B, A] = [ed25519.Point.fromBytes(keys.spend), ed25519.Point.fromBytes(keys.view)]
    if (!B.add(G.multiplyUnsafe(m)).equals(D)) return false
    const R1 = G.multiplyUnsafe(s).add(A.multiplyUnsafe(c))
    const R2 = D.multiplyUnsafe(s).add(C.multiplyUnsafe(c))
    return hashToScalar(VIEW_PROOF, A.toBytes(), D.toBytes(), C.toBytes(), R1.toBytes(), R2.toBytes()) === c
  })
}
