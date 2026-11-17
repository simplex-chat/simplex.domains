import { createHash, randomBytes } from "node:crypto"
import jsQR from "jsqr"
import { describe, expect, it } from "vitest"
import { formatOwnerCode, parseNameCode } from "../src/crypto/code.ts"
import { lightningInvoice } from "../dev/mock/addresses.ts"
import { encodeQr, paymentCode } from "../src/qr.ts"
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
    expect(paymentCode("xmr", XMR, "0.4512")).toEqual({
      link: `monero:${XMR}?tx_amount=0.4512`, desktopLink: `monero://${XMR}?tx_amount=0.4512`, qr: `monero:${XMR}?tx_amount=0.4512`,
    })
  })
  it("keeps Bitcoin's bitcoin: form on a laptop, a phone and in the QR", () => {
    const link = `bitcoin:${BTC}?amount=0.00156`
    expect(paymentCode("btc", BTC, "0.00156")).toEqual({ link, desktopLink: link, qr: link })
  })
  it("percent-encodes the address in every form, so it cannot add parameters of its own", () => {
    expect(paymentCode("xmr", "a?b&c#d", "1")).toEqual({
      link: "monero:a%3Fb%26c%23d?tx_amount=1", desktopLink: "monero://a%3Fb%26c%23d?tx_amount=1", qr: "monero:a%3Fb%26c%23d?tx_amount=1",
    })
  })

  const BOLT11 = lightningInvoice("q7ZpL2dN9xWc4KfR8tYb1A", "0.00050000", 1793000000, 3600)
  it("is null without an address or an amount, for every method", () => {
    expect([paymentCode("xmr", "", "1"), paymentCode("xmr", XMR, ""), paymentCode("btc", "", "1"), paymentCode("ln", "", "0.00050000"), paymentCode("ln", BOLT11, "")])
      .toEqual([null, null, null, null, null])
  })
  it("opens a Lightning wallet by lightning: on a laptop and a phone alike, with no amount beside the one the invoice holds", () => {
    const link = `lightning:${BOLT11}`
    expect(paymentCode("ln", BOLT11, "0.00050000")).toEqual({ link, desktopLink: link, qr: BOLT11.toUpperCase() })
  })
})

describe("a Lightning invoice's QR code", () => {
  const LONGEST = 400
  const MAX_VERSION_FOR_LONGEST = 12

  it("holds the bare invoice in uppercase, while the wallet links keep it lowercase behind lightning:", async () => {
    const invoice = lightningInvoice("2RWx7gmoLy73IvifBS1V5Q", "0.0015625", 1793000000, 3600)
    const { link, qr } = paymentCode("ln", invoice, "0.0015625")!
    expect(qr).toBe(invoice.toUpperCase())
    expect(link).toBe(`lightning:${invoice}`)
    expect(await readBack(qr)).toBe(invoice.toUpperCase())
  })
  it(`holds a request of ${LONGEST} characters at version ${MAX_VERSION_FOR_LONGEST} or below, which reads back whole`, async () => {
    const request = `lnbc500u1${"qpzry9x8gf2tvdw0s3jn54khce6mua7l".repeat(13)}`.slice(0, LONGEST)
    const payload = paymentCode("ln", request, "0.00050000")!.qr
    expect(encodeQr(payload)!.version).toBeLessThanOrEqual(MAX_VERSION_FOR_LONGEST)
    expect(await readBack(payload)).toBe(payload)
  })
})

const fingerprint = (payload: string) => {
  const { version, mask, modules } = encodeQr(payload)!
  return `${version} ${mask} ${createHash("sha256").update(modules.flat().map((dark) => (dark ? "1" : "0")).join("")).digest("hex").slice(0, 16)}`
}

describe("the QR encoder's modes", () => {
  const ALPHANUMERIC = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:"
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
  it.each([
    ["alphanumeric", "A", [[20, 1], [21, 2], [262, 9], [263, 10], [419, 12], [420, 13], [3391, 40]]],
    ["byte", "a", [[14, 1], [15, 2], [180, 9], [181, 10], [2331, 40]]],
  ] as const)("fits %s payloads to the standard's capacities, across the character count's widths", (_, ch, cases) => {
    for (const [length, version] of cases) expect(encodeQr(ch.repeat(length))?.version, `${length} characters`).toBe(version)
    expect(encodeQr(ch.repeat(cases.at(-1)![0] + 1)), "past version 40").toBeNull()
  })
  it("draws Bitcoin's and Monero's QR as it did before, in byte mode", () => {
    const XMR = "5AH4kYBG5e8fRrw5aKYx9ZDmFmS3cUvXzVRRxGW2pdXtStdmrMZoq3iPMQV4eR1DWh1hKeU3wgaMdPp7kq9DKV2WSUE5NWq"
    const btc = paymentCode("btc", "bcrt1qjhmc6927ct4w4vnas0g70pg3sdhgfdhcl8pd7s", "0.00156")!.qr
    expect(fingerprint(btc)).toBe("5 2 999f07cc2a84bfae")
    expect(fingerprint(paymentCode("xmr", XMR, "0.4512")!.qr)).toBe("7 5 2c75de003cf32020")
    expect(segments(btc).modes).toEqual(["byte"])
  })
})
