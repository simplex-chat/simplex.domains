import { createHash, randomBytes } from "node:crypto"
import jsQR from "jsqr"
import { describe, expect, it } from "vitest"
import { formatOwnerCode, parseNameCode } from "../src/crypto/code.ts"
import { lightningInvoice } from "../dev/mock/addresses.ts"
import { encodeQr, paymentQr, paymentUri } from "../src/qr.ts"
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
  // `LIGHTNING:` and 400 uppercase characters, in alphanumeric mode at level M; lowercase bytes needed version 15
  const MAX_VERSION_FOR_LONGEST = 12

  it("holds the invoice in uppercase, while the wallet links keep it lowercase", async () => {
    const invoice = lightningInvoice("2RWx7gmoLy73IvifBS1V5Q", "0.0015625", 1793000000, 3600)
    expect(paymentQr("ln", invoice, "")).toBe(`LIGHTNING:${invoice.toUpperCase()}`)
    expect(paymentUri("ln", invoice, "")).toBe(`lightning:${invoice}`)
    expect(await readBack(paymentQr("ln", invoice, "")!)).toBe(`LIGHTNING:${invoice.toUpperCase()}`)
  })
  it(`holds a request of ${LONGEST} characters at version ${MAX_VERSION_FOR_LONGEST} or below, which reads back whole`, async () => {
    const request = `lnbc499999440p1${"qpzry9x8gf2tvdw0s3jn54khce6mua7l".repeat(13)}`.slice(0, LONGEST)
    const payload = paymentQr("ln", request, "")!
    expect(encodeQr(payload)!.version).toBeLessThanOrEqual(MAX_VERSION_FOR_LONGEST)
    expect(await readBack(payload)).toBe(payload)
  })
})

// a symbol's version, mask and modules, to tell two encodings apart
const fingerprint = (payload: string) => {
  const { version, mask, modules } = encodeQr(payload)!
  return `${version} ${mask} ${createHash("sha256").update(modules.flat().map((dark) => (dark ? "1" : "0")).join("")).digest("hex").slice(0, 16)}`
}

describe("the QR encoder's modes", () => {
  const ALPHANUMERIC = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:"
  // jsQR reads each segment's mode, which the page's reader does not report
  const segments = (payload: string) => {
    const symbol = encodeQr(payload)!
    const { data, width, height } = qrPixels(withQuietZone(symbol.modules, QUIET))
    const read = jsQR(data, width, height)
    return { text: read?.data, modes: read?.chunks.map((c) => c.type) }
  }

  it("writes a payload of the 45 alphanumeric characters in alphanumeric mode, an odd length too, which jsQR reads as such", () => {
    for (const payload of [ALPHANUMERIC, `${ALPHANUMERIC}A`, "A", "LIGHTNING:LNBC1"]) {
      expect(segments(payload), payload).toEqual({ text: payload, modes: ["alphanumeric"] })
    }
  })
  it("writes anything with a character outside that set, a lowercase letter among them, in byte mode", () => {
    for (const payload of ["lightning:lnbc1", "A#B", "MONERO:5A?tx_amount=1", "\u00e9"]) {
      expect(segments(payload), payload).toEqual({ text: payload, modes: ["byte"] })
    }
  })
  // ISO/IEC 18004 table 7 at level M: the most characters each version holds
  it.each([
    ["alphanumeric", "A", [[20, 1], [21, 2], [262, 9], [263, 10], [419, 12], [420, 13], [3391, 40]]],
    ["byte", "a", [[14, 1], [15, 2], [180, 9], [181, 10], [2331, 40]]],
  ] as const)("fits %s payloads to the standard's capacities, across the character count's widths", (_, ch, cases) => {
    for (const [length, version] of cases) expect(encodeQr(ch.repeat(length))?.version, `${length} characters`).toBe(version)
    expect(encodeQr(ch.repeat(cases.at(-1)![0] + 1)), "past version 40").toBeNull()
  })
  // the symbols the encoder drew before it had an alphanumeric mode (f93446c), which wallets have scanned since
  it("draws Bitcoin's and Monero's QR as it did before, in byte mode", () => {
    const XMR = "5AH4kYBG5e8fRrw5aKYx9ZDmFmS3cUvXzVRRxGW2pdXtStdmrMZoq3iPMQV4eR1DWh1hKeU3wgaMdPp7kq9DKV2WSUE5NWq"
    expect(fingerprint(paymentQr("btc", "bcrt1qjhmc6927ct4w4vnas0g70pg3sdhgfdhcl8pd7s", "0.00156")!)).toBe("5 2 999f07cc2a84bfae")
    expect(fingerprint(paymentQr("xmr", XMR, "0.4512")!)).toBe("7 5 2c75de003cf32020")
    expect(segments(paymentQr("btc", "bcrt1qjhmc6927ct4w4vnas0g70pg3sdhgfdhcl8pd7s", "0.00156")!).modes).toEqual(["byte"])
  })
})
