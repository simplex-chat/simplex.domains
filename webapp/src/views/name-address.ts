import { SITE } from "../config.ts"
import { checksumAddress } from "../crypto/wallet.ts"
import { el } from "../dom.ts"
import { walletOf } from "../flow.ts"

const nameAddressOf = (code: string) => checksumAddress(walletOf(code)!.address)

const nameAddressText = (code: string) => ["Your name address is public. Please include it in any support request. ", el("span", { class: "mono" }, nameAddressOf(code))]

export const nameAddressLine = (code: string) => el("p", { class: "note name-address" }, ...nameAddressText(code))

export const nameAddressAndApp = (code: string) =>
  el("p", { class: "note" }, el("span", { class: "name-address" }, ...nameAddressText(code)), " ", el("span", { class: "app-names" }, "Please ",
    el("a", { href: `${SITE.appOrigin}/${nameAddressOf(code)}`, target: "_blank", rel: "noopener" }, "open your names in the SimpleX Names app"),
    " and check that this name is listed. If it is not, please contact support."))
