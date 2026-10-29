import { ed25519 } from "@noble/curves/ed25519"
import { keccak_256 } from "@noble/hashes/sha3"
import { describe, expect, it } from "vitest"
import { addressFor } from "../dev/mock/addresses.ts"

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

function fromFiveBits(values: number[]): number[] {
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
  return out
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
})
