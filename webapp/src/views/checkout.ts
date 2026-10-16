// Checkout: the links and the payment method (or a prepaid code), then the owner code, then the order.
import * as api from "../api.ts"
import { alertBox, btn, copyText, disabled, el, holding, holdLeft, icon, link, liveRegion, nameText, nameTitle, release, respectHold, startHold, waitOut } from "../dom.ts"
import * as flow from "../flow.ts"
import { carry, current, live } from "../motion.ts"
import { dateOf, dollars, methodName, seconds, shortAddress, termText, untilFromNow } from "../format.ts"
import { methodMark, type Method } from "../icons.ts"
import { linkKind, linkProblem, type LinkKind, PRICED_YEARS, priceFor } from "../names.ts"
import * as session from "../session.ts"
import * as store from "../store.ts"
import { CODE_ERRORS, showVerdict, verdictNode, watchCode } from "./codes.ts"
import { entityCard } from "./search.ts"
import { crumbs, currentRoute, go, INVEST_LINE, isRoute, page, pageHead, redirect, refresh, searchLink, status, twoCols, WEFUNDER_URL, whenLeaving } from "./shell.ts"

const METHOD_ORDER: Method[] = ["card", "btc", "xmr"]
const METHODS: Record<Method, string> = { card: "Processed by Stripe", btc: "On-chain", xmr: "Private by default" }
// what checkout selects when the chosen method is refused
const FALLBACK_METHOD: Record<Method, Method> = { card: "btc", btc: "xmr", xmr: "btc" }

function sideCard(c: session.Checkout, rows: [string, string | Node][], ...rest: (Node | null)[]): HTMLElement {
  return el("aside", { class: "panel summary" },
    el("span", { class: "label" }, "Your order"),
    nameTitle(c.label, "nm", c.chain.tld),
    el("div", { class: "rows" }, ...rows.map(([k, v]) => el("div", { class: "r" }, el("span", {}, k), el("span", {}, v)))),
    ...rest)
}

const codeStart = (code: session.AppliedCode) => `${code.display.slice(0, 9)}…`
const years = (c: session.Checkout) => c.code?.years ?? PRICED_YEARS

function totalLine(c: session.Checkout): HTMLElement {
  return el("div", { class: "total" }, el("span", { class: "label" }, "Total"),
    el("b", {}, c.code ? el("s", {}, dollars(priceFor(c.price, years(c)), true)) : null, c.code ? "$0.00" : dollars(c.price, true)))
}

function waitingCardOrder(): store.OrderRecord | undefined {
  return store.orders().find((o) => o.method === "card" && o.cardSubmittedAt)
}

let linksDraw: { route: number; label: string; node: HTMLElement } | null = null

export function checkoutPage(): void {
  const c = session.checkout()
  if (!c) return redirect("/#/")
  // an order on its way holds its checkout: on the code page when there is one, here for an order opened from the app
  const held = session.isSending(c)
  if (held && !c.appOwner) return redirect("/#/checkout/code")
  const fromApp = c.appOwner !== null
  const update = (change: Partial<session.Checkout>) => session.updateCheckout(c.label, change)
  const waiting = c.code ? undefined : waitingCardOrder()
  // switched in place: a redraw would drop a link whose preview is still loading
  const choose = (m: Method, off: boolean) => {
    if (off) return
    update({ method: m })
    for (const node of document.querySelectorAll<HTMLElement>(".method")) {
      const on = node.dataset.method === m
      node.classList.toggle("on", on)
      node.setAttribute("aria-checked", String(on))
      node.tabIndex = on ? 0 : -1
      if (on) node.focus()
    }
    const paying = [...document.querySelectorAll(".summary .r")].find((r) => r.firstChild?.textContent === "Paying with")
    if (paying?.lastChild) paying.lastChild.textContent = methodName(m)
  }

  // a redraw of the same checkout keeps the link fields as they are, with what is typed and any preview still loading
  const route = currentRoute()
  const kept = linksDraw?.route === route && linksDraw.label === c.label ? linksDraw.node : null
  const linksSec = fromApp ? null : kept ?? el("div", { class: "panel-sec" },
    el("div", { class: "sec-title" }, el("h2", {}, "Point it at your SimpleX"), el("span", { class: "opt" }, "Optional")),
    el("p", { class: "sec-note" }, "Set in the same registration. You can change them later."),
    linkField("contact", "Paste your address", "Address", c.contact, (v) => update({ contact: v })),
    linkField("channel", "Paste your channel link", "Channel", c.channel, (v) => update({ channel: v })))
  linksDraw = linksSec && { route, label: c.label, node: linksSec }

  let paySec: HTMLElement
  if (c.code) {
    paySec = el("div", { class: "panel-sec" }, el("div", { class: "sec-title" }, el("h2", {}, "Payment")),
      el("div", { class: "covered-box" }, icon("check"), el("div", {}, "Paid with your code", el("p", {}, `Registered for ${termText(c.code.years)}, with nothing to pay.`))))
  } else if (waiting) {
    paySec = el("div", { class: "panel-sec" }, el("div", { class: "sec-title" }, el("h2", {}, "Payment method")),
      alertBox("info", "info", "You have an order waiting to be confirmed", "A second order would be a second charge, so this one cannot start yet. When that payment is confirmed or expires, you can start a new one here."),
      el("div", { class: "mt-14" }, btn("Open the waiting order", "quiet", () => go(`/?order=${waiting.invoiceId}`))))
  } else {
    const open = METHOD_ORDER.filter((m) => m !== c.unavailable)
    // one Tab stop for the group, as a radio group has; arrows move between the methods
    const step = (m: Method, by: number) => choose(open[(open.indexOf(m) + by + open.length) % open.length], false)
    const methods = el("div", { class: "methods", role: "radiogroup", "aria-label": "Payment method" }, ...METHOD_ORDER.map((m) => {
      const off = c.unavailable === m
      return el("div", {
        class: "method" + (m === c.method ? " on" : "") + (off ? " off" : ""), role: "radio", tabindex: m === c.method ? "0" : "-1", "aria-checked": String(m === c.method), "aria-disabled": off ? "true" : undefined, "data-method": m,
        onclick: () => choose(m, off),
        onkeydown: (e: Event) => {
          const key = (e as KeyboardEvent).key
          if (key === "Enter" || key === " ") choose(m, off)
          else if (key === "ArrowRight" || key === "ArrowDown") step(m, 1)
          else if (key === "ArrowLeft" || key === "ArrowUp") step(m, -1)
          else return
          e.preventDefault()
        },
      }, el("span", { class: "radio" }), methodMark(m), el("div", {}, el("b", {}, methodName(m)), el("br"), el("span", {}, off ? "Temporarily unavailable" : METHODS[m])))
    }))
    paySec = el("div", { class: "panel-sec" }, el("div", { class: "sec-title" }, el("h2", {}, "Payment method")),
      // where a waiting order is pointed at, once it is found
      live(el("div", { class: "open-order" })),
      c.unavailable ? el("div", { class: "mb-14" }, alertBox("warn", "alert", `${methodName(c.unavailable)} is temporarily unavailable`, "Try another method, or come back later.")) : null,
      el("p", { class: "sec-note" }, fromApp ? "You pay on the next page." : "You pay on the next pages, after saving your name code."),
      methods)
  }
  const storage = store.canPersist() ? null : el("div", { class: "panel-sec" },
    fromApp
      ? alertBox("warn", "alert", "This browser will not keep this order", "Keep this page open until the name is registered; a reload loses it.")
      : alertBox("warn", "alert", "This browser will not keep your name code", "The next step shows it: your saved copy will be the only one."))
  const main = el("div", { class: "panel" }, storage, linksSec && carry(linksSec), paySec)

  const rows: [string, string | Node][] = [["Term", termText(years(c))], ["Registered until", `about ${dateOf(untilFromNow(years(c)), true)}`]]
  if (!waiting) rows.push(c.code ? ["Code", codeStart(c.code)] : ["Paying with", methodName(c.method)])
  const go_ = btn("Continue", "lg block", () => {
    const pending = [...main.querySelectorAll<HTMLElement>(".link-field")].find((f) => f.dataset.state === "bad" || f.dataset.state === "checking")
    if (pending) return pending.querySelector("input")!.focus()
    if (fromApp) void submitOrder(go_)
    else go("/#/checkout/code")
  }, icon("arrow"))
  const codeArea = live(el("div", {}))
  const showCodeLink = !fromApp && !c.code && !waiting
  // the link gives way to the code's field, fading out of its slot
  const linkSlot = live(el("div", {}))
  const codeLink = showCodeLink ? el("div", { class: "sub-links" }, link("I have a code", () => codeEntry(codeArea, c, linkSlot))) : null
  if (c.codeError) codeArea.append(el("div", { class: "code-entry" }, el("span", { class: "label" }, "Your code"), el("div", { class: "line bad" }, icon("x"), c.codeError)))
  const removeCode = c.code ? el("div", { class: "sub-links" }, link("Remove the code", () => { update({ code: null }); session.setAppliedCode(null); checkoutPage() })) : null
  const slotLink = codeLink ?? removeCode
  if (slotLink) linkSlot.append(slotLink)
  if (held) go_.firstChild!.textContent = "Sending your order…"
  const holdNote = liveRegion()
  const side = sideCard(c, rows, codeArea, totalLine(c), waiting || held ? disabled(go_) : go_, holdNote, linkSlot,
    el("p", { class: "fine" }, icon("shield"), fromApp
      ? el("span", {}, "Registered to your app's wallet, ", el("span", { class: "nowrap" }, shortAddress(c.appOwner!)), ".")
      : "Registered to a wallet made in this browser; nobody else holds its key."),
    fromApp ? null : el("div", { class: "mini-invest" }, INVEST_LINE, el("br"), el("a", { href: WEFUNDER_URL, target: "_blank", rel: "noopener" }, "Learn more on Wefunder\u00a0↗")))
  page("search", [pageHead("Check your order", null, crumbs("Details", { fromApp, prepaid: c.code !== null })), twoCols(main, side)])
  // an order opened from the app is sent from here, so a wait met in this tab holds it as the code page's would
  if (fromApp && !waiting && !held) respectHold(go_, holdNote)
  if (waiting?.invoiceId) void settleWaiting(waiting, route)
  else if (!c.code) void showOpenOrder(paySec, route)
}

let watchedRoute = -1
const RETRY_MS = 3000

// The card order blocks a second one only while its invoice is open, so checkout follows it and opens up when it settles or closes.
async function settleWaiting(waiting: store.OrderRecord, mine: number): Promise<void> {
  if (watchedRoute === mine) return
  watchedRoute = mine
  const polls = new AbortController()
  whenLeaving(() => polls.abort())
  const release = () => {
    store.updateOrder(waiting.registrationId, { cardSubmittedAt: undefined })
    store.clearCardSubmitted(waiting.invoiceId!)
    watchedRoute = -1
    if (isRoute(mine)) checkoutPage()
  }
  let seen: api.InvoiceView | undefined
  while (isRoute(mine)) {
    try {
      seen = await api.readInvoice(waiting.invoiceId!, seen && { status: seen.status, phase: seen.registration.phase, paid: seen.cryptoAmountPaid ?? "", full: seen.paidInFull === true }, polls.signal)
    } catch (e) {
      // the service forgets an unpaid invoice some time after it closes; other errors are waited out
      if (e instanceof api.ApiError && e.code === "not_found") return release()
      if (polls.signal.aborted) return
      await new Promise((r) => setTimeout(r, e instanceof api.ApiError && e.retryAfter ? e.retryAfter * 1000 : RETRY_MS))
      continue
    }
    if (seen.status !== "open") return release()
  }
}

const OPEN_ORDER_LOOKBACK = 5
// a link preview with no answer is asked again after this long
const PREVIEW_RETRY_S = 3

// An unpaid invoice this browser made is pointed at, without blocking a new order. Only the newest few orders are asked
// about, so a long Your names list does not cost a request each.
async function showOpenOrder(paySec: HTMLElement, mine: number): Promise<void> {
  const recent = store.orders().filter((o) => o.invoiceId && !o.cancelled && !o.replacedBy).slice(0, OPEN_ORDER_LOOKBACK)
  const invoices = await Promise.all(recent.map((o) => api.readInvoice(o.invoiceId!).catch(() => null)))
  const at = invoices.findIndex((i) => i?.status === "open" && i.registration.phase === "unpaid")
  if (at < 0 || !isRoute(mine)) return
  const waiting = recent[at]
  const state = invoices[at]!.paidInFull ? "is confirming its payment" : "is waiting for its payment"
  paySec.querySelector(".open-order")?.replaceChildren(el("div", { class: "mb-14" }, alertBox("info", "clock", `${waiting.label}.${waiting.tld} ${state}`,
    el("a", { href: `/?order=${waiting.invoiceId}` }, "Open that order"))))
}

function codeEntry(area: HTMLElement, c: session.Checkout, linkSlot: HTMLElement): void {
  linkSlot.replaceChildren()
  const input = el("input", { type: "text", "aria-label": "Code", spellcheck: "false", placeholder: "SN6-…", autocomplete: "off" })
  const box = el("div", { class: "input code-input mt-8" }, icon("key"), input)
  const line = liveRegion()
  const route = currentRoute()
  watchCode(input, (v) => {
    if (!isRoute(route) || session.checkout()?.label !== c.label) return
    if (!v) {
      box.className = "input code-input mt-8"
      return showVerdict(line)
    }
    if (v.ok && c.label.length < v.code.minLength) {
      box.className = "input code-input mt-8 bad"
      return showVerdict(line, el("div", { class: "line bad" }, icon("x"), `This code covers names of ${v.code.minLength} or more letters; ${c.label} has ${c.label.length}.`))
    }
    box.className = `input code-input mt-8 ${v.ok ? "ok" : "bad"}`
    if (!v.ok) return showVerdict(line, verdictNode(v))
    if (!session.updateCheckout(c.label, { code: v.code, codeError: undefined })) return
    checkoutPage()
  })
  area.replaceChildren(el("div", { class: "code-entry" }, el("span", { class: "label" }, "Your code"), box, line))
  input.focus()
}

// The field's data-state says whether its link is "ok", "bad", or "empty"; save gets the link only when it is ok.
let linkFields = 0

export function linkField(kind: LinkKind, placeholder: string, label: string, value: string, save: (v: string) => void): HTMLElement {
  const errorId = `link-error-${++linkFields}`
  const input = el("input", { type: "text", placeholder, value, "aria-label": label, spellcheck: "false", autocomplete: "off" })
  const box = el("div", { class: "input" }, icon("link"), input, el("span", { class: "kind" }, label))
  const card = live(el("div", {}))
  const field = el("div", { class: "link-field" }, box, card)
  const route = currentRoute()
  let seq = 0
  // the card's place is held while the link is checked, so the page is laid out at its height from the start
  const holdCardPlace = () => {
    if (!current(card, ".skeleton")) card.replaceChildren(el("div", { class: "entity-wrap", "aria-hidden": "true" }, el("div", { class: "entity skeleton" })))
  }
  const refuse = (text: string) => {
    box.className = "input bad"
    field.dataset.state = "bad"
    input.setAttribute("aria-invalid", "true")
    input.setAttribute("aria-describedby", errorId)
    // the same refusal again, as typing on in a refused link gives, keeps still
    if (current(card, ".field-error")?.textContent !== text) card.replaceChildren(el("p", { class: "field-error", id: errorId }, icon("alert"), text))
  }
  const check = async () => {
    const mine = ++seq
    const link = input.value.trim()
    save("")
    box.className = "input"
    input.removeAttribute("aria-invalid")
    input.removeAttribute("aria-describedby")
    field.dataset.state = link ? "checking" : "empty"
    if (!link) return card.replaceChildren()
    // the value the field opened with is kept as it is, even several links set elsewhere or one whose preview fails
    if (link === value) {
      field.dataset.state = "ok"
      box.className = "input ok"
      save(link)
      if (value.includes(";")) return card.replaceChildren(el("p", { class: "sec-note mt-8" }, "Several links. SimpleX opens the first one."))
      holdCardPlace()
      const profile = await api.previewLink(link).catch(() => null)
      if (mine === seq && isRoute(route) && field.isConnected) card.replaceChildren(profile ? el("div", { class: "entity-wrap" }, entityCard({ ...profile, link }, false)) : "")
      return
    }
    const problem = linkProblem(kind, link)
    if (problem) {
      const other = linkKind(link)
      return refuse(problem === "long" ? "This link is too long."
        : other ? `This is a ${other === "contact" ? "contact address" : "channel"} link: paste it in the ${other === "contact" ? "Address" : "Channel"} field.`
        : `Paste a SimpleX ${kind === "contact" ? "contact address" : "channel"} short link.`)
    }
    holdCardPlace()
    try {
      const profile = await api.previewLink(link)
      // checkout redraws in place, so a field from an earlier draw must not save into the order
      if (mine !== seq || !isRoute(route) || !field.isConnected) return
      box.className = "input ok"
      field.dataset.state = "ok"
      save(link)
      card.replaceChildren(el("div", { class: "entity-wrap" }, entityCard({ ...profile, link }, false)))
    } catch (e) {
      if (mine !== seq || !isRoute(route) || !field.isConnected) return
      // the service refusing the link is about the link; a rate limit or no answer is not, and the field checks again
      if (!(e instanceof api.ApiError) || e.code === "network" || e.code === "rate_limited" || e.status >= 500) {
        const line = el("span", {})
        const notice = el("p", { class: "field-error", id: errorId }, icon("clock"), line)
        input.setAttribute("aria-describedby", errorId)
        waitOut(line, e instanceof api.ApiError && e.retryAfter ? e.retryAfter : PREVIEW_RETRY_S,
          (left) => `The link could not be checked now. Checking again in ${left}.`, () => { if (mine === seq) void check() })
        return card.replaceChildren(notice)
      }
      refuse("This link could not be opened.")
    }
  }
  input.addEventListener("input", () => void check())
  field.dataset.state = "empty"
  if (value) void check()
  return field
}

export function ownerCodePage(): void {
  const c = session.checkout()
  if (!c || c.appOwner) return redirect("/#/checkout")
  if (!c.ownerCode) session.setCheckout({ ...c, ownerCode: flow.newOwnerCode() })
  const draft = session.checkout()!
  const code = draft.ownerCode!
  store.addPending({ ownerCode: code, label: c.label, tld: c.chain.tld, createdAt: new Date().toISOString() })
  const box = el("input", { type: "checkbox", checked: draft.saved })
  const action = btn(draft.code ? "Register" : "Continue to payment", "lg block", () => void submitOrder(action), icon("arrow"))
  const held = session.isSending(draft)
  disabled(action, !draft.saved || held)
  if (held) action.firstChild!.textContent = "Sending your order…"
  const ready = () => box.checked && !session.isSending(draft) && !holding()
  box.addEventListener("change", () => {
    if (!session.updateCheckout(c.label, { saved: box.checked })) return redirect("/#/names")
    if (ready()) action.removeAttribute("disabled")
    else disabled(action)
  })
  const holdNote = liveRegion()
  respectHold(action, holdNote, () => { if (ready()) action.removeAttribute("disabled") })
  const copy = btn("Copy code", "quiet", () => void copyText(code, copy), icon("copy"))
  const rows: [string, string | Node][] = [["Term", termText(years(c))], ["Registered until", `about ${dateOf(untilFromNow(years(c)), true)}`],
    c.code ? ["Code", codeStart(c.code)] : ["Paying with", methodName(c.method)]]
  page("search", [pageHead("Save your name code", ["It will own ", nameText(c.label, c.chain.tld, "."), " If you lose it, nothing else can recover the name."], crumbs("Name code", { prepaid: c.code !== null })),
    twoCols(
      el("div", { class: "panel" }, el("div", { class: "panel-sec" },
        el("div", { class: "sec-title" }, el("h2", {}, "Your name code")),
        el("p", { class: "sec-note" }, "Copy it somewhere safe or write it down. You redeem it in the app later."),
        store.canPersist() ? null : el("div", { class: "mb-14" }, alertBox("warn", "alert", "This browser will not keep your name code", "Your saved copy will be the only one.")),
        el("div", { class: "code-display", "data-testid": "owner-code" }, code),
        el("div", { class: "code-actions" }, copy),
        el("label", { class: "check" }, box, el("span", { class: "box" }), "I have saved my code"))),
      sideCard(c, rows, totalLine(c), action, holdNote,
        el("div", { class: "why" },
          el("div", {}, icon("key"), "The code owns the name once registered."),
          el("div", {}, icon("shield"), "The service never sees it; nobody else has a copy."),
          el("div", {}, icon("refresh"), "It also finishes the order on another browser, if this one loses it."))))])
}

async function submitOrder(button: HTMLButtonElement): Promise<void> {
  const c = session.checkout()
  if (!c) return go("/#/names")
  if (session.isSending(c) || holding()) return
  // a card payment awaiting confirmation blocks a second paid order, from this page as from checkout; nothing is held
  if (!c.code && waitingCardOrder()) return go("/#/checkout")
  session.startSending(c)
  try {
    await sendOrder(button)
  } finally {
    session.stopSending(c)
  }
}

async function sendOrder(button: HTMLButtonElement): Promise<void> {
  const c = session.checkout()
  // a page left open while its order went through, in this tab or by Back and Forward, has nothing left to send
  if (!c) return go("/#/names")
  disabled(button)
  const fromApp = c.appOwner !== null
  const appSecret = fromApp ? c.appSecret ?? `0x${[...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("")}` : null
  if (fromApp && !c.appSecret) session.setCheckout({ ...c, appSecret })
  const draft: flow.Draft = {
    label: c.label, links: { contact: c.contact, channel: c.channel }, chain: c.chain, years: years(c), ownerCode: c.ownerCode,
    ...(fromApp ? { appOwner: c.appOwner!, appSecret: appSecret! } : {}),
  }
  // The order is kept whatever the buyer did meanwhile. Its checkout ends, and the order opens, only while this checkout
  // is still the tab's: the buyer may have started another name, by Back and Forward too.
  const mine = currentRoute()
  const search = searchLink(c.label, c.appOwner)
  const done = (url: string) => {
    const current = session.checkout()
    const ours = current?.label === c.label && current.ownerCode === c.ownerCode
    if (ours) {
      session.setCheckout(null)
      if (c.code) session.setAppliedCode(null)
    }
    if (!isRoute(mine) && !(ours && location.hash.startsWith("#/checkout"))) return
    // Back from the order returns to its search, still opened from the app, rather than to a checkout that has ended
    if (location.hash.startsWith("#/checkout")) history.replaceState(history.state, "", search)
    go(url)
  }
  let built: flow.BuiltOrder | null = null
  try {
    built = await flow.orderRequest(draft)
    if (c.code) {
      const res = await api.registerWithCode(built.request, c.code.display)
      if (res.invoiceId) return await openInvoice(draft, built, res.invoiceId, done)
      store.saveOrder({ ...flow.recordFor(draft, built, "code", 0, { registrationId: res.registrationId, invoiceId: null }), prepaidCode: c.code.display })
      return done(`/?registration=${res.registrationId}`)
    }
    const res = await api.createOrder(built.request, c.method, c.price)
    const { method, paid } = flow.paidWith(res)
    store.saveOrder(flow.recordFor(draft, built, method, paid, { registrationId: res.registration.id, invoiceId: res.invoiceId }))
    done(flow.orderUrl({ invoiceId: res.invoiceId, registrationId: res.registration.id }))
  } catch (e) {
    release(button)
    if (built && e instanceof api.ApiError && e.code === "bad_request" && typeof e.body.invoiceId === "string") return openInvoice(draft, built, e.body.invoiceId, done)
    // the order did not go: its checkout is open to change again before the error page sends the buyer back to it
    session.stopSending(c)
    // a rate limit holds the tab's actions wherever the buyer has gone meanwhile
    if (e instanceof api.ApiError && e.code === "rate_limited") startHold(e.retryAfter ?? api.LIMITED_WAIT_S)
    // as on success: the error shows where the buyer still is in this checkout, by Back and Forward too
    const ours = session.checkout()?.label === c.label && session.checkout()?.ownerCode === c.ownerCode
    if (isRoute(mine) || (ours && location.hash.startsWith("#/checkout"))) orderError(e, c)
  }
}

// This commitment already has an order, so this browser's code owns it: its record is kept before it opens.
async function openInvoice(draft: flow.Draft, built: flow.BuiltOrder, invoiceId: string, done: (url: string) => void): Promise<void> {
  const invoice = await api.readInvoice(invoiceId).catch(() => null)
  if (invoice) store.saveOrder(flow.recordFor(draft, built, invoice.cryptoCurrency ?? "card", invoice.amount, { registrationId: invoice.registration.id, invoiceId }))
  done(`/?order=${invoiceId}`)
}

function orderError(e: unknown, c: session.Checkout): void {
  const code = e instanceof api.ApiError ? e.code : "network"
  // an order sent from the checkout itself draws it again in place, so focus stays where it was
  const back = () => location.hash === "#/checkout" ? refresh() : go("/#/checkout")
  if (code === "name_taken") return go(searchLink(c.label, c.appOwner))
  if (code in CODE_ERRORS) {
    session.setCheckout({ ...c, code: null, codeError: CODE_ERRORS[code] })
    session.setAppliedCode(null)
    return back()
  }
  if (code === "provider_unavailable") {
    session.setCheckout({ ...c, unavailable: c.method, method: FALLBACK_METHOD[c.method] })
    return back()
  }
  if (code === "catalog_changed" && e instanceof api.ApiError && typeof e.body.price === "number") {
    session.setCheckout({ ...c, price: e.body.price as number })
    return page("search", [status("warn", "alert", "The price changed", [nameText(c.label, c.chain.tld), ` costs ${dollars(e.body.price as number, true)} now; it changed while you were deciding. Nothing was charged.`], [btn("Search again", "", () => go(searchLink(c.label, c.appOwner)))])])
  }
  if (code === "rate_limited") {
    // Back to an earlier step draws its action held for the rest of the wait, a longer one met meanwhile included
    startHold(e instanceof api.ApiError ? e.retryAfter ?? api.LIMITED_WAIT_S : api.LIMITED_WAIT_S)
    let left = holdLeft()
    const again = disabled(btn(`Try again in ${seconds(left)}`, "counting", back))
    const tick = setInterval(() => {
      left -= 1
      if (left <= 0) {
        clearInterval(tick)
        again.textContent = "Try again"
        again.removeAttribute("disabled")
      } else again.textContent = `Try again in ${seconds(left)}`
    }, 1000)
    whenLeaving(() => clearInterval(tick))
    page("search", [status("warn", "clock", "Too many attempts", "Too many orders were tried from here, so ordering is paused. Nothing was charged.", [again, btn("Back", "quiet", () => go(searchLink(c.label, c.appOwner)))])])
    // the button keeps the width of its longest line, so the count moves neither it nor the button beside it
    again.style.minWidth = `${again.offsetWidth}px`
    return
  }
  // the same order is sent again from here; Back leaves it for the search
  const retry = btn("Try again", "", () => void submitOrder(retry))
  page("search", [status("bad", "alert", "That did not go through", "Nothing was charged. If this happens again, get in touch.", [retry, btn("Back", "quiet", () => go(searchLink(c.label, c.appOwner)))])])
}
