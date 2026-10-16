// An order's page (?order=<invoice>) or a code registration's (?registration=<id>): payment, registration, and every ending.
import * as api from "../api.ts"
import { codeTier, LONGEST_TIER, parseNameCode } from "../crypto/code.ts"
import { alertBox, btn, chip, copyText, disabled, el, gradName, holdFor, holding, icon, link, liveRegion, nameText, nameTitle, release, respectHold, startHold } from "../dom.ts"
import * as flow from "../flow.ts"
import { carry, live } from "../motion.ts"
import { clock, dateOf, dollars, methodName, shortAddress, shortHash, termText } from "../format.ts"
import { paymentUri, qrSvg } from "../qr.ts"
import * as store from "../store.ts"
import { publishableKey, mountCard } from "../stripe.ts"
import { useCode } from "./codes.ts"
import { CONTACT_EMAIL, crumbs, currentRoute, go, isDark, isRedraw, isRoute, nextRoute, page, placeholder, pageHead, redirect, refresh, searchLink, status, twoCols, whenLeaving } from "./shell.ts"

// a card payment Stripe has not confirmed after this long gets the "taking longer" page
const CARD_SLOW_MS = 10 * 60 * 1000
const RETRY_MS = 3000
// The badge service's words for a cancel the provider took while the service still shows the invoice open; a card
// invoice has no address. The browser keeps the cancel, so the warning stays until the invoice closes.
const cancelStillOpen = (invoice: api.InvoiceView) => invoice.cryptoCurrency
  ? "This invoice was cancelled, but the service still shows it open. Do not send anything more to the address."
  : "This invoice was cancelled, but the service still shows it open. Do not pay it again."
const REVEAL_ATTEMPTS = 3

// what the drawn page holds that must end with it: countdowns, a mounted card form
const cleanups: (() => void)[] = []

function cleanUp(): void {
  cleanups.splice(0).forEach((f) => f())
}

function every(ms: number, f: () => void): ReturnType<typeof setInterval> {
  const id = setInterval(f, ms)
  cleanups.push(() => clearInterval(id))
  return id
}

// the count stays with its word on one line; a payment taken on first sight waits for no confirmation at all
const confirmations = (n: number) => (n === 1 ? "Waiting for 1\u00a0confirmation" : n > 1 ? `Waiting for ${n}\u00a0confirmations` : "Waiting for the payment to settle")

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// errors of an action on an ended invoice; one node per route, so a redraw while the action runs keeps its message
let actionNote = liveRegion()

export function orderPage(invoiceId: string | null, registrationId: string | null): void {
  const mine = nextRoute()
  const polls = new AbortController()
  actionNote = liveRegion()
  // another tab cancelling or paying this order changes what it is; other orders' changes leave this page, and a card form, alone
  const watched = { registrationId }
  const onStorage = (e: StorageEvent) => {
    // a card paid in another tab, for an order this browser may have no record of, changes it too
    const ours = (watched.registrationId && e.key === store.orderKey(watched.registrationId)) || (invoiceId && e.key === store.cardKey(invoiceId))
    if (ours && isRoute(mine)) refresh()
  }
  window.addEventListener("storage", onStorage)
  whenLeaving(() => { polls.abort(); cleanUp(); window.removeEventListener("storage", onStorage) })
  // the same order drawn again stays on screen until it is read, rather than blanking to a loading line
  if (isRedraw()) document.querySelector("main")?.setAttribute("aria-busy", "true")
  else page(null, placeholder())
  void follow(mine, invoiceId, registrationId, polls.signal, watched)
}

// Follows the order with long polls, drawing each change, until it reaches an ending the buyer acts on.
async function follow(mine: number, invoiceId: string | null, registrationId: string | null, signal: AbortSignal, watched: { registrationId: string | null }): Promise<void> {
  // async work finishing after the buyer left must not draw over the page they went to
  // the same order drawn again, keeping a popup open over it
  const reload = () => { if (isRoute(mine)) refresh() }
  let invoice: api.InvoiceView | null = null
  let view: api.RegistrationView | null = null
  // what the page shows: the service's answer and this browser's record of it
  let drawn = ""
  let drawnRecord = ""
  // siblings that could not be read are asked again even when the order's own answer has not changed
  let reread = false
  while (isRoute(mine)) {
    const asked = Date.now()
    try {
      if (invoiceId) {
        const seen = invoice && { status: invoice.status, phase: invoice.registration.phase, paid: invoice.cryptoAmountPaid ?? "", full: invoice.paidInFull === true }
        invoice = await api.readInvoice(invoiceId, seen ?? undefined, signal)
        view = invoice.registration
      } else {
        view = await api.readRegistration(registrationId!, view?.phase, signal)
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
          const wait = retryDelay(e)
          if (wait === null) return unknownLink()
          if (!drawn) unreadable(invoiceId ?? registrationId!)
          await sleep(wait)
          continue
        }
        if (!isRoute(mine)) return
        return newer ? redirect(flow.orderUrl(newer)) : unknownLink()
      }
      if (!drawn) unreadable(invoiceId ?? registrationId!)
      await sleep(e instanceof api.ApiError && e.retryAfter ? e.retryAfter * 1000 : RETRY_MS)
      continue
    }
    if (!isRoute(mine)) return
    // a poll that held to its timeout answers unchanged; redrawing would reset the page, a card form included
    const answer = JSON.stringify(invoice ?? view)
    if (answer === drawn && !reread) {
      // one answered unchanged at once would otherwise poll in a tight loop
      if (Date.now() - asked < RETRY_MS) await sleep(RETRY_MS)
      continue
    }
    reread = false
    watched.registrationId = view.id
    let record = store.orderByRegistration(view.id) ?? (invoiceId ? store.orderByInvoice(invoiceId) : undefined)
    if (record) {
      const synced = await flow.syncRecord(record, view)
      if (!isRoute(mine)) return
      record = synced ?? undefined
    }
    // A late payment to a replaced invoice keeps its page, which says how support refunds it. Only a browser without this
    // order's record looks for its successor among its records, so two empty invoices never lead to each other.
    let unread: number | null = null
    try {
      const closedEmpty = invoice !== null && api.closedEmpty(invoice)
      let replacement = closedEmpty && !record ? await successorOf(view, invoice!) : undefined
      if (!replacement && !record && invoice) record = await adoptSibling(view, invoice)
      if (!replacement && closedEmpty) replacement = record?.replacedBy
      // another browser may have made a newer invoice that this one never opened
      if (!replacement && closedEmpty && record?.ownerCode) {
        const newer = await flow.newerOrder(record)
        replacement = newer ? flow.orderUrl(newer) : undefined
      }
      if (!isRoute(mine)) return
      if (replacement) return redirect(replacement)
    } catch (e) {
      // a sibling's invoice could not be read; the page shows the order as this browser knows it and reads it again
      unread = retryDelay(e)
    }
    if (!isRoute(mine)) return
    if (invoice && invoice.status !== "open") store.clearCardSubmitted(invoice.invoiceId)
    if (invoice && invoice.status !== "open" && record?.cardSubmittedAt) {
      store.updateOrder(record.registrationId, { cardSubmittedAt: undefined })
      record = { ...record, cardSubmittedAt: undefined }
    }
    // the page is drawn again only when what it shows has changed, so a re-read keeps focus and a card form in place
    const shown = JSON.stringify(record ?? null)
    if (answer !== drawn || shown !== drawnRecord) {
      drawn = answer
      drawnRecord = shown
      cleanUp()
      draw(invoice, view, record, reload)
    }
    // a finished order whose siblings could not be read is read once more before the page stops following it
    if (finished(invoice, view) && unread === null) return
    // only a closed invoice reads siblings
    if (unread !== null && invoice?.status !== "open") {
      await sleep(unread)
      // forgetting the last answer makes the next read answer at once
      invoice = null
      view = null
      reread = true
    }
  }
}

// Another order of the same buyer: one of this commitment, or of the code's wallet once it moved to another name.
// An order opened from the app shares its wallet with the app's other orders, so only its commitment counts.
const siblingOf = (view: api.RegistrationView) => (o: store.OrderRecord) => o.registrationId !== view.id &&
  (o.request.commitment === view.commitment || (o.ownerCode !== null && o.owner.toLowerCase() === view.owner.toLowerCase()))

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

async function successorOf(view: api.RegistrationView, invoice: api.InvoiceView): Promise<string | undefined> {
  const next = await nextOrder(view, invoice)
  return next && flow.orderUrl(next)
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
    cancelled: false, cardSubmittedAt: undefined, takenCode: undefined, prepaidCode: undefined, replacedBy: next && flow.orderUrl(next),
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
      store.updateOrder(o.registrationId, { replacedBy: flow.orderUrl({ invoiceId: invoice.invoiceId, registrationId: view.id }) })
    }
  }
}

// How long to wait before asking again: what a rate limit asks for, or the usual pause. Null for a refusal that asking
// again cannot change, such as a request this device's clock signed outside the service's window.
function retryDelay(e: unknown): number | null {
  if (!(e instanceof api.ApiError)) return RETRY_MS
  if (e.retryAfter) return e.retryAfter * 1000
  if (e.code === "rate_limited") return RETRY_MS
  return e.status >= 400 && e.status < 500 ? null : RETRY_MS
}

function unreadable(reference: string): void {
  page(null, [status("warn", "alert", "This order could not be loaded", "The page keeps trying. If it does not load, quote the reference below.", [], { reference })])
}

// An expired invoice is still followed: a payment can arrive after it closed, and then nothing must be ordered again.
// A taken or failed order is followed too, since another tab or browser can move, retry or turn it into a code.
function finished(invoice: api.InvoiceView | null, view: api.RegistrationView): boolean {
  if (["registered", "code_issued"].includes(view.phase)) return true
  return view.phase === "unpaid" && invoice?.status === "paid"
}

function unknownLink(): void {
  page(null, [status("info", "link", "This link does not work", "It names no order this service knows. Check the link, or start again.", [btn("Search a name", "", () => go("/#/"))])])
}

function draw(invoice: api.InvoiceView | null, view: api.RegistrationView, record: store.OrderRecord | undefined, reload: () => void): void {
  const ref = invoice?.invoiceId ?? view.id
  if (invoice && view.phase === "unpaid") {
    if (invoice.status === "open") return payment(invoice, view, record, reload)
    if (invoice.status === "paid") return page(null, [status("warn", "alert", "Paid after the invoice closed", "The payment arrived after this invoice had closed, so nothing was registered. Support refunds it: quote the reference below.", [record?.replacedBy ? btn("Open the new invoice", "quiet", () => go(record.replacedBy!)) : btn("Search a name", "quiet", () => go(searchFrom(view, record)))], { reference: ref })])
    return expired(invoice, record)
  }
  if (!invoice && view.phase === "unpaid") {
    const open = record?.invoiceId ? btn("Open its payment", "", () => go(`/?order=${record.invoiceId}`)) : btn("Search a name", "quiet", () => go(searchFrom(view, record)))
    return page(null, [status("info", "link", "This order is paid by invoice", "Its page is the payment link it was made with.", [open], { reference: ref })])
  }
  if (view.phase === "registered") return registered(view, record)
  if (view.phase === "taken") return taken(view, record, invoice, reload)
  if (view.phase === "code_issued") return codeIssued(view, record)
  if (view.phase === "failed") return failed(view, record, invoice, reload)
  return registering(view, record, invoice, reload)
}

// --- payment

const shortRef = (reference: string) => el("span", { class: "mono" }, `${reference.slice(0, 8)}…`)
// in full where the page leads to support, which asks for it
const fullRef = (reference: string) => el("span", { class: "mono ref-full" }, reference)

function orderCard(label: string | null, tld: string, rows: [string, string | Node][], ...rest: (Node | null)[]): HTMLElement {
  return el("aside", { class: "panel summary" },
    el("span", { class: "label" }, "Your order"),
    label ? nameTitle(label, "nm", tld) : el("div", { class: "nm unknown" }, "The name shows once it is registered"),
    el("div", { class: "rows" }, ...rows.map(([k, v]) => el("div", { class: "r" }, el("span", {}, k), el("span", {}, v)))),
    ...rest)
}

// a browser without the order's record learns the name only once it is revealed on chain
const labelOf = (view: api.RegistrationView, record?: store.OrderRecord) => view.label ?? record?.label ?? null
const total = (amount: number) => el("div", { class: "total" }, el("span", { class: "label" }, "Total"), el("b", {}, dollars(amount, true)))

function copyField(label: string, value: string, copy = true): HTMLElement {
  const button = copy ? link("Copy", () => void copyText(value, button!)) : null
  return el("div", { class: "copy-field" }, el("span", { class: "label" }, label), el("div", { class: "val" }, el("span", {}, value), button))
}

function countdown(expiresAt: string, node: HTMLElement, prefix: string): void {
  const end = Date.parse(expiresAt)
  const tick = () => { node.textContent = `${prefix} ${clock((end - api.serviceNow()) / 1000)}` }
  tick()
  every(1000, tick)
}

function payment(invoice: api.InvoiceView, view: api.RegistrationView, record: store.OrderRecord | undefined, reload: () => void): void {
  const label = labelOf(view, record)
  const fromApp = openedFromApp(view, record)
  const steps = crumbs("Payment", { fromApp })
  if (record?.cancelled && !invoice.paidInFull) return stillOpen(invoice)
  const currency = invoice.cryptoCurrency
  if (currency && currency !== "card") {
    const coin = currency === "btc" ? "BTC" : "XMR"
    const name = methodName(currency)
    if (invoice.paidInFull) return confirming(invoice, view, record, false, reload)
    const partial = Number(invoice.cryptoAmountPaid ?? "0") > 0
    const due = partial ? invoice.cryptoAmountDue! : invoice.cryptoAmount!
    const rate = chip("", "brand")
    countdown(invoice.expiresAt, rate, "Rate held")
    const uri = paymentUri(currency, invoice.address!, due)
    const note = liveRegion()
    // money has reached a partly paid invoice, so the service would refuse to cancel it
    let cancelling = false
    // both labels take the same place, so the link keeps its width and one fades into the other
    const [idle, working] = [el("span", {}, "Cancel this invoice"), el("span", { "aria-hidden": "true" }, "Cancelling…")]
    // aria-hidden as "true", which assistive technology and the stylesheet both read; an empty one counts as not hidden
    const working_ = (on: boolean) => {
      const [shown, hidden] = on ? [working, idle] : [idle, working]
      shown.removeAttribute("aria-hidden")
      hidden.setAttribute("aria-hidden", "true")
    }
    const cancel = partial ? null : link(el("span", { class: "swap" }, idle, working), () => {
      if (cancelling || holding()) return
      cancelling = true
      // the link says it is working until the service answers
      working_(true)
      cancel!.setAttribute("aria-disabled", "true")
      void cancel_(invoice, record, note, reload).finally(() => {
        cancelling = false
        working_(false)
        cancel!.removeAttribute("aria-disabled")
      })
    })
    // a wait the tab is in shows why the link does nothing until it is over
    if (cancel) respectHold(null, note)
    const main = el("div", { class: "panel" }, el("div", { class: "panel-sec" },
      partial ? el("div", { class: "mb-18" }, alertBox("warn", "alert", "Part of the payment arrived", `${invoice.cryptoAmountPaid} of ${invoice.cryptoAmount} ${coin} is seen. Send the remaining ${due} ${coin} to the same address.`)) : null,
      el("div", { class: "pay-head" },
        el("div", {}, el("span", { class: "label" }, partial ? "Send the rest" : "Send"), el("div", { class: "amount" }, `${due} ${coin}`), el("div", { class: "usd" }, `${dollars(invoice.amount, true)} in total`)),
        rate),
      el("div", { class: "pay-body" },
        el("div", { class: "qr" }, uri ? qrSvg(uri, `${name} payment`) : null),
        el("div", {}, copyField("Amount", `${due} ${coin}`), copyField(`${name} address`, invoice.address!), copyField("Reference", invoice.invoiceId, false))),
      el("div", { class: "waiting" }, el("span", { class: "awaiting" }, partial ? "Waiting for the rest of the payment" : "Waiting for payment"), cancel), note))
    return page(null, [pageHead(`Pay with ${name}`, "Bookmark this page: the address and the countdown live on its link.", steps),
      twoCols(main, orderCard(label, view.tld, [["Term", termText(view.years)], ["Paying with", name]], total(invoice.amount)))])
  }
  if (record?.cardSubmittedAt || store.cardSubmitted(invoice.invoiceId) || invoice.amountPaid) return confirming(invoice, view, record, true, reload)
  const pay = btn(`Pay ${dollars(invoice.amount, true)}`, "lg block")
  const error = el("div", {})
  const form = el("div", { class: "stripe" })
  // a submitted card is remembered only in storage; without it, a reload would offer the form again
  const forgetful = store.canPersist() ? null : el("div", { class: "mb-14" }, alertBox("warn", "alert", "This browser cannot remember a card payment",
    "After paying, keep this page open until it moves on. Reloading would show the card form again."))
  const main = el("div", { class: "panel" }, el("div", { class: "panel-sec" },
    el("div", { class: "sec-title" }, el("h2", {}, "Card details")), forgetful, form, error, el("div", { class: "mt-18" }, pay)))
  page(null, [pageHead("Pay by card", null, steps), twoCols(main, orderCard(label, view.tld, [["Term", termText(view.years)], ["Paying with", "Card"]], total(invoice.amount)))])
  // The page knows the card was submitted without asking the service, so it shows that at once, in an outage too; only
  // while this form is still on screen, since a confirm can outlast a redraw or a move to another page.
  const shownAt = currentRoute()
  const submitted = () => {
    const at = new Date().toISOString()
    store.markCardSubmitted(invoice.invoiceId)
    if (record) store.updateOrder(record.registrationId, { cardSubmittedAt: at })
    if (!isRoute(shownAt) || !form.isConnected) return
    cleanUp()
    confirming(invoice, view, record && { ...record, cardSubmittedAt: at }, true, reload)
  }
  const key = publishableKey()
  if (!key && import.meta.env.DEV) return cardStandIn(form, pay, submitted)
  // only a Pay that had focus, given back by a redraw, takes it again once the form is ready
  const hadFocus = document.activeElement === pay
  disabled(pay)
  const mine = currentRoute()
  void mountCard(key, invoice.clientSecret ?? "", form, isDark()).then((card) => {
    // the page may have been redrawn meanwhile, on this route or another
    if (!isRoute(mine) || !form.isConnected) return card?.destroy()
    if (!card) return cardFailed(invoice, reload)
    cleanups.push(card.destroy)
    if (hadFocus) release(pay)
    else pay.removeAttribute("disabled")
    pay.addEventListener("click", async () => {
      disabled(pay)
      const outcome = await card.confirm()
      if (outcome.kind === "submitted") return submitted()
      release(pay)
      error.replaceChildren(el("div", { class: "mt-14" }, alertBox("bad", "alert", null, outcome.message)))
    })
  })
}

// Without a Stripe key in development, Pay does what a submitted card does; the mock's controls settle it.
function cardStandIn(form: HTMLElement, pay: HTMLButtonElement, submitted: () => void): void {
  const f = (text: string, value: string) => el("label", { class: "f" }, el("span", {}, text), el("div", { class: "box" }, value))
  form.append(el("div", { class: "label" }, el("span", {}, "Stripe's payment form"), el("span", {}, "Development stand-in")),
    f("Card number", "4242 4242 4242 4242"), el("div", { class: "two" }, f("Expiry", "12 / 30"), f("CVC", "123")), f("Country", "Portugal"))
  pay.addEventListener("click", submitted)
}

// An order opened from the app has nothing sealed, so even a browser without its record can tell; it has no name code.
const openedFromApp = (view: api.RegistrationView, record: store.OrderRecord | undefined) => record ? record.ownerCode === null : view.sealed === null

// a new search from an order opened from the app stays the app's, so a name found there registers to its wallet
const searchFrom = (view: api.RegistrationView, record: store.OrderRecord | undefined) => searchLink("", openedFromApp(view, record) ? view.owner : null)

// what a browser without the order's record can do: take in the name code, or, for an app's order, nothing here
function withoutRecord(view: api.RegistrationView, cls: string, text = "Enter your name code"): HTMLButtonElement {
  return view.sealed === null ? btn("Search a name", cls, () => go(searchFrom(view, undefined))) : btn(text, cls, () => go("/#/restore"), icon("key"))
}

// A cancel the service still shows open: nothing more is paid into the invoice, so the page offers no way to pay it.
// The page keeps following it, and shows it as cancelled once the service closes it.
function stillOpen(invoice: api.InvoiceView): void {
  const partial = Number(invoice.cryptoAmountPaid ?? "0") > 0
  page(null, [status("warn", "alert", "Invoice cancelled", [cancelStillOpen(invoice), partial ? " Part of the payment arrived; quote the reference below to support." : ""],
    [btn("Search a name", "quiet", () => go(searchFrom(invoice.registration, store.orderByInvoice(invoice.invoiceId))))], { reference: invoice.invoiceId })])
}

function cardFailed(invoice: api.InvoiceView, reload: () => void): void {
  const note = actionNote
  const record = store.orderByInvoice(invoice.invoiceId)
  const again = record ? respectHold(btn("Get a new invoice", "quiet", async () => {
    disabled(again)
    note.replaceChildren()
    const mine = currentRoute()
    if (await cancelBeforeReorder(invoice, again, note, mine)) await newInvoice(invoice, store.orderByInvoice(invoice.invoiceId), again, note, mine)
    // a cancel the service still shows open has its own page
    else if (store.orderByInvoice(invoice.invoiceId)?.cancelled) reload()
    else if (!holding()) release(again)
  }), note) : withoutRecord(invoice.registration, "quiet")
  page(null, [status("warn", "alert", "The card form did not load", "Stripe's form was blocked or failed to load. Nothing was charged.",
    [btn("Load the card form again", "", reload), again],
    // the route's action note moves into each new drawing of the page
    { reference: invoice.invoiceId, extra: carry(note) })])
}

// The old invoice is cancelled before a new one is ordered; true when ordering again cannot charge twice.
async function cancelBeforeReorder(invoice: api.InvoiceView, button: HTMLButtonElement, note: HTMLElement, mine: number): Promise<boolean> {
  const say = (text: string) => note.replaceChildren(el("div", { class: "left mt-18" }, alertBox("warn", "alert", null, text)))
  let after: api.InvoiceView
  try {
    after = await api.cancelInvoice(invoice.invoiceId)
    const record = store.orderByInvoice(invoice.invoiceId)
    if (record && after.status !== "paid") store.updateOrder(record.registrationId, { cancelled: true })
    if (after.status === "open") {
      say(cancelStillOpen(after))
      return false
    }
  } catch (e) {
    const code = e instanceof api.ApiError ? e.code : "network"
    if (holdFor(e, button, note, (left) => `The invoice is still open. Try again in ${left}.`)) return false
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
    if (isRoute(mine)) go(`/?order=${after.invoiceId}`)
    return false
  }
  if (after.status === "paid" || !api.holdsPayment(after)) return true
  say("A payment has reached this invoice, so it is kept. Quote the reference below.")
  return false
}

async function cancel_(invoice: api.InvoiceView, record: store.OrderRecord | undefined, note: HTMLElement, reload: () => void): Promise<void> {
  try {
    const after = await api.cancelInvoice(invoice.invoiceId)
    if (record && after.status !== "paid") store.updateOrder(record.registrationId, { cancelled: true })
    // without a record nothing keeps the cancel, so the warning shows here once
    if (!record && after.status === "open") return void note.replaceChildren(el("div", { class: "mt-14" }, alertBox("bad", "alert", null, cancelStillOpen(after))))
    return reload()
  } catch (e) {
    // an invoice that closed meanwhile is shown as it is now
    if (e instanceof api.ApiError && e.code === "not_open") return reload()
    if (e instanceof api.ApiError && e.code === "funded") return void note.replaceChildren(el("div", { class: "mt-14" }, alertBox("warn", "alert", null, "A payment has reached this invoice, so it cannot be cancelled.")))
    if (holdFor(e, null, note, (left) => `The invoice is still open. Try again in ${left}.`)) return
  }
  note.replaceChildren(el("div", { class: "mt-14" }, alertBox("warn", "alert", null, "The invoice could not be cancelled now. Try again in a moment.")))
}

function confirming(invoice: api.InvoiceView, view: api.RegistrationView, record: store.OrderRecord | undefined, card: boolean, reload: () => void): void {
  const slowAt = card && record?.cardSubmittedAt ? Date.parse(record.cardSubmittedAt) + CARD_SLOW_MS : null
  // a card refused after Stripe's first answer leaves the invoice open with nothing paid, so the card can be entered again;
  // once the service has seen the payment, entering it again could charge twice
  const again = invoice.amountPaid ? null : btn("Enter the card again", "quiet", () => {
    store.clearCardSubmitted(invoice.invoiceId)
    if (record) store.updateOrder(record.registrationId, { cardSubmittedAt: undefined })
    reload()
  })
  const slow = () => page(null, [status("warn", "clock", "This is taking longer than expected", "The payment has not been confirmed. This page keeps working: come back to it later, or quote the reference below.", [btn("Check again", "", reload), ...(again ? [again] : [])], { reference: invoice.invoiceId })])
  if (slowAt !== null && Date.now() > slowAt) return slow()
  if (slowAt !== null) {
    const check = every(1000, () => {
      if (Date.now() <= slowAt) return
      clearInterval(check)
      slow()
    })
  }
  const coin = invoice.cryptoCurrency === "xmr" ? "XMR" : "BTC"
  const main = el("div", { class: "panel" }, el("div", { class: "panel-sec" },
    el("div", { class: "pay-head" }, el("div", {},
      el("span", { class: "label" }, card ? "Card accepted" : "Payment received"),
      el("div", { class: "amount smaller" }, card ? "Waiting for Stripe to\u00a0confirm" : confirmations(invoice.requiredConfirmations ?? 1)))),
    el("p", { class: "sec-note mt-12" }, card
      ? "Stripe usually confirms within a minute. Registration starts by itself; this page moves on."
      : `${invoice.cryptoAmount} ${coin} arrived. Registration starts once it confirms; this page moves on by itself.`),
    el("div", { class: "meter" }, el("i")),
    el("div", { class: "waiting" }, el("span", { class: "awaiting" }, "Confirming payment"), el("span", { class: "mono ref-small" }, invoice.invoiceId))))
  page(null, [pageHead(card ? "Paying by card" : "Confirming your payment", null, crumbs("Payment", { fromApp: openedFromApp(view, record) })),
    twoCols(main, orderCard(labelOf(view, record), view.tld, [["Term", termText(view.years)], ["Paying with", card ? "Card" : methodName(invoice.cryptoCurrency ?? "btc")]], total(invoice.amount)))])
}

function expired(invoice: api.InvoiceView, record: store.OrderRecord | undefined): void {
  const note = actionNote
  // a new invoice reuses this order's commitment, which only the browser holding its name code can rebuild
  const received = api.holdsPayment(invoice)
  // a replaced invoice that money reached late leads on to its replacement rather than to a third invoice
  const again = record?.replacedBy
    ? btn("Open the new invoice", "quiet", () => go(record.replacedBy!))
    : record
      ? respectHold(btn("Get a new invoice", record.cancelled || !received ? "" : "quiet", () => void newInvoice(invoice, record, again, note, currentRoute())), note)
      : withoutRecord(invoice.registration, "quiet")
  const extra = { reference: invoice.invoiceId, extra: note }
  // a buyer who cancelled starts again from the name, choosing anew how to pay
  if (record?.cancelled && !received) {
    const restart = btn("Order the name again", "", () => go(searchLink(record.label, record.ownerCode === null ? record.owner : null)), icon("arrow"))
    return page(null, [status("info", "x", "Invoice cancelled", "This invoice was cancelled and nothing was received.", [restart], extra)])
  }
  const crypto = Number(invoice.cryptoAmountPaid ?? "0") > 0
  if (received) {
    const coin = invoice.cryptoCurrency === "xmr" ? "XMR" : "BTC"
    const arrived = crypto && !invoice.paidInFull ? `${invoice.cryptoAmountPaid} ${coin} arrived, which is not the full amount.` : "A payment did not complete before the invoice closed."
    return page(null, [status("warn", "alert", "Invoice expired", [`${arrived} Write to `, el("a", { href: `mailto:${CONTACT_EMAIL}` }, CONTACT_EMAIL), " with the reference below and we will sort it out."], [again], extra)])
  }
  page(null, [status("info", "clock", "Invoice expired", invoice.cryptoCurrency ? "Nothing was received before its rate window closed." : "Nothing was paid before it closed.", [again], extra)])
}

// The same name, wallet and commitment, with a new invoice.
// mine is the route of the click, taken before any await, so a buyer who has moved on is not sent to the new order
async function newInvoice(invoice: api.InvoiceView, record: store.OrderRecord | undefined, button: HTMLButtonElement, note: HTMLElement, mine: number): Promise<void> {
  if (!isRoute(mine) || !record) return
  disabled(button)
  try {
    // the invoice as it is now: one still open, or paid into a registration, is the order; one paid after it closed
    // registered nothing, so the name is ordered again and support refunds the late payment
    const now = await api.readInvoice(invoice.invoiceId)
    if (now.status === "open" || (now.status === "paid" && now.registration.phase !== "unpaid")) {
      if (isRoute(mine)) go(`/?order=${invoice.invoiceId}`)
      return
    }
    const res = await api.createOrder(record.request, invoice.cryptoCurrency ?? "card", invoice.amount)
    const next = flow.orderUrl({ invoiceId: res.invoiceId, registrationId: res.registration.id })
    // the old record is the stored owner code until the new one is stored too
    store.saveOrder({ ...record, registrationId: res.registration.id, invoiceId: res.invoiceId, ...flow.paidWith(res), cancelled: false, cardSubmittedAt: undefined, replacedBy: undefined, createdAt: new Date(api.serviceNow()).toISOString() })
    // Your names lists the old order only while money it received needs its reference; its page leads to the new one
    if (res.registration.id !== record.registrationId) store.updateOrder(record.registrationId, { replacedBy: next })
    if (isRoute(mine)) go(next)
  } catch (e) {
    release(button)
    if (!isRoute(mine)) {
      // a rate limit holds the tab even when the page has been drawn again meanwhile
      if (e instanceof api.ApiError && e.code === "rate_limited") startHold(e.retryAfter ?? api.LIMITED_WAIT_S)
      return
    }
    if (e instanceof api.ApiError && e.code === "name_taken") return go(searchLink(record.label, record.ownerCode === null ? record.owner : null))
    if (e instanceof api.ApiError && typeof e.body.invoiceId === "string") return go(`/?order=${e.body.invoiceId}`)
    if (e instanceof api.ApiError && e.code === "catalog_changed" && typeof e.body.price === "number") {
      return page(null, [status("warn", "alert", "The price changed", [nameText(record.label, invoice.registration.tld), ` costs ${dollars(e.body.price, true)} now. Nothing was charged.`],
        [btn("Search again", "", () => go(searchLink(record.label, record.ownerCode === null ? record.owner : null)))], { reference: invoice.invoiceId })])
    }
    if (e instanceof api.ApiError && e.code === "provider_unavailable") {
      return void note.replaceChildren(el("div", { class: "left mt-18" }, alertBox("warn", "alert", `${methodName(invoice.cryptoCurrency ?? "card")} is unavailable right now`,
        ["Nothing was charged. Try again later, or ", el("a", { href: searchLink(record.label, record.ownerCode === null ? record.owner : null) }, "order the name again"), " to pay another way."])))
    }
    if (holdFor(e, button, note, (left) => `Nothing was charged. Try again in ${left}.`)) return
    note.replaceChildren(el("div", { class: "left mt-18" }, alertBox("warn", "alert", "That did not go through", "Nothing was charged. Try again in a moment.")))
  }
}


// --- registration

type StageState = "done" | "active" | "failed" | ""

function track(states: StageState[]): HTMLElement {
  const stage = (st: StageState, n: string, title: string, text: string) =>
    el("div", { class: `stage ${st}`.trim() }, el("span", { class: "node" }, st === "done" ? "✓" : st === "failed" ? "✕" : n), el("b", {}, title), el("span", {}, text))
  return el("div", { class: "track" },
    stage(states[0], "1", states[0] === "done" ? "Committed" : "Committing", "The name, hidden, goes on\u00a0chain"),
    stage(states[1], "2", "Waiting", "Every registration waits after its commit"),
    stage(states[2], "3", states[2] === "done" ? "Registered" : "Registering", "Then it is yours"))
}

// block explorers by chain id; a chain without one, as a local test chain, shows its hashes as text
const EXPLORERS: Record<number, string> = { 1: "https://etherscan.io", 11155111: "https://sepolia.etherscan.io" }

function txRows(view: api.RegistrationView, states: StageState[]): HTMLElement {
  const tx = (k: string, v: Node, c: Node | null) => el("div", { class: "tx" }, el("span", { class: "k" }, k), v, c)
  const explorer = EXPLORERS[view.chainId]
  const onChain = (kind: "tx" | "address", value: string | null, text: string) => explorer && value
    ? el("a", { class: "v mono", href: `${explorer}/${kind}/${value}`, target: "_blank", rel: "noopener", title: value }, `${text}\u00a0↗`)
    : el("span", { class: "v mono", title: value ?? "" }, text)
  const hash = (h: string | null) => onChain("tx", h, h ? shortHash(h) : "—")
  return el("div", { class: "panel-sec txs" },
    tx("Commit", hash(view.commitTx), view.commitTx ? chip(states[0] === "done" ? "Confirmed" : "Sent", states[0] === "done" ? "ok" : "brand") : null),
    tx("Register", hash(view.registerTx), states[2] === "done" ? chip("Confirmed", "ok") : states[2] === "active" ? chip("Sent", "brand") : chip("After the wait")),
    tx("Owner", onChain("address", view.owner, shortAddress(view.owner)), null))
}

function paidRows(view: api.RegistrationView, invoice: api.InvoiceView | null): [string, string | Node][] {
  const paid: [string, string] = invoice ? ["Paid", `${dollars(invoice.amount, true)} · ${methodName(invoice.cryptoCurrency ?? "card")}`] : ["Paid", "With a code"]
  return [paid, ["Term", termText(view.years)], ["Reference", shortRef(invoice?.invoiceId ?? view.id)]]
}

function registering(view: api.RegistrationView, record: store.OrderRecord | undefined, invoice: api.InvoiceView | null, reload: () => void): void {
  const label = labelOf(view, record)
  const fromApp = openedFromApp(view, record)
  // the browser with the code signs after the wait; any other one can only take the code in
  if (view.phase !== "registering" && view.label === null && !fromApp && !record?.ownerCode) return notOnThisDevice(view, invoice)
  const states: StageState[] = view.phase === "registering" ? ["done", "done", "active"] : view.phase === "committed" ? ["done", "active", ""] : ["active", "", ""]
  let box: HTMLElement
  const problem = el("div", {})
  if (view.phase === "committed") {
    const clockNode = live(el("b", {}))
    const note = live(el("p", {}))
    // the note fades across when it says something new, and its height eases with it
    let said = ""
    const say = (text: string) => {
      if (text === said) return
      said = text
      note.replaceChildren(text)
    }
    box = el("div", { class: "countdown" }, clockNode, note)
    // a reveal is signed for one commit: a retarget changes the commitment, a re-sign the nonce, a recommit the deadline
    const key = `${view.id} ${view.commitment} ${view.intentNonce} ${view.revealBefore}`
    const failures = revealFailures.get(key) ?? 0
    if (failures >= REVEAL_ATTEMPTS) {
      problem.append(el("div", { class: "mt-18" }, alertBox("bad", "alert", "The name could not be signed", "The service refused the signed registration."),
        el("div", { class: "mt-14" }, btn("Try again", "quiet", () => { revealFailures.delete(key); reload() }, icon("refresh")))))
    }
    const tick = () => {
      const left = (view.revealAfter ?? 0) - api.serviceNow() / 1000
      if (left > 0) {
        clockNode.textContent = clock(left)
        say("The contract makes every registration wait after its commit, so nobody can take a name they saw being registered.")
        return
      }
      // the clock gives way to the icon once, fading across
      if (!clockNode.querySelector("svg")) clockNode.replaceChildren(icon("clock"))
      if (view.label !== null) say("Sending the registration. The name is yours once it is mined.")
      else if (fromApp) say("Waiting for SimpleX to sign the registration with your app's wallet.")
      else say("Signing the registration with the name's key from your code.")
      if (view.label === null && record?.ownerCode && failures < REVEAL_ATTEMPTS && !revealing.has(key)) {
        revealing.add(key)
        // a refused reveal is retried on a fresh read of the order: its nonce or deadline may have moved
        flow.revealOrder(view, record).catch((e) => {
          // only a refusal counts against the attempts; an outage or a rate limit is waited out
          const refused = e instanceof api.ApiError && e.code === "bad_request"
          if (refused) revealFailures.set(key, failures + 1)
          setTimeout(() => { revealing.delete(key); reload() }, e instanceof api.ApiError && e.retryAfter ? e.retryAfter * 1000 : RETRY_MS)
        })
      }
    }
    tick()
    every(1000, tick)
  } else {
    box = el("div", { class: "countdown" }, el("b", {}, icon("clock")), el("p", {}, view.phase === "registering"
      ? "The register transaction is being mined; the name is yours once it is, and final 3 blocks later."
      : view.phase === "unpaid" ? "Waiting for payment." : "Waiting for the commit to be mined. The wait starts once it is."))
  }
  const signed = view.label !== null || view.phase === "registering"
  const keepOpen = fromApp ? "Keep this page open while SimpleX finishes it."
    : signed ? (record ? "It is signed and on its way on chain." : "The browser with its name code signed it.")
      : "Keep this page open: after the wait it signs the name to finish it."
  page(null, [pageHead(label ? ["Registering ", gradName(label, view.tld)] : "Registering the name", `About two minutes. ${keepOpen}`, crumbs("Registration", { fromApp, prepaid: !invoice })),
    twoCols(el("div", { class: "panel" }, el("div", { class: "panel-sec" }, track(states), box, problem), txRows(view, states)),
      orderCard(label, view.tld, paidRows(view, invoice)))])
}

const revealing = new Set<string>()
const revealFailures = new Map<string, number>()

function notOnThisDevice(view: api.RegistrationView, invoice: api.InvoiceView | null): void {
  page(null, [status("info", "key", "The name code is not in this browser",
    ["This order registers a name to ", el("span", { class: "nowrap" }, shortAddress(view.owner)), ". Its code was made in the browser it was bought in. Enter the code you saved before paying to carry on here."],
    [btn("Enter your name code", "", () => go("/#/restore"), icon("arrow"))], { reference: invoice?.invoiceId ?? view.id })])
}

function codeBlock(code: string): Node[] {
  const copy = btn("Copy code", "quiet", () => void copyText(code, copy), icon("copy"))
  return [el("div", { class: "code-display", "data-testid": "owner-code" }, code), el("div", { class: "code-actions" }, copy)]
}

function registered(view: api.RegistrationView, record: store.OrderRecord | undefined): void {
  const label = labelOf(view, record)
  const until = view.expiresAt ? dateOf(view.expiresAt) : ""
  const celebrate = (lead: string) => el("section", { class: "celebrate" }, el("div", { class: "wrap" },
    el("div", { class: "tick" }, icon("check")),
    el("h1", { class: "display" }, label ? gradName(label, view.tld) : "The name", el("br"), "is yours"),
    el("p", { class: "lead" }, lead)))
  const states: StageState[] = ["done", "done", "done"]
  if (!record?.ownerCode) {
    const back = record
      ? btn("Back to SimpleX", "lg block", () => { location.href = "simplex:/" }, icon("arrow"))
      : withoutRecord(view, "quiet block", "Restore with your name code")
    return page(null, [celebrate(record
      ? `Registered for ${termText(view.years)}, until ${until}, to your app's wallet, ${shortAddress(view.owner)}.`
      : view.sealed === null ? `Registered until ${until} to the wallet of the app it was ordered from, ${shortAddress(view.owner)}.`
        : `Registered until ${until} to ${shortAddress(view.owner)}. Its name code is not in this browser.`),
      el("div", { class: "wrap narrow" }, el("div", { class: "panel" },
        el("div", { class: "panel-sec" }, track(states)), txRows(view, states), el("div", { class: "panel-sec" }, back)))])
  }
  const next = (ic: Parameters<typeof icon>[0], title: string, text: string, action: Node | null) =>
    el("div", { class: "item" }, el("span", { class: "ic" }, icon(ic)), el("div", {}, el("b", {}, title), el("p", {}, text), action))
  page(null, [celebrate(`Registered for ${termText(view.years)}, until ${until}, to ${shortAddress(view.owner)}, the wallet of your name code.`),
    twoCols(
      el("div", { class: "panel" }, el("div", { class: "panel-sec" },
        el("div", { class: "sec-title" }, el("h2", {}, "Your name code")),
        el("p", { class: "sec-note" }, "The name code it was ordered with. It owns the name."),
        ...codeBlock(record.ownerCode),
        store.canPersist()
          ? alertBox("warn", "shield", null, "Whoever has this code controls the name. Nobody else has a copy, not even us.")
          : alertBox("bad", "alert", "This code could not be saved in this browser", "The copy you saved before paying is the only one."))),
      el("aside", { class: "panel summary" },
        el("span", { class: "label" }, "Next steps"),
        el("div", { class: "next mt-12" },
          next("phone", "Redeem it in the app", "Scan or enter the code in SimpleX: the name moves to the app's wallet.",
            el("div", { class: "qr mt-10" }, qrSvg(record.ownerCode, "name code"))),
          next("link", "Point it at your address", "Link your contact address or channel.", el("a", { href: `/#/edit/${view.id}` }, "Edit links")),
          next("key", "Keep the code safe", "Until you redeem it, it is the only key to the name.", null))))])
}

function taken(view: api.RegistrationView, record: store.OrderRecord | undefined, invoice: api.InvoiceView | null, reload: () => void): void {
  const label = labelOf(view, record)
  if (!invoice) {
    const code = record?.prepaidCode
    if (!code) return page(null, [status("info", "key", "Someone registered it first", [label ? nameText(label, view.tld) : "The name", " was registered just before ours. Your code was not spent: use it for another name."], [btn("Search another name", "", () => go("/#/"))], { reference: view.id })])
    // the released code goes back to this browser's codes, to use for another name
    const parsed = parseNameCode(code)
    const covers = parsed?.kind === "prepaid" ? parsed.minLength : codeTier(label?.length ?? LONGEST_TIER)
    if (!store.codes().some((c) => c.code === code)) store.addCode({ code, minLength: covers, years: view.years, addedAt: new Date().toISOString() })
    const copy = btn("Copy code", "quiet", () => void copyText(code, copy), icon("copy"))
    const use = btn("Use it for another name", "", () => useCode({ code, minLength: covers, years: view.years, addedAt: "" }), icon("arrow"))
    return page(null, [status("info", "key", "Someone registered it first", [label ? nameText(label, view.tld) : "The name", " was registered just before ours. Your code was not spent: use it for another name."], [use, copy],
      { reference: view.id, extra: el("div", { class: "code-display" }, code) })])
  }
  const paid = dollars(invoice.amount, true)
  // the order's worth caps another name; after a move to a cheaper name it is lower than what was paid
  const kept = dollars(view.price, true)
  const canAct = record?.ownerCode
  const other = btn("Choose another name", "block", () => go(`/#/?retarget=${view.id}`))
  const note = liveRegion()
  const code = btn("Take a code", "quiet block", () => void takeCode(view, record!, code, note, reload))
  // a browser without the order's code cannot act at all; one that can waits out any hold
  if (!canAct) { disabled(other); disabled(code) } else respectHold(code, note)
  const fromApp = openedFromApp(view, record)
  page(null, [pageHead("Someone registered it first", [label ? nameText(label, view.tld) : "The name", " was registered just before ours. Your payment is kept."], crumbs("Registration", { fromApp })),
    twoCols(el("div", { class: "panel" },
      el("div", { class: "panel-sec" }, track(["done", "done", "failed"]),
        el("p", { class: "sec-note mt-18" }, "Another registration of this name went through first, so ours could not."),
        canAct ? null : fromApp
          ? alertBox("info", "phone", "This order was opened from SimpleX", "Choose another name or take a code in the app.")
          : alertBox("info", "key", "The name code is not in this browser", "Restore it in Your names to choose another name or take a code."),
        el("div", { class: "options" },
          el("div", { class: "option" }, el("b", {}, "Choose another name"), el("p", {}, `Any name of up to ${kept}, registered to the same wallet, so your code owns it.`), other),
          el("div", { class: "option" }, el("b", {}, "Take a code instead"), el("p", {}, `A code for names of ${codeTier(label?.length ?? LONGEST_TIER)} or more letters, for 2 years, to use here or in the app.`), code)), note)),
      orderCard(label, view.tld, [["Paid", `${paid} · ${methodName(invoice.cryptoCurrency ?? "card")}`], ["Kept", kept], ["Reference", fullRef(invoice.invoiceId)]]))])
}

async function takeCode(view: api.RegistrationView, record: store.OrderRecord, button: HTMLButtonElement, note: HTMLElement, reload: () => void): Promise<void> {
  disabled(button)
  note.replaceChildren()
  try {
    await flow.takeCodeFor(record, view)
    return reload()
  } catch (e) {
    // the code may have been issued with the answer lost, or another browser moved the order: the order says
    const now = await api.readRegistration(view.id).catch(() => null)
    if (e instanceof api.ApiError && e.code === "rate_limited") startHold(e.retryAfter ?? api.LIMITED_WAIT_S)
    if (now && now.phase !== "taken") return reload()
    if (holdFor(e, button, note, (left) => `The code was not taken. Try again in ${left}.`)) return
  }
  release(button)
  note.replaceChildren(el("div", { class: "mt-14" }, alertBox("warn", "alert", null, "The code could not be taken now. Try again in a moment.")))
}

function codeIssued(view: api.RegistrationView, record: store.OrderRecord | undefined): void {
  if (openedFromApp(view, record)) {
    return page(null, [status("info", "key", "This order became a code", "The app the order was opened from shows the code.", [btn("Search a name", "", () => go(searchFrom(view, record)))], { reference: view.id })])
  }
  if (!record?.ownerCode) {
    return page(null, [status("info", "key", "This order became a code", "The code is made from the order's name code, so it shows in the browser that has it. Restore the name code here to see it.",
      [btn("Enter your name code", "", () => go("/#/restore"), icon("arrow"))], { reference: view.id })])
  }
  const code = record.takenCode ?? flow.takenCodeOf(record, view.id)
  if (!record.takenCode) {
    store.updateOrder(record.registrationId, { takenCode: code })
    store.addCode({ code, minLength: codeTier(record.label.length), years: 2, addedAt: new Date().toISOString() })
  }
  const copy = btn("Copy code", "", () => void copyText(code, copy), icon("copy"))
  page(null, [status("ok", "key", "Here is a code instead", [`For names of ${codeTier(record.label.length)} or more letters, for 2 years: what `, nameText(record.label, view.tld), " was paid for."],
    [copy, btn("Search another name", "quiet", () => go("/#/"))],
    { extra: [el("div", { class: "code-display" }, code),
      el("div", { class: "center mt-16" }, el("div", { class: "qr" }, qrSvg(code, "code"))),
      el("div", { class: "left" }, alertBox("info", "info", "Keep a copy of this code", "The service keeps only its hash; this browser keeps the code, under Your names."))] })])
}

function failed(view: api.RegistrationView, record: store.OrderRecord | undefined, invoice: api.InvoiceView | null, reload: () => void): void {
  const label = labelOf(view, record)
  const note = liveRegion()
  const again = respectHold(btn("Try again", "lg", () => void retry_(view, again, note, reload), icon("refresh")), note)
  const failedAt: StageState[] = view.commitTx === null ? ["failed", "", ""] : ["done", "done", "failed"]
  page(null, [pageHead(invoice ? "Paid, not registered" : "Not registered", invoice ? "Your payment is kept. Trying again charges nothing." : "Your code is kept. Trying again spends nothing more.", crumbs("Registration", { fromApp: openedFromApp(view, record), prepaid: !invoice })),
    twoCols(el("div", { class: "panel" },
      el("div", { class: "panel-sec" }, track(failedAt),
        el("div", { class: "mt-22" }, alertBox("bad", "alert", view.error ?? "The registration did not go through", "The service's own retries gave up.")),
        note, el("div", { class: "mt-18" }, again))),
      orderCard(label, view.tld, [...paidRows(view, invoice).slice(0, 1), ["Charged again", "Never"], ["Reference", fullRef(invoice?.invoiceId ?? view.id)]]))])
}

const RETRY_CODE_ERRORS: Record<string, string> = {
  code_used: "Your code was used for another name",
  code_reserved: "Your code is held by another registration; try again later",
  code_invalid: "This code is not valid",
  code_expired: "This code has expired",
}

async function retry_(view: api.RegistrationView, button: HTMLButtonElement, note: HTMLElement, reload: () => void): Promise<void> {
  disabled(button)
  try {
    await api.retry(view.id)
  } catch (e) {
    // another tab may have retried it already
    const now = await api.readRegistration(view.id).catch(() => null)
    if (e instanceof api.ApiError && e.code === "rate_limited") startHold(e.retryAfter ?? api.LIMITED_WAIT_S)
    if (now && now.phase !== "failed") return reload()
    release(button)
    const line = e instanceof api.ApiError ? RETRY_CODE_ERRORS[e.code] : undefined
    if (line) return void note.replaceChildren(el("div", { class: "mt-14" }, alertBox("warn", "key", line, null)))
    if (holdFor(e, button, note, (left) => `Nothing changed. Try again in ${left}.`)) return
    return void note.replaceChildren(el("div", { class: "mt-14" }, alertBox("warn", "alert", "That did not go through", "Nothing changed. Try again in a moment.")))
  }
  reload()
}
