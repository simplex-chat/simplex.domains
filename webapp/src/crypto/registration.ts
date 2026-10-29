// The registration, its commitment and the signed intents, from simplexmq PR #1942's names-web (which mirrors
// simplex-chat PR #7693's Registration.hs), with the record edits and the store's derived secret added.
import { concatBytes, numberToBytesBE, utf8ToBytes } from "@noble/curves/utils"
import { hmac } from "@noble/hashes/hmac"
import { sha256 } from "@noble/hashes/sha2"
import { keccak_256 } from "@noble/hashes/sha3"

// SimplexPriceOracle.SECONDS_PER_YEAR: a paid year is 365 days, as the oracle prices it
export const YEAR_S = 365 * 86400
export const CONTACT_KEY = "simplex.contact"
export const CHANNEL_KEY = "simplex.channel"

export interface Registration {
  label: string
  tld: string
  owner: Uint8Array
  duration: bigint
  secret: Uint8Array
  resolver: Uint8Array
  contactLinks: string[]
  channelLinks: string[]
}

// The contract counts a duration from the block's time, so the free days until the term starts are added to the paid years.
export function durationFor(years: number, termStart: number, now: number): bigint {
  return BigInt(years * YEAR_S + Math.max(0, termStart - now))
}

// derived from the owner code, so the same code and name always give the same commitment
export function commitmentSecret(seed: Uint8Array, label: string): Uint8Array {
  return hmac(sha256, seed, utf8ToBytes("simplex.domains commitment " + label))
}

export function labelHash(label: string): Uint8Array {
  return keccak_256(utf8ToBytes(label))
}

export function namehash(tld: string, label: string): Uint8Array {
  const tldNode = keccak_256(concatBytes(new Uint8Array(32), keccak_256(utf8ToBytes(tld))))
  return keccak_256(concatBytes(tldNode, labelHash(label)))
}

export function makeCommitment(r: Registration): Uint8Array {
  return keccak_256(abiTuple([dynamic(registrationTuple(r))]))
}

export function recordCalls(r: Registration): Uint8Array[] {
  const node = namehash(r.tld, r.label)
  const records: [string, string[]][] = [[CONTACT_KEY, r.contactLinks], [CHANNEL_KEY, r.channelLinks]]
  return records
    .filter(([, links]) => links.length > 0)
    .map(([key, links]) =>
      concatBytes(
        selector("setText(bytes32,string,string)"),
        abiTuple([fixed(node), dynamic(abiBytes(utf8ToBytes(key))), dynamic(abiBytes(utf8ToBytes(links.join(";"))))]),
      ),
    )
}

export function registerIntentDigest(chainId: bigint, sponsor: Uint8Array, r: Registration, nonce: bigint, deadline: bigint): Uint8Array {
  const intent = hashStruct("RegisterName(string label,address owner,uint256 duration,address resolver,bytes[] data,uint256 nonce,uint256 deadline)", [
    keccak_256(utf8ToBytes(r.label)),
    addressWord(r.owner),
    uint256(r.duration),
    addressWord(r.resolver),
    keccak_256(concatBytes(...recordCalls(r).map((c) => keccak_256(c)))),
    uint256(nonce),
    uint256(deadline),
  ])
  return typedDigest(domainSeparator("SimplexSponsor", chainId, sponsor), intent)
}

export function setTextDigest(chainId: bigint, resolver: Uint8Array, node: Uint8Array, key: string, value: string, nonce: bigint, deadline: bigint): Uint8Array {
  const intent = hashStruct("SetText(bytes32 node,string key,string value,uint256 nonce,uint256 deadline)", [
    node,
    keccak_256(utf8ToBytes(key)),
    keccak_256(utf8ToBytes(value)),
    uint256(nonce),
    uint256(deadline),
  ])
  return typedDigest(domainSeparator("SimplexResolver", chainId, resolver), intent)
}

export function clearRecordsDigest(chainId: bigint, resolver: Uint8Array, node: Uint8Array, nonce: bigint, deadline: bigint): Uint8Array {
  const intent = hashStruct("ClearRecords(bytes32 node,uint256 nonce,uint256 deadline)", [node, uint256(nonce), uint256(deadline)])
  return typedDigest(domainSeparator("SimplexResolver", chainId, resolver), intent)
}

function domainSeparator(name: string, chainId: bigint, verifyingContract: Uint8Array): Uint8Array {
  return hashStruct("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)", [
    keccak_256(utf8ToBytes(name)),
    keccak_256(utf8ToBytes("1")),
    uint256(chainId),
    addressWord(verifyingContract),
  ])
}

function typedDigest(domain: Uint8Array, struct: Uint8Array): Uint8Array {
  return keccak_256(concatBytes(new Uint8Array([0x19, 0x01]), domain, struct))
}

function hashStruct(typeString: string, words: Uint8Array[]): Uint8Array {
  return keccak_256(concatBytes(keccak_256(utf8ToBytes(typeString)), ...words))
}

function registrationTuple(r: Registration): Uint8Array {
  const reverseRecord = uint256(0n)
  const referrer = new Uint8Array(32)
  return abiTuple([
    dynamic(abiBytes(utf8ToBytes(r.label))),
    fixed(addressWord(r.owner)),
    fixed(uint256(r.duration)),
    fixed(r.secret),
    fixed(addressWord(r.resolver)),
    dynamic(abiArray(recordCalls(r).map(abiBytes))),
    fixed(reverseRecord),
    fixed(referrer),
  ])
}

interface AbiValue {
  dynamic: boolean
  bytes: Uint8Array
}

const fixed = (bytes: Uint8Array): AbiValue => ({ dynamic: false, bytes })
const dynamic = (bytes: Uint8Array): AbiValue => ({ dynamic: true, bytes })

function abiTuple(values: AbiValue[]): Uint8Array {
  let offset = 32 * values.length
  const heads = values.map((v) => {
    if (!v.dynamic) return v.bytes
    const head = uint256(offset)
    offset += v.bytes.length
    return head
  })
  return concatBytes(...heads, ...values.filter((v) => v.dynamic).map((v) => v.bytes))
}

function abiBytes(bytes: Uint8Array): Uint8Array {
  return concatBytes(uint256(bytes.length), bytes, new Uint8Array((32 - (bytes.length % 32)) % 32))
}

function abiArray(items: Uint8Array[]): Uint8Array {
  return concatBytes(uint256(items.length), abiTuple(items.map(dynamic)))
}

function uint256(n: number | bigint): Uint8Array {
  return numberToBytesBE(n, 32)
}

function addressWord(address: Uint8Array): Uint8Array {
  return concatBytes(new Uint8Array(12), address)
}

function selector(signature: string): Uint8Array {
  return keccak_256(utf8ToBytes(signature)).slice(0, 4)
}
