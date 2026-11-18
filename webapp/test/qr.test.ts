import { randomBytes } from "node:crypto"
import { describe, expect, it } from "vitest"
import { formatOwnerCode, parseNameCode } from "../src/crypto/code.ts"
import { lightningInvoice } from "../dev/mock/addresses.ts"
import { encodeQr, paymentUri } from "../src/qr.ts"
import { readQr } from "../src/scan.ts"
import { qrPixels, withQuietZone } from "./qr-image.ts"

// a reader needs four modules of white around the code
const QUIET = 4
const LN_AMOUNT = "0.00050000"
const CREATED = 1793000000
const EXPIRY_S = 3600

const readBack = async (payload: string) => {
  const symbol = encodeQr(payload)
  expect(symbol, `a QR code for ${payload}`).not.toBeNull()
  return readQr(qrPixels(withQuietZone(symbol!.modules, QUIET)))
}

describe("a name code's QR code", () => {
  it("holds a name code as it is typed, which the code field takes as the same name code", async () => {
    for (let i = 0; i < 8; i++) {
      const code = formatOwnerCode(new Uint8Array(randomBytes(16)))
      const read = await readBack(code)
      expect(read, `the QR of ${code}`).toBe(code)
      expect(parseNameCode(read!), `${code} read back`).toEqual(parseNameCode(code))
      expect(parseNameCode(read!)?.kind).toBe("owner")
    }
  })
})

describe("a payment's wallet URI", () => {
  const XMR = "5AH4kYBG5e8fRrw5aKYx9ZDmFmS3cUvXzVRRxGW2pdXtStdmrMZoq3iPMQV4eR1DWh1hKeU3wgaMdPp7kq9DKV2WSUE5NWq"
  const BTC = "bcrt1qjhmc6927ct4w4vnas0g70pg3sdhgfdhcl8pd7s"

  it("opens Monero GUI on a laptop by monero://, and a phone's wallet or a QR's reader by monero:", () => {
    expect(paymentUri("xmr", XMR, "0.4512", true)).toBe(`monero://${XMR}?tx_amount=0.4512`)
    expect(paymentUri("xmr", XMR, "0.4512")).toBe(`monero:${XMR}?tx_amount=0.4512`)
  })
  it("keeps Bitcoin's bitcoin: form on a laptop and a phone", () => {
    expect(paymentUri("btc", BTC, "0.00156", true)).toBe(`bitcoin:${BTC}?amount=0.00156`)
    expect(paymentUri("btc", BTC, "0.00156")).toBe(`bitcoin:${BTC}?amount=0.00156`)
  })
  it("percent-encodes the address in either form, so it cannot add parameters of its own", () => {
    expect(paymentUri("xmr", "a?b&c#d", "1", true)).toBe("monero://a%3Fb%26c%23d?tx_amount=1")
    expect(paymentUri("xmr", "a?b&c#d", "1")).toBe("monero:a%3Fb%26c%23d?tx_amount=1")
  })
  const BOLT11 = lightningInvoice("q7ZpL2dN9xWc4KfR8tYb1A", LN_AMOUNT, CREATED, EXPIRY_S)
  it("is null without an address or an amount", () => {
    expect([paymentUri("xmr", "", "1", true), paymentUri("xmr", XMR, "", true), paymentUri("btc", "", "1"), paymentUri("ln", "", LN_AMOUNT), paymentUri("ln", BOLT11, "")])
      .toEqual([null, null, null, null, null])
  })
  it("is lightning:<invoice> on a laptop and a phone alike, without an amount parameter", () => {
    expect(paymentUri("ln", BOLT11, LN_AMOUNT, true)).toBe(`lightning:${BOLT11}`)
    expect(paymentUri("ln", BOLT11, LN_AMOUNT)).toBe(`lightning:${BOLT11}`)
  })
})

describe("a Lightning invoice's QR code", () => {
  const LONGEST_BOLT11 = 400
  const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
  it(`contains the wallet link, which a phone camera opens in a wallet, read back whole for a request of ${LONGEST_BOLT11} characters`, async () => {
    const request = "lnbc500u1".padEnd(LONGEST_BOLT11, BECH32_CHARSET)
    const link = paymentUri("ln", request, LN_AMOUNT)!
    expect(await readBack(link)).toBe(`lightning:${request}`)
  })
})
