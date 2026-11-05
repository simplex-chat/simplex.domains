// Each invoice its own address, as BTCPay gives one: a Bitcoin regtest or a Monero stagenet address with a valid checksum,
// or a signed regtest BOLT11 invoice, so a wallet on those test networks takes it, derived from the invoice id and payable
// by nobody here.
import { createHash } from "node:crypto"
import { ed25519 } from "@noble/curves/ed25519"
import { secp256k1 } from "@noble/curves/secp256k1"
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

function bech32(hrp: string, data: number[]): string {
  const mod = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 1
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31)
  return `${hrp}1${[...data, ...checksum].map((v) => BECH32[v]).join("")}`
}

const regtestAddress = (program: Uint8Array) => bech32(REGTEST_HRP, [WITNESS_V0, ...toFiveBits(program)])

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

// BOLT11: the network and amount in the prefix, then a timestamp, tagged fields and a recoverable signature over them
const LIGHTNING_HRP = "lnbcrt"
// the amount's multipliers of a bitcoin, in picobitcoin, largest first
const MULTIPLIERS: [string, bigint][] = [["m", 10n ** 9n], ["u", 10n ** 6n], ["n", 10n ** 3n], ["p", 1n]]
const PICO_DECIMALS = 12
const TIMESTAMP_GROUPS = 7
const LENGTH_GROUPS = 2
// var_onion_optin and payment_secret, both compulsory, as every current invoice sets them
const FEATURES = (1 << 8) | (1 << 14)
const DESCRIPTION = "SimpleX name"

function fiveBitsOf(n: number, groups = 1): number[] {
  const out: number[] = []
  for (let rest = n; rest > 0 || out.length < groups; rest = Math.floor(rest / 32)) out.unshift(rest % 32)
  return out
}

function fromFiveBits(groups: number[]): Uint8Array {
  const out: number[] = []
  let acc = 0
  let bits = 0
  for (const g of groups) {
    acc = (acc << 5) | g
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out.push((acc >>> bits) & 0xff)
    }
  }
  if (bits > 0) out.push((acc << (8 - bits)) & 0xff)
  return new Uint8Array(out)
}

const tagged = (type: string, data: number[]) => [BECH32.indexOf(type), ...fiveBitsOf(data.length, LENGTH_GROUPS), ...data]

function lightningAmount(btc: string): string {
  const [whole, fraction = ""] = btc.split(".")
  const pico = BigInt(whole + fraction.padEnd(PICO_DECIMALS, "0"))
  const [unit, size] = MULTIPLIERS.find(([, size]) => pico % size === 0n)!
  return `${pico / size}${unit}`
}

export function lightningInvoice(invoiceId: string, btc: string, createdAt: number, expirySeconds: number): string {
  const seed = createHash("sha512").update(`ln ${invoiceId}`).digest()
  const hrp = `${LIGHTNING_HRP}${lightningAmount(btc)}`
  const data = [
    ...fiveBitsOf(createdAt, TIMESTAMP_GROUPS),
    ...tagged("p", toFiveBits(createHash("sha256").update(seed.subarray(0, 32)).digest())),
    ...tagged("s", toFiveBits(seed.subarray(32, 64))),
    ...tagged("d", toFiveBits(new TextEncoder().encode(DESCRIPTION))),
    ...tagged("x", fiveBitsOf(expirySeconds)),
    ...tagged("9", fiveBitsOf(FEATURES)),
  ]
  const signed = createHash("sha256").update(Buffer.concat([Buffer.from(hrp), fromFiveBits(data)])).digest()
  const signature = secp256k1.sign(signed, createHash("sha256").update(seed).digest())
  return bech32(hrp, [...data, ...toFiveBits(new Uint8Array([...signature.toBytes("compact"), signature.recovery]))])
}

export function addressFor(method: "btc" | "xmr", invoiceId: string): string {
  const seed = createHash("sha512").update(`${method} ${invoiceId}`).digest()
  return method === "btc" ? regtestAddress(seed.subarray(0, P2WPKH_BYTES)) : stagenetAddress(seed)
}
