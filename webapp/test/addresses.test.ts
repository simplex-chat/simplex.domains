import { bytesToHex, hexToBytes } from "@noble/hashes/utils"
import { HDKey } from "@scure/bip32"
import { describe, expect, it } from "vitest"
import { bitcoinPayee, DEV_MONERO_PRIMARY, DEV_XPUB, devReceiving, moneroPayee, payeeFor, TESTNET_VERSIONS } from "../dev/mock/addresses.ts"
import { LOCAL } from "../src/config.ts"
import { bitcoinProven, moneroProven, p2wpkh } from "../src/crypto/payees.ts"
import { BIP32, BIP84, DEV_BITCOIN, DEV_MONERO } from "./payee-vectors.ts"

const proven = ({ address, addressProof: p }: ReturnType<typeof payeeFor>) => p.type === "btc"
  ? bitcoinProven(address, p.keyTweak, LOCAL.bitcoinReceiveKeys, LOCAL.bitcoinHrp)
  : moneroProven(address, p.spendTweak, p.viewProof, LOCAL.moneroPrimaryAddresses, LOCAL.moneroSubaddressPrefix)

describe("the mock's invoice addresses", () => {
  const ids = ["q7ZpL2dN9xWc4KfR8tYb1A", "2RWx7gmoLy73IvifBS1V5Q", "x"]

  it("derive from the dev keys the page holds", () => {
    expect(DEV_XPUB).toBe(DEV_BITCOIN.xpub)
    expect(LOCAL.bitcoinReceiveKeys).toEqual([`0x${bytesToHex(devReceiving.publicKey!)}`])
    expect(LOCAL.moneroPrimaryAddresses).toEqual([DEV_MONERO_PRIMARY])
  })

  it("derive a child's key and its tweak as BIP-32 does", () => {
    const child = HDKey.fromExtendedKey(BIP32.xpub).deriveChild(BIP32.index)
    expect([bytesToHex(child.publicKey!), bytesToHex(child.chainCode!)]).toEqual([BIP32.publicKey, BIP32.chainCode])
    const parent = HDKey.fromExtendedKey(BIP32.xpub)
    const payee = bitcoinPayee(parent, "bc", BIP32.index)
    expect(payee.address).toBe(p2wpkh("bc", hexToBytes(BIP32.publicKey)))
    expect(bitcoinProven(payee.address, payee.addressProof.keyTweak, [`0x${bytesToHex(parent.publicKey!)}`], "bc")).toBe(true)
  })

  it("are the store service's recorded addresses and proofs, for BIP-84's wallet and the dev wallets", () => {
    const bip84 = HDKey.fromExtendedKey(BIP84.xpub).deriveChild(0)
    expect(`0x${bytesToHex(bip84.publicKey!)}`).toBe(BIP84.receiveKey)
    for (const { index, address, keyTweak } of BIP84.invoices) expect(bitcoinPayee(bip84, "bc", index)).toEqual({ address, addressProof: { type: "btc", keyTweak } })
    expect(`0x${bytesToHex(HDKey.fromExtendedKey(DEV_BITCOIN.xpub, TESTNET_VERSIONS).deriveChild(0).publicKey!)}`).toBe(DEV_BITCOIN.receiveKey)
    for (const { index, address, keyTweak } of DEV_BITCOIN.invoices) expect(bitcoinPayee(devReceiving, "bcrt", index)).toEqual({ address, addressProof: { type: "btc", keyTweak } })
    for (const { accountIndex, addressIndex, address, spendTweak, viewProof } of DEV_MONERO.invoices) {
      expect(moneroPayee(accountIndex, addressIndex)).toEqual({ address, addressProof: { type: "xmr", spendTweak, viewProof } })
    }
  })

  it.each(ids)("give each invoice a regtest address and a stagenet subaddress the page proves from its keys (%s)", (id) => {
    const btc = payeeFor("btc", id)
    const xmr = payeeFor("xmr", id)
    expect(btc.address).toMatch(/^bcrt1q[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{38}$/)
    expect(xmr.address).toHaveLength(95)
    expect([proven(btc), proven(xmr)]).toEqual([true, true])
  })

  it("give each invoice its own address, the same each time it is asked", () => {
    expect(payeeFor("btc", ids[0])).toEqual(payeeFor("btc", ids[0]))
    expect(payeeFor("btc", ids[0]).address).not.toBe(payeeFor("btc", ids[1]).address)
    expect(payeeFor("xmr", ids[0]).address).not.toBe(payeeFor("xmr", ids[1]).address)
  })

  it.each(ids)("give an address outside the page's keys with the proof of the invoice's own (%s)", (id) => {
    for (const method of ["btc", "xmr"] as const) {
      const outside = payeeFor(method, id, true)
      expect(outside.addressProof).toEqual(payeeFor(method, id).addressProof)
      expect(outside.address).not.toBe(payeeFor(method, id).address)
      expect(proven(outside), method).toBe(false)
    }
  })
})
