import * as api from "../api.ts"
import { el, icon, line, nameText, nameTitle } from "../dom.ts"
import { blocksOf, spansOf } from "../markdown.ts"
import { POPUP_TITLE, showPopup } from "./shell.ts"

const TERMS_CHANGED = "The terms changed. Agree to them again."
const INFO_KEY = "community-info"
const TERMS_KEY = "community-terms"
export const CANT_SHOW = "The community terms can't be shown now. Try again in a moment."
export const NO_ORDERS = "Names can't be ordered right now"

function showCommunity(label: string, tld: string, community: api.Community | null, key: string): void {
  showPopup(key, [
    el("h2", { id: POPUP_TITLE }, nameText(label, tld)),
    el("span", { class: "soft" }, "Community name"),
    el("p", {}, community?.for ? `This name is for ${community.for}. ` : "", "Its owner agrees to use it for this community, not as the name of one person or business."),
  ], null)
}

// the terms' own headings come under the page's heading, and a popup's
const HEADINGS = ["h3", "h4", "h5", "h6"] as const
const inline = (text: string) => spansOf(text).map((s) => s.strong ? el("strong", {}, s.text) : s.em ? el("em", {}, s.text) : s.text)

// The community terms' Markdown drawn as headings, paragraphs and lists, which scroll in their box.
export function termsText(text: string): HTMLDivElement {
  return el("div", { class: "terms-text", tabindex: "0" }, blocksOf(text).map((b) =>
    b.kind === "heading" ? el(HEADINGS[Math.min(b.level, HEADINGS.length) - 1], {}, inline(b.text))
    : b.kind === "paragraph" ? el("p", {}, inline(b.text))
    : el(b.ordered ? "ol" : "ul", {}, b.items.map((item) => el("li", {}, inline(item))))))
}

export function commitLink(terms: api.Terms, chainId: number): HTMLElement | null {
  const commit = api.termsLink(terms.link, chainId)?.commit
  return commit ? el("p", { class: "note center" }, el("a", { href: api.readerUrl(terms.link), target: "_blank", rel: "noopener" }, `View at commit ${commit.slice(0, 7)}`)) : null
}

// the community terms' text as the service fetches it by the chain's link
function showTerms(terms: api.Terms, chainId: number, key: string): void {
  const reading = el("p", { class: "note" }, "Loading the terms…")
  showPopup(key, [el("h2", { id: POPUP_TITLE }, "Community terms"), reading], null)
  api.termsText(terms, chainId).then((read) => reading.replaceWith(termsText(read), commitLink(terms, chainId) ?? ""), () => { reading.textContent = CANT_SHOW })
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
  accepted?: boolean
  changed: boolean
  label: string
  tld: string
  chainId: number
  disabled: boolean
}

export function termsCheck(a: Agreement, agree: (agreed: boolean) => void): HTMLLabelElement {
  const box = el("input", { type: "checkbox", checked: a.agreed, disabled: a.disabled, "data-focus": "agreed" })
  box.addEventListener("change", () => agree(box.checked))
  const terms = el("a", { class: "nowrap", href: api.readerUrl(a.terms.link), target: "_blank", rel: "noopener" }, "SimpleX general terms")
  return el("label", { class: "check terms" }, box, el("span", { class: "box" }), el("span", {}, "I agree to ", terms, " and do not knowingly violate any trademarks."))
}

// A community name's own tick: its words open the community terms' text, unless their step shows it above them, and its ⓘ
// says what the name is for.
export function communityCheck(a: Agreement, accept: (accepted: boolean) => void, shown = false): HTMLLabelElement {
  const community = a.community!
  const box = el("input", { type: "checkbox", checked: a.accepted, disabled: a.disabled, "data-focus": "accepted" })
  box.addEventListener("change", () => accept(box.checked))
  const terms = shown ? "community terms" : el("button", { class: "text-link", type: "button", "aria-haspopup": "dialog", "data-focus": TERMS_KEY,
    onclick: () => showTerms(a.terms, a.chainId, TERMS_KEY) }, "community terms")
  return el("label", { class: "check terms" }, box, el("span", { class: "box" }), el("span", {}, "I accept the ", terms, " and will use this name for its community.",
    el("button", { class: "cinfo", type: "button", "aria-label": "Which community this name is for", "aria-haspopup": "dialog", "data-focus": INFO_KEY,
      onclick: () => showCommunity(a.label, a.tld, community, INFO_KEY) }, icon("info"))))
}

// the general terms' box, or a community name's own tick in its place, as its community terms include the general terms
export function termsChecks(a: Agreement, agree: (agreed: boolean) => void, accept?: (accepted: boolean) => void): HTMLElement {
  return a.community && accept ? communityCheck(a, accept) : termsCheck(a, agree)
}

export function termsChangedLine(focus: string): HTMLElement {
  const notice = line("warn", "alert", TERMS_CHANGED)
  notice.tabIndex = -1
  notice.dataset.focus = focus
  return notice
}

export const termsBox = (a: Agreement, agree: (agreed: boolean) => void, focus: string, accept?: (accepted: boolean) => void) =>
  el("div", { class: "mid" }, a.changed ? termsChangedLine(focus) : null, termsChecks(a, agree, accept))
