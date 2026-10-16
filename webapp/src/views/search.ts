// Search: the hero, the search box and every answer it can show, then how it works.
import * as api from "../api.ts"
import { labelHash } from "../crypto/registration.ts"
import { checksumAddress, fromHex, hex } from "../crypto/wallet.ts"
import { alertBox, btn, chip, disabled, el, holdFor, holding, holdLeft, icon, link, liveRegion, nameText, nameTitle, release, respectHold, startHold, waitOut } from "../dom.ts"
import * as flow from "../flow.ts"
import { dollars, letters, methodName, shortAddress, termText } from "../format.ts"
import { methodMark } from "../icons.ts"
import { carry, current, live, still } from "../motion.ts"
import { foldLabel, labelProblem, MAX_LABEL_LENGTH, priceFor } from "../names.ts"
import * as session from "../session.ts"
import * as store from "../store.ts"
import { codePopup } from "./codes.ts"
import { CONTACT_EMAIL, currentRoute, go, INVEST_LINE, isRedraw, isRoute, page, popup, closePopup, refresh, searchLink, status, WEFUNDER_URL } from "./shell.ts"

// links from the service come from records on chain, which anyone can write: only SimpleX and https links are followed
const SAFE_LINK = /^(simplex:\/|https:\/\/)/

export const TEAM_LINK = "https://smp6.simplex.im/a#lrdvu2d8A1GumSmoKb2krQmtKhWXq-tyGpHuM7aMwsw"
// word joiners keep "a–z" and "0–9" whole: a line may otherwise break after their dash
// the bakery the home page's example points at, as the mock's seed name does
const PREVIEW_PROFILE = "Alice's Bakery"
const RANGES = "a\u2060–\u2060z, 0\u2060–\u20609"
const RULE = `A name has 6 letters or more: ${RANGES} and single hyphens between them.`

interface SearchContext {
  fromApp: string | null
  retarget: store.OrderRecord | null
  // the latest search, so a slower earlier answer is dropped, and when a rate limit ends
  seq: number
  pausedUntil: number
  // what the results show once a pause is over: the line of a code applied meanwhile
  afterPause?: () => void
}

// the search on screen; a retarget search becomes a plain one once its order has moved
let shown: SearchContext | null = null
export const shownSearch = (): Readonly<SearchContext> | null => shown
// its name field, whose text a redraw of the same search keeps while it is not searched yet
let shownInput: HTMLInputElement | null = null
// and its answers, which a redraw of the same search keeps on screen, dimmed, until it has searched again
let shownResults: HTMLElement | null = null

// The search is drawn again without the code; the link went with it, so focus goes to the end of the search box. The
// link lets go of focus first, so the redraw has no control to look for.
function removeCode(): void {
  session.setAppliedCode(null)
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  refresh()
  if (!shownInput) return
  shownInput.focus()
  shownInput.setSelectionRange(shownInput.value.length, shownInput.value.length)
}

// An app's wallet in mixed case carries its checksum; one that fails it was damaged on the way.
function appWallet(owner: string | null): string | null {
  if (!owner || !/^0x[0-9a-fA-F]{40}$/.test(owner)) return null
  const hex = owner.slice(2)
  const checksummed = checksumAddress(fromHex(owner))
  const unchecked = hex === hex.toLowerCase() || hex === hex.toUpperCase()
  return unchecked || checksummed === owner ? checksummed : null
}

export function searchPage(params: URLSearchParams): void {
  const name = params.get("name") ?? ""
  const owner = params.get("owner")
  const fromApp = appWallet(owner)
  // A link from SimpleX whose wallet is damaged would register to a wallet made here instead of the app's, so it says
  // so rather than quietly becoming an order of this browser.
  if (owner !== null && !fromApp) {
    // nothing is searched here, so a code used from the popup goes to a search
    shown = null
    shownInput = null
    shownResults = null
    return page("search", [status("warn", "alert", "This link from SimpleX does not work", "The wallet it names is not a valid address. Open the link again from the app, or search here for a name owned by a wallet made in this browser.",
      [el("a", { class: "btn quiet", href: searchLink(foldLabel(name), null) }, "Search here")])])
  }
  const retargetId = params.get("retarget")
  // an order opened from the app has no code here to sign another name with; the app chooses it
  const retargeted = retargetId ? store.orderByRegistration(retargetId) : undefined
  const retarget = retargeted?.ownerCode ? retargeted : null
  const ctx: SearchContext = { fromApp, retarget, seq: 0, pausedUntil: 0 }
  const typed = isRedraw() && shownInput ? shownInput.value : null
  // a name typed over the searched one, not searched yet, is not replaced by searching the old one again
  const searched = typed === null || foldLabel(typed) === foldLabel(name)
  shown = ctx
  const results = typed !== null && searched && shownResults ? shownResults : liveRegion("results")
  shownResults = results
  const input = el("input", { type: "text", value: typed ?? foldLabel(name), placeholder: "yourname", "aria-label": "Name", autocomplete: "off", autocapitalize: "none", spellcheck: "false" })
  shownInput = input
  const go = btn("Search", "lg", () => submit(), icon("arrow"))
  const box = el("div", { class: "search" }, icon("search"), input, el("span", { class: "tld" }, ".simplex"), go)
  const submit = () => {
    if (Date.now() < ctx.pausedUntil) return
    // a wait met elsewhere in the tab says so here rather than ignore the search
    if (holding()) return limited(holdLeft(), ctx, go, results, "Too many requests were sent from here.")
    void runSearch(foldLabel(input.value), ctx, box, go, results)
  }
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit() })
  // names are lower case, so upper case folds as it is typed; the caret stays where it was
  const fold = () => {
    const lower = input.value.toLowerCase()
    if (lower === input.value) return
    const caret = input.selectionStart
    input.value = lower
    input.setSelectionRange(caret, caret)
  }
  // a keyboard composing a character would restart and repeat it if the value changed under it
  input.addEventListener("compositionend", fold)
  input.addEventListener("input", (e) => {
    box.classList.remove("bad")
    if (!(e as InputEvent).isComposing) fold()
    // written once, not on every key, so a screen reader announces it once
    if (input.value && !current(results, ".result, .alert, .rule, .hint")) results.replaceChildren(el("p", { class: "hint keys" }, "Press ", el("kbd", {}, "Enter"), " or Search"))
  })
  const banner = fromApp
    ? el("div", { class: "banner" }, icon("phone"), el("span", {}, el("b", {}, "Opened from SimpleX. "), `The name is registered to your app's wallet, ${shortAddress(fromApp)}.`))
    : retarget ? keptBanner(retarget) : null
  const hero = el("section", { class: "hero" }, el("div", { class: "wrap" },
    el("span", { class: "eyebrow" }, el("span", { class: "tag" }, "NEW"), "Names for SimpleX channels and addresses"),
    el("h1", { class: "display" }, "Own your name", el("br"), "on ", el("span", { class: "grad" }, "SimpleX")),
    el("p", { class: "lead" }, "One name for your public channel and contact address, registered to a wallet only you hold."),
    banner, box, carry(results)))
  page("search", ctx.fromApp || ctx.retarget ? [hero] : [hero, bento()])
  if (retarget && banner) void checkRetarget(retarget, ctx, banner, submit)
  // a code applied from the popup on another page shows here until a name is searched
  const showApplied = () => {
    const applied = fromApp || retarget ? null : session.appliedCode()
    if (!applied) return
    results.replaceChildren(el("p", { class: "hint applied" }, `Code applied: names of ${applied.minLength} or more letters, for ${applied.years}\u00a0years. Search a name to use it. `,
      link("Remove", () => {
        session.setAppliedCode(null)
        results.replaceChildren()
        // the link is gone, so focus goes back to the search box
        input.focus()
      })))
  }
  // a wait met anywhere in this tab, Back to a paused search included, holds searching until it is over; the code's
  // line follows the pause notice
  // the name the pause held back is searched once it is over
  ctx.afterPause = () => foldLabel(input.value) ? submit() : showApplied()
  if (holding()) limited(holdLeft(), ctx, go, results, "Too many requests were sent from here.")
  else if (name && searched) return submit()
  else showApplied()
  // a redraw that kept focus somewhere, a popup's field included, keeps it there
  if (document.activeElement === document.body) input.focus()
}

// The order may have its new name already, from this tab earlier or another browser; then there is nothing to choose.
function keptBanner(record: store.OrderRecord): HTMLElement {
  const worth = dollars(record.paid, true)
  return el("div", { class: "banner" }, icon("wallet"), el("span", {}, el("b", {}, `Your payment is kept: ${worth}. `), `Choose another name of up to ${worth}; nothing more is charged.`))
}

async function checkRetarget(record: store.OrderRecord, ctx: SearchContext, banner: HTMLElement, rerun: () => void): Promise<void> {
  const mine = currentRoute()
  const view = await (record.invoiceId ? api.readInvoice(record.invoiceId).then((i) => i.registration) : api.readRegistration(record.registrationId)).catch(() => null)
  if (!view || !isRoute(mine)) return
  // another browser may have moved the order meanwhile: its name, links and worth come from the service
  const synced = { ...(await flow.syncRecord(record, view) ?? record), paid: view.price }
  if (!isRoute(mine)) return
  if (view.phase === "taken") {
    if (synced.paid === record.paid && synced.label === record.label) return
    ctx.retarget = synced
    banner.replaceWith(keptBanner(synced))
    return rerun()
  }
  ctx.retarget = null
  const url = flow.orderUrl(record)
  banner.replaceWith(view.phase === "code_issued"
    ? el("div", { class: "banner" }, icon("key"), el("span", {}, el("b", {}, "Your payment already became a code. "), el("a", { href: url }, "Open it")))
    : el("div", { class: "banner" }, icon("info"), el("span", {}, el("b", {}, "Your payment already went to another name. "), el("a", { href: url }, "Open ", nameText(synced.label, synced.tld)))))
  rerun()
}

async function runSearch(label: string, ctx: SearchContext, box: HTMLElement, button: HTMLButtonElement, results: HTMLElement): Promise<void> {
  if (!label) return
  const mine = ++ctx.seq
  // the link always names the last search, a refused one included, so a reload repeats it
  const params = new URLSearchParams(location.hash.split("?")[1] ?? "")
  if (params.get("name") !== label) {
    params.set("name", label)
    history.replaceState(history.state, "", `/#/?${params}`)
  }
  const problem = labelProblem(label)
  if (problem) {
    box.classList.add("bad")
    const text = problem === "short" ? `${letters(label.length)}. ${RULE}` : problem === "long" ? `${letters(label.length)}. A name has at most ${MAX_LABEL_LENGTH}.` : `Use only ${RANGES} and single hyphens between them.`
    results.replaceChildren(el("p", { class: "rule" }, icon("alert"), text))
    return
  }
  // the last answer stays, dimmed, until this one comes; a first search holds the answer's place with an empty card
  const last = current<HTMLElement>(results, ".result")
  if (last) last.classList.add("busy")
  else results.replaceChildren(el("div", { class: "skeleton result-shape" }, el("span", { class: "sr-only" }, "Searching…")))
  let answer: api.SearchAnswer
  try {
    answer = await api.searchName(hex(labelHash(label)), label.length)
  } catch (e) {
    if (mine !== ctx.seq || !box.isConnected) return
    if (e instanceof api.ApiError && e.code === "rate_limited") return limited(e.retryAfter ?? api.LIMITED_WAIT_S, ctx, button, results)
    results.replaceChildren(el("div", { class: "under-search" }, alertBox("warn", "alert", "This name could not be checked", "The name service did not answer."),
      el("div", { class: "mt-14" }, btn("Try again", "quiet", () => { button.focus(); button.click() }, icon("refresh")))))
    return
  }
  if (mine !== ctx.seq || !box.isConnected) return
  const next = resultFor(label, answer, ctx)
  // the same answer again keeps still
  if (last?.textContent === next.textContent) still(next)
  results.replaceChildren(next)
}

function limited(asked: number, ctx: SearchContext, button: HTMLButtonElement, results: HTMLElement, reason = "Too many names were searched from here."): void {
  startHold(asked)
  // a longer wait met elsewhere in the tab outlasts this one
  const wait = holdLeft()
  ctx.pausedUntil = Date.now() + wait * 1000
  const title = el("b", {})
  disabled(button)
  const notice = el("div", { class: "under-search" }, el("div", { class: "alert warn" }, icon("clock"), el("div", {}, title, `${reason} Searching is paused until then.`)))
  waitOut(title, wait, (left) => `Try again in ${left}`, () => {
    button.removeAttribute("disabled")
    results.replaceChildren()
    ctx.afterPause?.()
    // focus that fell to the page when the button was turned off comes back to it
    if (document.activeElement === document.body) button.focus()
  })
  results.replaceChildren(notice)
}

function resultFor(label: string, answer: api.SearchAnswer, ctx: SearchContext): HTMLElement {
  if (answer.status === "available") return availableResult(label, answer, ctx)
  if (answer.status === "reserved") {
    return takenResult(label, chip("Reserved", "warn", true), [
      el("p", { class: "note" }, "Reserved names are not sold here. If it is yours to use, contact the SimpleX team."),
      el("div", { class: "mt-12" }, btn("Contact the SimpleX team", "quiet", () => teamPopup())),
    ])
  }
  const hash = hex(labelHash(label))
  const mine = answer.owner !== undefined && store.orders().find((o) => o.request.labelHash === hash && o.owner.toLowerCase() === answer.owner!.toLowerCase())
  // a name of ours past its expiry, in its grace period, is over: there are no renewals
  const expired = answer.expiresAt !== undefined && answer.expiresAt < api.serviceNow() / 1000
  // a name whose registration is being mined has no owner on chain yet
  const state = mine ? (expired ? chip("Expired", "bad") : chip("Yours", "ok", true)) : answer.owner === undefined ? chip("Being registered", "brand", true) : chip("Taken", "bad", true)
  // links kept by another resolver, or of a name that has expired, are not edited here, as Your names does not offer to
  const editing = mine && mine.ownerCode && answer.records !== null && !expired
  const yours = mine ? [el("div", { class: "yours" }, el("a", { href: "/#/names" }, "Your names"),
    editing ? el("a", { href: `/#/edit/${mine.registrationId}` }, "Edit links") : null)] : []
  if (answer.entities.length === 0) {
    const note = answer.owner === undefined ? "Someone is registering it right now. Its owner and links show once it is on chain." : "Registered, and not pointing at any address or channel that we know of yet."
    return takenResult(label, state, [el("p", { class: "note" }, note), ...yours])
  }
  return takenResult(label, state, [
    el("span", { class: "label" }, "Used by"),
    el("div", { class: "entities" }, ...answer.entities.map((e) => entityCard(e))),
    ...yours,
  ])
}

function availableResult(label: string, answer: Extract<api.SearchAnswer, { status: "available" }>, ctx: SearchContext): HTMLElement {
  const applied = ctx.fromApp || ctx.retarget ? null : session.appliedCode()
  const coded = applied !== null && label.length >= applied.minLength
  const credit = ctx.retarget !== null
  const affordable = !credit || answer.price <= ctx.retarget!.paid
  const years = coded ? applied!.years : answer.years
  const meta = el("div", { class: "meta" },
    chip("Available", "ok", true), chip(`${label.length} letters`), chip(termText(years)),
    coded ? chip("Code applied", "brand") : null, credit && affordable ? chip("Covered by your payment", "brand") : null)
  const what = el("div", { class: "what" }, nameTitle(label, "name", answer.tld), meta,
    coded ? el("div", { class: "covered" }, "Covered by your code", el("span", { class: "mono nowrap" }, `${applied!.display.slice(0, 9)}…`), el("span", { class: "then" }, "·", link("Remove", removeCode))) : null,
    applied && !coded ? el("div", { class: "covered" }, `Your code covers names of ${applied.minLength} or more letters.`) : null,
    credit && !affordable ? el("div", { class: "covered" }, `This name costs more than the ${dollars(ctx.retarget!.paid, true)} your order is worth.`) : null)
  const price = coded
    ? el("div", { class: "price" }, el("b", {}, el("s", {}, dollars(priceFor(answer.price, years, answer.years))), "$0"), el("span", {}, `for ${years} years`))
    : el("div", { class: "price" }, el("b", {}, dollars(answer.price)), el("span", {}, `for ${years} years`))
  const action = coded ? "Register with code" : credit ? "Register with your payment" : "Register"
  const note = live(el("div", { class: "under-search" }))
  const button = btn(action, "", () => void register(label, answer, ctx, coded ? applied : null, button, note), icon("arrow"))
  if (!affordable) disabled(button)
  // a wait the tab is in, from this action or another, holds the new button too
  else respectHold(button, note)
  void pointAtOwnOrder(label, button, note)
  return el("div", {}, el("div", { class: "result" }, what, el("div", { class: "deal" }, price, button)), note)
}

// An order of this browser for the name, paid or still payable, is pointed at instead of offering a second one.
async function pointAtOwnOrder(label: string, button: HTMLButtonElement, note: HTMLElement): Promise<void> {
  const hash = hex(labelHash(label))
  const mine = currentRoute()
  for (const o of store.orders().filter((r) => r.request.labelHash === hash && !r.cancelled)) {
    const invoice = o.invoiceId ? await api.readInvoice(o.invoiceId).catch(() => null) : null
    const reg = invoice?.registration ?? (o.invoiceId ? null : await api.readRegistration(o.registrationId).catch(() => null))
    if (!isRoute(mine) || !button.isConnected) return
    // an unpaid order counts while its invoice is open; a closed one, even paid late, registered nothing; a name
    // registered and found free again has lapsed
    const live = reg !== null && (reg.phase !== "unpaid" || invoice?.status === "open")
    if (!live || ["taken", "failed", "code_issued", "registered"].includes(reg.phase)) continue
    disabled(button)
    note.replaceChildren(alertBox("info", "info", "You already have an order for this name", el("a", { href: flow.orderUrl(o) }, "Open that order")))
    return
  }
}

async function register(label: string, answer: Extract<api.SearchAnswer, { status: "available" }>, ctx: SearchContext, code: session.AppliedCode | null, button: HTMLButtonElement, note: HTMLElement): Promise<void> {
  const chain = { resolver: answer.resolver, sponsor: answer.sponsor, chainId: answer.chainId, tld: answer.tld }
  const record = ctx.retarget
  if (record) {
    disabled(button)
    note.replaceChildren()
    const mine = currentRoute()
    try {
      await flow.retargetOrder(record, label, { contact: record.contact, channel: record.channel }, chain)
      if (isRoute(mine)) go(flow.orderUrl(record))
    } catch (e) {
      // the answer may be lost after the service moved the order: the order itself says
      const view = await (record.invoiceId ? api.readInvoice(record.invoiceId).then((i) => i.registration) : api.readRegistration(record.registrationId)).catch(() => null)
      const synced = view && await flow.syncRecord(record, view)
      // a rate limit holds the tab whichever way the page goes on, the buyer having moved on included
      if (e instanceof api.ApiError && e.code === "rate_limited") startHold(e.retryAfter ?? api.LIMITED_WAIT_S)
      if (!isRoute(mine)) return
      if (synced?.label === label) return go(flow.orderUrl(record))
      // the payment went elsewhere meanwhile, from another tab or browser: the search page says where
      if (view && view.phase !== "taken") return refresh()
      if (holdFor(e, button, note, (left) => `Nothing changed. Try again in ${left}.`)) return
      release(button)
      const other = e instanceof api.ApiError && typeof e.body.invoiceId === "string" ? e.body.invoiceId : null
      note.replaceChildren(other
        ? alertBox("info", "info", "You already have an order for this name", el("a", { href: `/?order=${other}` }, "Open that order"))
        : alertBox("bad", "alert", "That did not go through", e instanceof api.ApiError && e.code === "name_taken" ? "This name was taken just now. Search another one." : "Nothing changed. Try again in a moment."))
    }
    return
  }
  session.setCheckout({
    label, price: answer.price, chain, contact: "", channel: "", method: "btc", code, ownerCode: null, saved: false,
    appOwner: ctx.fromApp, appSecret: null,
  })
  go("/#/checkout")
}

function takenResult(label: string, chipNode: HTMLElement, below: Node[]): HTMLElement {
  return el("div", { class: "result stack" },
    el("div", { class: "result-top" }, el("div", { class: "what" }, nameTitle(label), el("div", { class: "meta" }, chipNode))),
    el("div", { class: "below" }, ...below))
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?"
}

function hue(text: string): number {
  let h = 0
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) % 360
  return h
}

// A profile without a picture shows its initials on its name's colour, the same wherever it is drawn. One lightness for
// every hue keeps white initials at 4.5:1 or more once the browser fits the colour into sRGB, which 55% did not for greens.
function initialsAvatar(displayName: string): HTMLElement {
  const avatar = el("span", { class: "avatar" }, initials(displayName))
  avatar.style.background = `oklch(52% 0.15 ${hue(displayName)})`
  return avatar
}

export function entityCard(e: { type: "address" | "channel"; displayName: string; image: string | null; link: string; deepLink?: string }, openable = true): HTMLElement {
  const avatar = e.image ? el("img", { class: "avatar", src: e.image, alt: "" }) : initialsAvatar(e.displayName)
  return el("div", { class: "entity" },
    avatar,
    el("div", { class: "who" }, el("b", { title: e.displayName }, e.displayName), el("span", {}, e.type === "address" ? "Contact address" : "Channel")),
    el("span", { class: "url" }, e.link),
    openable && e.deepLink && SAFE_LINK.test(e.deepLink) ? el("a", { href: e.deepLink }, "Open in SimpleX") : null)
}

export function teamPopup(): void {
  popup(el("div", { class: "modal", role: "dialog", "aria-label": "Contact the SimpleX team" },
    el("div", { class: "modal-head" }, el("h3", {}, "Own a trademark?"),
      el("a", { class: "icon-btn", href: "#", "aria-label": "Close", onclick: (e: Event) => { e.preventDefault(); closePopup() } }, icon("x"))),
    el("p", { class: "sec-note" }, "You can reserve the matching SimpleX name. Email us at ", el("a", { href: `mailto:${CONTACT_EMAIL}` }, CONTACT_EMAIL),
      " or ", el("a", { href: TEAM_LINK, target: "_blank", rel: "noopener" }, "connect in the SimpleX Chat app"), ".")))
}

function bento(): HTMLElement {
  const step = (n: string, title: string, text: string, extra: Node | null = null) =>
    el("article", { class: "tile" }, el("span", { class: "n" }, n), el("h3", {}, title), el("p", {}, text), extra)
  return el("section", { class: "section" }, el("div", { class: "wrap" },
    el("div", { class: "section-head" }, el("h2", { class: "display" }, "How it works")),
    el("div", { class: "bento" },
      step("1", "Search", `Any name of 6 letters or more: ${RANGES} and single hyphens between them. The search sends only its hash and length.`),
      step("2", "Pay", "One price for 2 years, shown with the name, and 30 more days free.",
        el("div", { class: "pays" }, ...(["card", "btc", "xmr"] as const).map((m) => el("span", {}, methodMark(m), methodName(m))))),
      step("3", "It's yours", "Registered to a wallet made in your browser. Its name code is the only key, and moves the name to your app."),
      el("article", { class: "tile wide" },
        el("h3", {}, "One name, wherever people find you"),
        el("p", {}, "Point it at your contact address and your channel. People type the name in SimpleX and connect."),
        el("div", { class: "preview" },
          el("span", { class: "nm grad" }, "bakery.simplex"), el("span", { class: "arrow" }, icon("arrow")),
          initialsAvatar(PREVIEW_PROFILE),
          el("div", { class: "who" }, el("b", {}, PREVIEW_PROFILE), el("span", {}, "Contact address · Channel")))),
      el("article", { class: "tile invest" },
        el("h3", {}, "Investors get a name free"),
        el("p", {}, INVEST_LINE),
        el("div", { class: "links" }, el("a", { href: WEFUNDER_URL, target: "_blank", rel: "noopener" }, "Wefunder\u00a0↗"), link("Check your code", () => codePopup()))))))
}
