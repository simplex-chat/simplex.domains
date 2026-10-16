// Name codes, as simplex-chat's Badges/Code.hs reads them. The owner code is from simplexmq PR #1942's names-web.
import { bytesToNumberBE, numberToBytesBE } from "@noble/curves/utils"
import { hmac } from "@noble/hashes/hmac"
import { sha256 } from "@noble/hashes/sha2"
import { utf8ToBytes } from "@noble/hashes/utils"

// Crockford base32: the digits and the upper-case letters except I, L, O and U
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
const BASE = ALPHABET.length
const PREFIX = "SN"
const OWNER_CODE_LENGTH = 30
const CHECKSUM_BITS = 22n
const ENTROPY_BYTES = 16
const PREPAID_BODY_LENGTH = 20
const PREPAID_PAYLOAD = PREPAID_BODY_LENGTH - 1
const GROUP = 5
// a taken order's code covers its name's length, with every name of 8 or more letters in one tier
export const LONGEST_TIER = 8
// the shortest names a code covers: its own length, up to the longest tier
export const codeTier = (length: number) => Math.min(length, LONGEST_TIER)

export type NameCode =
  | { kind: "owner"; entropy: Uint8Array }
  | { kind: "prepaid"; minLength: number; canonical: string; display: string }

export function formatOwnerCode(entropy: Uint8Array): string {
  let n = (bytesToNumberBE(entropy) << CHECKSUM_BITS) + ownerChecksum(entropy)
  let body = ""
  for (let i = 0; i < OWNER_CODE_LENGTH; i++) {
    body = ALPHABET[Number(n % BigInt(BASE))] + body
    n /= BigInt(BASE)
  }
  return group(PREFIX, body)
}

// The body's length after "SN" tells the kinds apart; digits cannot, since an owner code's body may start with one.
// How far typed text is from a name code: nothing yet, on its way, long enough to judge, or never one, as a character
// no code has. A prepaid code's body is its length digits and 20 characters; an owner code's is 30.
export type CodeProgress = "empty" | "partial" | "complete" | "impossible"
export function codeProgress(text: string): CodeProgress {
  const cleaned = text.replace(/[^\p{L}\p{N}]/gu, "").toUpperCase()
  if (!cleaned) return "empty"
  if (!PREFIX.startsWith(cleaned.slice(0, PREFIX.length))) return "impossible"
  const body = cleaned.slice(PREFIX.length)
  if ([...body].some((c) => charValue(c) === undefined)) return "impossible"
  const shortest = 1 + PREPAID_BODY_LENGTH
  if (body.length < shortest) return "partial"
  return body.length <= shortest + 1 || body.length >= OWNER_CODE_LENGTH ? "complete" : "partial"
}

export function parseNameCode(text: string): NameCode | null {
  const cleaned = text.replace(/[^\p{L}\p{N}]/gu, "").toUpperCase()
  if (!cleaned.startsWith(PREFIX)) return null
  const body = cleaned.slice(PREFIX.length)
  if (body.length === OWNER_CODE_LENGTH) return parseOwner(body)
  const lengthDigits = body.length - PREPAID_BODY_LENGTH
  if (lengthDigits === 1 || lengthDigits === 2) return parsePrepaid(body.slice(0, lengthDigits), body.slice(lengthDigits))
  return null
}

function parseOwner(body: string): NameCode | null {
  let n = 0n
  for (const c of body) {
    const v = charValue(c)
    if (v === undefined) return null
    n = n * BigInt(BASE) + BigInt(v)
  }
  const entropy = numberToBytesBE(n >> CHECKSUM_BITS, ENTROPY_BYTES)
  return n % (1n << CHECKSUM_BITS) === ownerChecksum(entropy) ? { kind: "owner", entropy } : null
}

function parsePrepaid(lengthText: string, body: string): NameCode | null {
  if (!/^[0-9]+$/.test(lengthText)) return null
  const values: number[] = []
  for (const c of body) {
    const v = charValue(c)
    if (v === undefined) return null
    values.push(v)
  }
  const params = [...lengthText].map((c) => ALPHABET.indexOf(c))
  if (values[PREPAID_PAYLOAD] !== checkValue([...params, ...values.slice(0, PREPAID_PAYLOAD)])) return null
  const canonicalBody = values.map((v) => ALPHABET[v]).join("")
  return { kind: "prepaid", minLength: Number(lengthText), canonical: PREFIX + lengthText + canonicalBody, display: group(PREFIX + lengthText, canonicalBody) }
}

// A taken order's code: its payload from the owner code's seed and the registration id, so the owner code recovers it.
export function takenOrderCode(seed: Uint8Array, registrationId: string, length: number): NameCode & { kind: "prepaid" } {
  const lengthText = String(codeTier(length))
  const mac = hmac(sha256, seed, utf8ToBytes("simplex.domains taken code " + registrationId))
  // 256 is a multiple of 32, so a byte reduces without bias
  const payload = [...mac.slice(0, PREPAID_PAYLOAD)].map((b) => b % BASE)
  const params = [...lengthText].map((c) => ALPHABET.indexOf(c))
  const body = [...payload, checkValue([...params, ...payload])].map((v) => ALPHABET[v]).join("")
  return { kind: "prepaid", minLength: Number(lengthText), canonical: PREFIX + lengthText + body, display: group(PREFIX + lengthText, body) }
}

// the badge codes' hash: unpadded base64url SHA-256 of the canonical code
export function codeHash(canonical: string): string {
  return base64url(sha256(utf8ToBytes(canonical)))
}

export function base64url(bytes: Uint8Array): string {
  let s = ""
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function fromBase64url(text: string): Uint8Array {
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/"))
  return Uint8Array.from(s, (c) => c.charCodeAt(0))
}

function group(prefix: string, body: string): string {
  return [prefix, ...body.match(new RegExp(`.{1,${GROUP}}`, "g"))!].join("-")
}

// I and L are read as 1, O as 0, so a code copied by hand still verifies
function charValue(c: string): number | undefined {
  if (c === "I" || c === "L") return 1
  if (c === "O") return 0
  const v = ALPHABET.indexOf(c)
  return v < 0 ? undefined : v
}

function ownerChecksum(entropy: Uint8Array): bigint {
  return bytesToNumberBE(sha256(entropy)) >> (256n - CHECKSUM_BITS)
}

// Luhn mod 32, folded from the right because the check character sits to the right of the payload
function checkValue(values: readonly number[]): number {
  let sum = 0
  let factor = 2
  for (let i = values.length - 1; i >= 0; i--) {
    const addend = factor * values[i]
    sum += Math.floor(addend / BASE) + (addend % BASE)
    factor = factor === 2 ? 1 : 2
  }
  return (BASE - (sum % BASE)) % BASE
}
