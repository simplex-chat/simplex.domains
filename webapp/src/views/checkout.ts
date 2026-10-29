// The checkout's steps: the links the name opens, its name code, and Check your order with how it pays, and Pay.
import * as api from "../api.ts"
import { alertBox, announce, btn, codeDisplay, el, type Kid, line, link, nameText, setAction } from "../dom.ts"
import * as flow from "../flow.ts"
import { bonusDays, bonusHint, dateOf, dollars, freeDays, methodName, termEnd } from "../format.ts"
import { type Method, methodMark } from "../icons.ts"
import type { LinkKind } from "../names.ts"
import { CONFIRMING_READ_MS, heldWords, holderStill, holdWait } from "../screens/balance.ts"
import { RETRY_MS, REVEAL_HOURS } from "../screens/order.ts"
import {
  awaitsCode, balanceHeld, changeOf, codeEntry, heldForThisName, methodOf, methodsFor, payWaits, tookOwnOrder, type CheckoutEvent, type CheckoutKind, type CheckoutState, covered, initialState, reduce, screenOf, split, stepFor, type WaitingOrder,
} from "../screens/checkout.ts"
import { CODES_ONLY, codesOnly } from "../mode.ts"
import { type CheckoutStep, checkoutUrl, CODE_URL } from "../screens/routes.ts"
import * as session from "../session.ts"
import * as store from "../store.ts"
import { CODE_ERRORS, codeField, CODES_ONLY_TITLE, type CodeVerdict } from "./codes.ts"
import { CHECKING_LINK, linkChat, linkFieldsFor, linksSettled } from "./links.ts"
import {
  asStep, type Builder, currentRoute, draw, focusOn, go, goFrom, isRedraw, isRoute, kept, keptLive, limitScreen, outcome, redirect, refresh, screen, searchLink, whenLeaving,
} from "./shell.ts"
import { after } from "./effects.ts"
import { holdEnd, holdEnder, holdFrom, holding, holdNotice, tabHold } from "./hold.ts"
import { openedInstead } from "./order.ts"
import { rowName, termsBox } from "./terms.ts"

const CHECKOUT_NOTE = "checkout-note"
const SAVED_LABEL = "I have saved my name code"
// the dApp that registers a name paid for in ETH
const DAPP_URL = "https://app.simplex.domains"
// the service takes a signed order's timestamp within this many seconds; an older one is signed anew
const SIGNED_WINDOW_S = 600

const years = (c: session.Checkout) => c.code?.years ?? c.years
// a card order waiting for Stripe holds a second paid order; a code or a balance that covers the price pays nothing, so it holds none
const blockedBy = ({ checkout, waiting, codesOnly }: CheckoutState) => checkout.code || covered(checkout) || codesOnly ? null : waiting
const payLabel = (c: session.Checkout, codesOnly: boolean) => c.code || codeEntry(c, codesOnly) === "field" ? "Register with your code"
  : covered(c) ? "Register with your balance" : `Pay ${dollars(split(c).rest)} with ${methodName(methodOf(c))}`

function waitingCardOrder(): WaitingOrder | null {
  const order = store.orders().find((o) => o.method === "card" && o.cardSubmittedAt && o.invoiceId)
  return order ? { registrationId: order.registrationId, invoiceId: order.invoiceId! } : null
}

let state: CheckoutState
let shown: CheckoutKind | null = null
let pageRoute = -1

// The name code is made as its step opens and kept as pending, so Your names lists it before any order exists.
export function checkoutPage(asked: CheckoutStep): void {
  const stored = session.checkout()
  if (!stored) return redirect("/#/")
  const step = stepFor(stored, asked)
  if (step !== asked) return redirect(checkoutUrl(step))
  // a balance pays nothing in codes-only mode, so a checkout started before it pays with a code
  const unpaid = codesOnly() ? { balance: null, balanceChange: undefined } : {}
  session.setCheckout({ ...stored, step, ownerCode: stored.ownerCode ?? (step === "code" ? flow.newOwnerCode() : null), ...unpaid })
  const c = session.checkout()!
  // a name code that already has an order, as one ordered again, is no pending code
  if (c.ownerCode && !store.orders().some((o) => o.ownerCode === c.ownerCode)) store.addPending({ ownerCode: c.ownerCode, label: c.label, tld: c.chain.tld, createdAt: new Date().toISOString() })
  if (!isRedraw() || shown === null || state.checkout.label !== c.label) {
    state = initialState(c, step, codesOnly())
    shown = null
  }
  pageRoute = currentRoute()
  // a wait met elsewhere in the tab holds this page's actions too
  dispatch({ type: "opened", step, checkout: c, sending: session.isSending(c), waiting: waitingCardOrder(), hold: tabHold() })
  if (step !== "review") return
  const reads = new AbortController()
  whenLeaving(() => reads.abort())
  if (state.waiting) void settleWaiting(state.waiting, reads.signal)
  else void showOpenOrder(reads.signal)
  if (c.balance) void watchBalance(c.balance.source, reads.signal)
}

const pause = (ms: number, signal: AbortSignal) => new Promise<void>((done) => {
  after(Math.max(0, ms), done, signal)
  signal.addEventListener("abort", () => done(), { once: true })
})

// The balance as its order reads now, in the tab and on the review. While an invoice holds it, Pay waits: the holder,
// as the code's find names it, is followed until its invoice closes; else the balance is read again when the hold can
// end, or after a pause while the holder's payment is confirming. A find that names no holder of a balance read held
// answered after the hold ended, so the balance is read again at once. Reads are never closer than the minimum, on the
// service's clock, and find, which has a tight limit of its own, is asked again only after the wait a refusal names, or
// after a pause once it named no holder.
async function watchBalance(source: string, signal: AbortSignal): Promise<void> {
  let holder: store.OrderRecord | null = null
  let findAfter = 0
  while (!signal.aborted) {
    let unnamed = false
    const readAt = api.serviceNow()
    let balance: api.Balance | null
    try {
      balance = (await api.readRegistration(source, undefined, signal)).balance
    } catch (e) {
      await pause(api.retryDelay(e, RETRY_MS) ?? RETRY_MS, signal)
      continue
    }
    if (signal.aborted) return
    session.updateActiveBalance(source, session.appliedBalance(source, balance))
    if (!act({ type: "balance-read", balance })) return
    if (!balanceHeld(state.checkout)) return showOwnOrder()
    const paying = store.orderByRegistration(source)
    if (!holder && paying && api.serviceNow() >= findAfter) {
      try {
        holder = await flow.balanceHolder(paying)
        if (!holder) {
          unnamed = true
          findAfter = api.serviceNow() + CONFIRMING_READ_MS
        }
      } catch (e) {
        findAfter = api.serviceNow() + (api.retryDelay(e, RETRY_MS) ?? CONFIRMING_READ_MS)
      }
    }
    if (signal.aborted) return
    const seen = holder && { label: holder.label, tld: holder.tld, url: store.orderUrl(holder) }
    if (JSON.stringify(seen) !== JSON.stringify(state.holder)) dispatch({ type: "holder-seen", holder: seen })
    const followed = holder?.invoiceId != null
    if (followed) await follow(holder!.invoiceId!, signal, (read) => holderStill(read, state.checkout.balance?.heldUntil ?? null))
    // a holder whose invoice closed may be followed by another, which find names on the next turn
    if (followed) holder = null
    await pause(holdWait(state.checkout.balance?.heldUntil ?? null, followed || unnamed, readAt, api.serviceNow()), signal)
  }
}

function dispatch(event: CheckoutEvent): void {
  state = reduce(state, event)
  show()
}

function show(): void {
  if (!isRoute(pageRoute)) return
  const kind = screenOf(state)
  shown = kind
  draw(kind, (signal) => asStep(BUILDERS[kind](state, signal)))
}

const holdEnds = (signal: AbortSignal) => holdEnder(signal, () => dispatch({ type: "hold-ended" }))

// A change is written to the tab's checkout before the page takes it; false, changing nothing, once the tab moved to another checkout.
function act(event: CheckoutEvent, apply: (event: CheckoutEvent) => void = dispatch): boolean {
  const change = changeOf(state, event)
  if (change && !session.updateCheckout(state.checkout.label, change)) return false
  apply(event)
  return true
}

const hasLinks = (c: session.Checkout) => Boolean(c.contact || c.channel)
// a link typed is shown by its own field, so the page takes it without drawing, unless the step's actions change with it
const setLink = (kind: LinkKind, link: string) => {
  const event: CheckoutEvent = { type: "link-set", kind, link }
  const turns = hasLinks(reduce(state, event).checkout) !== hasLinks(state.checkout)
  act(event, turns ? dispatch : (e) => { state = reduce(state, e) })
}

// Follows an invoice, each answer once it moves on from the one seen, while `followed` returns true; an invoice the service forgot is null.
async function follow(invoiceId: string, signal: AbortSignal, followed: (seen: api.InvoiceView | null) => boolean, seen?: api.InvoiceView): Promise<void> {
  while (!signal.aborted) {
    try {
      seen = await api.readInvoice(invoiceId, seen && api.seenOf(seen), signal)
    } catch (e) {
      // the service forgets an unpaid invoice some time after it closes; other errors are waited out
      if (e instanceof api.ApiError && e.code === "not_found") return void followed(null)
      if (signal.aborted) return
      await new Promise((r) => setTimeout(r, e instanceof api.ApiError && e.retryAfter ? e.retryAfter * 1000 : RETRY_MS))
      continue
    }
    if (!followed(seen)) return
  }
}

// The card order blocks a second one only while its invoice is open, so checkout follows it and opens up when it settles or closes.
const settleWaiting = (waiting: WaitingOrder, signal: AbortSignal) => follow(waiting.invoiceId, signal, (seen) => seen?.status === "open" || settled(waiting, signal))

function settled(waiting: WaitingOrder, signal: AbortSignal): false {
  store.updateOrder(waiting.registrationId, { cardSubmittedAt: undefined })
  store.clearCardSubmitted(waiting.invoiceId)
  if (signal.aborted) return false
  dispatch({ type: "waiting-settled" })
  void showOpenOrder(signal)
  return false
}

const OPEN_ORDER_LOOKBACK = 5
const unpaid = (i: api.InvoiceView | null): i is api.InvoiceView => i?.status === "open" && i.registration.phase === "unpaid"

// An unpaid invoice this browser made is pointed at, not blocking a new order, and followed until paid or closed; only the newest few are asked.
async function showOpenOrder(signal: AbortSignal): Promise<void> {
  const recent = store.orders().filter((o) => o.invoiceId && !o.cancelled && !o.replacedBy).slice(0, OPEN_ORDER_LOOKBACK)
  const invoices = await Promise.all(recent.map((o) => api.readInvoice(o.invoiceId!).catch(() => null)))
  const open = invoices.find(unpaid)
  if (!open || signal.aborted) return
  const show = (seen: api.InvoiceView | null) => {
    const order = unpaid(seen) ? { invoiceId: open.invoiceId, confirming: seen.paidInFull === true } : null
    if (!signal.aborted && JSON.stringify(order) !== JSON.stringify(state.openOrder)) dispatch({ type: "open-order-seen", order })
    return order !== null
  }
  show(open)
  void follow(open.invoiceId, signal, show, open)
}

const row = (what: string, value: Kid, cls?: string) => el("div", { class: `trow${cls ? ` ${cls}` : ""}` }, el("span", {}, what), el("span", {}, value))

const BONUS_HINT = "bonus-hint"
const HUSHED = "hushed"

// The free days before the paid years start, with a hint saying why, which shows over the page on hover, focus or tap
// and Escape hides.
function term(years: number, termStart: number, now: number): Kid {
  const free = freeDays(termStart, now)
  if (free === 0) return `${years} years`
  const days = el("button", { class: "days", type: "button", "aria-describedby": BONUS_HINT, "data-focus": "bonus" }, bonusDays(free))
  const bonus = el("span", { class: "bonus" }, days, el("span", { class: "tip", id: BONUS_HINT, role: "tooltip" }, bonusHint(years, termStart)))
  days.addEventListener("keydown", (e) => { if (e.key === "Escape") bonus.classList.add(HUSHED) })
  days.addEventListener("blur", () => bonus.classList.remove(HUSHED))
  bonus.addEventListener("mouseleave", () => bonus.classList.remove(HUSHED))
  return [`${years} years `, bonus]
}

// The order as the search answered it, with the chats its links open, over its term, with the free days before it
// starts, its end, and what it costs; a name registered with a code costs nothing. Paid from a balance, its price takes
// the chats' place and the table ends with what the balance pays and the rest. In codes-only mode a code pays for every order.
function orderCard(c: session.Checkout, codesOnly: boolean): HTMLElement {
  const y = years(c)
  const now = api.serviceNow() / 1000
  const name = `${c.label}.${c.chain.tld}`
  const chats = api.LINK_KINDS.filter((kind) => c[kind]).map((kind) => linkChat(c[kind], kind, name, `chat-${kind}`))
  const { fromBalance, rest } = split(c)
  const side = c.balance ? el("b", { class: "price" }, dollars(c.price)) : chats.length ? el("span", { class: "chats" }, chats) : null
  return el("section", { class: "card order" },
    el("div", { class: "row" }, rowName(c.label, c.chain.tld, c.community, "community"), side),
    el("div", { class: "table" },
      row("Term", term(y, c.termStart, now)),
      row("Registered until", dateOf(termEnd(y, c.termStart, now))),
      c.code || codesOnly ? el("div", { class: "trow total" }, el("span", {}, "Free SimpleX name"))
        : c.balance ? [row("From your balance", `\u2212${dollars(fromBalance)}`), row("To pay", dollars(rest), "total")]
        : row("Total", dollars(c.price), "total")))
}

const BALANCE_NOTE = "balance-note"
const BALANCE_LINE = "balance-line"

// The balance's line is said as it comes and goes, in a review paid from a balance. Pay, turned off by a hold, hands focus
// to the line, which shares its key.
function balanceNote(s: CheckoutState): HTMLElement | null {
  if (!s.checkout.balance && !s.checkout.balanceChange) return null
  const line = balanceChangeLine(s)
  if (line) line.id = BALANCE_LINE
  if (line && payWaits(s)) {
    line.tabIndex = -1
    line.dataset.focus = "pay"
  }
  return keptLive(BALANCE_NOTE, BALANCE_NOTE, line)
}

// The order whose invoice holds the balance, named and linked once find names it, and how long it holds it; else how the
// balance changed since the search showed it.
function balanceChangeLine(s: CheckoutState): HTMLElement | null {
  const { checkout: c, holder } = s
  if (holder && heldForThisName(s)) {
    return line("warn", "wallet", "Your order for ", el("a", { href: holder.url }, nameText(holder.label, holder.tld)), ` holds your balance ${heldWords(c.balance!.heldUntil)}.`,
      ` Press ${payLabel(c, s.codesOnly)} to open it.`)
  }
  if (c.balance?.held) {
    return line("warn", "wallet", "Your balance is in use by ", holder ? el("a", { href: holder.url }, nameText(holder.label, holder.tld)) : "another order",
      ` ${heldWords(c.balance.heldUntil)}.`)
  }
  switch (c.balanceChange) {
    case undefined: return null
    case "gone": return holder && tookOwnOrder(s)
      ? line("warn", "wallet", "Your order for ", el("a", { href: holder.url }, nameText(holder.label, holder.tld)), " already took your balance, with nothing more to pay.")
      : line("warn", "wallet", "Your balance was spent or refunded meanwhile, so you pay the whole price.")
    case "changed": return line("warn", "wallet", `Your balance changed to ${dollars(c.balance!.amount)} meanwhile. Check what is left to pay.`)
  }
}

// an order on its way is sent as it is: its method and code stay as they are until it is answered
function locked<T extends HTMLElement>(node: T, sending: boolean): T {
  for (const input of node.querySelectorAll("input")) input.disabled = sending
  return node
}

function chooseMethod(m: Method): void {
  if (state.sending || m === state.checkout.unavailable || !act({ type: "method-chosen", method: m })) return
  focusOn(`method-${m}`)
}

function methodsBlock({ checkout: c, openOrder: order, sending }: CheckoutState): HTMLElement {
  // one Tab stop for the group, as a radio group has; arrows move between the methods open to choose
  const keyed = (e: KeyboardEvent, m: Method) => {
    const open = methodsFor(state.checkout).filter((other) => other !== state.checkout.unavailable)
    const by = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0
    if (e.key === "Enter" || e.key === " ") chooseMethod(m)
    else if (by) chooseMethod(open[(open.indexOf(m) + by + open.length) % open.length])
    else return
    e.preventDefault()
  }
  const radios = methodsFor(c).map((m) => {
    const [on, off] = [m === methodOf(c), m === c.unavailable]
    return el("div", { class: "method", role: "radio", "data-method": m, "data-focus": `method-${m}`, "aria-checked": String(on), "aria-disabled": off || sending ? "true" : undefined,
      tabindex: on ? "0" : "-1", onclick: () => chooseMethod(m), onkeydown: (e: Event) => keyed(e as KeyboardEvent, m) },
    methodMark(m), el("b", {}, methodName(m)))
  })
  return el("section", { class: "pay-with" },
    order ? el("p", { class: "note other-order" }, `Another order ${order.confirming ? "is confirming its payment" : "is waiting for its payment"}. `,
      el("a", { class: "nowrap", href: store.invoiceUrl(order.invoiceId) }, "Open that order")) : null,
    c.unavailable ? line("warn", "alert", `${methodName(c.unavailable)} is temporarily unavailable. Try another method, or come back later.`) : null,
    el("div", { class: "methods", role: "radiogroup", "aria-label": "Pay with" }, ...radios))
}

const HAVE_CODE = "have-code"
const codeInput = () => document.querySelector<HTMLInputElement>(`body > main .${HAVE_CODE} input`)

// the field's code pays for the order once it covers the name; anything else typed there pays for nothing
function heardCode(v: CodeVerdict | null): void {
  const event: CheckoutEvent = { type: "code-heard", code: v?.kind === "prepaid" ? v.code : null }
  if (isRoute(pageRoute) && !state.sending && changeOf(state, event)) act(event)
}

function openCode(): void {
  if (state.sending || !act({ type: "code-opened" })) return
  codeInput()?.focus()
}

// the field emptied, so what it heard last pays for nothing, and closed
function removeCode(): void {
  if (state.sending) return
  const input = codeInput()
  if (input) {
    input.value = ""
    input.dispatchEvent(new Event("input"))
  }
  if (act({ type: "code-removed" })) focusOn(HAVE_CODE)
}

function codeBlock(s: CheckoutState): HTMLElement | null {
  const c = s.checkout
  const entry = codeEntry(c, s.codesOnly)
  if (entry === null) return null
  if (entry === "field") return el("div", { class: HAVE_CODE }, locked(codeField(`checkout-code-${c.label}`, "Code", heardCode, { name: c.label, code: c.code?.display }), s.sending))
  // the line saying why the service refused a code offers another in its own words
  return c.codeError ? null : el("div", { class: HAVE_CODE }, codeLink("I have a code"))
}

function codeLink(text: string): HTMLAnchorElement {
  const open = link(text, openCode)
  open.dataset.focus = HAVE_CODE
  return open
}

// the step's other action while the code field is open, under the main button; in codes-only mode nothing else pays
function removeLink(s: CheckoutState): HTMLAnchorElement | null {
  if (s.codesOnly || codeEntry(s.checkout, s.codesOnly) !== "field") return null
  const remove = link("Remove code", removeCode)
  if (s.sending) remove.setAttribute("aria-disabled", "true")
  return remove
}

const waitingNotice = (blocked: WaitingOrder) => el("section", { class: "pay-with" },
  alertBox("info", "info", "You have an order waiting to be confirmed", "A second order would be a second charge, so this one cannot start yet. When that payment is confirmed or expires, you can start a new one here."),
  el("div", {}, btn("Open the waiting order", "quiet", () => go(store.invoiceUrl(blocked.invoiceId)))))

const actionLabel = (text: string, s: CheckoutState) => s.sending && !s.busy ? "Sending your order…" : text

function payButton(s: CheckoutState, blocked: boolean): HTMLButtonElement {
  const own = tookOwnOrder(s) ? s.holder!.url : null
  const pay = own ? btn("Open your order", "", () => go(own)) : btn(actionLabel(payLabel(s.checkout, s.codesOnly), s), "", () => void submitOrder())
  pay.dataset.focus = "pay"
  if (s.checkout.balance?.held || s.checkout.balanceChange) pay.setAttribute("aria-describedby", BALANCE_LINE)
  return setAction(pay, s.busy, blocked || s.sending || s.hold !== null || !s.checkout.agreed || payWaits(s) || awaitsCode(s.checkout, s.codesOnly))
}

function agreement({ checkout: c, sending }: CheckoutState): HTMLElement {
  const agree = (agreed: boolean) => { if (!state.sending && !act({ type: "agreed", agreed })) refresh() }
  return termsBox({ terms: c.terms, community: c.community, agreed: c.agreed, changed: c.termsChanged === true, label: c.label, tld: c.chain.tld, disabled: sending }, agree, "pay")
}

function payNote(s: CheckoutState, blocked: boolean, signal: AbortSignal): HTMLElement {
  const held = !blocked && !s.sending ? s.hold : null
  holdEnds(signal)(s.hold !== null)
  return keptLive(CHECKOUT_NOTE, undefined, held && holdNotice(held, signal))
}

function continueButton(onclick: () => void, held = false, busy = false): HTMLButtonElement {
  const next = setAction(btn(busy ? CHECKING_LINK : "Continue", "", onclick), busy, held)
  next.dataset.focus = "continue"
  return next
}

// Continue waits for a link being checked, once, busy and saying so; a link refused takes focus. Until the code is saved,
// the review opens the name code step instead.
let awaitingChecks = false
async function linksDone(fields: HTMLElement[]): Promise<void> {
  if (awaitingChecks) return
  const route = currentRoute()
  const settled = await linksSettled(fields, () => {
    awaitingChecks = true
    announce(CHECKING_LINK)
    show()
  }).finally(() => { awaitingChecks = false })
  if (!isRoute(route)) return
  if (settled) go(checkoutUrl("review"))
  else show()
}

function buildLinks(s: CheckoutState): HTMLElement {
  const c = s.checkout
  const links = kept("links", () => linkFieldsFor({ contact: c.contact, channel: c.channel }, setLink))
  locked(links.node, s.sending)
  // Continue needs a link; without one the step goes on by Skip for now
  const linked = hasLinks(c)
  const skip = linked ? null : link("Skip for now", () => go(checkoutUrl("review")))
  skip?.setAttribute("data-focus", "skip")
  return screen({ title: "Your name's links", back: searchLink(c.label),
    lead: ["Paste your SimpleX contact address or channel link. ", el("span", { class: "nowrap" }, "You can change it later.")],
    alt: skip, action: continueButton(() => void linksDone(links.fields()), !linked, awaitingChecks) },
    el("span", { class: "label" }, "Link"), links.node)
}

function buildCode(s: CheckoutState): HTMLElement {
  const c = s.checkout
  const box = el("input", { type: "checkbox", checked: c.saved, disabled: s.sending, "data-focus": "saved" })
  box.addEventListener("change", () => { if (!state.sending && !act({ type: "saved", saved: box.checked })) refresh() })
  return screen({ title: "Save your name code", lead: ["It is the only key to ", nameText(c.label, c.chain.tld, "."), " If you lose it, nothing can recover it."], back: checkoutUrl("links"),
    action: continueButton(() => go(checkoutUrl("review")), !c.saved) },
    codeDisplay(c.ownerCode!, "owner-code", true),
    store.canPersist() ? el("p", { class: "note center" }, "Private windows and Tor Browser forget it when closed.")
      : alertBox("danger", "alert", "This code could not be saved in this browser", "Save a copy now: it will be the only one."),
    el("label", { class: "check" }, box, el("span", { class: "box" }), SAVED_LABEL))
}

function buildReview(s: CheckoutState, signal: AbortSignal): HTMLElement {
  const c = s.checkout
  const blocked = blockedBy(s)
  const paid = !(c.code || codeEntry(c, s.codesOnly) === "field" || covered(c))
  // the other way to pay ends the note under the methods
  const eth = el("a", { class: "nowrap", href: DAPP_URL, target: "_blank", rel: "noopener" }, "Pay with ETH")
  return screen({ title: "Check your order", back: checkoutUrl("code"), action: payButton(s, blocked !== null), alt: removeLink(s) },
    el("div", { class: "review" }, orderCard(c, s.codesOnly),
      !c.codeError ? null : s.codesOnly ? line("bad", "alert", `${c.codeError} Enter another code.`)
        : line("bad", "alert", `${c.codeError} Pay for the name here, or `, codeLink("check another code"), "."),
      balanceNote(s),
      !paid ? null : blocked ? waitingNotice(blocked) : methodsBlock(s),
      codeBlock(s),
      !paid || blocked ? null : el("div", { class: "notes" }, el("p", {}, `After paying, keep this page open, or reopen its link within ${REVEAL_HOURS} hours. `, eth))),
    payNote(s, blocked !== null, signal),
    agreement(s))
}

function buildPriceChanged({ checkout: c }: CheckoutState): HTMLElement {
  return outcome({ tone: "warn", icon: "alert", title: "The price changed",
    text: [nameText(c.label, c.chain.tld), ` costs ${dollars(c.price)} now; it changed while you were deciding. Nothing was charged.`],
    action: btn("Search again", "", () => go(searchLink(c.label))) })
}

function buildTooMany({ checkout: c, hold }: CheckoutState, signal: AbortSignal): HTMLElement {
  holdEnds(signal)(hold !== null)
  return limitScreen(hold, refresh, searchLink(c.label), signal)
}

function buildTaken({ checkout: c }: CheckoutState): HTMLElement {
  return outcome({ tone: "info", icon: "info", title: "This name is no longer available", text: [nameText(c.label, c.chain.tld), " became unavailable after you searched for it. Nothing was charged."],
    action: btn("Search another name", "", () => go(searchLink(""))) })
}

function buildFailed(s: CheckoutState): HTMLElement {
  const c = s.checkout
  // the same order is sent again from here; Back leaves it for the search
  const retry = setAction(btn("Try again", "", () => void submitOrder()), s.busy, false)
  return outcome({ tone: "danger", icon: "alert", title: "That did not go through", text: "Nothing was charged. If this happens again, get in touch.",
    action: retry, alt: link("Back", () => go(searchLink(c.label))) })
}

// a page opened before the service took codes only; the code entered there registers the name searched again for free
function buildCodesOnly({ checkout: c }: CheckoutState): HTMLElement {
  return outcome({ tone: "info", icon: "key", title: CODES_ONLY_TITLE,
    text: [nameText(c.label, c.chain.tld), " can be registered with an investor code for now. Nothing was charged."],
    action: btn("Enter a code", "", () => go(CODE_URL)) })
}

const BUILDERS: Record<CheckoutKind, Builder<CheckoutState>> = {
  links: buildLinks,
  code: buildCode,
  review: buildReview,
  "status:price-changed": buildPriceChanged,
  "status:too-many": buildTooMany,
  "status:failed": buildFailed,
  "status:taken": buildTaken,
  "status:codes-only": buildCodesOnly,
}

async function submitOrder(): Promise<void> {
  const c = session.checkout()
  if (!c) return go("/#/names")
  if (session.isSending(c) || holding() || awaitsCode(c, state.codesOnly)) return
  // a card payment awaiting confirmation, met since the page was drawn, blocks a second paid order; the page shows it
  if (!c.code && !covered(c) && waitingCardOrder()) return refresh()
  session.startSending(c)
  try {
    await sendOrder()
  } finally {
    session.stopSending(c)
  }
}

async function sendOrder(): Promise<void> {
  const c = session.checkout()
  // a page left open while its order went through, in this tab or by Back and Forward, has nothing left to send
  if (!c) return go("/#/names")
  // a balance pays under its order's name code; one whose order this browser no longer keeps pays nothing
  const source = c.balance && store.orderByRegistration(c.balance.source)
  if (c.balance && !source) return balanceChanged(c, null)
  dispatch({ type: "send-started" })
  const links = { contact: c.contact, channel: c.channel }
  const terms = api.termsFor(c.terms, c.community)
  const draft: flow.Draft = source ? flow.spendDraft(source, c.label, links, { ...c.chain, price: c.price, years: years(c), termStart: c.termStart }, terms)
    : { label: c.label, links, chain: c.chain, years: years(c), termStart: c.termStart, ownerCode: c.ownerCode!, terms }
  // The order is kept whatever the buyer did meanwhile. Its checkout ends, and the order opens, only while this checkout
  // is still the tab's: the buyer may have started another name, by Back and Forward too.
  const mine = currentRoute()
  const search = searchLink(c.label)
  const done = (url: string) => {
    const current = session.checkout()
    const ours = current?.label === c.label && current.ownerCode === c.ownerCode
    if (ours) session.setCheckout(null)
    if (!isRoute(mine) && !(ours && location.hash.startsWith("#/checkout"))) return
    // Back from the order returns once to its search, past the checkout that has ended
    if (location.hash.startsWith("#/checkout")) goFrom(c.searchAt, search, url)
    else go(url)
  }
  const method = methodOf(c)
  const chosen = c.code ? "code" : covered(c) ? "balance" : method
  const of = JSON.stringify([draft, c.code?.display ?? method, c.price, c.balance && [c.balance.source, c.balance.amount]])
  try {
    // a spend that reached the service, as its order holding the balance shows, is sent again as it was, however old
    const fresh = c.sent?.of === of && (api.serviceNow() / 1000 - c.sent.request.timestamp < SIGNED_WINDOW_S || (c.sent.spend !== undefined && heldForThisName(state)))
    const built = fresh ? c.sent! : { of, ...await (source ? flow.spendRequest(source, draft, c.price, c.balance!.amount, method) : flow.orderRequest(draft)) }
    session.updateCheckout(c.label, { sent: built })
    try {
      if (source) {
        // a spend's `of` names its balance, so the order kept for it holds the spend
        const next = await flow.sendSpend(source, draft, { request: built.request, owner: built.owner, spend: built.spend! })
        // the balance is spent, or held by the new order's invoice, so it pays for nothing more in this tab
        session.updateActiveBalance(source.registrationId, null)
        return done(store.orderUrl(next))
      }
      if (c.code) {
        const res = await api.registerWithCode(built.request, c.code.display)
        // the code is the order's now, so it pays for nothing more in this tab
        session.dropActiveCode(c.code.display)
        store.saveOrder({ ...flow.recordFor(draft, built, "code", 0, { registrationId: res.registrationId, invoiceId: null }), prepaidCode: c.code.display })
        return done(store.orderUrl({ invoiceId: null, registrationId: res.registrationId }))
      }
      const res = await api.createOrder(built.request, method, c.price)
      const paidBy = flow.paidWith(res)
      store.saveOrder(flow.recordFor(draft, built, paidBy.method, paidBy.paid, { registrationId: res.registration.id, invoiceId: res.invoiceId }))
      done(store.orderUrl({ invoiceId: res.invoiceId, registrationId: res.registration.id }))
    } catch (e) {
      if (!(e instanceof api.ApiError && e.code === "order_exists")) throw e
      // this name code already has a live order for the name, which it opens instead
      const own = await flow.ownOrderFor(c.ownerCode!, built.request.labelHash)
      if (!own) throw e
      if (own.invoiceId && own.method !== chosen) openedInstead({ invoiceId: own.invoiceId, had: own.method, chosen })
      done(store.orderUrl(own))
    }
  } catch (e) {
    // the order did not go: its checkout is open to change again before the error page sends the buyer back to it
    session.stopSending(c)
    // a rate limit holds the tab's actions wherever the buyer has gone meanwhile
    holdFrom(e)
    // as on success: the error shows where the buyer still is in this checkout, by Back and Forward too
    const ours = session.checkout()?.label === c.label && session.checkout()?.ownerCode === c.ownerCode
    if (!isRoute(mine) && !(ours && location.hash.startsWith("#/checkout"))) return
    // a page whose checkout the tab has moved on from shows the tab's checkout now, which is not on its way
    if (!ours) return refresh()
    orderError(e, c)
  }
}

// the balance as the service has it now, in the tab and on the review
function balanceChanged(c: session.Checkout, balance: api.Balance | null): void {
  if (c.balance) session.updateActiveBalance(c.balance.source, session.appliedBalance(c.balance.source, balance))
  act({ type: "balance-changed", balance })
  // the review opened again follows the invoice that holds it
  if (balanceHeld(state.checkout)) refresh()
  void showOwnOrder()
}

// A balance gone after this page sent a spend may have gone to that spend, whose answer was lost: the order of this name
// that the code's find lists is the buyer's.
async function showOwnOrder(): Promise<void> {
  const c = state.checkout
  if (c.balance || c.balanceChange !== "gone" || !c.sent?.spend) return
  const own = await flow.ownOrderFor(c.ownerCode!, c.sent.request.labelHash).catch(() => null)
  if (own && state.checkout.label === c.label) dispatch({ type: "holder-seen", holder: { label: own.label, tld: own.tld, url: store.orderUrl(own) } })
}

function orderError(e: unknown, c: session.Checkout): void {
  if (e instanceof api.BalanceChanged) return balanceChanged(c, e.balance)
  if (e instanceof api.TermsChanged) return void act({ type: "terms-changed", terms: e.terms, community: e.community })
  const code = e instanceof api.ApiError ? e.code : "network"
  if (code === "name_taken") {
    // no order was made, so the name code made for it owns nothing to find later
    if (c.ownerCode) store.dropPending(c.ownerCode)
    return void act({ type: "order-refused", reason: "taken" })
  }
  if (code in CODE_ERRORS) {
    // a code the service will not take pays for nothing more in this tab
    if (c.code) session.dropActiveCode(c.code.display)
    return void act({ type: "order-refused", reason: "code", error: CODE_ERRORS[code] })
  }
  if (code === "provider_unavailable") return void act({ type: "order-refused", reason: "method" })
  if (code === CODES_ONLY) return dispatch({ type: "order-refused", reason: "codes-only" })
  if (code === "catalog_changed" && e instanceof api.ApiError && typeof e.body.price === "number") return void act({ type: "price-changed", price: e.body.price })
  // the tab's wait started as the order was refused; the page holds for what is left of it
  if (code === "rate_limited") return dispatch({ type: "hold-started", until: holdEnd() })
  dispatch({ type: "order-refused", reason: "failed" })
}
