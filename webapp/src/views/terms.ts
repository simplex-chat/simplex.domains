import type * as api from "../api.ts"
import { el, icon, line, nameText, nameTitle } from "../dom.ts"
import { POPUP_TITLE, showPopup } from "./shell.ts"

const TERMS_CHANGED = "The terms changed. Agree to them again."
const INFO_KEY = "community-info"

function showCommunity(label: string, tld: string, community: api.Community | null, key: string): void {
  showPopup(key, [
    el("h2", { id: POPUP_TITLE }, nameText(label, tld)),
    el("span", { class: "soft" }, "Community name"),
    el("p", {}, community ? `This name is for ${community.for}. ` : "", "Its owner agrees to use it for this community, not as the name of one person or business."),
  ], null)
}

// `listed` marks a community name whose entry is not read yet, so the marker takes its place before the entry comes
export function rowName(label: string, tld: string, community: api.Community | null, key: string, listed = community !== null): HTMLDivElement {
  if (!listed) return nameTitle(label, "name", tld)
  const marker = el("button", { class: "cmark", type: "button", "aria-label": "Community name: about it", "aria-haspopup": "dialog", "data-focus": key,
    onclick: () => showCommunity(label, tld, community, key) }, "Community", icon("info"))
  return nameTitle(label, "name comm", tld, " ", marker)
}

export interface Agreement {
  terms: api.Terms
  community: api.Community | null
  agreed: boolean
  changed: boolean
  label: string
  tld: string
  disabled: boolean
}

export function termsCheck(a: Agreement, agree: (agreed: boolean) => void): HTMLLabelElement {
  const box = el("input", { type: "checkbox", checked: a.agreed, disabled: a.disabled, "data-focus": "agreed" })
  box.addEventListener("change", () => agree(box.checked))
  const terms = el("a", { class: "nowrap", href: a.terms.url, target: "_blank", rel: "noopener" }, "SimpleX name terms")
  const community = a.community
  const words = community
    ? ["I agree to ", terms, " and will use this name for its community.", el("button", { class: "cinfo", type: "button", "aria-label": "Which community this name is for",
      "aria-haspopup": "dialog", "data-focus": INFO_KEY, onclick: () => showCommunity(a.label, a.tld, community, INFO_KEY) }, icon("info"))]
    : ["I agree to ", terms, " and do not knowingly violate any trademarks."]
  return el("label", { class: "check terms" }, box, el("span", { class: "box" }), el("span", {}, ...words))
}

export function termsChangedLine(focus: string): HTMLElement {
  const notice = line("warn", "alert", TERMS_CHANGED)
  notice.tabIndex = -1
  notice.dataset.focus = focus
  return notice
}

export const termsBox = (a: Agreement, agree: (agreed: boolean) => void, focus: string) =>
  el("div", { class: "mid" }, a.changed ? termsChangedLine(focus) : null, termsCheck(a, agree))
