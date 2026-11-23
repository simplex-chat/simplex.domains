import { readFileSync } from "node:fs"
import { join } from "node:path"
import { hashMessage, recoverMessageAddress, type Hex } from "viem"
import { describe, expect, it } from "vitest"
import { codeHash, formatOwnerCode, parseNameCode } from "../../src/crypto/code.ts"
import { acceptTermsDigest, makeCommitment, namehash, registerIntentDigest, setTextDigest } from "../../src/crypto/registration.ts"
import { checksumAddress, hex, personalDigest, signDigest, walletFromEntropy } from "../../src/crypto/wallet.ts"
import { labelProblem } from "../../src/names.ts"

const DIR = process.env.STORE_FIXTURES

const read = <T>(name: string): T => JSON.parse(readFileSync(join(DIR!, `${name}.json`), "utf8")) as T
const fromHex = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"))
const ENTROPY = fromHex("6f2d1c9a4b7e3f80d15a2c6e9b04f7a3")

interface Signatures {
  owner: string
  findTimestamp: number
  messages: { kind: string; terms: string | null; text: string; digest: Hex; signature: Hex }[]
  registerName: {
    chainId: number; sponsor: string; label: string; owner: string; duration: number; secret: string; resolver: string
    contact: string | null; channel: string | null; commitment: string; disputeDays: number; nonce: number; deadline: number; digest: string
  }
  setText: { chainId: number; resolver: string; label: string; key: string; value: string; nonce: number; deadline: number; digest: string }
}

interface Acceptance { chainId: number; policy: string; commitment: string; termsHash: string; nonce: number; deadline: number; digests: { general: string; community: string } }

interface Codes {
  ownerCodes: { entropy: string; code: string }[]
  prepaidCodes: { typed: string; minLength: number; canonical: string; display: string; hash: string }[]
  refused: string[]
}

describe.skipIf(!DIR)("the names page reproduces the service's recorded vectors", () => {
  it("signs find with the owner in lowercase, as the service recovers it", async () => {
    const v = read<Signatures>("vectors-signatures")
    const wallet = walletFromEntropy(ENTROPY)
    expect(checksumAddress(wallet.address)).toBe(v.owner)
    const find = v.messages.find((m) => m.kind === "find")!
    expect(find.text).toBe(`simplex.domains find ${v.owner.toLowerCase()} ${v.findTimestamp}`)
    expect([hex(personalDigest(find.text)), hashMessage(find.text)]).toEqual([find.digest, find.digest])
    expect(hex(signDigest(wallet.privateKey, personalDigest(find.text)))).toBe(find.signature)
    expect(await recoverMessageAddress({ message: find.text, signature: find.signature })).toBe(v.owner)
  })

  it("commits to a registration and hashes RegisterName and SetText as the service does", () => {
    const { registerName: r, setText: s } = read<Signatures>("vectors-signatures")
    const registration = {
      label: r.label, tld: "simplex", owner: fromHex(r.owner), duration: BigInt(r.duration), secret: fromHex(r.secret), resolver: fromHex(r.resolver),
      contactLink: r.contact, channelLink: r.channel,
    }
    expect(hex(makeCommitment(registration))).toBe(r.commitment)
    expect(hex(registerIntentDigest(BigInt(r.chainId), fromHex(r.sponsor), registration, BigInt(r.disputeDays), BigInt(r.nonce), BigInt(r.deadline)))).toBe(r.digest)
    expect(hex(setTextDigest(BigInt(s.chainId), fromHex(s.resolver), namehash("simplex", s.label), s.key, s.value, BigInt(s.nonce), BigInt(s.deadline)))).toBe(s.digest)
  })

  it("hashes the acceptance of general and community terms as the service does", () => {
    const a = read<Acceptance>("vectors-acceptance")
    const digest = (community: boolean) =>
      hex(acceptTermsDigest(community, BigInt(a.chainId), fromHex(a.policy), fromHex(a.commitment), fromHex(a.termsHash), BigInt(a.nonce), BigInt(a.deadline)))
    expect([digest(false), digest(true)]).toEqual([a.digests.general, a.digests.community])
  })

  it("reads the name codes as the service reads them, and refuses the ones it refuses", () => {
    const c = read<Codes>("vectors-codes")
    for (const { entropy, code } of c.ownerCodes) {
      expect(formatOwnerCode(fromHex(entropy)), code).toBe(code)
      const parsed = parseNameCode(code)
      expect(parsed?.kind === "owner" ? hex(parsed.entropy) : null, code).toBe(`0x${entropy}`)
    }
    for (const { typed, minLength, canonical, display, hash } of c.prepaidCodes) {
      expect(parseNameCode(typed), typed).toEqual({ kind: "prepaid", minLength, canonical, display })
      expect(codeHash(canonical), typed).toBe(hash)
    }
    for (const typed of c.refused) expect(parseNameCode(typed), typed).toBeNull()
  })

  it("refuses exactly the labels the service refuses", () => {
    for (const { label, valid } of read<{ label: string; valid: boolean }[]>("vectors-labels")) expect(labelProblem(label) === null, label).toBe(valid)
  })
})
