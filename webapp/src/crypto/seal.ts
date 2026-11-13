// The order's name and links, sealed under a key from the owner code, so the code alone restores the order in another browser.
import { hmac } from "@noble/hashes/hmac"
import { sha256 } from "@noble/hashes/sha2"
import { utf8ToBytes } from "@noble/hashes/utils"
import { base64url, fromBase64url } from "./code.ts"

const IV_BYTES = 12

interface SealedOrder {
  label: string
  contact: string
  channel: string
}

async function sealingKey(seed: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  const raw = hmac(sha256, seed, utf8ToBytes("simplex.domains sealed"))
  return crypto.subtle.importKey("raw", Uint8Array.from(raw), "AES-GCM", false, [usage])
}

// unpadded base64url(iv ‖ ciphertext ‖ 16-byte tag), WebCrypto's output carrying the tag
export async function seal(seed: Uint8Array, order: SealedOrder): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const body = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await sealingKey(seed, "encrypt"), Uint8Array.from(utf8ToBytes(JSON.stringify(order))))
  return base64url(new Uint8Array([...iv, ...new Uint8Array(body)]))
}

export async function unseal(seed: Uint8Array, sealed: string): Promise<SealedOrder | null> {
  try {
    const raw = fromBase64url(sealed)
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, IV_BYTES) }, await sealingKey(seed, "decrypt"), raw.slice(IV_BYTES))
    const order = JSON.parse(new TextDecoder().decode(plain))
    return typeof order?.label === "string" && typeof order.contact === "string" && typeof order.channel === "string" ? order : null
  } catch {
    return null
  }
}
