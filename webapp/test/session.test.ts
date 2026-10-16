import { describe, expect, it } from "vitest"
import { isSending, startSending, stopSending, type Checkout } from "../src/session.ts"

const CHAIN = { resolver: "0x8A791620dd6260079BF849Dc5567aDC3F2FdC318", sponsor: "0x0B306BF915C4d645ff596e518fAf3F9669b97016", chainId: 31337, tld: "simplex" }

function checkout(label: string, ownerCode: string | null, appOwner: string | null = null): Checkout {
  return { label, price: 10000, chain: CHAIN, contact: "", channel: "", method: "btc", code: null, ownerCode, saved: true, appOwner, appSecret: null }
}

describe("orders on their way", () => {
  it("holds each checkout until its own order is answered, whatever finishes first", () => {
    const alpha = checkout("alphaname", "SN-AAAAA")
    const beta = checkout("betaname", "SN-BBBBB")
    startSending(alpha)
    startSending(beta)
    stopSending(alpha)
    expect(isSending(alpha)).toBe(false)
    expect(isSending(beta)).toBe(true)
    stopSending(beta)
    expect(isSending(beta)).toBe(false)
  })

  it("tells apart checkouts of one name by their owner code or app wallet", () => {
    startSending(checkout("samename", "SN-AAAAA"))
    expect(isSending(checkout("samename", "SN-AAAAA"))).toBe(true)
    expect(isSending(checkout("samename", "SN-CCCCC"))).toBe(false)
    expect(isSending(checkout("samename", null, "0x0000000000000000000000000000000000000001"))).toBe(false)
    stopSending(checkout("samename", "SN-AAAAA"))
  })
})
