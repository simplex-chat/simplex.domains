// The prepaid code popup: check a code, use it on search, or add it to Your names.
import * as api from "../api.ts"
import { codeProgress, parseNameCode } from "../crypto/code.ts"
import { seconds } from "../format.ts"
import { btn, disabled, el, icon, liveRegion } from "../dom.ts"
import * as session from "../session.ts"
import * as store from "../store.ts"
import { checkoutPage } from "./checkout.ts"
import { shownSearch } from "./search.ts"
import { closePopup, go, popup, refresh } from "./shell.ts"

export type CodeVerdict =
  | { ok: true; code: session.AppliedCode; line: string }
  | { ok: false; title: string; line: string }

const FROM_APP = "An order opened from SimpleX is paid here, not with a code."

const STATE_LINES: Record<Exclude<api.CodeState, "unused">, [string, string]> = {
  reserved: ["This code is being used for a name now", "Each code registers one name; this one is held by an unfinished registration."],
  used: ["This code was already used", "Each code registers one name."],
  revoked: ["This code is not valid", "SimpleX withdrew it, so it cannot be used."],
  expired: ["This code has expired", "It can no longer register a name."],
  unpaid: ["This code is not paid for yet", "It works once its payment is confirmed."],
}

// what the service's code errors at checkout say, where the code was entered
export const CODE_ERRORS: Record<string, string> = {
  code_invalid: "This code is not valid.",
  code_used: "This code was already used.",
  code_reserved: "This code is being used for a name now.",
  code_expired: "This code has expired.",
  payment_pending: "This code is not paid for yet.",
  code_not_covering: "This code does not cover this name.",
}

function covers(code: session.AppliedCode): string {
  return `Covers names of ${code.minLength} or more letters, for ${code.years} years.`
}

const MISTYPED: CodeVerdict = { ok: false, title: "This code is not valid", line: "Check it for a mistyped character." }

// A typo or an owner code is answered on the page; anything else asks the service, which spends nothing.
export async function judgeCode(text: string): Promise<CodeVerdict> {
  const parsed = parseNameCode(text)
  if (parsed === null) return MISTYPED
  if (parsed.kind === "owner") return { ok: false, title: "This is a name code", line: "It owns a name. Restore it in Your names." }
  try {
    const answer = await api.checkCode(parsed.display)
    if (answer.state === "unused") {
      const code = { display: parsed.display, minLength: answer.minLength, years: answer.years }
      return { ok: true, code, line: covers(code) }
    }
    const [title, line] = STATE_LINES[answer.state]
    return { ok: false, title, line }
  } catch (e) {
    // well formed but unknown to the service: not a typo, which the check digit would have caught
    if (e instanceof api.ApiError && e.code === "code_invalid") return { ok: false, title: "This code is not valid", line: "SimpleX did not issue it, or withdrew it." }
    if (e instanceof api.ApiError && e.code === "rate_limited") return { ok: false, title: "Too many checks just now", line: `Your code may be fine. Try again in ${seconds(e.retryAfter ?? api.LIMITED_WAIT_S)}.` }
    return { ok: false, title: "The code could not be checked", line: "Try again in a moment." }
  }
}

// The pause after the last key before a code typed in full is judged; one pasted whole is judged at once.
const JUDGE_PAUSE_MS = 400

// A code field judged as it is typed: no verdict while the code is on its way, a character no code has at once, and a
// code long enough to judge once typing pauses. show gets null while there is nothing to say.
export function watchCode(input: HTMLInputElement, show: (v: CodeVerdict | null) => void): void {
  let seq = 0
  let pause: ReturnType<typeof setTimeout> | undefined
  const judge = async (mine: number) => {
    const v = await judgeCode(input.value.trim())
    if (mine === seq && input.isConnected) show(v)
  }
  input.addEventListener("input", (e) => {
    const mine = ++seq
    clearTimeout(pause)
    const progress = codeProgress(input.value)
    if (progress === "empty" || progress === "partial") return show(null)
    if (progress === "impossible") return show(MISTYPED)
    if ((e as InputEvent).inputType === "insertFromPaste") void judge(mine)
    else pause = setTimeout(() => void judge(mine), JUDGE_PAUSE_MS)
  })
}

// A verdict the field already shows keeps still rather than fading in again at each key.
export function showVerdict(part: HTMLElement, ...nodes: (Node | string)[]): void {
  const shown = [...part.childNodes].filter((n) => !(n instanceof Element && n.classList.contains("outgoing"))).map((n) => n.textContent).join("")
  if (shown !== nodes.map((n) => typeof n === "string" ? n : n.textContent).join("")) part.replaceChildren(...nodes)
}

export function verdictNode(v: CodeVerdict): HTMLElement {
  return v.ok
    ? el("div", { class: "verdict ok" }, icon("check"), el("div", {}, el("b", {}, "Unused"), el("span", {}, v.line)))
    : el("div", { class: "verdict bad" }, icon("x"), el("div", {}, el("b", {}, v.title), el("span", {}, v.line)))
}

export function codePopup(mode: "check" | "add" = "check"): void {
  const input = el("input", { type: "text", "aria-label": "Code", spellcheck: "false", placeholder: "SN6-…", autocomplete: "off" })
  const box = el("div", { class: "input code-input" }, icon("key"), input)
  const verdict = liveRegion()
  let current: CodeVerdict | null = null
  const action = disabled(btn(mode === "add" ? "Add to your codes" : "Use this code", "block", () => {
    if (!current?.ok) return
    if (mode === "add") {
      store.addCode({ code: current.code.display, minLength: current.code.minLength, years: current.code.years, addedAt: new Date().toISOString() })
      // the list is drawn again first, so focus lands on the redrawn page rather than on a button it replaced
      refresh()
      return closePopup()
    }
    const refusal = applyCode(current.code)
    if (refusal) return void verdict.replaceChildren(verdictNode({ ok: false, title: "Not for this order", line: refusal }))
    closePopup()
  }))
  const restore = el("a", { href: "/#/restore", class: "restore-link", onclick: () => closePopup() }, "Restore in Your names")
  // the last verdict belongs to the last text: nothing is applied until this one is judged
  input.addEventListener("input", () => {
    current = null
    disabled(action)
  })
  watchCode(input, (judged) => {
    if (!judged) {
      box.className = "input code-input"
      return showVerdict(verdict)
    }
    // a code already listed is said so, rather than offered for adding again
    const listed = mode === "add" && judged.ok && store.codes().some((c) => c.code === judged.code.display)
    const v: CodeVerdict = listed ? { ok: false, title: "Already in your codes", line: "It is listed under Codes in Your names." } : judged
    current = v
    box.className = `input code-input ${v.ok ? "ok" : "bad"}`
    showVerdict(verdict, verdictNode(v), !v.ok && v.title === "This is a name code" ? restore : "")
    if (v.ok) action.removeAttribute("disabled")
  })
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return
    // the key's own press would land on the opener that closing the popup focuses, opening it again
    e.preventDefault()
    action.click()
  })
  popup(el("div", { class: "modal", role: "dialog", "aria-label": mode === "add" ? "Add a code" : "Check your code" },
    el("div", { class: "modal-head" },
      el("h3", {}, mode === "add" ? "Add a code" : "Check your code"),
      el("a", { class: "icon-btn", href: "#", "aria-label": "Close", onclick: (e: Event) => { e.preventDefault(); closePopup() } }, icon("x"))),
    el("p", { class: "sec-note" }, "A code from SimpleX, for example for investors. Nothing is spent until a name is registered with it."),
    box, verdict, action))
  input.focus()
}

// A code is used where the buyer is: the checkout in progress takes it, the search applies it to the names it
// covers, and anywhere else leads to search. Returns why the page cannot take it.
function applyCode(code: session.AppliedCode): string | null {
  const c = session.checkout()
  if (c && location.hash.startsWith("#/checkout")) {
    if (c.appOwner) return FROM_APP
    if (session.isSending(c)) return "This order is on its way already; the code can pay for your next name."
    if (c.label.length < code.minLength) return `This code covers names of ${code.minLength} or more letters; ${c.label} has ${c.label.length}.`
    session.updateCheckout(c.label, { code, codeError: undefined })
    session.setAppliedCode(code)
    // on the checkout itself it draws in place, as its own code entry does, so links still being checked are kept
    if (location.hash === "#/checkout") checkoutPage()
    else go("/#/checkout")
    return null
  }
  // an order's page has its own query and no hash
  const onSearch = location.search === "" && (location.hash === "" || location.hash === "#/" || location.hash.startsWith("#/?"))
  const search = onSearch ? shownSearch() : null
  if (search?.fromApp) return FROM_APP
  if (search?.retarget) return "Your paid order covers the name you move it to; no code is needed."
  session.setAppliedCode(code)
  if (search) refresh()
  else go("/#/")
  return null
}

export function useCode(code: store.CodeRecord): void {
  session.setAppliedCode({ display: code.code, minLength: code.minLength, years: code.years })
  go("/#/")
}
