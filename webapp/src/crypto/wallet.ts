// The owner code's wallet, from simplexmq PR #1942's names-web, with the seed kept for the store's own keys.
import { secp256k1 } from "@noble/curves/secp256k1"
import { keccak_256 } from "@noble/hashes/sha3"
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils"
import { HDKey } from "@scure/bip32"
import { entropyToMnemonic, mnemonicToSeedSync } from "@scure/bip39"
import { wordlist } from "@scure/bip39/wordlists/english"

// The phrase is only a step to the seed, as BIP-39 defines it, so wallets match the app's; it is never shown.
export interface Wallet {
  entropy: Uint8Array
  seed: Uint8Array
  privateKey: Uint8Array
  address: Uint8Array
}

export function walletFromEntropy(entropy: Uint8Array): Wallet {
  const seed = mnemonicToSeedSync(entropyToMnemonic(entropy, wordlist))
  const privateKey = HDKey.fromMasterSeed(seed).derive("m/44'/60'/0'/0/0").privateKey!
  const address = keccak_256(secp256k1.getPublicKey(privateKey, false).slice(1)).slice(12)
  return { entropy, seed, privateKey, address }
}

// 65 bytes r ‖ s ‖ v with v 27 or 28 and a low s, as the contracts' SignatureChecker requires
export function signDigest(privateKey: Uint8Array, digest: Uint8Array): Uint8Array {
  const sig = secp256k1.sign(digest, privateKey)
  return new Uint8Array([...sig.toBytes("compact"), 27 + sig.recovery])
}

// EIP-191 personal_sign over a text message
export function personalDigest(message: string): Uint8Array {
  const body = utf8ToBytes(message)
  return keccak_256(new Uint8Array([...utf8ToBytes(`\x19Ethereum Signed Message:\n${body.length}`), ...body]))
}

// EIP-55 mixed-case checksum
export function checksumAddress(address: Uint8Array): string {
  const hex = bytesToHex(address)
  const hash = bytesToHex(keccak_256(utf8ToBytes(hex)))
  return "0x" + [...hex].map((c, i) => (parseInt(hash[i], 16) >= 8 ? c.toUpperCase() : c)).join("")
}

export function hex(bytes: Uint8Array): `0x${string}` {
  return `0x${bytesToHex(bytes)}`
}

export function fromHex(text: string): Uint8Array {
  return hexToBytes(text.replace(/^0x/, ""))
}
