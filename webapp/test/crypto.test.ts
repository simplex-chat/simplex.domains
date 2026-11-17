import { createHash } from "node:crypto"
import {
  encodeAbiParameters, encodeFunctionData, hashMessage, hashTypedData, keccak256, labelhash, namehash as viemNamehash,
  parseAbi, recoverMessageAddress, recoverTypedDataAddress, zeroHash,
} from "viem"
import { mnemonicToAccount } from "viem/accounts"
import { describe, expect, it } from "vitest"
import { codeHash, codeProgress, formatOwnerCode, mayBeOwnerCode, parseNameCode } from "../src/crypto/code.ts"
import {
  acceptTermsDigest, clearRecordsDigest, commitmentSecret, durationFor, labelHash, makeCommitment, namehash, recordCalls,
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

function registration(owner: Uint8Array, contact: string[] = [], channel: string[] = []): Registration {
  return { label: "dynamis", tld: "simplex", owner, duration: durationFor(2, TERM_START, BEFORE_START), secret: new Uint8Array(32).fill(0x11), resolver: RESOLVER, contactLinks: contact, channelLinks: channel }
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
  it("accepts the design's example and gives its length and canonical form", () => {
    const parsed = parseNameCode("SN7-BJTBP-29596-R3HJ8-25YM7")
    expect(parsed).toEqual({ kind: "prepaid", minLength: 7, canonical: "SN7BJTBP29596R3HJ825YM7", display: "SN7-BJTBP-29596-R3HJ8-25YM7" })
  })

  it("refuses a typo, which the check character catches", () => {
    expect(parseNameCode("SN7-4K2P7-TQ9M1-ZX3RB-8HJ5X")).toBeNull()
  })

  it("refuses a length outside 6 to 63 or written with a leading zero, as the service's parser does", () => {
    // the zero adds nothing to the check, so this text passes it and only the length rule refuses it
    expect(parseNameCode("SN07-BJTBP-29596-R3HJ8-25YM7")).toBeNull()
    // the design's example body under each length, with the check character that length gives
    const texts = ["SN5-BJTBP-29596-R3HJ8-25YM9", "SN6-BJTBP-29596-R3HJ8-25YM8", "SN9-BJTBP-29596-R3HJ8-25YM5",
      "SN10-BJTBP-29596-R3HJ8-25YMC", "SN63-BJTBP-29596-R3HJ8-25YMZ", "SN64-BJTBP-29596-R3HJ8-25YMY"]
    const lengths = texts.map((text) => {
      const parsed = parseNameCode(text)
      return parsed?.kind === "prepaid" ? parsed.minLength : null
    })
    expect(lengths).toEqual([null, 6, 9, 10, 63, null])
  })

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
    const r = registration(owner, ["https://smp8.simplex.im/a#contact"], ["https://smp9.simplex.im/c#channel"])
    const node = viemNamehash("dynamis.simplex")
    const data = [
      encodeFunctionData({ abi, functionName: "setText", args: [node, "simplex.contact", "https://smp8.simplex.im/a#contact"] }),
      encodeFunctionData({ abi, functionName: "setText", args: [node, "simplex.channel", "https://smp9.simplex.im/c#channel"] }),
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

  it("signs RegisterName as viem's typed data, recoverable to the owner", async () => {
    const wallet = walletFromEntropy(ENTROPY)
    const r = registration(wallet.address, ["https://smp8.simplex.im/a#contact"])
    const typed = {
      domain: { name: "SimplexSponsor", version: "1", chainId: Number(CHAIN_ID), verifyingContract: hex(SPONSOR) },
      types: { RegisterName: [
        { name: "label", type: "string" }, { name: "owner", type: "address" }, { name: "duration", type: "uint256" },
        { name: "resolver", type: "address" }, { name: "data", type: "bytes[]" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
      ] },
      primaryType: "RegisterName" as const,
      message: { label: r.label, owner: hex(r.owner), duration: r.duration, resolver: hex(RESOLVER), data: recordCalls(r).map(hex), nonce: 0n, deadline: 1800000000n },
    }
    const digest = registerIntentDigest(CHAIN_ID, SPONSOR, r, 0n, 1800000000n)
    expect(hex(digest)).toBe(hashTypedData(typed))
    const signature = hex(signDigest(wallet.privateKey, digest))
    expect(await recoverTypedDataAddress({ ...typed, signature })).toBe(OWNER_ADDRESS)
  })

  it("signs SetText and ClearRecords as viem's typed data", () => {
    const node = viemNamehash("dynamis.simplex")
    const domain = { name: "SimplexResolver", version: "1", chainId: Number(CHAIN_ID), verifyingContract: hex(RESOLVER) }
    expect(hex(setTextDigest(CHAIN_ID, RESOLVER, fromHex(node), "simplex.contact", "https://x", 3n, 99n))).toBe(hashTypedData({
      domain, primaryType: "SetText",
      types: { SetText: [{ name: "node", type: "bytes32" }, { name: "key", type: "string" }, { name: "value", type: "string" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
      message: { node, key: "simplex.contact", value: "https://x", nonce: 3n, deadline: 99n },
    }))
    expect(hex(clearRecordsDigest(CHAIN_ID, RESOLVER, fromHex(node), 4n, 99n))).toBe(hashTypedData({
      domain, primaryType: "ClearRecords",
      types: { ClearRecords: [{ name: "node", type: "bytes32" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
      message: { node, nonce: 4n, deadline: 99n },
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
    const order = { label: "dynamis", contact: "https://smp8.simplex.im/a#contact", channel: "" }
    const sealed = await seal(seed, order)
    expect(sealed).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(await unseal(seed, sealed)).toEqual(order)
    expect(await unseal(walletFromEntropy(new Uint8Array(16)).seed, sealed)).toBeNull()
  })
})
