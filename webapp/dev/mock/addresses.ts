// Each invoice its own address, as BTCPay gives one: a Bitcoin regtest or a Monero stagenet address with a valid checksum,
// so a wallet on those test networks takes it, derived from the invoice id and payable by nobody here.
import { createHash } from "node:crypto"
import { ed25519 } from "@noble/curves/ed25519"
import { keccak_256 } from "@noble/hashes/sha3"

// BIP-173: the regtest prefix, and bech32's alphabet and checksum generator
const REGTEST_HRP = "bcrt"
const WITNESS_V0 = 0
const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
const BECH32_GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
const P2WPKH_BYTES = 20

function polymod(values: number[]): number {
  let chk = 1
  for (const v of values) {
    const top = chk >>> 25
    chk = ((chk & 0x1ffffff) << 5) ^ v
    BECH32_GENERATOR.forEach((g, i) => { if ((top >>> i) & 1) chk ^= g })
  }
  return chk
}

const hrpExpand = (hrp: string) => [...[...hrp].map((c) => c.charCodeAt(0) >>> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)]

function toFiveBits(bytes: Uint8Array): number[] {
  const out: number[] = []
  let acc = 0
  let bits = 0
  for (const b of bytes) {
    acc = (acc << 8) | b
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out.push((acc >>> bits) & 31)
    }
  }
  if (bits > 0) out.push((acc << (5 - bits)) & 31)
  return out
}

function regtestAddress(program: Uint8Array): string {
  const data = [WITNESS_V0, ...toFiveBits(program)]
  const mod = polymod([...hrpExpand(REGTEST_HRP), ...data, 0, 0, 0, 0, 0, 0]) ^ 1
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31)
  return `${REGTEST_HRP}1${[...data, ...checksum].map((v) => BECH32[v]).join("")}`
}

// Monero's stagenet standard address: network byte 24, the public spend and view keys, and 4 bytes of keccak-256 checksum,
// in Monero's base58, which encodes each 8-byte block alone
const STAGENET_STANDARD = 24
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
const FULL_BLOCK = 8
// the characters a block of n bytes takes
const BLOCK_CHARS = [0, 2, 3, 5, 6, 7, 9, 10, 11]
const CHECKSUM_BYTES = 4

function base58Block(block: Uint8Array): string {
  let n = block.reduce((acc, b) => acc * 256n + BigInt(b), 0n)
  let text = ""
  for (let i = 0; i < BLOCK_CHARS[block.length]; i++) {
    text = BASE58[Number(n % 58n)] + text
    n /= 58n
  }
  return text
}

function moneroBase58(bytes: Uint8Array): string {
  let text = ""
  for (let at = 0; at < bytes.length; at += FULL_BLOCK) text += base58Block(bytes.slice(at, at + FULL_BLOCK))
  return text
}

// a private key is a scalar below the group order; its public key is that multiple of the base point
function publicKey(seed: Uint8Array): Uint8Array {
  const scalar = seed.reduceRight((acc, b) => acc * 256n + BigInt(b), 0n) % ed25519.Point.Fn.ORDER
  return ed25519.Point.BASE.multiply(scalar).toBytes()
}

function stagenetAddress(seed: Uint8Array): string {
  const spend = publicKey(seed.slice(0, 32))
  const view = publicKey(keccak_256(seed.slice(0, 32)))
  const body = new Uint8Array([STAGENET_STANDARD, ...spend, ...view])
  return moneroBase58(new Uint8Array([...body, ...keccak_256(body).slice(0, CHECKSUM_BYTES)]))
}

export function addressFor(method: "btc" | "xmr", invoiceId: string): string {
  const seed = createHash("sha512").update(`${method} ${invoiceId}`).digest()
  return method === "btc" ? regtestAddress(seed.subarray(0, P2WPKH_BYTES)) : stagenetAddress(seed)
}
