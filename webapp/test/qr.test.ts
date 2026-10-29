import { randomBytes } from "node:crypto"
import { describe, expect, it } from "vitest"
import { formatOwnerCode, parseNameCode } from "../src/crypto/code.ts"
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
})
