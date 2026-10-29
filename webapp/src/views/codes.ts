// The code field of Check your code, judged as it is typed: a prepaid code that registers a free name, or a name code that owns one.
import * as api from "../api.ts"
import { codeProgress, mayBeOwnerCode, parseNameCode } from "../crypto/code.ts"
import { el, icon, liveRegion, NO_AUTOFILL, refill, waitOut } from "../dom.ts"
import * as flow from "../flow.ts"
import type * as session from "../session.ts"
import * as store from "../store.ts"
import { holdFrom } from "./hold.ts"
import { scanButton, scanQr } from "./scan.ts"
import { kept, whenDropped } from "./shell.ts"

export type CodeVerdict =
  | { kind: "prepaid"; code: session.AppliedCode; line: string }
  | { kind: "owner"; found: flow.CodeOrder; line: string }
  | { kind: "refused"; title: string; line: string; link?: string; checkAgainIn?: number }

export const STATE_LINES: Record<Exclude<api.CodeState, "unused">, [string, string]> = {
  reserved: ["This code is being used for a name now", "Each code registers one name; this one is held by an unfinished registration."],
  used: ["This code was already used", "Each code registers one name."],
  revoked: ["This code is not valid: SimpleX withdrew it", ""],
  expired: ["This code has expired", "It can no longer register a name."],
  unpaid: ["This code is not paid for yet", "It works once its payment is confirmed."],
}

// what codes-only mode says, until the full launch opens payments
export const CODES_ONLY_TITLE = "Registration is by code only for now"
export const CODES_ONLY_LINE = "Names can be registered with an investor code for now."

const NOT_COVERING = "This code does not cover this name"

// the service's refusals of a code an order carried
export const CODE_ERRORS: Record<string, string> = {
  code_invalid: "This code is not valid.",
  code_used: "This code was already used.",
  code_reserved: "This code is being used for a name now.",
  code_expired: "This code has expired.",
  payment_pending: "This code is not paid for yet.",
  code_not_covering: `${NOT_COVERING}.`,
}

const coversLine = (code: session.AppliedCode) => `This code allows you to register a free name of ${code.minLength} or more letters, for ${code.years} years.`
const unused = (code: session.AppliedCode): CodeVerdict => ({ kind: "prepaid", code, line: coversLine(code) })
const notCovering = (code: session.AppliedCode): CodeVerdict => ({ kind: "refused", title: NOT_COVERING, line: `It covers names of ${code.minLength} or more letters.` })
// a name code where a prepaid code pays for one name
const NAME_CODE: CodeVerdict = { kind: "refused", title: "This is a name code", line: "A code from SimpleX lets you register a free name." }

const MISTYPED: CodeVerdict = { kind: "refused", title: "This code is not valid", line: "Check it for a mistyped character." }
const NO_CAMERA: CodeVerdict = { kind: "refused", title: "The camera could not be used", line: "Allow the camera, or paste the code." }
const SCAN_HINT = "Point the camera at the QR code of your name code."
const UNFINISHED: CodeVerdict = { kind: "refused", title: "This is not a SimpleX names code", line: "Check it and try again." }

const ownerLine = (name: string) => `Name code of ${name}.simplex. Adding it shows the name in Your names, where you can edit its links.`

// A refusal that asking again can change: a rate limit, after whose wait the code is checked again, or a service that did not answer.
function notChecked(e: unknown): CodeVerdict {
  if (e instanceof api.ApiError && e.code === "rate_limited") {
    return { kind: "refused", title: "Too many checks just now", line: "Your code may be fine.", checkAgainIn: e.retryAfter ?? api.LIMITED_WAIT_S }
  }
  return { kind: "refused", title: "The code could not be checked", line: "Try again in a moment." }
}

// A name code is named by the order it restores, which only the code opens; a rate limit holds the tab's lookups too.
async function judgeNameCode(text: string): Promise<CodeVerdict> {
  try {
    const found = await flow.codeOrderOf(text)
    if (!found) return { kind: "refused", title: "This code does not open the order", line: "The order found for it was made with another code." }
    return { kind: "owner", found, line: ownerLine(found.name) }
  } catch (e) {
    if (e instanceof api.ApiError && e.code === "not_found") return { kind: "refused", title: "No order was found for this code", line: "The service has no order registered to its wallet." }
    holdFrom(e)
    return notChecked(e)
  }
}

// A typo is answered on the page; a prepaid code asks the service, which spends nothing, and a name code finds its orders.
// A field for one name's order takes only a prepaid code that covers that name.
async function judgeCode(text: string, signal: AbortSignal, forName?: string): Promise<CodeVerdict> {
  const parsed = parseNameCode(text)
  if (parsed === null) return MISTYPED
  if (parsed.kind === "owner") return forName === undefined ? judgeNameCode(text) : NAME_CODE
  try {
    const answer = await api.checkCode(parsed.display, signal)
    if (answer.state === "unused") {
      const code = { display: parsed.display, minLength: answer.minLength, years: answer.years }
      return forName !== undefined && forName.length < code.minLength ? notCovering(code) : unused(code)
    }
    const [title, line] = STATE_LINES[answer.state]
    // the service names no order for a code in use; this browser's own order that holds it is linked
    const holder = answer.state === "reserved" ? store.orders().find((o) => o.prepaidCode === parsed.display) : undefined
    return { kind: "refused", title, line, link: holder && store.orderUrl(holder) }
  } catch (e) {
    // well formed but unknown to the service: not a typo, which the check digit would have caught
    if (e instanceof api.ApiError && e.code === "code_invalid") return { kind: "refused", title: "This code is not valid: SimpleX did not issue it", line: "" }
    return notChecked(e)
  }
}

// The pause after the last key before a code typed in full is judged; one pasted whole is judged at once.
const JUDGE_PAUSE_MS = 400

// Each edit says nothing until its own verdict; a character no code has is refused at once, and a code long enough is
// judged once typing pauses, and again once a wait the service asked for is over. One too short is refused once the
// reader is done: on Enter, or as focus leaves the field for the page, not for another window. Nothing is judged once the
// signal ends. The returned check judges the code at once.
function watchCode(input: HTMLInputElement, show: (v: CodeVerdict | null) => void, signal: AbortSignal, forName?: string): () => void {
  let seq = 0
  let pause: ReturnType<typeof setTimeout> | undefined
  const forget = () => {
    seq += 1
    clearTimeout(pause)
  }
  signal.addEventListener("abort", forget, { once: true })
  const judge = async (mine: number) => {
    const v = await judgeCode(input.value.trim(), signal, forName)
    if (mine !== seq || signal.aborted) return
    show(v)
    if (v.kind === "refused" && v.checkAgainIn) pause = setTimeout(() => void judge(mine), v.checkAgainIn * 1000)
  }
  input.addEventListener("input", (e) => {
    forget()
    const mine = seq
    const progress = codeProgress(input.value)
    if (progress === "impossible") return show(MISTYPED)
    show(null)
    if (progress === "empty" || progress === "partial") return
    if ((e as InputEvent).inputType === "insertFromPaste") void judge(mine)
    else pause = setTimeout(() => void judge(mine), JUDGE_PAUSE_MS)
  })
  const done = () => {
    if (signal.aborted || codeProgress(input.value) !== "partial") return
    forget()
    show(UNFINISHED)
  }
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") done() })
  // Chromium blurs the field as a redraw moves it, and the redraw gives focus back before the check
  input.addEventListener("blur", () => queueMicrotask(() => { if (document.activeElement !== input && document.hasFocus()) done() }))
  return () => {
    if (signal.aborted || codeProgress(input.value) !== "complete") return done()
    forget()
    void judge(seq)
  }
}

const said = (v: CodeVerdict) => v.kind !== "refused" ? v.line : v.line ? `${v.title}. ${v.line}` : `${v.title}.`
// what was typed in a field, by its key, shown and judged again when its page is opened again
const typed = new Map<string, string>()

// `heard` hears each verdict, and nothing while the code is being typed. A field for an order takes only a prepaid code
// that covers its name, and starts with the order's code, if any, when nothing was typed there.
export function codeField(key: string, label: string, heard: (v: CodeVerdict | null) => void, order?: { name: string; code?: string }): HTMLElement {
  return kept(key, () => {
    const verdictId = `${key}-verdict`
    const input = el("input", { type: "text", "aria-label": label, "aria-describedby": verdictId, placeholder: "SN…", ...NO_AUTOFILL,
      value: typed.get(key) ?? order?.code })
    const check = el("button", { class: "btn lens", type: "button", "aria-label": "Check" }, icon("key"))
    // a phone with a camera reads the code from its QR code, as another device shows it
    const scan = scanButton(() => void scanned())
    const box = el("label", { class: "field code-input" }, input, scan, check)
    const line = liveRegion("verdict")
    line.id = verdictId
    const life = new AbortController()
    whenDropped(() => life.abort())
    // the count of the verdict shown, which the next one ends
    let counting = new AbortController()
    life.signal.addEventListener("abort", () => counting.abort(), { once: true })
    const show = (v: CodeVerdict | null) => {
      const tone = v === null ? "" : v.kind === "refused" ? " bad" : " ok"
      box.className = `field code-input${tone}`
      line.className = `verdict${tone}`
      counting.abort()
      counting = new AbortController()
      if (v?.kind === "refused" && v.checkAgainIn) {
        const count = el("span", {})
        refill(line, count)
        waitOut(count, v.checkAgainIn, (left) => `${said(v)} Checking again in ${left}.`, () => undefined, counting.signal)
      } else refill(line, v && said(v), v?.kind === "refused" && v.link ? [" ", el("a", { href: v.link }, "Open that order")] : null)
      heard(v)
    }
    check.addEventListener("click", watchCode(input, show, life.signal, order?.name))
    // one scan at a time, ended with the field's page; a code read is judged at once, as a pasted one is
    async function scanned(): Promise<void> {
      scan.disabled = true
      try {
        const text = await scanQr(life.signal, SCAN_HINT)
        if (text !== null) {
          input.value = text.trim()
          input.dispatchEvent(new InputEvent("input", { inputType: "insertFromPaste" }))
        }
      } catch {
        if (!life.signal.aborted) show(NO_CAMERA)
      } finally {
        scan.disabled = false
      }
      if (!life.signal.aborted) input.focus()
    }
    // a name code is never kept to show again, nor most of one mistyped or cut short, as anyone who sees it can take the name
    input.addEventListener("input", () => {
      if (mayBeOwnerCode(input.value)) typed.delete(key)
      else typed.set(key, input.value)
    })
    // judged once the page that asked for the field is drawn, as a verdict may change the page
    if (input.value) queueMicrotask(() => input.dispatchEvent(new Event("input")))
    return el("div", { class: "code-entry" }, box, line)
  })
}
