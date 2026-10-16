// Your names: this browser's orders and codes, restoring an order with its name code, and editing a name's links.
import * as api from "../api.ts"
import { parseNameCode } from "../crypto/code.ts"
import { alertBox, btn, chip, copyText, disabled, el, gradName, holdFor, holding, holdLeft, icon, liveRegion, nameText, release, respectHold, startHold, waitOut } from "../dom.ts"
import { focusHeading } from "../focus.ts"
import * as flow from "../flow.ts"
import { addTo, live, moving, removeFrom, textSpan } from "../motion.ts"
import { dateOf, dollars, methodName, SEP } from "../format.ts"
import { qrSvg } from "../qr.ts"
import * as session from "../session.ts"
import * as store from "../store.ts"
import { linkField } from "./checkout.ts"
import { codePopup, useCode, verdictNode } from "./codes.ts"
import { closePopup, CONTACT_EMAIL, currentRoute, go, isRedraw, isRoute, page, placeholder, pageHead, popup, redirect, refresh, twoCols, whenLeaving } from "./shell.ts"

function row(mark: string, title: string, sub: Node | string, state: Node, ...acts: Node[]): HTMLElement {
  return el("div", { class: "row-item" },
    el("span", { class: "mark" }, mark), el("div", { class: "main" }, el("b", { title }, title), el("div", { class: "sub" }, sub)), state, live(el("div", { class: "acts" }, ...acts)))
}

const small = (text: string, onclick: () => void, ic?: Parameters<typeof icon>[0]) =>
  el("a", { class: "small-btn", href: "#", onclick: (e: Event) => { e.preventDefault(); onclick() } }, ic ? icon(ic) : null, text)

export function historyPage(): void {
  const mine = currentRoute()
  const orders = store.orders()
  const codes = store.codes()
  const forget = live(el("div", {}))
  // Another tab ordering, cancelling or adding a code changes this list; the writes of one change, often several, are
  // drawn once, in the next frame, and not while the list asks whether to forget everything, which a redraw would
  // take away: then once the question is answered.
  let drawing = false
  let held = false
  const redraw = () => {
    if (!forget.contains(forgetLink)) held = true
    if (drawing || held && !forget.contains(forgetLink)) return
    drawing = true
    requestAnimationFrame(() => { if (isRoute(mine)) refresh() })
  }
  const forgetLink = el("a", { class: "danger-link", href: "#", onclick: (e: Event) => {
    e.preventDefault()
    confirmForget(forget, forgetLink, () => { if (held) redraw() })
  } }, "Forget everything in this browser")
  forget.append(forgetLink)
  const onStorage = (e: StorageEvent) => { if (store.isRecordKey(e.key)) redraw() }
  window.addEventListener("storage", onStorage)
  whenLeaving(() => window.removeEventListener("storage", onStorage))
  const orderRows = [...store.pendingCodes().map((p) => pendingRow(p, mine)), ...orders.map((o) => orderRow(o, mine))]
  const codeRows = codes.map((c) => codeRow(c, mine))
  page("names", [pageHead("Your names", store.canPersist() ? "This list is kept only in this browser." : "This browser cannot keep this list: it empties when the page reloads."),
    el("div", { class: "wrap" },
      el("div", { class: "toolbar" }, btn([icon("key"), "Add a code"], "quiet", () => codePopup("add")), btn([icon("refresh"), "Restore with a name code"], "quiet", () => go("/#/restore"))),
      el("div", { class: "panel" }, el("div", { class: "list-title" }, el("h2", {}, "Names")),
        ...(orderRows.length ? orderRows : [el("p", { class: "sec-note empty-list" }, "No names in this browser yet.")])),
      el("div", { class: "panel mt-16" }, el("div", { class: "list-title" }, el("h2", {}, "Codes")),
        ...(codeRows.length ? codeRows : [el("p", { class: "sec-note empty-list" }, "No codes in this browser yet.")])),
      orderRows.length || codes.length ? forget : null)])
}

// The link gives way to the question, whose safe answer takes focus; keeping them puts the link back.
function confirmForget(area: HTMLElement, forgetLink: HTMLElement, kept: () => void): void {
  const keep = btn("Keep them", "quiet", () => {
    area.replaceChildren(forgetLink)
    forgetLink.focus()
    kept()
  })
  area.replaceChildren(el("div", { class: "mt-18" }, alertBox("bad", "alert", "Forget every name and code in this browser?",
    "Everything listed here is removed from this browser. Without your saved copies, the name codes and codes cannot be restored."),
  el("div", { class: "actions mt-14" },
    btn("Forget everything", "danger", () => {
      store.forgetEverything()
      // nothing read about the forgotten orders and codes is drawn again
      seenRows.clear()
      seenCodes.clear()
      // the tab's unfinished checkout holds an owner code too
      session.setCheckout(null)
      session.setAppliedCode(null)
      refresh()
    }),
    keep)))
  keep.focus()
}

const markOf = (label: string) => label.slice(0, 1).toUpperCase()

const NAME_KEPT_WHOLE = 24

const PROGRESS: Partial<Record<api.Phase, string>> = {
  queued: "Paid, waiting to commit",
  committing: "Committing",
  committed: "Committed, waiting before it can register",
  registering: "Registering on chain",
}

// a row's line goes on after a separator in lower case, as "paid with a code" after the date
const continued = (text: string | null) => text ? text.charAt(0).toLowerCase() + text.slice(1) : text

// What a row last read about its order from the service, so the list drawn again starts from it rather than from
// "Checking"; the order's own record is always this browser's latest. The search answer is undefined until a
// registered name's records are read.
type RowSeen = { view: api.RegistrationView; invoice: api.InvoiceView | null; answer?: api.SearchAnswer | null }
const seenRows = new Map<string, RowSeen>()

const FOLLOW_MS = 15_000
const SETTLED: api.Phase[] = ["registered", "taken", "failed", "code_issued"]
// an order that changes no more by itself: a final phase, or an invoice that closed unpaid
const settled = (seen: RowSeen | undefined) => seen !== undefined
  && (SETTLED.includes(seen.view.phase) || (seen.view.phase === "unpaid" && seen.invoice !== null && seen.invoice.status !== "open"))
const seenCodes = new Map<string, api.CodeState>()

// A registered name past its expiry: there are no renewals, so it is over, in its grace period too, and whether or not
// someone has registered it again since.
const lapsed = ({ view, answer }: Pick<RowSeen, "view" | "answer">) =>
  view.phase === "registered" && ((view.expiresAt !== null && view.expiresAt < api.serviceNow() / 1000) || answer?.status === "available")

// the reference support asks for, in a face where l and I differ
const reference = (id: string) => [`${SEP}reference `, el("span", { class: "mono" }, id)]

function subLine(o: store.OrderRecord, { view, invoice, answer }: RowSeen): string | (Node | string)[] {
  // what was paid, from the invoice; the record's amount is the order's worth, lower after a move to a cheaper name
  const paid = invoice ? `${dollars(invoice.amount, true)} ${methodName(invoice.cryptoCurrency ?? "card")}`
    : o.method === "code" ? "Paid with a code" : `${dollars(o.paid, true)} ${methodName(o.method)}`
  if (lapsed({ view, answer })) return `Expired ${view.expiresAt ? dateOf(view.expiresAt, true) : ""}`.trim()
  if (view.phase === "registered") {
    const shown = answer?.status === "registered" ? answer.entities[0]?.displayName : undefined
    // a short display name stays on one line
    const target = shown && shown.length <= NAME_KEPT_WHOLE ? shown.replaceAll(" ", "\u00a0") : shown
    return [view.expiresAt ? `Until ${dateOf(view.expiresAt, true)}` : null, target ? `points at ${target}` : null, continued(paid)].filter(Boolean).join(SEP)
  }
  if (invoice?.status === "paid" && view.phase === "unpaid") return ["Paid after the invoice closed; support refunds it", ...reference(invoice.invoiceId)]
  if (invoice?.status === "expired" && view.phase === "unpaid") {
    const part = Number(invoice.cryptoAmountPaid ?? "0") > 0 && !invoice.paidInFull
    const arrived = part ? "Part of the payment arrived" : api.holdsPayment(invoice) ? "A payment did not complete before the invoice closed" : null
    return arrived ? [`${arrived}; support sorts it out`, ...reference(invoice.invoiceId)] : `Nothing was charged${SEP}${dateOf(Date.parse(o.createdAt) / 1000, true)}`
  }
  if (view.phase === "taken" && o.method === "code") return "Paid with a code, released for another name"
  if (waitsToSign(view)) return `${o.ownerCode ? "Open the order so this browser can sign it" : "Waiting for SimpleX to sign it"}${SEP}${continued(paid)}`
  return PROGRESS[view.phase] ? `${PROGRESS[view.phase]}${SEP}${continued(paid)}` : paid
}

// a part of a row changes only when what it shows does, so an unchanged chip or button does not fade in again
function swapIfChanged(part: HTMLElement, ...nodes: (Node | string)[]): void {
  // compared as the part would hold it, its text in spans
  const next = el("span", {}, ...nodes.map(textSpan))
  // what fades out of the part is not what it shows
  const shown = [...part.childNodes].filter((n) => !(n instanceof Element && n.classList.contains("outgoing")))
  if (next.innerHTML !== el("span", {}, ...shown.map((n) => n.cloneNode(true))).innerHTML) part.replaceChildren(...nodes)
}

function orderRow(stored: store.OrderRecord, mine: number): HTMLElement {
  let o = stored
  const sub = live(el("span", {}, o.method === "code" ? "Paid with a code" : `${dollars(o.paid, true)} ${methodName(o.method)}`))
  const state = live(el("span", {}, chip("Checking", "", true)))
  const acts = live(el("span", { class: "acts-inner" }, small("Open", () => go(flow.orderUrl(o)))))
  const node = row(markOf(o.label), `${o.label}.${o.tld}`, sub, state, acts)
  // a redraw finds focus again within the same row
  node.dataset.key = o.registrationId
  // a replaced invoice is listed again only once a late payment has reached it
  node.hidden = Boolean(o.replacedBy)
  const show = (seen: RowSeen) => {
    const { view } = seen
    node.hidden = false
    // the order may have moved to another name since it was stored
    const shown = `${view.label ?? o.label}.${view.tld}`
    const title = node.querySelector("b")!
    title.textContent = shown
    title.title = shown
    node.querySelector(".mark")!.textContent = markOf(view.label ?? o.label)
    swapIfChanged(sub, ...[subLine(o, seen)].flat())
    const [text, tone] = lapsed(seen) ? ["Expired", "bad"] : phaseChip(view, seen.invoice, o)
    swapIfChanged(state, chip(text, tone, tone !== "bad"))
    if (view.phase !== "registered" || !o.ownerCode || seen.answer === undefined) return
    const editing = !lapsed(seen) && (seen.answer === null || editable(seen.answer, o.owner))
    swapIfChanged(acts, small("Show code", () => showCode(o), "key"), editing ? small("Edit links", () => go(`/#/edit/${o.registrationId}`), "link") : "")
  }
  // a replaced invoice stays hidden until its own read says money reached it
  const before = seenRows.get(o.registrationId)
  if (before && !o.replacedBy) show(before)
  // Another browser may have made a newer invoice for this order; that one takes this row's place. Only this row
  // changes, so a popup opened meanwhile stays open.
  const replaceWithNewer = async () => {
    const next = !o.replacedBy && o.ownerCode ? await flow.newerOrder(o).catch(() => null) : null
    if (!next || !isRoute(mine)) return false
    if (document.querySelector(`.row-item[data-key="${next.registrationId}"]`)) node.remove()
    else node.replaceWith(orderRow(next, mine))
    return true
  }
  // read now, and again now and then while the order is on its way, so the row follows it as its page does
  const load = async () => {
    let view: api.RegistrationView
    let invoice: api.InvoiceView | null = null
    try {
      if (o.invoiceId) {
        invoice = await api.readInvoice(o.invoiceId)
        view = invoice.registration
      } else view = await api.readRegistration(o.registrationId)
    } catch (e) {
      // the service forgets an unpaid order some time after it closes
      if (e instanceof api.ApiError && e.code === "not_found" && await replaceWithNewer()) return
      if (isRoute(mine)) swapIfChanged(state, chip("Not checked", "warn"))
      return
    }
    o = await flow.syncRecord(o, view) ?? o
    if (!isRoute(mine)) return
    if (o.replacedBy && api.closedEmpty(invoice)) return
    if (api.closedEmpty(invoice) && await replaceWithNewer()) return
    if (!isRoute(mine)) return
    // a name's records, read last time, stand until they are read again
    const last = seenRows.get(o.registrationId)
    const seen: RowSeen = { view, invoice, answer: last?.view.phase === "registered" ? last.answer : undefined }
    seenRows.set(o.registrationId, seen)
    show(seen)
    if (!settled(seen)) setTimeout(() => { if (isRoute(mine)) void load() }, FOLLOW_MS)
    if (view.phase !== "registered") return
    seen.answer = await api.searchName(view.labelHash, (view.label ?? o.label).length).catch(() => null)
    if (isRoute(mine)) show(seen)
  }
  void load()
  return node
}

// Focus dropped by a button that stays off goes to the answer below it, which a phone shows where the button was; the
// heading would scroll the answer away.
function focusAnswer(answer: HTMLElement): void {
  if (document.activeElement !== document.body) return
  answer.tabIndex = -1
  // focus alone would jump the page to the answer
  answer.focus({ preventScroll: true })
  answer.scrollIntoView({ block: "nearest", behavior: moving() ? "smooth" : "auto" })
}

// A checkout that showed its owner code and may or may not have created the order: the code finds out.
function pendingRow(p: store.PendingCode, mine: number): HTMLElement {
  const state = live(el("span", {}, chip("Checkout not finished", "warn")))
  const node = row(markOf(p.label), `${p.label}.${p.tld}`, `Name code shown ${dateOf(Date.parse(p.createdAt) / 1000, true)}`, state)
  node.dataset.key = `${p.label}@${p.createdAt}`
  const acts = node.querySelector<HTMLElement>(".acts")!
  // held from the click until the lookup answers, and through any wait it asks for
  let held = false
  const hold = (on: boolean) => {
    held = on
    if (on) find.setAttribute("aria-disabled", "true")
    else find.removeAttribute("aria-disabled")
  }
  const waitHeld = (wait: number) => {
    hold(true)
    const waiting = chip("", "warn")
    state.replaceChildren(waiting)
    waitOut(waiting, wait, (left) => `Try again in ${left}`, () => {
      hold(false)
      state.replaceChildren(chip("Checkout not finished", "warn"))
    })
  }
  const find = small("Find the order", async () => {
    if (held) return
    // a wait met by another row or page says so here too
    if (holding()) return waitHeld(holdLeft())
    hold(true)
    try {
      const { record } = await flow.restore(p.ownerCode)
      if (isRoute(mine)) go(flow.orderUrl(record))
    } catch (e) {
      const none = e instanceof api.ApiError && e.code === "not_found"
      const wait = e instanceof api.ApiError && e.code === "rate_limited" ? e.retryAfter ?? api.LIMITED_WAIT_S : null
      if (wait !== null) {
        startHold(wait)
        return waitHeld(holdLeft())
      }
      hold(false)
      // The link goes with nothing left to find, first, so the chip slides into its room as one, its label changing
      // on the way; focus the link held goes to the heading, not onto Remove beside it.
      if (none) {
        const focused = document.activeElement === find
        removeFrom(acts, find)
        if (focused) focusHeading()
      }
      state.replaceChildren(chip(none ? "No order was made" : "Not checked", "bad"))
    }
  }, "refresh")
  const remove = small("Remove", () => { store.dropPending(p.ownerCode); refresh() })
  // focus moving on from a control that went never lands here
  remove.dataset.destructive = ""
  acts.append(find, remove)
  // a row drawn during a wait met elsewhere in the tab shows it, once the row is in the page
  if (holding()) setTimeout(() => { if (node.isConnected && holding()) waitHeld(holdLeft()) })
  return node
}

// after the wait an order stands still until its owner signs: the page that has its code, or the app it was opened from
const waitsToSign = (view: api.RegistrationView) =>
  view.phase === "committed" && view.label === null && view.revealAfter !== null && api.serviceNow() / 1000 >= view.revealAfter
const waitsForThisBrowser = (view: api.RegistrationView, o: store.OrderRecord) => waitsToSign(view) && o.ownerCode !== null

function phaseChip(view: api.RegistrationView, invoice: api.InvoiceView | null, o: store.OrderRecord): [string, string] {
  if (waitsForThisBrowser(view, o)) return ["Open to finish", "warn"]
  if (view.phase === "unpaid") {
    // amber once money reached it, as its page shows: support sorts that out
    if (invoice?.status === "expired") return o.cancelled && !api.holdsPayment(invoice) ? ["Invoice cancelled", "bad"] : ["Invoice expired", api.holdsPayment(invoice) ? "warn" : "bad"]
    // a cancel the service has not closed yet: nothing more is to be paid into it, whatever reached it meanwhile
    if (o.cancelled && invoice?.status === "open" && !invoice.paidInFull) return ["Invoice cancelled", "warn"]
    if (invoice?.status === "paid") return ["Paid late", "warn"]
    // amber, as the order's page shows the same states
    if (invoice?.paidInFull || o.cardSubmittedAt) return ["Confirming payment", "warn"]
    if (invoice?.amountPaid || Number(invoice?.cryptoAmountPaid ?? "0") > 0) return ["Waiting for the rest", "warn"]
    return ["Waiting for payment", "warn"]
  }
  return ({
    queued: ["Registering", "brand"], committing: ["Registering", "brand"], committed: ["Registering", "brand"], registering: ["Registering", "brand"],
    registered: ["Registered", "ok"], taken: ["Taken first", "warn"], failed: ["Not registered", "bad"], code_issued: ["Code taken", "ok"],
  } as Record<api.Phase, [string, string]>)[view.phase]
}

// what a code's state reads as in the list, worded as the code popup words it
const CODE_CHIPS: Record<api.CodeState, [string, string]> = {
  unused: ["Unused", "ok"], used: ["Used", "bad"], reserved: ["In use", "brand"],
  expired: ["Expired", "bad"], unpaid: ["Not paid yet", "warn"], revoked: ["Not valid", "bad"],
}

function codeRow(c: store.CodeRecord, mine: number): HTMLElement {
  const state = live(el("span", {}, chip("Checking", "", true)))
  const copy = small("Copy", () => void copyText(c.code, copy), "copy")
  const useButton = () => small("Use", () => useCode(c))
  let use = useButton()
  const node = row("≡", c.code, `Names of ${c.minLength} or more letters, for ${c.years} years${SEP}added ${dateOf(Date.parse(c.addedAt) / 1000, true)}`, state, use, copy)
  node.classList.add("code-row")
  node.dataset.key = c.code
  const acts = node.querySelector<HTMLElement>(".acts")!
  // the code's state as read last time stands until it is read again; Use goes while the code cannot be used, and comes
  // back, as a new button, once it can
  const show = (codeState: api.CodeState) => {
    const [text, tone] = CODE_CHIPS[codeState]
    swapIfChanged(state, chip(text, tone, codeState === "unused"))
    const usable = use.parentNode === acts && !use.classList.contains("outgoing")
    if (codeState !== "unused" && usable) removeFrom(acts, use)
    if (codeState === "unused" && !usable) {
      use = useButton()
      addTo(acts, use, copy)
    }
  }
  const before = seenCodes.get(c.code)
  if (before) show(before)
  void api.checkCode(c.code).then((answer) => {
    seenCodes.set(c.code, answer.state)
    if (isRoute(mine)) show(answer.state)
  }, (e) => {
    // the service answers a code it does not know, or has revoked, as not valid
    if (e instanceof api.ApiError && e.code === "code_invalid") {
      seenCodes.set(c.code, "revoked")
      if (isRoute(mine)) show("revoked")
    } else if (isRoute(mine)) swapIfChanged(state, chip("Not checked", "warn"))
  })
  return node
}

function showCode(o: store.OrderRecord): void {
  const code = o.ownerCode!
  const copy = btn("Copy code", "quiet", () => void copyText(code, copy), icon("copy"))
  popup(el("div", { class: "modal", role: "dialog", "aria-label": "Name code" },
    el("div", { class: "modal-head" }, el("h3", {}, nameText(o.label, o.tld)),
      el("a", { class: "icon-btn", href: "#", "aria-label": "Close", onclick: (e: Event) => { e.preventDefault(); closePopup() } }, icon("x"))),
    el("p", { class: "sec-note" }, "The name code owns the name. Scan or enter it in SimpleX to move the name to the app."),
    el("div", { class: "code-display" }, code),
    el("div", { class: "center mt-16" }, el("div", { class: "qr" }, qrSvg(code, "name code"))),
    el("div", { class: "code-actions" }, copy)))
}

// --- restore

export function restorePage(): void {
  const mine = currentRoute()
  const input = el("input", { type: "text", "aria-label": "Name code", spellcheck: "false", placeholder: "SN-…", autocomplete: "off" })
  const box = el("div", { class: "input code-input mt-8" }, icon("key"), input)
  const note = liveRegion()
  const action = btn("Restore", "lg block", () => void run(), icon("arrow"))
  // a code that cannot work stays refused until it is edited; a service error can be tried again as it is
  // a verdict on the code itself looks as the code popup shows one; a failed lookup is an alert
  // Restore had focus when the lookup started, and lost it to the page when it was turned off
  let pressed = false
  const fail = (title: string, text: string, again = false, verdict = false) => {
    box.className = "input code-input mt-8 bad"
    if (again) release(action)
    else {
      // a code refused as it is goes back to its field to be fixed
      const focused = document.activeElement === action || (pressed && document.activeElement === document.body)
      disabled(action)
      if (focused) input.focus()
    }
    note.replaceChildren(el("div", { class: "mt-14" }, verdict ? verdictNode({ ok: false, title, line: text }) : alertBox("bad", "alert", title, text)))
  }
  const run = async () => {
    const code = parseNameCode(input.value)
    if (code === null) return fail("This code is not valid", "Check it for a mistyped character.", false, true)
    if (code.kind === "prepaid") return fail("This is a prepaid code", "It pays for a name rather than owning one. Add it under Your names, or use it on search.", false, true)
    pressed = document.activeElement === action
    disabled(action)
    note.replaceChildren(el("p", { class: "hint" }, "Finding the code's orders…"))
    try {
      const { record } = await flow.restore(input.value)
      if (isRoute(mine)) go(flow.orderUrl(record))
    } catch (e) {
      if (e instanceof api.ApiError && e.code === "not_found") return fail("No order was found for this code", "The service has no order registered to its wallet.")
      // the service asks for a wait before the next lookup; the button stays off until then, whatever is typed meanwhile
      if (holdFor(e, action, note, (left) => `Your code is fine. Try again in ${left}.`)) return
      if (e instanceof api.ApiError) return fail("The service could not be asked now", "Your code is fine to try again in a moment.", true)
      fail("This code does not open the order", "The order found for it was made with another code.")
    }
  }
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") action.click() })
  input.addEventListener("input", () => {
    if (holding()) return
    box.className = "input code-input mt-8"
    note.replaceChildren()
    action.removeAttribute("disabled")
  })
  page("names", [pageHead("Restore with a name code", "The code stays in this browser. The service sees only a signature from the name's key."),
    twoCols(
      el("div", { class: "panel" }, el("div", { class: "panel-sec" },
        el("span", { class: "label" }, "Name code"), box, note, el("div", { class: "mt-20" }, action))),
      el("aside", { class: "panel summary" },
        el("span", { class: "label" }, "How it works"),
        el("div", { class: "why" },
          el("div", {}, icon("wallet"), "The page rebuilds the name's key and the order's secret from the code."),
          el("div", {}, icon("shield"), "It signs a request with that key and finds the code's orders; knowing the address alone finds nothing."),
          el("div", {}, icon("refresh"), "If the registration waits for this browser, it carries on from here."))))])
  // a wait met anywhere in this tab holds the lookup too
  respectHold(action, note)
  input.focus()
}

// --- edit links

export async function editPage(registrationId: string): Promise<void> {
  const mine = currentRoute()
  const stored = store.orderByRegistration(registrationId)
  if (!stored?.ownerCode) {
    return editNotice(pageHead("Edit links"), alertBox("info", "key", "The name code is not in this browser", "Restore it in Your names to edit this name's links."))
  }
  if (!isRedraw()) page("names", placeholder())
  let view: api.RegistrationView
  let answer: api.SearchAnswer
  let record = stored
  try {
    view = stored.invoiceId ? (await api.readInvoice(stored.invoiceId)).registration : await api.readRegistration(stored.registrationId)
    record = await flow.syncRecord(stored, view) ?? stored
    answer = await api.searchName(record.request.labelHash, record.label.length)
  } catch (e) {
    // a forgotten unpaid order may have a newer one, found with the code
    const newer = e instanceof api.ApiError && e.code === "not_found" ? await flow.newerOrder(stored).catch(() => null) : null
    if (!isRoute(mine)) return
    if (newer) return redirect(`/#/edit/${newer.registrationId}`)
    // the page tries again by itself, and on demand, until it can read the name
    setTimeout(() => { if (isRoute(mine)) refresh() }, EDIT_RETRY_MS)
    return editNotice(pageHead(["Edit links for ", gradName(record.label, record.tld)]), alertBox("warn", "alert", "The name could not be read now", "This page tries again by itself."),
      el("div", { class: "mt-14" }, btn("Try again", "quiet", () => refresh(), icon("refresh"))))
  }
  if (!isRoute(mine)) return
  if (view.phase === "unpaid") {
    // the name may have been registered through a newer invoice that another browser made, perhaps under another name
    const newer = await flow.newerOrder(record).catch(() => null)
    if (!isRoute(mine)) return
    if (newer) return redirect(`/#/edit/${newer.registrationId}`)
  }
  const head = pageHead(["Edit links for ", gradName(record.label, record.tld)])
  if (lapsed({ view, answer })) {
    return editNotice(head, alertBox("info", "clock", "This name has expired", "Its registration ran out, so its links can no longer be edited. Search it to register it again."))
  }
  const owned = answer.status === "registered" && answer.owner !== undefined && answer.owner.toLowerCase() === record.owner.toLowerCase()
  if (answer.status === "registered" && answer.owner !== undefined && !owned) {
    return editNotice(head, alertBox("info", "phone", "This name is managed in SimpleX", "It was moved to the app's wallet, so its links are edited in the app."))
  }
  if (owned && answer.status === "registered" && answer.records === null) {
    return editNotice(head, alertBox("info", "link", "This name's links are kept elsewhere", "It points at another resolver, so its links are not edited here."))
  }
  if (view.phase !== "registered" || answer.status !== "registered" || !answer.records || answer.recordsNonce == null) {
    return editNotice(head, alertBox("info", "clock", "The name is not registered yet", "Its links can be edited once the registration is final."))
  }
  const current = { ...answer.records }
  const values = { ...current }
  let nonce = answer.recordsNonce
  const result = liveRegion()
  const save = btn("Save links", "lg block", () => void submit())
  // an edit on its way spends a nonce, so Save waits for it whatever the fields do meanwhile
  let saving = false
  const changed = (kind: keyof flow.Links) => (v: string) => {
    values[kind] = v
    if (!saving && !holding()) save.removeAttribute("disabled")
  }
  const fields = el("div", {},
    el("span", { class: "label" }, "Contact address"),
    linkField("contact", "Paste your address", "Address", current.contact, changed("contact")),
    el("span", { class: "label block mt-20" }, "Channel"),
    linkField("channel", "Paste your channel link", "Channel", current.channel, changed("channel")))
  const submit = async () => {
    const pending = [...fields.querySelectorAll<HTMLElement>(".link-field")].find((f) => f.dataset.state === "bad" || f.dataset.state === "checking")
    if (pending) return pending.querySelector("input")!.focus()
    const changes: Partial<flow.Links> = {}
    for (const k of ["contact", "channel"] as const) if (values[k] !== current[k]) changes[k] = values[k]
    if (Object.keys(changes).length === 0) return result.replaceChildren(el("div", { class: "mt-14" }, alertBox("info", "info", null, "Nothing has changed.")))
    disabled(save)
    saving = true
    result.replaceChildren(el("p", { class: "hint" }, "Signing and sending…"))
    const saved: (keyof flow.Links)[] = []
    // an edit sends each link on its own, so one can be on chain when the next fails
    const notSaved = () => {
      const missed = (Object.keys(changes) as (keyof flow.Links)[]).filter((k) => !saved.includes(k))
      return saved.length && missed.length ? `The ${LINK_NAMES[saved[0]]} was saved; the ${LINK_NAMES[missed[0]]} was not.` : "The links were not saved."
    }
    try {
      await flow.saveLinks(record, view, nonce, changes, (kind) => {
        nonce += 1
        saved.push(kind)
        // what was sent is now on chain; a field edited meanwhile is still to be saved
        current[kind] = changes[kind]!
      })
      const done = alertBox("ok", "check", "Links saved", "The change is on chain; the app shows it within a few minutes.")
      result.replaceChildren(el("div", { class: "mt-14" }, done))
      saving = false
      // nothing is left to save unless a field changed while this edit was sent; Save stays off, so focus goes to the answer
      if (values.contact === current.contact && values.channel === current.channel) return focusAnswer(done)
    } catch (e) {
      // no answer is not a refusal: the edit may still be mined, and sending it again would pay for it twice
      if (e instanceof api.ApiError && (e.code === "network" || e.code === "edit_pending")) {
        saving = false
        const unsure = alertBox("warn", "clock", "No answer yet",
          "The change may still go through. Reload this page in a few minutes to see whether it did before saving again.")
        result.replaceChildren(el("div", { class: "mt-14" }, unsure))
        // Save stays off, so focus it dropped goes to the answer rather than to the top of the page
        return focusAnswer(unsure)
      }
      // Save stays off for the wait the service asked for, whatever the fields do meanwhile
      if (holdFor(e, save, result, (left) => `${notSaved()} Try again in ${left}.`, () => {
        saving = false
        save.removeAttribute("disabled")
      })) return
      // A refused edit may mean the nonce moved: an earlier save, from a page reloaded before it was mined, or from
      // another browser. The next save signs with the fresh one, and the page says why this one did not go.
      const fresh = await api.searchName(record.request.labelHash, record.label.length).catch(() => null)
      const moved = fresh?.status === "registered" && fresh.recordsNonce != null && fresh.recordsNonce > nonce ? fresh.recordsNonce : null
      if (moved !== null) nonce = moved
      result.replaceChildren(el("div", { class: "mt-14" }, moved !== null
        // a link already sent stays said, as the next save sends only the rest
        ? alertBox("warn", "clock", saved.length ? notSaved() : "An earlier save got there first",
          saved.length ? "Another save reached the chain first. Save again to send the rest." : "It was still on its way when this one was signed. Save again to send this change.")
        : alertBox("bad", "alert", notSaved(), "Try again in a moment.")))
      saving = false
    }
    release(save)
  }
  page("names", [head,
    twoCols(
      el("div", { class: "panel" }, el("div", { class: "panel-sec" }, fields)),
      el("aside", { class: "panel summary" },
        el("span", { class: "label" }, "Saving"),
        el("div", { class: "why" },
          el("div", {}, icon("key"), "This browser signs the change with the name's key, from your name code."),
          el("div", {}, icon("shield"), "SimpleX sends it and pays the fee.")),
        el("div", { class: "mt-20" }, save), result))])
  respectHold(save, result, () => { if (!saving) save.removeAttribute("disabled") })
}

const LINK_NAMES: Record<keyof flow.Links, string> = { contact: "address", channel: "channel" }

const EDIT_RETRY_MS = 5000

// a notice in place of the edit form, under the page's heading and lined up with it
function editNotice(head: HTMLElement, ...content: Node[]): void {
  page("names", [head, el("div", { class: "wrap" }, el("div", { class: "narrow" }, ...content))])
}

// A name redeemed to the app has another owner, and one pointed at another resolver has no records here.
function editable(answer: api.SearchAnswer, owner: string): boolean {
  if (answer.status !== "registered" || answer.owner === undefined) return true
  return answer.owner.toLowerCase() === owner.toLowerCase() && answer.records !== null
}

// --- trademark owners

export function trademarksPage(): void {
  page(null, [pageHead("Trademark owners", "Some names are reserved and cannot be bought."),
    el("div", { class: "wrap" }, el("div", { class: "panel narrow" }, el("div", { class: "panel-sec" },
      el("p", {}, "If you own a trademark and want the matching name reserved for you, write to ", el("a", { href: `mailto:${CONTACT_EMAIL}` }, CONTACT_EMAIL),
        " with the name and proof that you own the mark. A reserved name can only be registered by the SimpleX team for its owner."))))])
}
