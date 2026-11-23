import { createHash } from "node:crypto"
import {
  encodeAbiParameters, encodeFunctionData, hashMessage, hashTypedData, keccak256, labelhash, namehash as viemNamehash,
  parseAbi, recoverMessageAddress, recoverTypedDataAddress, zeroHash,
} from "viem"
import { mnemonicToAccount } from "viem/accounts"
import { describe, expect, it } from "vitest"
import { registerNameTypedData } from "../dev/register-name.ts"
import { codeHash, codeProgress, formatOwnerCode, mayBeOwnerCode, parseNameCode } from "../src/crypto/code.ts"
import {
  acceptTermsDigest, commitmentSecret, durationFor, labelHash, makeCommitment, namehash, recordCalls,
  registerIntentDigest, setTextDigest, type Registration,
} from "../src/crypto/registration.ts"
import { seal, unseal } from "../src/crypto/seal.ts"
import { checksumAddress, hex, personalDigest, signDigest, walletFromEntropy } from "../src/crypto/wallet.ts"

const fromHex = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"))
// the design's fixture: this entropy's owner code and account-0 address
const ENTROPY = fromHex("6f2d1c9a4b7e3f80d15a2c6e9b04f7a3")
const OWNER_CODE = "SN-DWPHS-6JBFR-ZR1MA-T5HQ9-P17QM-F5GM5"
const OWNER_ADDRESS = "0x014f9c09CcEeDEF1B713110d04D3a07d5B5D9b73"
const CHAIN_ID = 31337n
const SPONSOR = fromHex("9a676e781a523b5d0c0e43731313a708cb607508")
const RESOLVER = fromHex("2279b7a0a67db372996a5fab50d91eaa73d2ebe6")
const YEAR = 365n * 86400n
const TERM_START = Date.UTC(2027, 0, 1) / 1000
const BEFORE_START = Date.UTC(2026, 9, 21, 9, 15) / 1000

function registration(owner: Uint8Array, contactLink: string | null = null, channelLink: string | null = null): Registration {
  return { label: "dynamis", tld: "simplex", owner, duration: durationFor(2, TERM_START, BEFORE_START), secret: new Uint8Array(32).fill(0x11), resolver: RESOLVER, contactLink, channelLink }
}

describe("owner code", () => {
  it("formats the fixture entropy as the fixture code and parses it back", () => {
    expect(formatOwnerCode(ENTROPY)).toBe(OWNER_CODE)
    const parsed = parseNameCode(OWNER_CODE.toLowerCase().replace(/-/g, " "))
    expect(parsed?.kind).toBe("owner")
    expect(parsed?.kind === "owner" ? hex(parsed.entropy) : null).toBe(hex(ENTROPY))
  })

  it("reads I and L as 1 and O as 0, and refuses a changed character", () => {
    const misread = OWNER_CODE.replace("1", "I").replace("0", "O")
    expect(parseNameCode(misread)?.kind).toBe("owner")
    expect(parseNameCode(OWNER_CODE.replace("DWPHS", "DWPHT"))).toBeNull()
  })

  it("makes the fixture's account-0 address, and viem's for the BIP-39 test phrase", () => {
    expect(checksumAddress(walletFromEntropy(ENTROPY).address)).toBe(OWNER_ADDRESS)
    const abandon = walletFromEntropy(new Uint8Array(16))
    const phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
    expect(checksumAddress(abandon.address)).toBe(mnemonicToAccount(phrase).address)
  })
})

describe("prepaid code", () => {
  it("hashes the canonical form as the badge codes do: unpadded base64url SHA-256", () => {
    const expected = createHash("sha256").update("SN7BJTBP29596R3HJ825YM7").digest("base64url")
    expect(codeHash("SN7BJTBP29596R3HJ825YM7")).toBe(expected)
  })
})

describe("text that may be a name code", () => {
  it("is a name code whole, mistyped or cut short past a prepaid code's length, and never a prepaid code or less", () => {
    const owner = formatOwnerCode(ENTROPY)
    const mistyped = owner.slice(0, -1) + (owner.endsWith("0") ? "1" : "0")
    expect([owner, mistyped, owner.slice(0, 30)].map(mayBeOwnerCode)).toEqual([true, true, true])
    expect(["SN7-BJTBP-29596-R3HJ8-25YM7", "SN12-BJTBP-29596-R3HJ8-25YM7", "SN7-BJTBP", owner.slice(0, 20), ""].map(mayBeOwnerCode)).toEqual([false, false, false, false, false])
  })
})

describe("code typed so far", () => {
  const PREPAID = "SN7-BJTBP-29596-R3HJ8-25YM7"
  it("has nothing to judge while a prepaid code is on its way, and judges it once whole", () => {
    expect(codeProgress("")).toBe("empty")
    for (let i = 1; i < PREPAID.length; i++) expect(codeProgress(PREPAID.slice(0, i)), PREPAID.slice(0, i)).toBe("partial")
    expect(codeProgress(PREPAID)).toBe("complete")
    expect(codeProgress(PREPAID.toLowerCase().replace(/-/g, " "))).toBe("complete")
  })

  it("waits through the lengths between a prepaid code and an owner code, and judges an owner code once whole", () => {
    const body = OWNER_CODE.replace(/-/g, "").slice(2)
    for (let n = 23; n < body.length; n++) expect(codeProgress(`SN${body.slice(0, n)}`), `${n} characters`).toBe("partial")
    expect(codeProgress(OWNER_CODE)).toBe("complete")
    expect(codeProgress(`${OWNER_CODE}X`)).toBe("complete")
  })

  it("says at once when no code can begin so or holds a character no code has", () => {
    for (const text of ["X", "SX", "NS7", "SN7-BJTBU", "SN7-БJTBP"]) expect(codeProgress(text), text).toBe("impossible")
  })
})

describe("registration", () => {
  const owner = walletFromEntropy(ENTROPY).address
  const abi = parseAbi([
    "struct Registration { string label; address owner; uint256 duration; bytes32 secret; address resolver; bytes[] data; uint8 reverseRecord; bytes32 referrer; }",
    "function makeCommitment(Registration registration) pure returns (bytes32)",
    "function setText(bytes32 node, string key, string value)",
  ])

  it("signs the paid years of 365 days and the free days until the term starts", () => {
    expect(durationFor(2, TERM_START, BEFORE_START)).toBe(2n * YEAR + BigInt(TERM_START - BEFORE_START))
    // from an order before the start, 2 years end on 31 December 2028, as the contract's example says
    expect(BEFORE_START + Number(durationFor(2, TERM_START, BEFORE_START))).toBe(1861833600)
    expect(durationFor(5, TERM_START, TERM_START)).toBe(5n * YEAR)
    expect(durationFor(2, TERM_START, TERM_START + 1000)).toBe(2n * YEAR)
  })

  it("hashes the label and the node as viem does", () => {
    expect(hex(labelHash("dynamis"))).toBe(labelhash("dynamis"))
    expect(hex(namehash("simplex", "dynamis"))).toBe(viemNamehash("dynamis.simplex"))
  })

  it("encodes the records and the commitment as the contract's ABI does", () => {
    const r = registration(owner, "https://smp8.simplex.im/a#Y8m3qT0vLw2Ab7cD9eF1gH3jK5mN7pQ9rSAAAAAAAAA", "https://smp9.simplex.im/c#Rk27xN4pDe9Tz1Wb3Yc5Vd7Xf9Hg2Jk4LmAAAAAAAAA")
    const node = viemNamehash("dynamis.simplex")
    const data = [
      encodeFunctionData({ abi, functionName: "setText", args: [node, "simplex.contact", "https://smp8.simplex.im/a#Y8m3qT0vLw2Ab7cD9eF1gH3jK5mN7pQ9rSAAAAAAAAA"] }),
      encodeFunctionData({ abi, functionName: "setText", args: [node, "simplex.channel", "https://smp9.simplex.im/c#Rk27xN4pDe9Tz1Wb3Yc5Vd7Xf9Hg2Jk4LmAAAAAAAAA"] }),
    ]
    expect(recordCalls(r).map(hex)).toEqual(data)
    const tuple = { label: r.label, owner: checksumAddress(owner) as `0x${string}`, duration: r.duration, secret: hex(r.secret), resolver: hex(RESOLVER), data, reverseRecord: 0, referrer: zeroHash }
    const encoded = encodeAbiParameters(abi.find((f) => f.type === "function" && f.name === "makeCommitment")!.inputs, [tuple])
    expect(hex(makeCommitment(r))).toBe(keccak256(encoded))
  })

  it("derives the commitment secret from the seed and the name", () => {
    const seed = walletFromEntropy(ENTROPY).seed
    expect(hex(commitmentSecret(seed, "dynamis"))).toBe(hex(commitmentSecret(seed, "dynamis")))
    expect(hex(commitmentSecret(seed, "dynamis"))).not.toBe(hex(commitmentSecret(seed, "dynamos")))
  })

  it("signs RegisterName with the dispute days as viem's typed data, recoverable to the owner", async () => {
    const wallet = walletFromEntropy(ENTROPY)
    const r = registration(wallet.address, "https://smp8.simplex.im/a#Y8m3qT0vLw2Ab7cD9eF1gH3jK5mN7pQ9rSAAAAAAAAA")
    const typed = {
      ...registerNameTypedData(Number(CHAIN_ID), hex(SPONSOR)),
      message: { label: r.label, owner: hex(r.owner), duration: r.duration, resolver: hex(RESOLVER), data: recordCalls(r).map(hex), disputeDays: 37n, nonce: 0n, deadline: 1800000000n },
    }
    const digest = registerIntentDigest(CHAIN_ID, SPONSOR, r, 37n, 0n, 1800000000n)
    expect(hex(digest)).toBe(hashTypedData(typed))
    const signature = hex(signDigest(wallet.privateKey, digest))
    expect(await recoverTypedDataAddress({ ...typed, signature })).toBe(OWNER_ADDRESS)
  })

  it("signs SetText as viem's typed data", () => {
    const node = viemNamehash("dynamis.simplex")
    const domain = { name: "SimplexResolver", version: "1", chainId: Number(CHAIN_ID), verifyingContract: hex(RESOLVER) }
    expect(hex(setTextDigest(CHAIN_ID, RESOLVER, fromHex(node), "simplex.contact", "https://x", 3n, 99n))).toBe(hashTypedData({
      domain, primaryType: "SetText",
      types: { SetText: [{ name: "node", type: "bytes32" }, { name: "key", type: "string" }, { name: "value", type: "string" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
      message: { node, key: "simplex.contact", value: "https://x", nonce: 3n, deadline: 99n },
    }))
  })

  it.each([["AcceptGeneralTerms", false], ["AcceptCommunityTerms", true]] as const)("hashes the acceptance of the terms of a name's kind, %s, as the name policy's EIP-712 digest", (primaryType, community) => {
    const policy = "0x9A676e781A523b5d0C0e43731313A708CB607508"
    const [commitment, termsHash] = [`0x${"cd".repeat(32)}`, `0x${"c7".repeat(32)}`] as const
    expect(hex(acceptTermsDigest(community, CHAIN_ID, fromHex(policy), fromHex(commitment), fromHex(termsHash), 2n, 99n))).toBe(hashTypedData({
      domain: { name: "SimplexNamePolicy", version: "1", chainId: Number(CHAIN_ID), verifyingContract: policy }, primaryType,
      types: { [primaryType]: [{ name: "commitment", type: "bytes32" }, { name: "termsHash", type: "bytes32" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
      message: { commitment, termsHash, nonce: 2n, deadline: 99n },
    }))
  })

  it("signs an EIP-191 message as personal_sign does", async () => {
    const wallet = walletFromEntropy(ENTROPY)
    const message = `simplex.domains find ${OWNER_ADDRESS.toLowerCase()} 1791641400`
    expect(hex(personalDigest(message))).toBe(hashMessage(message))
    const signature = hex(signDigest(wallet.privateKey, personalDigest(message)))
    expect(await recoverMessageAddress({ message, signature })).toBe(OWNER_ADDRESS)
  })
})

describe("sealed order", () => {
  it("opens with the same code and not with another", async () => {
    const seed = walletFromEntropy(ENTROPY).seed
    const order = { label: "dynamis", contact: "https://smp8.simplex.im/a#Y8m3qT0vLw2Ab7cD9eF1gH3jK5mN7pQ9rSAAAAAAAAA", channel: "" }
    const sealed = await seal(seed, order)
    expect(sealed).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(await unseal(seed, sealed)).toEqual(order)
    expect(await unseal(walletFromEntropy(new Uint8Array(16)).seed, sealed)).toBeNull()
  })
})
