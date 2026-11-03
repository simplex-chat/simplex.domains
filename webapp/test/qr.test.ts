import { randomBytes } from "node:crypto"
import { describe, expect, it } from "vitest"
import { formatOwnerCode, parseNameCode } from "../src/crypto/code.ts"
import { lightningInvoice } from "../dev/mock/addresses.ts"
import { encodeQr, paymentUri } from "../src/qr.ts"
import { readQr } from "../src/scan.ts"
import { qrPixels, withQuietZone } from "./qr-image.ts"

// a reader needs four modules of white around the code
const QUIET = 4

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
  it("is null without an address or an amount", () => {
    expect([paymentUri("xmr", "", "1", true), paymentUri("xmr", XMR, "", true), paymentUri("btc", "", "1")]).toEqual([null, null, null])
  })

  const BOLT11 = lightningInvoice("q7ZpL2dN9xWc4KfR8tYb1A", "0.00049999944", 1793000000, 3600)
  it("opens a Lightning wallet by lightning: on a laptop and a phone alike, with no amount beside the one the invoice holds", () => {
    expect(paymentUri("ln", BOLT11, "0.00049999944", true)).toBe(`lightning:${BOLT11}`)
    expect(paymentUri("ln", BOLT11, "0.00049999944")).toBe(`lightning:${BOLT11}`)
    expect(paymentUri("ln", BOLT11, "")).toBe(`lightning:${BOLT11}`)
    expect(paymentUri("ln", "", "0.00049999944", true)).toBeNull()
  })
})

describe("a Lightning invoice's QR code", () => {
  // the longest BOLT11 request BTCPay is expected to give, with route hints and a fallback address
  const LONGEST = 400
  // the version a 410-byte payload needs at level M; the pay card draws it 132 px wide, at 1.5 px a module
  const VERSION_FOR_LONGEST = 15

  it("holds the mock's invoice, which reads back as the wallet link", async () => {
    const uri = paymentUri("ln", lightningInvoice("2RWx7gmoLy73IvifBS1V5Q", "0.0015625", 1793000000, 3600), "")!
    expect(await readBack(uri)).toBe(uri)
  })
  it(`holds a request of ${LONGEST} characters at version ${VERSION_FOR_LONGEST}, which reads back whole`, async () => {
    const request = `lnbc499999440p1${"qpzry9x8gf2tvdw0s3jn54khce6mua7l".repeat(13)}`.slice(0, LONGEST)
    const uri = `lightning:${request}`
    expect(encodeQr(uri)?.version).toBe(VERSION_FOR_LONGEST)
    expect(await readBack(uri)).toBe(uri)
  })
})
