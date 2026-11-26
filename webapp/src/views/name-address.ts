import { SITE } from "../config.ts"
import { checksumAddress } from "../crypto/wallet.ts"
import { el } from "../dom.ts"
import { walletOf } from "../flow.ts"

const nameAddressOf = (code: string) => checksumAddress(walletOf(code)!.address)

const nameAddressText = (code: string) => ["Your name address is public. Send it with any support requests. ", el("span", { class: "mono" }, nameAddressOf(code))]

export const nameAddressLine = (code: string) => el("p", { class: "note name-address" }, ...nameAddressText(code))

export const nameAddressAndExplorer = (code: string) =>
  el("p", { class: "note" }, el("span", { class: "name-address" }, ...nameAddressText(code)), " ", el("span", { class: "explorer" },
    el("a", { href: `${SITE.explorer}/token/${SITE.baseRegistrar}?a=${nameAddressOf(code)}`, target: "_blank", rel: "noopener" }, "Open your names on Etherscan"),
    ". Check that this name is listed. If it is not, contact support."))
