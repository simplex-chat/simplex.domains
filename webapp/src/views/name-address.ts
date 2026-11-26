import { SITE } from "../config.ts"
import { checksumAddress } from "../crypto/wallet.ts"
import { el } from "../dom.ts"
import { walletOf } from "../flow.ts"

export const nameAddressOf = (code: string) => checksumAddress(walletOf(code)!.address)

export const explorerLink = (code: string) => `${SITE.explorer}/token/${SITE.baseRegistrar}?a=${nameAddressOf(code)}`

const nameAddressText = (code: string) => ["Your name address is public. Send it with any support requests. ", el("span", { class: "mono" }, nameAddressOf(code))]

const explorerText = (code: string) =>
  [el("a", { href: explorerLink(code), target: "_blank", rel: "noopener" }, "Open your names on Etherscan"), ". Check that this name is listed. If it is not, contact support."]

export const nameAddressLine = (code: string) => el("p", { class: "note name-address" }, ...nameAddressText(code))

export const explorerLine = (code: string) => el("p", { class: "note explorer" }, ...explorerText(code))

export const nameAddressAndExplorer = (code: string) =>
  el("p", { class: "note" }, el("span", { class: "name-address" }, ...nameAddressText(code)), " ", el("span", { class: "explorer" }, ...explorerText(code)))
