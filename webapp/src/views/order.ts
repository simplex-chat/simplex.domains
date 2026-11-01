// An order's page (?order=<invoice>) or a code registration's (?registration=<id>): payment, registration, and every ending.
import * as api from "../api.ts"
import { parseNameCode } from "../crypto/code.ts"
import { alertBox, announce, btn, codeDisplay, copyButton, el, gradName, icon, type Kid, link, nameCodeQr, nameText, refill, setAction, type Tone, waitOut } from "../dom.ts"
import * as flow from "../flow.ts"
import { clock, dateOf, dollars, methodName, SEP, shortAddress, timeOf } from "../format.ts"
import { paymentUri, qrSvg } from "../qr.ts"
import {
  closedBalance, type ClosedCase, closedCase, coinOf, costOf, failedAlert, failedLead, finished, newInvoiceBy, spendCovers, initialState, type Note, type OrderEvent, type OrderKind,
  type OrderState, reduce, refusalsOf, RETRY_MS, retryRefusal, sameStep, REVEAL_ATTEMPTS, REVEAL_HOURS, revealDue, revealKey, screenOf, stalledAt, unreadDelay, wakeAt, askAgainDue, commitKey, nameUnavailable, termsAskedAgain, termsToAgree,
} from "../screens/order.ts"
import { heldWords } from "../screens/balance.ts"
import { termsToSign, ticked } from "../screens/terms.ts"
import { CODES_ONLY, codesOnly } from "../mode.ts"
import { checkoutUrl, CODE_FROM_ORDER_URL, CODE_URL, editUrl } from "../screens/routes.ts"
import { hasLinks, linksAction } from "../screens/names.ts"
import * as session from "../session.ts"
import * as store from "../store.ts"
import { type MountedCard, mountCard, publishableKey } from "../stripe.ts"
import { CODES_ONLY_TITLE } from "./codes.ts"
import { seenRegistered } from "./names.ts"
import { holdEnd, holdEnder, holdFrom, holdNotice, tabHold } from "./hold.ts"
import { NO_ORDERS, termsBox } from "./terms.ts"
import {
  asStep, type Builder, CONTACT_EMAIL, currentRoute, draw, drawLoading, focusOn, go, historyPlace, isRedraw, isRoute, kept, keptLive, outcome, pageTheme, redirect, referenceLine, refresh, screen,
  searchLink, showRefund, useBalance, whenDropped, whenLeaving,
} from "./shell.ts"

// the count stays with its word on one line; a payment taken on first sight waits for no confirmation at all
const confirmations = (n: number) => (n === 1 ? "Waiting for 1\u00a0confirmation" : n > 1 ? `Waiting for ${n}\u00a0confirmations` : "Waiting for the payment to settle")

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const ORDER_NOTE = "order-note"
const warning = (text: string): Note => ({ tone: "warn", icon: "alert", title: null, text })
const termsUnavailable = (e: unknown) => e instanceof api.ApiError && e.code === "terms_unavailable"
const noOrders = (lead: string) => warning(`${NO_ORDERS}. ${lead}Try again later.`)

let state: OrderState = initialState("", null)
let opened = 0
let pageRoute = -1
let reads = 0
let wakes: ReturnType<typeof setTimeout> | undefined

export function orderPage(invoiceId: string | null, registrationId: string | null): void {
  const mine = currentRoute()
  const reference = invoiceId ?? registrationId!
  const redraw = isRedraw()
  if (!redraw || state.reference !== reference) {
    opened += 1
    // A reveal on its way outlasts the page, so the same order opened again does not sign it twice.
    state = initialState(reference, tabHold(), state.reference === reference ? state.reveal : null)
  }
  pageRoute = mine
  const polls = new AbortController()
  // another tab cancelling or paying this order changes what it is; other orders' changes leave this page, and a card form, alone
  const onStorage = (e: StorageEvent) => {
    const registration = state.view?.id ?? registrationId
    // a card paid in another tab, for an order this browser may have no record of, changes it too
    const ours = (registration && e.key === store.orderKey(registration)) || (invoiceId && e.key === store.cardKey(invoiceId))
    if (ours && isRoute(mine)) refresh()
  }
  window.addEventListener("storage", onStorage)
  whenLeaving(() => { polls.abort(); clearTimeout(wakes); window.removeEventListener("storage", onStorage) })
  if (!redraw) whenDropped(() => { dropCard(); stopWatchingName(); instead = null })
  // the same order drawn again stays on screen until it is read, rather than blanking to a loading line
  if (redraw) document.querySelector("main")?.setAttribute("aria-busy", "true")
  else drawLoading("Opening the order…", asStep)
  void follow(mine, invoiceId, registrationId, polls.signal)
}

function dispatch(event: OrderEvent): void {
  const before = state
  state = reduce(state, event)
  if (!isRoute(pageRoute)) return
  const kind = screenOf(state)
  document.querySelector("main")?.removeAttribute("aria-busy")
  if (cardStays(before, kind)) showCard()
  else draw(kind, (signal) => asStep(BUILDERS[kind](state, signal)))
  if (kind !== "pay-card") dropCard()
  if (!checksName(state)) stopWatchingName()
  if (kind === "registered") seenRegistered(state.view!, state.invoice)
  if (revealDue(state)) reveal(state.view!, state.record!)
  else if (askAgainDue(state) && askingAgain !== opened) askAgain(state.record!)
  if (kind !== screenOf(before) || state.record !== before.record) keepCodes(state)
  wakeOnTime()
}

function wakeOnTime(): void {
  clearTimeout(wakes)
  const at = wakeAt(state)
  if (at !== null) wakes = setTimeout(() => dispatch({ type: "tick", now: api.serviceNow() }), at - api.serviceNow())
}

const isOpen = (gen: number) => gen === opened && isRoute(pageRoute)

const answer = (gen: number, event: OrderEvent) => { if (isOpen(gen)) dispatch(event) }
const reread = (gen: number) => { if (isOpen(gen)) refresh() }

function holdOn(e: unknown, lead: string, gen: number): boolean {
  if (!holdFrom(e)) return false
  if (isOpen(gen)) dispatch({ type: "hold-started", until: holdEnd(), lead })
  return true
}

const holdEnds = (signal: AbortSignal) => holdEnder(signal, () => dispatch({ type: "hold-ended" }))

const cardSubmittedAt = (invoice: api.InvoiceView | null, record: store.OrderRecord | undefined) =>
  record?.cardSubmittedAt ?? (invoice ? store.cardSubmittedAt(invoice.invoiceId) : undefined) ?? null

async function follow(mine: number, invoiceId: string | null, registrationId: string | null, signal: AbortSignal): Promise<void> {
  let invoice: api.InvoiceView | null = null
  let view: api.RegistrationView | null = null
  let drawn = ""
  let drawnRecord = ""
  // siblings that could not be read are asked again even when the order's own answer has not changed
  let again = false
  let codeChecked = false
  let sourceRead = false
  let unreadReads = 0
  let status: api.SearchAnswer["status"] | null | undefined
  // forgetting the last answer makes the next read answer at once
  const forget = () => {
    invoice = null
    view = null
  }
  while (isRoute(mine)) {
    const asked = Date.now()
    const seq = ++reads
    try {
      if (invoiceId) {
        invoice = await api.readInvoice(invoiceId, invoice ? api.seenOf(invoice) : undefined, signal)
        view = invoice.registration
      } else {
        view = await api.readRegistration(registrationId!, view?.version, signal)
      }
    } catch (e) {
      if (!isRoute(mine)) return
      if (e instanceof api.ApiError && e.code === "not_found") {
        // The service forgets an unpaid order some time after it closes; this browser may know what replaced it, or its
        // code may find it.
        const known = registrationId ? store.orderByRegistration(registrationId) : invoiceId ? store.orderByInvoice(invoiceId) : undefined
        if (known?.replacedBy) return redirect(known.replacedBy)
        let newer: store.OrderRecord | null
        try {
          newer = known ? await flow.newerOrder(known) : null
        } catch (e) {
          // the code's orders could not be asked for now; the link may still work, so the page asks again
          if (!isRoute(mine)) return
          const wait = api.retryDelay(e, RETRY_MS)
          if (wait === null) return dispatch({ type: "not-found" })
          dispatch({ type: "read-failed" })
          await sleep(wait)
          continue
        }
        if (!isRoute(mine)) return
        return newer ? redirect(store.orderUrl(newer)) : dispatch({ type: "not-found" })
      }
      dispatch({ type: "read-failed" })
      await sleep(e instanceof api.ApiError && e.retryAfter ? e.retryAfter * 1000 : RETRY_MS)
      continue
    }
    if (!isRoute(mine)) return
    const pause = view.unread.length ? unreadDelay(unreadReads++) : null
    if (pause === null) unreadReads = 0
    const paced = async () => {
      if (pause === null) return false
      await sleep(pause)
      forget()
      return true
    }
    const answered = JSON.stringify(invoice ?? view)
    if (answered === drawn && !again) {
      // one answered unchanged at once would otherwise poll in a tight loop
      if (!await paced() && Date.now() - asked < RETRY_MS) await sleep(RETRY_MS)
      continue
    }
    again = false
    let record = store.orderByRegistration(view.id) ?? (invoiceId ? store.orderByInvoice(invoiceId) : undefined)
    if (record) {
      const synced = await flow.syncRecord(record, view)
      if (!isRoute(mine)) return
      record = synced ?? undefined
    }
    // A late payment to a replaced invoice keeps its page, which says that it is kept as the order's balance. Only a browser without this
    // order's record looks for its successor among its records, so two empty invoices never lead to each other.
    let unread: number | null = null
    try {
      const closedEmpty = invoice !== null && api.closedEmpty(invoice)
      const successor = closedEmpty && !record ? await nextOrder(view, invoice!) : undefined
      let replacement = successor && store.orderUrl(successor)
      if (!replacement && !record && invoice) record = await adoptSibling(view, invoice)
      if (!replacement && closedEmpty) replacement = record?.replacedBy
      // another browser may have made a newer invoice that this one never opened
      if (!replacement && closedEmpty && record) {
        const newer = await flow.newerOrder(record)
        replacement = newer ? store.orderUrl(newer) : undefined
      }
      if (!isRoute(mine)) return
      if (replacement) return redirect(replacement)
    } catch (e) {
      // a sibling's invoice could not be read; the page shows the order as this browser knows it and reads it again
      unread = api.retryDelay(e, RETRY_MS)
    }
    if (!isRoute(mine)) return
    if (view.phase !== "failed") codeChecked = false
    if (view.phase !== "taken" && view.phase !== "failed") status = undefined
    if (invoice && invoice.status !== "open") store.clearCardSubmitted(invoice.invoiceId)
    if (invoice && invoice.status !== "open" && record?.cardSubmittedAt) {
      store.updateOrder(record.registrationId, { cardSubmittedAt: undefined })
      record = { ...record, cardSubmittedAt: undefined }
    }
    record = (record && store.orderByRegistration(record.registrationId)) ?? record
    // links refused at another browser's reveal are kept with this browser's record, which a move then leaves out
    if (record && view.linksRefused && !record.linksRefused) {
      store.updateOrder(record.registrationId, { linksRefused: true })
      record = { ...record, linksRefused: true }
    }
    const recorded = JSON.stringify(record ?? null)
    if (answered !== drawn || recorded !== drawnRecord) {
      drawn = answered
      drawnRecord = recorded
      if (view.phase === "taken" && status === undefined) {
        status = await statusNow(view, record ?? null)
        if (!isRoute(mine)) return
      }
      dispatch({ type: "answered", seq, now: api.serviceNow(), invoice, view, record: record ?? null, cardSubmittedAt: cardSubmittedAt(invoice, record), nameStatus: status ?? null })
    }
    // A failed order is drawn first, and its name searched after: one registered or reserved since can move to another
    // name, from the browser with its name code.
    if (view.phase === "failed" && status === undefined && record && !view.linksRefused) {
      status = await statusNow(view, record)
      if (!isRoute(mine)) return
      if (status) dispatch({ type: "answered", seq: ++reads, now: api.serviceNow(), invoice, view, record, cardSubmittedAt: cardSubmittedAt(invoice, record), nameStatus: status })
    }
    // a closed order that a balance paid part of reads that balance once, for what its new invoice will pay
    if (!sourceRead && closedCase(state) !== null && record?.balanceSource) {
      sourceRead = true
      const balance = await api.readRegistration(record.balanceSource).then((v) => v.balance, () => null)
      if (!isRoute(mine)) return
      dispatch({ type: "source-read", balance })
    }
    // A failed order is drawn before its code is checked, saying nothing of the code until the check answers; a rate
    // limit is waited out, counting down, as often as it is met.
    if (view.phase === "failed" && !codeChecked && !invoice && record?.prepaidCode && !record.codeRefusal) {
      codeChecked = true
      let spent = await codeSpent(record.prepaidCode)
      while (typeof spent === "object" && spent !== null) {
        if (!isRoute(mine)) return
        const wait = spent.checkAgainIn * 1000
        dispatch({ type: "code-check-due", at: api.serviceNow() + wait })
        await sleep(wait)
        if (!isRoute(mine)) return
        spent = await codeSpent(record.prepaidCode)
      }
      if (!isRoute(mine)) return
      if (state.codeCheckAt !== null && spent !== false) dispatch({ type: "code-check-due", at: null })
      if (spent) {
        store.updateOrder(record.registrationId, { codeRefusal: "code_used" })
        record = store.orderByRegistration(record.registrationId) ?? record
        drawnRecord = JSON.stringify(record)
        dispatch({ type: "record-changed", record, cardSubmittedAt: cardSubmittedAt(invoice, record) })
      } else if (spent === false) dispatch({ type: "code-checked" })
    }
    // a finished order whose siblings could not be read is read once more before the page stops following it
    if (finished(invoice, view) && unread === null) return
    if (await paced()) continue
    if (unread !== null && invoice?.status !== "open") {
      await sleep(unread)
      forget()
      again = true
    }
  }
}

async function statusNow(view: api.RegistrationView, record: store.OrderRecord | null): Promise<api.SearchAnswer["status"] | null> {
  const label = labelOf(view, record)
  if (label === null) return null
  const answer = await api.searchName(view.labelHash, label.length).catch(() => null)
  return answer?.status ?? null
}

// Another order of the same buyer: one of this commitment, or of the code's wallet once it moved to another name.
const siblingOf = (view: api.RegistrationView) => (o: store.OrderRecord) => o.registrationId !== view.id &&
  (o.request.commitment === view.commitment || o.owner.toLowerCase() === view.owner.toLowerCase())

// The same order with a later invoice. Only an invoice that closes later can have replaced this one; expiry times are
// whole seconds, so a tie counts.
async function nextOrder(view: api.RegistrationView, invoice: api.InvoiceView): Promise<store.OrderRecord | undefined> {
  const candidates = store.orders().filter((o) => o.invoiceId && !o.replacedBy && siblingOf(view)(o))
  for (const o of candidates) {
    // a sibling the service has forgotten replaced nothing; any other failure leaves the answer unknown
    const other = await api.readInvoice(o.invoiceId!).catch((e) => { if (e instanceof api.ApiError && e.code === "not_found") return null; throw e })
    if (other && Date.parse(other.expiresAt) >= Date.parse(invoice.expiresAt)) return o
  }
  return undefined
}

// A browser holding the code of another invoice of this order holds this one too: another browser may have made a newer
// invoice, or money may have reached an older one late. The code reopens the name when the order has moved to another one.
async function adoptSibling(view: api.RegistrationView, invoice: api.InvoiceView): Promise<store.OrderRecord | undefined> {
  const sibling = store.orders().find(siblingOf(view))
  if (!sibling) return undefined
  const closed = invoice.status !== "open" && view.phase === "unpaid"
  const next = closed ? await nextOrder(view, invoice) : undefined
  const record: store.OrderRecord = { ...sibling, registrationId: view.id, invoiceId: invoice.invoiceId,
    method: invoice.cryptoCurrency ?? "card", paid: view.price,
    cancelled: false, cardSubmittedAt: undefined, prepaidCode: undefined, balanceSource: undefined, replacedBy: next && store.orderUrl(next),
    // a replaced invoice came just before its replacement; otherwise the code asks the service when the order was made,
    // which a later search for a newer order compares against
    createdAt: next ? new Date(Date.parse(next.createdAt) - 1).toISOString() : await flow.createdAtOf(sibling, view.id).catch(() => null) ?? new Date(api.serviceNow()).toISOString() }
  const adopted = await flow.syncRecord(record, view)
  if (adopted === record) store.saveOrder(record)
  if (adopted && !adopted.replacedBy) await replaceOlder(view, invoice)
  return adopted ?? undefined
}

// The older invoices of an order adopted here were replaced by it, as if this browser had asked for the new invoice.
async function replaceOlder(view: api.RegistrationView, invoice: api.InvoiceView): Promise<void> {
  for (const o of store.orders().filter((r) => r.invoiceId && !r.replacedBy && siblingOf(view)(r))) {
    const old = await api.readInvoice(o.invoiceId!).catch(() => null)
    if (old && old.status !== "open" && old.registration.phase === "unpaid" && Date.parse(old.expiresAt) <= Date.parse(invoice.expiresAt)) {
      store.updateOrder(o.registrationId, { replacedBy: store.orderUrl({ invoiceId: invoice.invoiceId, registrationId: view.id }) })
    }
  }
}

function reveal(view: api.RegistrationView, record: store.OrderRecord): void {
  const key = revealKey(view)
  const reference = state.reference
  dispatch({ type: "reveal-sent", key })
  flow.revealOrder(view, record).catch((e) => {
    // links the service refuses are in the commitment, so signing again cannot fix them: the order has to move
    if (e instanceof api.ApiError && e.code === "invalid_link") {
      store.updateOrder(record.registrationId, { linksRefused: true })
      // the record is changed first, so the reveal's end does not send it again
      if (isRoute(pageRoute) && state.reference === reference) dispatch({ type: "record-changed", record: { ...record, linksRefused: true }, cardSubmittedAt: state.cardSubmittedAt })
      dispatch({ type: "reveal-failed", key })
      return
    }
    const refused = e instanceof api.ApiError && e.code === "bad_request"
    setTimeout(() => {
      dispatch({ type: refused ? "reveal-refused" : "reveal-failed", key })
      if (isRoute(pageRoute) && state.reference === reference) refresh()
    }, e instanceof api.ApiError && e.retryAfter ? e.retryAfter * 1000 : RETRY_MS)
  })
}

// Terms of the name's kind that changed on chain since the order are agreed to again before the owner signs their
// acceptance at the reveal.
let askingAgain: number | null = null
function askAgain(record: store.OrderRecord): void {
  const gen = opened
  askingAgain = gen
  const done = () => { if (askingAgain === gen) askingAgain = null }
  // after a pause, a search that failed for now is made again, and after one that answered other terms than the
  // view's, the view is read again; one that answered the name as registered or reserved ends the ask, which the page says
  const later = (delay: number, again: () => void) => setTimeout(() => { done(); again() }, delay)
  const tick = () => answer(gen, { type: "tick", now: api.serviceNow() })
  api.searchName(state.view!.labelHash, record.label.length).then((quote) => {
    if (!isOpen(gen) || !askAgainDue(state)) return done()
    if (quote.status !== "available") {
      done()
      return answer(gen, { type: "name-unavailable", key: commitKey(state.view!), status: quote.status })
    }
    if (!flow.orderable(quote) || quote.terms.hash !== state.view!.acceptance!.termsHash) return later(RETRY_MS, () => reread(gen))
    done()
    askTerms(gen, record.label, quote, true)
    // the notice is focused only while the focus is on the page, not in the header, the footer or a dialog
    const active = document.activeElement
    if (active === document.body || active?.closest("body > main")) focusOn("reveal")
  // a refusal is no answer about the name, so the search is made again after a pause as well
  }, (e) => later(api.retryDelay(e, RETRY_MS) ?? RETRY_MS, tick))
}

function keepCodes(s: OrderState): void {
  const { view, record, invoice } = s
  if (!view || !record) return
  const released = screenOf(s) === "taken" && !invoice ? releasedCode(view, record) : null
  if (released && !store.codes().some((c) => c.code === released.code)) store.addCode({ ...released, addedAt: new Date().toISOString() })
}

function releasedCode(view: api.RegistrationView, record: store.OrderRecord | null): Omit<store.CodeRecord, "addedAt"> | null {
  const parsed = record?.prepaidCode ? parseNameCode(record.prepaidCode) : null
  return parsed?.kind === "prepaid" ? { code: parsed.display, minLength: parsed.minLength, years: view.years } : null
}

// holdsFor is the screen's signal where the screen holds an action for the tab's wait
const noteText = (note: Note): Kid => note.link ? [note.text, el("a", { href: note.link.href }, note.link.text), note.link.after] : note.text
export const noteBox = (note: Note) => alertBox(note.tone, note.icon, note.title, noteText(note))

function noteOf({ hold, note, codeCheckAt }: OrderState, holdsFor: AbortSignal | null): HTMLElement | null {
  if (holdsFor && hold) return holdNotice(hold, holdsFor)
  if (note || !holdsFor || codeCheckAt === null) return note && noteBox(note)
  const line = el("span", {})
  const notice = alertBox("warn", "clock", "Too many checks just now", line)
  waitOut(line, Math.max(1, Math.ceil((codeCheckAt - api.serviceNow()) / 1000)), (left) => `Your code may be fine. Checking again in ${left}.`, () => undefined, holdsFor)
  return notice
}

const actionNote = (s: OrderState, holdsFor: AbortSignal | null) => keptLive(ORDER_NOTE, undefined, noteOf(s, holdsFor))

function buildUnreadable({ reference }: OrderState): HTMLElement {
  return outcome({ tone: "warn", icon: "alert", title: "This order could not be loaded", text: "The page keeps trying. If it does not load, quote the reference below.", reference })
}

function buildUnknownLink(): HTMLElement {
  return outcome({ tone: "info", icon: "link", title: "This link does not work", text: "It names no order this service knows. Check the link, or start again.",
    action: btn("Search a name", "", () => go("/#/")) })
}

function buildPaidByInvoice({ view, record }: OrderState): HTMLElement {
  return outcome({ tone: "info", icon: "link", title: "This order is paid by invoice", text: "Its page is the payment link it was made with.",
    action: record?.invoiceId ? btn("Open its payment", "", () => go(store.orderUrl(record))) : btn("Search a name", "quiet", () => go(searchLink(""))),
    reference: view!.id })
}

// a browser without the order's record learns the name only once it is revealed on chain
const labelOf = (view: api.RegistrationView, record: store.OrderRecord | null) => view.label ?? record?.label ?? null
const UNKNOWN_NAME = "The name shows once it is registered"

// what the order is for and what it cost, after its name where the screen has not said it already
function termLine({ view, invoice }: OrderState): Kid[] {
  const paid = costOf(view!, invoice)
  const years = api.termYears(view!.community, view!.years)
  if (!paid) return [el("span", { class: "nowrap" }, `${years} years`), SEP, "With a code"]
  const { cost, fromBalance } = paid
  return [el("span", { class: "nowrap" }, `${dollars(cost)} / ${years} years`),
    fromBalance ? [SEP, el("span", { class: "nowrap" }, fromBalance === cost ? "Paid from your balance" : `${dollars(fromBalance)} from your balance`)] : null]
}

// the order in one line, the lead of each screen that pays or registers it
function orderLine(s: OrderState): Kid[] {
  const label = labelOf(s.view!, s.record)
  return [label ? nameText(label, s.view!.tld) : UNKNOWN_NAME, SEP, ...termLine(s)]
}

const TICKER: Record<"btc" | "xmr", string> = { btc: "BTC", xmr: "XMR" }
const WALLET = "Open in wallet"

// the invoice an earlier try made, which a checkout opened in place of paying as it chose; said until its page is left
let instead: { invoiceId: string; had: string; chosen: string } | null = null
export const openedInstead = (opened: typeof instead) => { instead = opened }
const methodWord = (method: string) => method === "card" ? "card" : methodName(method)
const insteadWords = (invoice: api.InvoiceView) => instead?.invoiceId !== invoice.invoiceId ? null
  : `This name already has a ${methodWord(instead.had)} invoice from an earlier try, so it opened instead of ${instead.chosen === "code" ? "using your code" : instead.chosen === "balance" ? "using your balance" : `a new ${methodWord(instead.chosen)} one`}.`
const insteadLine = (invoice: api.InvoiceView) => {
  const words = insteadWords(invoice)
  return words && el("p", { class: "note" }, words)
}

function copyField(label: string, value: string): HTMLElement {
  // A long value, as an address, may break between any two letters, which the field's balance evens out: WebKit
  // balances only between the breaks it is given, Firefox only in a word that breaks anywhere (.word).
  const shown = [...value].flatMap((ch, i) => i ? [el("wbr"), ch] : [ch])
  return el("div", { class: "copy-field" }, el("span", { class: "label" }, label),
    el("div", { class: "val" }, el("span", { class: "word" }, ...shown), copyButton(value, "field-copy", `Copy ${label}`)))
}

function validLine(invoice: api.InvoiceView, signal: AbortSignal): HTMLElement {
  const left = () => (Date.parse(invoice.expiresAt) - api.serviceNow()) / 1000
  const time = el("span", { class: "time" })
  onTheSecond(left, () => { time.textContent = clock(left()) }, signal)
  return el("span", {}, "Invoice valid for ", time)
}

// Someone may register the name before an unpaid invoice is paid, so its pay page checks the name as it opens and
// every few minutes. A browser without the order's record does not know the name's length, which the search needs.
const NAME_CHECK_MS = 5 * 60_000
const NAME_NOTE = "name-note"
let nameCheck: { invoiceId: string; taken: boolean; at: number } | null = null
let nameWatch: { invoiceId: string; timer?: ReturnType<typeof setTimeout> } | null = null
// the payment's details on the pay page in view, which a name taken meanwhile turns off
let payDetails: HTMLElement | null = null

const checksName = (s: OrderState) => (screenOf(s) === "pay-crypto" || screenOf(s) === "pay-card") && !partlyPaid(s.invoice!) && labelOf(s.view!, s.record) !== null
const nameTaken = () => nameCheck !== null && nameCheck.invoiceId === state.invoice?.invoiceId && nameCheck.taken

function watchName(s: OrderState): void {
  const invoiceId = s.invoice!.invoiceId
  if (nameWatch?.invoiceId === invoiceId) return
  stopWatchingName()
  const { labelHash } = s.view!
  const { length } = labelOf(s.view!, s.record)!
  const watch: NonNullable<typeof nameWatch> = { invoiceId }
  nameWatch = watch
  const check = async () => {
    let next = NAME_CHECK_MS
    try {
      const answer = await api.searchName(labelHash, length)
      if (nameWatch !== watch) return
      nameCheck = { invoiceId, taken: answer.status === "registered", at: Date.now() }
      showNameCheck()
    } catch (e) {
      next = api.retryDelay(e, RETRY_MS) ?? NAME_CHECK_MS
    }
    if (nameWatch === watch) watch.timer = setTimeout(check, next)
  }
  void check()
}

function stopWatchingName(): void {
  clearTimeout(nameWatch?.timer)
  nameWatch = null
  nameCheck = null
  payDetails = null
}

// The note holds both sentences in one cell, the one not in force hidden, so it keeps its height as one replaces the
// other; it is hidden until the first check answers. The card page's note is its one notice (cardWords).
function nameNote(s: OrderState): HTMLElement {
  if (checksName(s)) watchName(s)
  const note = kept(NAME_NOTE, () => el("div", { class: "notice name-check unchecked", role: "status" }))
  fillNameNote(note, s)
  return note
}

// What the card page says above its form, other than its name's check, by priority under a taken name: what an action
// met, that this browser cannot remember a card payment, that an earlier try's invoice opened. It says one thing there,
// in the room held for the name's note, so nothing reaches Pay.
function cardWords(s: OrderState): { tone: Note["tone"] | null; words: Kid[] }[] {
  const opened = insteadWords(s.invoice!)
  return [
    s.note && { tone: s.note.tone, words: [s.note.title && [el("b", {}, `${s.note.title}.`), " "], noteText(s.note)] },
    store.canPersist() ? null : { tone: "warn" as const, words: [el("b", {}, "This browser cannot remember a card payment."), " After paying, keep this page open until it moves on. Reloading would show the card form again."] },
    opened === null ? null : { tone: null, words: [opened] },
  ].filter((said) => said !== null)
}

function fillNameNote(note: HTMLElement, s: OrderState): void {
  const card = screenOf(s) === "pay-card"
  const others = card ? cardWords(s) : []
  const other = others[0] ?? null
  const shown = JSON.stringify([nameCheck, card, others.length, card && s.note, other?.tone ?? null])
  if (note.dataset.shown === shown) return
  note.dataset.shown = shown
  const taken = nameTaken()
  const time = timeOf(nameCheck?.at ?? Date.now())
  const dontPay = "Don't pay this invoice: cancel it and choose another name."
  // the card page says them in brief, so Stripe's form fits above Pay with a name of 63 letters
  const free: Kid[] = card ? [el("b", {}, "Available"), ` at ${time}. If someone registers it first, you keep the payment as balance.`]
    : [el("b", {}, "The name is available"), ` (checked at ${time}). `,
      "If someone registers it before you pay and the registration succeeds, what you paid is kept as your balance for another name, or refunded on request."]
  const gone: Kid[] = card ? [el("b", {}, "Taken"), ` at ${time}. ${dontPay}`] : [el("b", {}, "Someone has registered this name"), ` (checked at ${time}). `, dontPay]
  const said = taken ? gone : other?.words ?? free
  note.replaceChildren(...[free, gone, ...others.map((o) => o.words)].map((words) => {
    const sentence = el("span", {}, ...words)
    sentence.classList.toggle("sizer", words !== said)
    return sentence
  }))
  const tone = taken ? "danger" : other?.tone
  note.classList.toggle("danger", tone === "danger")
  note.classList.toggle("warn", tone === "warn")
  note.classList.toggle("unchecked", nameCheck === null && !other)
}

function refillNameNote(s: OrderState): void {
  const note = document.querySelector<HTMLElement>("body > main .name-check")
  if (note) fillNameNote(note, s)
}

// what a check answered shows in place, so the card form keeps what was typed
function showNameCheck(): void {
  if (!isRoute(pageRoute) || !checksName(state)) return
  refillNameNote(state)
  if (payDetails) turnOff(payDetails, nameTaken())
  if (payButton) setAction(payButton, state.busy === "card", card === null || nameTaken())
}

function turnOff<T extends HTMLElement>(details: T, off: boolean): T {
  details.classList.toggle("off", off)
  details.inert = off
  return details
}

const partSeen = (invoice: api.InvoiceView, coin: "btc" | "xmr") => `Part of the payment arrived: ${invoice.cryptoAmountPaid} of ${invoice.cryptoAmount} ${TICKER[coin]} is seen.`
const restAsked = (invoice: api.InvoiceView, coin: "btc" | "xmr") => `Send the remaining ${invoice.cryptoAmountDue} ${TICKER[coin]} to the same address.`
const INVOICE_EXPIRED = "The invoice expired before the full amount arrived. Don't send more; what you sent is kept as your balance."

// A part-paid invoice stays open past its rate window until it closes, and past the window asks for no more: of its
// payment controls only the address stays. When the window ends in view, the words and controls that ask for more are
// hidden in place, so nothing on the screen moves.
function partLines(invoice: api.InvoiceView, coin: "btc" | "xmr", payMore: (HTMLElement | null)[], signal: AbortSignal): { notice: Kid; rate: HTMLElement; ended: boolean } {
  const left = () => (Date.parse(invoice.expiresAt) - api.serviceNow()) / 1000
  if (left() <= 0) return { notice: partSeen(invoice, coin), rate: el("span", {}, INVOICE_EXPIRED), ended: true }
  const rest = el("span", {}, restAsked(invoice, coin))
  const time = el("span", {})
  const held = el("span", {}, "Waiting for the rest of the payment", SEP, "Invoice valid for ", time)
  const expired = el("span", { class: "sizer" }, INVOICE_EXPIRED)
  onTheSecond(left, () => {
    if (left() > 0) time.textContent = clock(left())
    else if (expired.classList.contains("sizer")) {
      for (const node of [rest, held, ...payMore]) node?.classList.add("sizer")
      expired.classList.remove("sizer")
    }
  }, signal)
  return { notice: [partSeen(invoice, coin), " ", rest], rate: el("span", { class: "sized" }, held, expired), ended: false }
}

function cancelLink(s: OrderState): HTMLAnchorElement {
  const working = s.busy === "cancel"
  const cancel = link(working ? "Cancelling…" : "Cancel this invoice", () => void cancelInvoice())
  cancel.classList.add("danger-link")
  cancel.dataset.focus = "cancel"
  if (working) cancel.setAttribute("aria-disabled", "true")
  return cancel
}

function buildPayCrypto(s: OrderState, signal: AbortSignal): HTMLElement {
  const inv = s.invoice!
  const coin = coinOf(inv)!
  const partial = Number(inv.cryptoAmountPaid ?? "0") > 0
  const due = partial ? inv.cryptoAmountDue! : inv.cryptoAmount!
  const uri = paymentUri(coin, inv.address!, due)
  holdEnds(signal)(s.hold !== null)
  // the QR's link shows on a laptop only, as styles.css draws the phone's layout without the QR
  const qr = uri ? el("div", { class: "qr" }, qrSvg(uri, `${methodName(coin)} payment`), el("a", { href: paymentUri(coin, inv.address!, due, true)! }, WALLET)) : null
  // labels in sentence case, as their copy buttons say them; the label style draws them in capitals
  const amount = copyField(`${partial ? "rest to send" : "amount"} in ${TICKER[coin]}`, due)
  const address = copyField(`${methodName(coin)} address`, inv.address!)
  const wallet = uri ? el("a", { class: "wallet", href: uri }, WALLET) : null
  const part = partial ? partLines(inv, coin, [qr, amount, wallet], signal) : null
  const waiting = el("span", { class: "waiting" }, el("i", { class: "dot", "aria-hidden": "true" }), "Waiting for payment")
  const note = part ? alertBox("warn", "alert", null, part.notice) : checksName(s) ? nameNote(s) : null
  // a phone opens its wallet from the link under the address, a laptop from the QR's
  payDetails = el("div", { class: "card pay" },
    part?.ended ? address : el("div", { class: "qr-grid" }, qr, el("div", { class: "copy-fields" }, amount, address)),
    part?.ended ? null : wallet,
    el("div", { class: "pay-status" }, part ? part.rate : waiting, part ? null : validLine(inv, signal), el("span", { class: "ref" }, "Reference ", el("span", { class: "mono" }, inv.invoiceId))))
  return screen({ title: `Pay with ${methodName(coin)}`, lead: orderLine(s), alt: partial ? null : cancelLink(s) },
    note,
    insteadLine(inv),
    turnOff(payDetails, nameTaken()),
    // a wait the tab is in shows why the link does nothing until it is over
    actionNote(s, partial ? null : signal))
}

// The Stripe frame reloads, losing what was typed, whenever its form moves in the page; so while the card screen stays
// for the same invoice, a change shows on Pay and its note where they are, as the badge store's card form does.
let card: MountedCard | null = null
// the form a card is mounted in, or being mounted in; a mount that answers after it was dropped is destroyed
let cardIn: HTMLElement | null = null
let cardMounts = 0
let payButton: HTMLButtonElement | null = null
// without a Stripe key in development, Pay does what a submitted card does; the mock's controls settle it
const STAND_IN: MountedCard = { confirm: async () => ({ kind: "submitted" }), destroy: () => undefined }

function dropCard(): void {
  cardMounts += 1
  card?.destroy()
  card = null
  cardIn?.replaceChildren()
  cardIn = null
  payButton = null
}

function mountInto(form: HTMLElement, invoice: api.InvoiceView): void {
  const mine = ++cardMounts
  cardIn = form
  const key = publishableKey()
  if (!key && import.meta.env.DEV) {
    cardStandIn(form)
    card = STAND_IN
    return
  }
  void mountCard(key, invoice.clientSecret ?? "", form, pageTheme).then((mounted) => {
    if (mine !== cardMounts) return mounted?.destroy()
    if (!mounted) return dispatch({ type: "card-failed" })
    card = mounted
    showCard()
  })
}

const cardStays = (before: OrderState, kind: OrderKind) =>
  payButton !== null && kind === "pay-card" && screenOf(before) === "pay-card" && before.invoice?.invoiceId === state.invoice?.invoiceId

function showCard(): void {
  if (!payButton) return
  setAction(payButton, state.busy === "card", card === null || nameTaken())
  document.querySelector('body > main [data-focus="cancel"]')?.replaceWith(cancelLink(state))
  refillNameNote(state)
}

async function payByCard(): Promise<void> {
  if (state.busy || !card) return
  const gen = opened
  const { invoice, record } = state
  dispatch({ type: "card-started" })
  const confirmed = await card.confirm()
  if (!isOpen(gen)) return
  if (confirmed.kind !== "submitted") return dispatch({ type: "card-refused", note: confirmed.kind === "error" ? { tone: "danger", icon: "alert", title: null, text: confirmed.message } : null })
  // The page knows the card was submitted without asking the service, so it shows that at once, in an outage too.
  const at = new Date(api.serviceNow()).toISOString()
  store.markCardSubmitted(invoice!.invoiceId, at)
  if (record) store.updateOrder(record.registrationId, { cardSubmittedAt: at })
  dispatch({ type: "card-submitted", at })
}

const STRIPE_NOTE = "The card form is Stripe's. Nothing is charged until you pay."

function buildPayCard(s: OrderState): HTMLElement {
  const invoice = s.invoice!
  const form = kept("stripe-form", () => el("div", { class: "stripe" }))
  if (cardIn !== form) mountInto(form, invoice)
  const notice = nameNote(s)
  payDetails = turnOff(form, nameTaken())
  payButton = setAction(btn(`Pay ${dollars(invoice.amount)}`, "", () => void payByCard()), s.busy === "card", card === null || nameTaken())
  payButton.dataset.focus = "pay"
  // Stripe's note is under Pay and Cancel, so the form fits above Pay
  const alt = el("span", {}, cancelLink(s), el("span", { class: "note stripe-note" }, STRIPE_NOTE))
  return screen({ title: "Pay by card", lead: orderLine(s), action: payButton, alt }, notice, form)
}

function cardStandIn(form: HTMLElement): void {
  const f = (text: string, value: string) => el("label", { class: "f" }, el("span", {}, text), el("div", { class: "box" }, value))
  form.append(el("p", { class: "label" }, "Test card form: no Stripe key is set, so Pay simulates a payment."),
    f("Card number", "4242 4242 4242 4242"), el("div", { class: "cols" }, f("Expiry", "12 / 30"), f("CVC", "123"), f("Country", "Portugal")))
}

// what a browser without the order's record can do: take in the name code
const withoutRecord = (cls: string, text = "Enter your name code") => btn(text, cls, () => go(CODE_FROM_ORDER_URL))
// in codes-only mode a prepaid code is the only way to a name: nothing here orders or pays again
const codeAction = () => btn("Register with code", "", () => go(CODE_URL))
// a page opened before the service took codes only, refused a new invoice or a spend
const CODES_ONLY_NOTE: Note = { tone: "warn", icon: "key", title: CODES_ONLY_TITLE, text: "Nothing was charged. ", link: { text: "Enter a code", href: CODE_URL, after: "." } }

const CLOSED_TITLE = "Invoice closed"
const KEPT_LATE = "kept as your balance for this name or another, or refunded on request; Your names shows it."
const partlyPaid = (invoice: api.InvoiceView) => Number(invoice.cryptoAmountPaid ?? "0") > 0

function buildClosed(s: OrderState, signal: AbortSignal): HTMLElement {
  const inv = s.invoice!
  const closed = closedCase(s)!
  const [tone, text] = closedWords(closed, inv, s.view!)
  const kept = closedBalance(s)
  // only a new invoice is held for the tab's wait; the balance kept pays for one of the same name
  const reorders = !codesOnly() && (kept === "offer" || ((closed === "received" || closed === "expired") && s.record !== null && !s.record.replacedBy))
  holdEnds(signal)(s.hold !== null)
  const replaced = kept === "replaced" ? el("p", { class: "note" }, "What reached this invoice is kept as your balance: you can cancel the new invoice and use the balance instead.") : null
  return outcome({ tone, icon: "alert", title: CLOSED_TITLE, text, reference: inv.invoiceId,
    extra: [replaced, actionNote(s, reorders ? signal : null)], agreement: reorders ? agreement(s, "reorder") : null,
    ...kept === "offer" ? balanceActions(s, newInvoiceButton(s, "", reorder)) : { action: closedAction(s, closed) } })
}

function agreement({ ask, view, busy, reveal }: OrderState, focus: string): HTMLElement | null {
  if (!ask) return null
  const agree = (agreed: boolean) => dispatch({ type: "terms-agreed", agreed, now: api.serviceNow() })
  const accept = (accepted: boolean) => dispatch({ type: "terms-accepted", accepted, now: api.serviceNow() })
  // a reveal on its way has signed the ticked terms already
  const signing = reveal?.sending === true && reveal.key === revealKey(view!)
  return termsBox({ ...ask, tld: view!.tld, chainId: view!.chainId, disabled: busy !== null || signing }, agree, focus, accept)
}

const unagreed = ({ ask }: OrderState) => ask !== null && !ticked(ask)

// the box takes focus as it comes; the notice of changed terms takes the button's
function askTerms(gen: number, label: string, quote: Pick<flow.Quote, "terms" | "community">, changed = state.ask?.label === label): void {
  answer(gen, { type: "terms-asked", label, terms: quote.terms, community: quote.community, changed })
  if (!changed && isOpen(gen)) focusOn("agreed")
}

function termsOrAsk(gen: number, record: store.OrderRecord, signed: string | null | undefined, quote: flow.Quote): string | null {
  const terms = termsToSign(record.label, api.currentTerms(quote), signed, state.ask)
  if (terms === null) askTerms(gen, record.label, quote)
  return terms
}

async function signsHere(record: store.OrderRecord, invoice: api.InvoiceView): Promise<boolean> {
  const by = newInvoiceBy(record, invoice)
  if (by === "order") return true
  const source = await sourceOf(by, record, invoice)
  return source != null && await balanceOf(source) !== null
}

// the order whose balance a new invoice of a closed one spends
async function sourceOf(by: "spend" | "find" | "own", record: store.OrderRecord, invoice: api.InvoiceView): Promise<string | null | undefined> {
  if (by === "own") return invoice.registration.id
  return by === "find" ? await flow.balanceSourceOf(record) : record.balanceSource
}

// nothing is cancelled before the buyer has agreed to the terms the new invoice would sign
async function agreedFirst(gen: number, record: store.OrderRecord, invoice: api.InvoiceView): Promise<boolean> {
  try {
    const quote = await flow.quoteOf(record.label)
    if (!quote || !await signsHere(record, invoice)) return true
    return termsOrAsk(gen, record, invoice.registration.terms ?? record.terms, quote) !== null
  } catch (e) {
    if (!holdOn(e, "The invoice is still open. ", gen)) {
      answer(gen, { type: "reorder-failed", note: termsUnavailable(e) ? noOrders("The invoice is still open. ") : warning("The name could not be checked now. Try again in a moment.") })
    }
    return false
  }
}

// a late credit the service cannot make by itself, which support makes by hand
const creditBySupport: Kid[] = [" It is not credited to your balance by itself: write to ", el("a", { href: `mailto:${CONTACT_EMAIL}` }, CONTACT_EMAIL), " with the reference below."]

const KEPT_ONCE: Record<Exclude<api.LateWait, "support">, string> = { confirming: "Once confirmed, it is", crediting: "Once credited, it is" }

function closedWords(closed: ClosedCase, inv: api.InvoiceView, view: api.RegistrationView): [Tone, Kid] {
  const waiting = view.latePayment?.waiting
  const kept = (lead: string): Kid => waiting === "support" ? [lead, creditBySupport] : `${lead} ${waiting ? KEPT_ONCE[waiting] : "It is"} ${KEPT_LATE}`
  switch (closed) {
    case "paid-late": return ["warn", kept("The payment arrived after this invoice had closed, so nothing was registered.")]
    case "cancelled": return ["info", "This invoice was cancelled and nothing was received."]
    case "received": {
      const coin = coinOf(inv)
      return ["warn", kept(coin && partlyPaid(inv) && !inv.paidInFull ? `${inv.cryptoAmountPaid} ${TICKER[coin]} arrived, which is not the full amount.` : "A payment did not complete before the invoice closed.")]
    }
    case "expired": return ["info", inv.cryptoCurrency ? "Nothing was received before it closed." : "Nothing was paid before it closed."]
  }
}

// a new invoice is a new order of this order's name code, which only the browser holding it can make
function closedAction(s: OrderState, closed: ClosedCase): HTMLButtonElement {
  const { record } = s
  if (record?.replacedBy) return btn("Open the new invoice", "quiet", () => go(record.replacedBy!))
  if (codesOnly()) return codeAction()
  if (closed === "paid-late") return btn("Search a name", "quiet", () => go(searchLink("")))
  if (!record) return withoutRecord("quiet")
  if (closed === "cancelled") {
    const again = setAction(btn("Order the name again", "", () => void orderAgain(record)), s.busy === "reorder", s.hold !== null)
    again.dataset.focus = "reorder"
    return again
  }
  return newInvoiceButton(s, closed === "received" && !record.cancelled ? "quiet" : "", reorder)
}

// The balance that paid part of an order, as its own order reads now; null when none is left.
async function balanceOf(source: string): Promise<session.AppliedBalance | null> {
  return session.appliedBalance(source, (await api.readRegistration(source)).balance)
}

// A cancelled order is ordered again on Check your order, with the same name code, saved already, the same links, and
// the balance that paid part of it, if any is left.
async function orderAgain(record: store.OrderRecord): Promise<void> {
  const gen = opened
  dispatch({ type: "reorder-started" })
  let quote: Awaited<ReturnType<typeof flow.quoteOf>>
  let balance: session.AppliedBalance | null
  try {
    quote = await flow.quoteOf(record.label)
    balance = record.balanceSource ? await balanceOf(record.balanceSource) : null
  } catch (e) {
    if (holdOn(e, "Nothing was charged. ", gen)) return
    return answer(gen, { type: "reorder-failed", note: termsUnavailable(e) ? noOrders("Nothing was charged. ") : warning("The name could not be checked now. Try again in a moment.") })
  }
  if (!isOpen(gen)) return
  if (!quote) return go(searchLink(record.label))
  if (balance) session.setActiveBalance(balance)
  session.setCheckout({
    label: record.label, price: quote.price, years: quote.years, termStart: quote.termStart, chain: flow.chainOf(quote), contact: record.contact, channel: record.channel,
    terms: quote.terms, community: quote.community,
    method: record.method === "code" || record.method === "balance" ? "btc" : record.method, code: null, balance, ownerCode: record.ownerCode, saved: true, agreed: false, searchAt: historyPlace(), step: "review",
  })
  go(checkoutUrl("review"))
}

function newInvoiceButton(s: OrderState, cls: string, get: () => void): HTMLButtonElement {
  const again = setAction(btn(spendCovers(s) ? "Register with your balance" : "Get a new invoice", cls, get), s.busy === "reorder", s.hold !== null || unagreed(s))
  again.dataset.focus = "reorder"
  return again
}

// A card never submitted is on this screen only because its form failed to load.
function buildCardUnconfirmed(s: OrderState, signal: AbortSignal): HTMLElement {
  const inv = s.invoice!
  const formFailed = s.cardSubmittedAt === null
  const reorders = formFailed && !codesOnly()
  holdEnds(signal)(s.hold !== null)
  return outcome({ tone: "warn", icon: "alert", title: "Card payment not confirmed", reference: inv.invoiceId,
    text: formFailed ? "Stripe's form was blocked or failed to load. Nothing was charged."
      : "The payment has not been confirmed. This page keeps checking: come back to it later, or quote the reference below.",
    extra: actionNote(s, reorders && s.record !== null ? signal : null), agreement: reorders ? agreement(s, "reorder") : null, action: cardAction(s, formFailed),
    alt: reorders && s.record ? coinLinks(s) : null })
}

// a card form that did not load leaves the coins: each cancels the card invoice and orders the name again paid with it
function coinLinks(s: OrderState): HTMLElement {
  const coin = (method: "btc" | "xmr") => {
    const pay = link(`Pay with ${methodName(method)}`, () => void reorderAfterCancel(method))
    if (s.busy !== null || s.hold !== null || unagreed(s)) pay.setAttribute("aria-disabled", "true")
    return pay
  }
  return el("span", {}, coin("btc"), SEP, coin("xmr"))
}

// Once the service has seen a card payment, entering the card again could charge twice.
function cardAction(s: OrderState, formFailed: boolean): HTMLButtonElement | null {
  if (formFailed) return codesOnly() ? codeAction() : s.record ? newInvoiceButton(s, "", () => void reorderAfterCancel()) : withoutRecord("")
  return s.invoice!.amountPaid ? null : btn("Enter the card again", "", enterCardAgain)
}

async function reorderAfterCancel(method: api.Method = "card"): Promise<void> {
  if (state.busy || state.hold || unagreed(state)) return
  const gen = opened
  const invoice = state.invoice!
  const record = store.orderByInvoice(invoice.invoiceId)
  dispatch({ type: "reorder-started" })
  if (record && !await agreedFirst(gen, record, invoice)) return
  if (await cancelBeforeReorder(invoice, gen)) return newInvoice(invoice, record, gen, method)
  if (store.orderByInvoice(invoice.invoiceId)?.cancelled) reread(gen)
}

// The old invoice is cancelled before a new one is ordered; true when ordering again cannot charge twice.
async function cancelBeforeReorder(invoice: api.InvoiceView, gen: number): Promise<boolean> {
  const say = (text: string) => answer(gen, { type: "reorder-failed", note: warning(text) })
  let after: api.InvoiceView
  try {
    after = await api.cancelInvoice(invoice.invoiceId)
    const record = store.orderByInvoice(invoice.invoiceId)
    if (record && after.status !== "paid") store.updateOrder(record.registrationId, { cancelled: true })
  } catch (e) {
    const code = e instanceof api.ApiError ? e.code : "network"
    if (holdOn(e, "The invoice is still open. ", gen)) return false
    if (code !== "not_open") {
      say(code === "funded" ? "A payment has reached this invoice, so it is kept." : "The invoice could not be cancelled now. Try again in a moment.")
      return false
    }
    try {
      after = await api.readInvoice(invoice.invoiceId)
    } catch {
      say("The invoice could not be read now. Try again in a moment.")
      return false
    }
  }
  if (after.status === "paid" && after.registration.phase !== "unpaid") {
    if (isOpen(gen)) go(store.invoiceUrl(after.invoiceId))
    return false
  }
  if (after.status === "paid" || !api.holdsPayment(after)) return true
  say("A payment has reached this invoice, so it is kept. Quote the reference below.")
  return false
}

async function cancelInvoice(): Promise<void> {
  if (state.busy || state.hold) return
  const gen = opened
  const { invoice, record } = state
  dispatch({ type: "cancel-started" })
  try {
    const after = await api.cancelInvoice(invoice!.invoiceId)
    if (record && after.status !== "paid") store.updateOrder(record.registrationId, { cancelled: true })
    answer(gen, { type: "cancel-answered" })
    reread(gen)
  } catch (e) {
    // an invoice that closed meanwhile, or an order another request changed first, is shown as it is now
    if (e instanceof api.ApiError && (e.code === "not_open" || e.code === "registration_changed")) {
      answer(gen, { type: "cancel-answered" })
      return reread(gen)
    }
    if (e instanceof api.ApiError && e.code === "funded") return answer(gen, { type: "cancel-failed", note: warning("A payment has reached this invoice, so it cannot be cancelled.") })
    if (holdOn(e, "The invoice is still open. ", gen)) return
    answer(gen, { type: "cancel-failed", note: warning("The invoice could not be cancelled now. Try again in a moment.") })
  }
}

function buildConfirming(s: OrderState): HTMLElement {
  const invoice = s.invoice!
  const coin = coinOf(invoice)
  const notice = coin
    ? alertBox("info", "clock", confirmations(invoice.requiredConfirmations ?? 1),
      `${invoice.cryptoAmount} ${TICKER[coin]} arrived. Registration starts once it confirms; this page moves on by itself.`)
    : alertBox("info", "clock", "Waiting for Stripe to\u00a0confirm", "Stripe usually confirms within a minute. Registration starts by itself; this page moves on.")
  // a card Stripe has not confirmed can still be cancelled while nothing is paid, as an unpaid crypto invoice can
  const cancel = !coin && !invoice.amountPaid ? cancelLink(s) : null
  return screen({ title: coin ? "Confirming your payment" : "Paying by card", lead: orderLine(s), alt: cancel }, notice, referenceLine(invoice.invoiceId), actionNote(s, null))
}

function enterCardAgain(): void {
  const { invoice, record } = state
  store.clearCardSubmitted(invoice!.invoiceId)
  if (record) store.updateOrder(record.registrationId, { cardSubmittedAt: undefined })
  dispatch({ type: "record-changed", record: record && { ...record, cardSubmittedAt: undefined }, cardSubmittedAt: null })
}

function reorder(): void {
  if (unagreed(state)) return
  const gen = opened
  const { invoice, record } = state
  dispatch({ type: "reorder-started" })
  void newInvoice(invoice!, record ?? undefined, gen)
}

function buildPriceChanged({ record, invoice, price }: OrderState): HTMLElement {
  const { label } = record!
  return outcome({ tone: "warn", icon: "alert", title: "The price changed", text: [nameText(label, invoice!.registration.tld), ` costs ${dollars(price!)} now. Nothing was charged.`],
    action: btn("Search again", "", () => go(searchLink(label))), reference: invoice!.invoiceId })
}

async function newInvoice(invoice: api.InvoiceView, record: store.OrderRecord | undefined, gen: number, method: api.Method = invoice.cryptoCurrency ?? "card"): Promise<void> {
  if (!isOpen(gen) || !record) return
  try {
    // the invoice as it is now: one still open, or paid into a registration, is the order; one paid after it closed
    // registered nothing, so the name is ordered again and the late payment is kept as the old order's balance
    const now = await api.readInvoice(invoice.invoiceId)
    if (now.status === "open" || (now.status === "paid" && now.registration.phase !== "unpaid")) {
      if (isOpen(gen)) go(store.invoiceUrl(invoice.invoiceId))
      return
    }
    // a new invoice is a new order of the same name code, at the price this one was made for
    const quote = await flow.quoteOf(record.label)
    if (!quote) {
      if (isOpen(gen)) go(searchLink(record.label))
      return
    }
    // part of the price came from a balance, which pays again, or money on the invoice became the order's own; a browser
    // that adopted the order asks find which balance
    const by = newInvoiceBy(record, now)
    const signed = now.registration.terms ?? record.terms
    if (by !== "order") {
      const source = await sourceOf(by, record, now)
      if (source) return await spendAgain(record, source, quote, gen, method, signed)
      if (isOpen(gen)) go(searchLink(record.label))
      return
    }
    const terms = termsOrAsk(gen, record, signed, quote)
    if (terms === null) return
    const built = await flow.orderRequest(flow.draftAgain(record, quote, terms))
    const res = await api.createOrder(built.request, method, invoice.amount, quote.chainId)
    const next = store.orderUrl({ invoiceId: res.invoiceId, registrationId: res.registration.id })
    // the old record is the stored owner code until the new one is stored too
    store.saveOrder({ ...record, request: built.request, terms, registrationId: res.registration.id, invoiceId: res.invoiceId, ...flow.paidWith(res), cancelled: false, cardSubmittedAt: undefined, replacedBy: undefined, createdAt: new Date(api.serviceNow()).toISOString() })
    // Your names lists the old order only while money it received needs its reference; its page leads to the new one
    if (res.registration.id !== record.registrationId) store.updateOrder(record.registrationId, { replacedBy: next })
    if (isOpen(gen)) go(next)
  } catch (e) {
    if (!isOpen(gen)) {
      holdFrom(e)
      return
    }
    if (e instanceof api.ApiError && e.code === "name_taken") return go(searchLink(record.label))
    if (e instanceof api.ApiError && e.code === "order_exists") {
      const own = await flow.ownOrderFor(record.ownerCode, record.request.labelHash).catch(() => null)
      if (own && isOpen(gen)) return go(store.orderUrl(own))
    }
    if (e instanceof api.ApiError && e.code === "catalog_changed" && typeof e.body.price === "number") return dispatch({ type: "price-changed", price: e.body.price })
    if (e instanceof api.TermsChanged) return askTerms(gen, record.label, e, true)
    if (termsUnavailable(e)) return dispatch({ type: "reorder-failed", note: noOrders("Nothing was charged. ") })
    if (e instanceof api.BalanceChanged) return dispatch({ type: "reorder-failed", note: warning("Your balance changed meanwhile. Nothing was charged. Try again.") })
    if (e instanceof api.ApiError && e.code === CODES_ONLY) return dispatch({ type: "reorder-failed", note: CODES_ONLY_NOTE })
    if (e instanceof api.ApiError && e.code === "provider_unavailable") {
      return dispatch({ type: "reorder-failed", note: { tone: "warn", icon: "alert", title: `${methodName(method)} is unavailable right now`,
        text: "Nothing was charged. Try again later, or ", link: { text: "order the name again", href: searchLink(record.label), after: " to pay another way." } } })
    }
    if (holdOn(e, "Nothing was charged. ", gen)) return
    dispatch({ type: "reorder-failed", note: { tone: "warn", icon: "alert", title: "That did not go through", text: "Nothing was charged. Try again in a moment." } })
  }
}

// An invoice for the rest of a price that a balance paid part of is made again by a new spend of that balance as it is
// now; once the balance is spent or refunded, the name's search opens instead, with the name's price.
async function spendAgain(record: store.OrderRecord, source: string, quote: flow.Quote, gen: number, method: api.Method, signed: string | null | undefined): Promise<void> {
  const read = (await api.readRegistration(source)).balance
  const balance = session.appliedBalance(source, read)
  if (!isOpen(gen)) return
  if (!balance) return go(searchLink(record.label))
  // a balance grown to the price since the button was labelled registers the name: the button says so first, for a second press
  if (!balance.held && balance.amount >= quote.price && !spendCovers(state)) return dispatch({ type: "source-read", balance: read })
  // the balance's order has the same name code as this one, which signs the spend
  const paying = { registrationId: source, ownerCode: record.ownerCode }
  if (balance.held) {
    // an earlier press whose answer was lost made the order that holds it, which is this name's new invoice
    const holder = await flow.balanceHolder(paying).catch(() => null)
    if (!isOpen(gen)) return
    if (holder && holder.registrationId !== record.registrationId && holder.label === record.label) return replacedWith(record, store.orderUrl(holder), gen)
    const by = holder ? `${holder.label}.${holder.tld}` : "another order"
    return dispatch({ type: "reorder-failed", note: warning(`Your balance is in use by ${by} ${heldWords(balance.heldUntil)}. Nothing was charged.`) })
  }
  const terms = termsOrAsk(gen, record, signed, quote)
  if (terms === null) return
  const next = await flow.spendBalance(paying, record.label, { contact: record.contact, channel: record.channel }, quote, balance.amount, method, terms)
  replacedWith(record, store.orderUrl(next), gen)
}

// the old record leads to the order that replaced it, which opens
function replacedWith(record: store.OrderRecord, url: string, gen: number): void {
  store.updateOrder(record.registrationId, { replacedBy: url })
  if (isOpen(gen)) go(url)
}

type StageState = "done" | "active" | "failed" | ""
const STAGES = [
  { going: "Committing", done: "Committed" },
  { going: "Waiting", done: "Waiting" },
  { going: "Registering", done: "Registered" },
]

// `ended` names the last stage in place of its own word, as "Taken" for a name registered by someone else first
function stages(states: StageState[], ended?: string): HTMLElement {
  return el("ol", { class: "stages", role: "list" }, ...STAGES.map((stage, i) => el("li", { class: `stage ${states[i]}`.trim() },
    el("b", {}, i === STAGES.length - 1 && ended ? ended : states[i] === "done" ? stage.done : stage.going))))
}

// the stage a registration is at, said once as it is reached, never each second of its wait
let saidStage = ""
function sayStage(view: api.RegistrationView, states: StageState[]): void {
  const at = states.indexOf("active")
  const stage = `${view.id} ${at}`
  if (at < 0 || stage === saidStage) return
  saidStage = stage
  announce(STAGES[at].going)
}

const stagesOf = (view: api.RegistrationView): StageState[] => view.phase === "registering" ? ["done", "done", "active"] : view.phase === "committed" ? ["done", "active", ""] : ["active", "", ""]

function headingOf({ view, record }: OrderState): Kid {
  const label = labelOf(view!, record)
  return label ? ["Registering ", gradName(label, view!.tld)] : "Registering the name"
}

const leadOf = ({ record }: OrderState) => record ? ["Keep this page open until the name is yours, ", el("span", { class: "nowrap" }, `or come back within ${REVEAL_HOURS} hours.`)]
  : "The browser with its name code signed it."

const WAIT_NOTE = "Every new name waits a little, so nobody who sees your order can take the name first."
const COMMIT_NOTE = "Placing your order. The wait starts once it is in."
const REGISTERING_NOTE = "Registering the name. It is yours in a moment."
const STALL_NOTE = "This is taking longer than usual. It continues by itself."

function buildRegistering(s: OrderState, signal: AbortSignal): HTMLElement {
  const view = s.view!
  const states = stagesOf(view)
  sayStage(view, states)
  const refused = refusalsOf(s) >= REVEAL_ATTEMPTS
  const steps = stages(states)
  const stalled = stalledAt(s)
  const unavailable = nameUnavailable(s)
  const clockNode = el("b", {})
  const note = el("span", {})
  const tryAgain = () => {
    dispatch({ type: "reveal-retried" })
    refresh()
  }
  const say = (node: HTMLElement, text: string) => { if (node.textContent !== text) node.textContent = text }
  // the wait's time, its line and the words under it move on each second between the screen's own changes
  const tick = () => {
    if (view.phase === "committed") fillWait(steps.children[1] as HTMLElement, view)
    const left = waitLeft(view)
    if (view.phase === "committed" && left > 0) {
      say(clockNode, clock(left))
      return say(note, WAIT_NOTE)
    }
    if (!clockNode.querySelector("svg")) clockNode.replaceChildren(icon("clock"))
    if (stalled !== null && api.serviceNow() >= stalled) return say(note, STALL_NOTE)
    if (view.phase !== "committed") return say(note, view.phase === "registering" ? REGISTERING_NOTE : COMMIT_NOTE)
    waitsSeen.delete(view.id)
    if (view.label === null && (refused || termsToAgree(s))) say(note, "The registration is not signed yet.")
    else say(note, REGISTERING_NOTE)
  }
  onTheSecond(() => waitLeft(view), tick, signal)
  return screen({ title: headingOf(s), lead: unavailable ? null : leadOf(s), action: refused ? btn("Try again", "", tryAgain) : null },
    steps,
    // the note keeps the height of its longest words, so the page keeps still as they change
    el("div", { class: "countdown" }, clockNode, el("p", {}, note, el("span", { class: "sizer", "aria-hidden": "true" }, WAIT_NOTE))),
    refused ? alertBox("danger", "alert", "The name could not be signed", "The service refused the signed registration.") : null,
    // a name taken or reserved while its changed terms waited cannot be registered by this order, which fails once its
    // hours to sign are over
    unavailable ? alertBox("warn", "alert", unavailable.status === "reserved" ? "The name was reserved meanwhile" : "Someone registered the name first",
      `This order can't register it. Once its ${REVEAL_HOURS} hours to sign are over, choose another name for it.`) : null,
    referenceLine(s.invoice?.invoiceId ?? view.id),
    termsAskedAgain(s) ? agreement(s, "reveal") : null)
}

const waitsSeen = new Map<string, number>()
// a timed wait's bar starts this full, so as it becomes active it reads apart from the stages still to come
const WAIT_FILL_START = 0.08
const waitLeft = (view: api.RegistrationView) => (view.revealAfter ?? 0) - api.serviceNow() / 1000
function fillWait(stage: HTMLElement, view: api.RegistrationView): void {
  const now = api.serviceNow()
  const end = (view.revealAfter ?? 0) * 1000
  if (!waitsSeen.has(view.id)) waitsSeen.set(view.id, now)
  const start = waitsSeen.get(view.id)!
  const done = end > start ? Math.min(1, (now - start) / (end - start)) : 1
  stage.style.setProperty("--done", String(Math.max(WAIT_FILL_START, done)))
}

const TURN_SLACK_MS = 20
function onTheSecond(left: () => number, f: () => void, signal: AbortSignal): void {
  if (signal.aborted) return
  let id: ReturnType<typeof setTimeout> | undefined
  const next = () => {
    clearTimeout(id)
    f()
    const l = left()
    id = setTimeout(next, l > 0 ? (l % 1) * 1000 + TURN_SLACK_MS : 1000)
  }
  signal.addEventListener("abort", () => clearTimeout(id), { once: true })
  next()
}

// The order cannot register with the links it committed to, waiting to be signed or failed since; it moves to the same
// name without them, or to another name.
function buildLinksRefused(s: OrderState, signal: AbortSignal): HTMLElement {
  const view = s.view!
  const move = setAction(btn("Register without links", "", () => void moveWithoutLinks()), s.busy === "move", s.hold !== null || unagreed(s))
  move.dataset.focus = "move"
  holdEnds(signal)(s.hold !== null)
  const title = view.phase === "failed" ? s.invoice ? "Paid, not registered" : "Not registered" : headingOf(s)
  return screen({ title, lead: orderLine(s), action: move, alt: link("Choose another name", () => go(`/#/?retarget=${view.id}`)) },
    alertBox("warn", "alert", "The service refused this order's links",
      "They are part of the order, so they cannot be changed in it. Register the name without them and add links in Your names once it is registered, or choose another name."),
    actionNote(s, signal),
    referenceLine(s.invoice?.invoiceId ?? view.id),
    agreement(s, "move"))
}

// what a move refused for good says: the service bounds how often an order moves, and support settles it from there
export const moveLimitNote = (reference: string): Note => ({ tone: "warn", icon: "alert", title: "This order cannot move again",
  text: "Write to SimpleX support with its reference, ", link: { text: CONTACT_EMAIL, href: `mailto:${CONTACT_EMAIL}`, after: `: ${reference}.` } })

async function moveWithoutLinks(): Promise<void> {
  if (unagreed(state)) return
  const gen = opened
  const record = state.record!
  const view = state.view!
  const reference = state.invoice?.invoiceId ?? view.id
  dispatch({ type: "move-started" })
  try {
    const quote = await flow.quoteOf(record.label)
    if (!quote) return answer(gen, { type: "move-failed", note: warning("This name is no longer available. Choose another name.") })
    const terms = termsOrAsk(gen, record, view.terms ?? record.terms, quote)
    if (terms === null) return
    await flow.retargetOrder(record, record.label, { contact: "", channel: "" }, quote, terms)
    reread(gen)
  } catch (e) {
    if (holdOn(e, "Nothing changed. ", gen)) return
    const limit = e instanceof api.ApiError && e.code === "move_limit"
    if (e instanceof api.TermsChanged) return askTerms(gen, record.label, e, true)
    const now = e instanceof api.ApiError && e.code === "registration_changed" ? api.changedView(e) : null
    if (now && !sameStep(view, now)) {
      answer(gen, { type: "answered", seq: ++reads, now: api.serviceNow(), invoice: state.invoice && { ...state.invoice, registration: now },
        view: now, record: state.record, cardSubmittedAt: state.cardSubmittedAt, nameStatus: state.nameStatus })
      return answer(gen, { type: "move-failed", note: null })
    }
    answer(gen, { type: "move-failed", note: limit ? moveLimitNote(reference) : termsUnavailable(e) ? noOrders("Nothing changed. ") : warning("That did not go through. Nothing changed. Try again in a moment.") })
    if (now) reread(gen)
  }
}

function buildNotOnDevice({ view, invoice }: OrderState): HTMLElement {
  return outcome({ tone: "info", icon: "key", title: "The name code is not in this browser",
    text: ["This order registers a name to ", el("span", { class: "nowrap" }, shortAddress(view!.owner)), ". Its code was made in the browser it was bought in. Enter the code you saved to carry on here."],
    action: btn("Enter your name code", "", () => go(CODE_FROM_ORDER_URL)), reference: invoice?.invoiceId ?? view!.id })
}

// a name of this browser's code needs nothing more from here; one of another browser's restores its code
const registeredAction = (record: store.OrderRecord | null) => record ? null : withoutRecord("", "Restore with your name code")

function buildRegistered(s: OrderState): HTMLElement {
  const view = s.view!
  const label = labelOf(view, s.record)
  const code = s.record?.ownerCode ?? null
  // the code's QR is under everything, there only while the code is shown
  const qr = el("div", { class: "code-qr" })
  return screen({ title: [label ? gradName(label, view.tld) : "The name", " is\u00a0yours"], lead: registeredLead(view, s.record), action: registeredAction(s.record) },
    code ? [el("div", { class: "card use" }, el("h2", {}, "Use in the app"),
      el("p", {}, "In SimpleX, open Your SimpleX address, tap Set SimpleX name and enter ", nameText(label ?? "", view.tld, "."), " For a channel, set it in the channel's profile.")),
    el("p", { class: "note center" }, "Keep your name code: it owns the name and edits its links."),
    codeDisplay(code, "owner-code", true, (shown) => refill(qr, shown && nameCodeQr(code))),
    // under the code and over its QR, so showing the code moves it and nothing above it
    el("div", { class: "yours-edit center" }, btn(linksAction(hasLinks(s.record!, null)), "quiet small", () => go(editUrl(view.id)))), qr] : null)
}

function registeredLead(view: api.RegistrationView, record: store.OrderRecord | null): string {
  const until = view.expiresAt ? dateOf(view.expiresAt) : ""
  return record ? `Registered until ${until}.` : `Registered until ${until} to ${shortAddress(view.owner)}. Its name code is not in this browser.`
}

function buildTakenWithCode({ view: taken, record, nameStatus }: OrderState): HTMLElement {
  const reserved = nameStatus === "reserved"
  const view = taken!
  const label = labelOf(view, record)
  const released = releasedCode(view, record)
  const name = label ? nameText(label, view.tld) : "The name"
  return outcome({ tone: "info", icon: "key", title: reserved ? "The name was reserved meanwhile" : "Someone registered it first",
    text: [name, reserved ? " can't be registered." : " was registered just before ours.", " Your code was not spent: use it for another name."],
    extra: released ? codeDisplay(released.code) : null,
    action: btn("Search another name", "", () => go("/#/")),
    reference: view.id })
}

// A paid order taken first keeps what it is worth as its balance, which pays for another name of its code, or which
// support refunds; only the browser holding the code spends it. One spent or refunded since says so.
function buildTaken(s: OrderState): HTMLElement {
  const { view: taken, record, invoice } = s
  const view = taken!
  if (!invoice && view.fromBalance === 0) return buildTakenWithCode(s)
  const label = labelOf(view, record)
  const balance = session.appliedBalance(view.id, view.balance)
  const uses = codesOnly() ? " You can ask for a refund." : " Choose another name and pay only the difference, or ask for a refund."
  const note = balance || view.balance === null
    ? el("div", { class: "notice plain" }, el("b", {}, "What you paid is kept as your balance."), uses, " Your names shows the balance.")
    : el("div", { class: "notice plain" }, el("b", {}, "What you paid went to your balance."), " It has been spent or refunded since; Your names shows it.")
  const reserved = s.nameStatus === "reserved"
  const title = label ? [gradName(label, view.tld), reserved ? " is\u00a0reserved" : " was\u00a0taken"] : reserved ? "The name is reserved" : "The name was taken"
  return screen({ title, lead: reserved ? "It was reserved meanwhile, so it can't be registered." : "Someone registered it before your order could.",
    ...balanceActions(s) },
    stages(["done", "done", "failed"], reserved ? "Reserved" : "Taken"),
    note,
    record ? null : alertBox("info", "key", "The name code is not in this browser", "Add it in Check your code to use the balance."),
    referenceLine(invoice?.invoiceId ?? view.id))
}

const REFUND = "refund"

// An order's balance pays for another name of its code, or the same name when `same` gets its invoice, or support refunds it
// while no open invoice holds it; only the browser holding the code does any. Without a balance left, another name is
// searched as usual.
function balanceActions({ view, invoice, record }: OrderState, same?: HTMLButtonElement): { action: HTMLButtonElement; alt: HTMLElement | null } {
  const balance = session.appliedBalance(view!.id, view!.balance)
  const another = () => balance ? useBalance(balance) : go(searchLink(""))
  const refund = record && balance && !balance.held ? link("Get a refund", () => showRefund(invoice?.invoiceId ?? view!.id, REFUND)) : null
  refund?.setAttribute("data-focus", REFUND)
  refund?.setAttribute("aria-haspopup", "dialog")
  if (codesOnly()) return { action: codeAction(), alt: refund }
  if (!same) return { action: setAction(btn("Choose another name", "", another), false, record === null), alt: refund }
  return { action: same, alt: el("span", {}, link("Choose another name", another), refund && SEP, refund) }
}

function buildFailed(s: OrderState, signal: AbortSignal): HTMLElement {
  const { view: failed, invoice } = s
  const view = failed!
  // a code refused for good leaves nothing to try again, so the page offers another search as the other endings do
  const retry = setAction(btn("Try again", "", () => void retryRegistration()), s.busy === "retry", s.hold !== null)
  retry.dataset.focus = "retry"
  // links the service refused leave nothing to try again either; the browser with the code moves the order instead
  const action = view.linksRefused ? withoutRecord("") : s.codeRefused ? btn("Search a name", "quiet", () => go(searchLink(""))) : retry
  holdEnds(signal)(s.hold !== null)
  const failedAt: StageState[] = view.commitTx === null ? ["failed", "", ""] : ["done", "done", "failed"]
  const alert = failedAlert(s)
  const support = [el("a", { href: `mailto:${CONTACT_EMAIL}` }, CONTACT_EMAIL), " with its reference."]
  // a name taken or reserved since cannot be registered by this order, so it can move to another one with its code
  const gone = s.nameStatus === "registered" || s.nameStatus === "reserved"
  const alt = gone && s.record && !s.codeRefused ? link("Choose another name", () => go(`/#/?retarget=${view.id}`)) : null
  return screen({ title: invoice ? "Paid, not registered" : "Not registered", lead: failedLead(s), action, alt },
    el("p", { class: "note center" }, ...orderLine(s)),
    stages(failedAt),
    alertBox("danger", "alert", alert.title, alert.retry ? ["If Try again still fails, write to ", ...support] : ["Write to ", ...support]),
    actionNote(s, signal),
    referenceLine(invoice?.invoiceId ?? view.id))
}

// The refusal is kept with the order, so the page opened again says it from its first frame.
function keepRefusal(gen: number, error: store.CodeRefusal): void {
  const record = state.record
  if (!isOpen(gen) || !record) return
  store.updateOrder(record.registrationId, { codeRefusal: error })
  dispatch({ type: "record-changed", record: { ...record, codeRefusal: error }, cardSubmittedAt: state.cardSubmittedAt })
}

// Another order may have spent the code since this one failed, which a retry would only find out. A code revoked or
// expired may still be held by this registration, whose retry the service then takes, so only a spent one is refused.
// A code the service does not know (code_invalid), or revoked, was not spent; null when the service did not answer, and
// the seconds to wait when it refused the check for its rate limit.
async function codeSpent(code: string): Promise<boolean | null | { checkAgainIn: number }> {
  try {
    return (await api.checkCode(code)).state === "used"
  } catch (e) {
    if (!(e instanceof api.ApiError)) return null
    if (e.code === "code_invalid") return false
    return e.code === "rate_limited" ? { checkAgainIn: e.retryAfter ?? api.LIMITED_WAIT_S } : null
  }
}

async function retryRegistration(): Promise<void> {
  const gen = opened
  const view = state.view!
  dispatch({ type: "retry-started" })
  try {
    await api.retry(view.id)
  } catch (e) {
    // another tab may have retried it already
    const now = await api.readRegistration(view.id).catch(() => null)
    const held = holdOn(e, "Nothing changed. ", gen)
    if (now && now.phase !== "failed") return reread(gen)
    if (held) return
    const refusal = e instanceof api.ApiError ? retryRefusal(e.code) : null
    answer(gen, { type: "retry-failed", codeRefused: refusal?.kept != null, note: refusal?.note
      ?? { tone: "warn", icon: "alert", title: "That did not go through", text: "Nothing changed. Try again in a moment." } })
    if (refusal?.kept) keepRefusal(gen, refusal.kept)
    return
  }
  reread(gen)
}

const BUILDERS: Record<OrderKind, Builder<OrderState>> = {
  "pay-crypto": buildPayCrypto,
  "pay-card": buildPayCard,
  confirming: buildConfirming,
  registering: buildRegistering,
  "links-refused": buildLinksRefused,
  registered: buildRegistered,
  taken: buildTaken,
  failed: buildFailed,
  "not-on-device": buildNotOnDevice,
  "status:closed": buildClosed,
  "status:card-unconfirmed": buildCardUnconfirmed,
  "status:paid-by-invoice": buildPaidByInvoice,
  "status:unreadable": buildUnreadable,
  "status:unknown-link": buildUnknownLink,
  "status:price-changed": buildPriceChanged,
}
