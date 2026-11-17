import { createHash } from "node:crypto"
import { ed25519 } from "@noble/curves/ed25519"
import { secp256k1 } from "@noble/curves/secp256k1"
import { keccak_256 } from "@noble/hashes/sha3"
import { describe, expect, it } from "vitest"
import { addressFor, lightningInvoice } from "../dev/mock/addresses.ts"

const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

// BIP-173's reference decoder: the checksum over the expanded prefix and the data is 1 for bech32
function bech32Decode(address: string): { hrp: string; data: number[] } {
  const at = address.lastIndexOf("1")
  const hrp = address.slice(0, at)
  const data = [...address.slice(at + 1)].map((c) => BECH32.indexOf(c))
  const generator = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
  let chk = 1
  for (const v of [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31), ...data]) {
    const top = chk >>> 25
    chk = ((chk & 0x1ffffff) << 5) ^ v
    generator.forEach((g, i) => { if ((top >>> i) & 1) chk ^= g })
  }
  expect(chk, `${address}'s checksum`).toBe(1)
  return { hrp, data: data.slice(0, -6) }
}

function fromFiveBits(values: number[], pad = false): number[] {
  const out: number[] = []
  let acc = 0
  let bits = 0
  for (const v of values) {
    acc = (acc << 5) | v
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out.push((acc >>> bits) & 255)
    }
  }
  if (pad && bits > 0) out.push((acc << (8 - bits)) & 255)
  return out
}

const numberOf = (groups: number[]) => groups.reduce((n, g) => n * 32 + g, 0)

// BOLT11's reader: the timestamp, each tagged field by its letter, and the signature's 104 groups before the checksum
function bolt11Decode(invoice: string) {
  const { hrp, data } = bech32Decode(invoice)
  const body = data.slice(0, -104)
  const fields = new Map<string, number[]>()
  for (let at = 7; at < body.length;) {
    const length = numberOf(body.slice(at + 1, at + 3))
    fields.set(BECH32[body[at]], body.slice(at + 3, at + 3 + length))
    at += 3 + length
  }
  const signature = fromFiveBits(data.slice(-104))
  const signed = createHash("sha256").update(Buffer.concat([Buffer.from(hrp), Buffer.from(fromFiveBits(body, true))])).digest()
  return { hrp, timestamp: numberOf(body.slice(0, 7)), fields, signature: new Uint8Array(signature.slice(0, 64)), recovery: signature[64], signed: new Uint8Array(signed) }
}

// Monero's base58: 11 characters a full block of 8 bytes, fewer for the last
function moneroDecode(address: string): Uint8Array {
  const sizes = [0, 2, 3, 5, 6, 7, 9, 10, 11]
  const out: number[] = []
  for (let at = 0; at < address.length; at += 11) {
    const chunk = address.slice(at, at + 11)
    const bytes = sizes.indexOf(chunk.length)
    let n = [...chunk].reduce((acc, c) => acc * 58n + BigInt(BASE58.indexOf(c)), 0n)
    const block = new Array<number>(bytes)
    for (let i = bytes - 1; i >= 0; i--) {
      block[i] = Number(n % 256n)
      n /= 256n
    }
    out.push(...block)
  }
  return new Uint8Array(out)
}

describe("the mock's invoice addresses", () => {
  const ids = ["q7ZpL2dN9xWc4KfR8tYb1A", "2RWx7gmoLy73IvifBS1V5Q", "x"]

  it.each(ids)("gives a Bitcoin regtest P2WPKH address with a valid bech32 checksum (%s)", (id) => {
    const address = addressFor("btc", id)
    expect(address).toMatch(/^bcrt1q[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{38}$/)
    const { hrp, data } = bech32Decode(address)
    expect(hrp).toBe("bcrt")
    expect(data[0], "witness version").toBe(0)
    expect(fromFiveBits(data.slice(1)), "a 20-byte key hash").toHaveLength(20)
  })

  it.each(ids)("gives a Monero stagenet standard address whose checksum and keys hold (%s)", (id) => {
    const address = addressFor("xmr", id)
    expect(address).toHaveLength(95)
    expect(address.startsWith("5"), "stagenet standard addresses start with 5").toBe(true)
    const bytes = moneroDecode(address)
    expect(bytes).toHaveLength(69)
    expect(bytes[0], "the stagenet network byte").toBe(24)
    expect([...keccak_256(bytes.slice(0, 65)).slice(0, 4)], "the checksum").toEqual([...bytes.slice(65)])
    // the spend and view keys are points of the curve
    for (const key of [bytes.slice(1, 33), bytes.slice(33, 65)]) expect(() => ed25519.Point.fromBytes(key)).not.toThrow()
  })

  it("gives each invoice its own address, the same each time it is asked", () => {
    expect(addressFor("btc", ids[0])).toBe(addressFor("btc", ids[0]))
    expect(addressFor("btc", ids[0])).not.toBe(addressFor("btc", ids[1]))
    expect(addressFor("xmr", ids[0])).not.toBe(addressFor("xmr", ids[1]))
  })

  const CREATED = 1793000000
  const nodeKey = (invoice: string) => {
    const { signature, recovery, signed } = bolt11Decode(invoice)
    return secp256k1.Signature.fromBytes(signature, "compact").addRecoveryBit(recovery).recoverPublicKey(signed).toHex()
  }
  const EXPIRY_S = 3600
  it.each([["0.00049999944", "499999440p"], ["0.0015625", "1562500n"], ["0.001", "1m"], ["0.000002", "2u"], ["0.00000002", "20n"]])("gives a regtest BOLT11 invoice of %s BTC whose prefix holds it as %s, signed over its fields", (btc, amount) => {
    const invoice = lightningInvoice(ids[0], btc, CREATED, EXPIRY_S)
    const { hrp, timestamp, fields } = bolt11Decode(invoice)
    expect(hrp).toBe(`lnbcrt${amount}`)
    expect(timestamp).toBe(CREATED)
    expect([...fields.keys()].sort(), "payment hash, secret, description, expiry and features").toEqual(["9", "d", "p", "s", "x"])
    expect(fromFiveBits(fields.get("p")!), "a 32-byte payment hash").toHaveLength(32)
    expect(fromFiveBits(fields.get("s")!), "a 32-byte payment secret").toHaveLength(32)
    expect(numberOf(fields.get("x")!)).toBe(EXPIRY_S)
    // a key recovered from a hash the mock did not sign would differ from one invoice to the next
    expect(nodeKey(invoice), "the node key that signed the prefix and fields").toBe(nodeKey(lightningInvoice(ids[0], "0.5", CREATED + 1, EXPIRY_S)))
  })

  it("gives each Lightning invoice its own request, the same each time it is asked", () => {
    expect(lightningInvoice(ids[0], "0.001", CREATED, EXPIRY_S)).toBe(lightningInvoice(ids[0], "0.001", CREATED, EXPIRY_S))
    expect(lightningInvoice(ids[0], "0.001", CREATED, EXPIRY_S)).not.toBe(lightningInvoice(ids[1], "0.001", CREATED, EXPIRY_S))
  })
})
