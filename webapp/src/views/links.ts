// The link field that the Links step and Edit links share: one field for either kind of link, each checked as it is typed and
// shown with its profile, and a second field for the other kind once the first holds a link.
import * as api from "../api.ts"
import { el, icon, link, NO_AUTOFILL, refill, waitOut } from "../dom.ts"
import { type LinkKind, linkKind, linkProblem, linkTooLong } from "../names.ts"
import { chatButton, profileLine } from "./chats.ts"
import { scanButton, scanQr } from "./scan.ts"
import { inPlace, whenDropped } from "./shell.ts"

// a phone's field, beside Paste and the scan button, has room for a short placeholder only
const KIND_TEXT: Record<LinkKind, { name: string; noun: string; placeholder: string; short: string; add: string }> = {
  contact: { name: "Contact address", noun: "contact address", placeholder: "Paste your contact address", short: "Your contact address", add: "Add a contact address" },
  channel: { name: "Channel", noun: "channel link", placeholder: "Paste your channel link", short: "Your channel link", add: "Add a channel link" },
}
const ANY_LINK = { name: "Link", placeholder: "Paste a contact address or channel link", short: "Contact or channel link" }
const ANY_LINK_SCANNED = "Paste or scan a link"
// styles.css's phone layout
const PHONE = "(max-width: 520px)"
const NO_CAMERA = "Allow the camera, or paste the link."
const SCAN_HINT = "Point the camera at the QR code of your SimpleX address or channel link."
const NOT_A_LINK = "This is not a SimpleX contact address or channel link."
const linkName = (kind: LinkKind) => KIND_TEXT[kind].name
const otherKind = (kind: LinkKind): LinkKind => kind === "contact" ? "channel" : "contact"

let linkFields = 0
// a link's profile as shown, so a field or a review drawn again for it shows it at once
const previews = new Map<string, api.Profile>()
const PREVIEW_RETRY_S = 3
// each field's wait for the check of its link to end, which a Save or Continue pressed meanwhile waits on
const checksEnded = new WeakMap<HTMLElement, () => Promise<void>>()
type FieldState = "ok" | "bad" | "checking" | "empty"

// a preview's place is held while it is asked for, so the page is laid out at its height from the start
const previewPlace = () => el("div", { class: "entity skeleton", "aria-hidden": "true" })

// a link's profile, named by its link, so that what a field shows can be told from what it holds
function linkLine(link: string, profile: api.Profile, withKind: boolean): HTMLElement {
  const line = profileLine(profile, withKind)
  line.dataset.link = link
  return line
}

// The place is the link's own: a field checking another link drops it rather than take it over, so a late answer
// fills a place no longer shown.
function linkPreview(link: string, withKind = false): HTMLElement {
  const known = previews.get(link)
  if (known) return linkLine(link, known, withKind)
  const place = previewPlace()
  place.dataset.link = link
  void api.previewLink(link).then((profile) => {
    previews.set(link, profile)
    place.replaceWith(inPlace(linkLine(link, profile, withKind)))
  }, () => place.replaceWith(el("span", { class: "raw" }, link)))
  return place
}

// The chat a link of `kind` opens, as the search's answer draws it, opening its popup; its place is held while its profile
// is asked for, and a profile that cannot be read is drawn as the kind's default picture, named by the link.
export function linkChat(link: string, kind: LinkKind, name: string, key: string): HTMLElement {
  const button = (p: api.Profile) => chatButton({ ...p, link, deepLink: link }, name, key)
  const known = previews.get(link)
  if (known) return button(known)
  const place = el("span", { class: "chat skeleton", "aria-hidden": "true" })
  const unread: api.Profile = { type: kind === "contact" ? "address" : "channel", kind, displayName: link, fullName: "", image: null, subscribers: null, profile: "unread" }
  void api.previewLink(link).then((p) => {
    previews.set(link, p)
    place.replaceWith(inPlace(button(p)))
  }, () => place.replaceWith(inPlace(button(unread))))
  return place
}

// What a field takes: a link of its kind, or of either kind, less a kind another field holds; `fieldOf` names the field for a kind,
// and `filled` tells whether the other field already holds a link of a kind.
interface Takes { kind: LinkKind | null; refused: () => LinkKind | null; fieldOf: (kind: LinkKind) => string; filled: (kind: LinkKind) => boolean }

// data-state is "ok", "bad", "checking" or "empty"; save hears each good link with its kind and the field emptied, never one checked or refused.
// `valueKind` is the record `value` came from, which a value kept as it is, such as several links, keeps.
function linkField(takes: Takes, value: string, save: (v: string, kind: LinkKind | null) => void, valueKind = takes.kind): HTMLElement {
  const errorId = `link-error-${++linkFields}`
  const text = takes.kind ? KIND_TEXT[takes.kind] : ANY_LINK
  const input = el("input", { type: "text", value, "aria-label": text.name, ...NO_AUTOFILL, "data-focus": `link-${takes.kind ?? "any"}` })
  // a phone's field has room for the short placeholder only, chosen again as the window crosses the phone's width
  const phone = matchMedia(PHONE)
  let camera = false
  const placeholder = () => { input.placeholder = !phone.matches ? text.placeholder : camera && !takes.kind ? ANY_LINK_SCANNED : text.short }
  placeholder()
  // the profile a link opens shows at the field's end, and what is wrong with a link under it
  const preview = el("span", { class: "preview" })
  const unlink = el("button", { class: "unlink", type: "button", "aria-label": "Remove link", onclick: () => {
    input.value = ""
    input.dispatchEvent(new Event("input"))
    input.focus()
  } }, icon("close"))
  // an empty field offers the link copied in the app, where the browser lets the page read what was copied
  const paste = navigator.clipboard?.readText ? el("button", { class: "field-copy paste", type: "button", onclick: () => {
    navigator.clipboard.readText().then((text) => {
      input.value = text.trim()
      input.dispatchEvent(new Event("input"))
    }, () => undefined).finally(() => input.focus())
  } }, "Paste") : null
  // a phone with a camera reads the link from its QR code, as the app shows it
  const scan = scanButton(() => void scanned(), (found) => {
    camera = found
    placeholder()
  })
  const box = el("label", { class: "field" }, icon("link"), input, preview, paste, scan, unlink)
  const card = el("div", {})
  const field = el("div", { class: "link-field" }, box, card)
  const show = (inField: Node | null, below: Node | null = null) => {
    refill(preview, inField)
    refill(card, below)
  }
  // the field lives as long as the route keeps it; a check started anew ends the last one's wait
  const life = new AbortController()
  let waiting = new AbortController()
  let ended: (() => void)[] = []
  const endChecks = () => {
    for (const end of ended) end()
    ended = []
  }
  const setState = (state: FieldState) => {
    field.dataset.state = state
    if (state !== "checking") endChecks()
  }
  checksEnded.set(field, () => field.dataset.state === "checking" && !life.signal.aborted ? new Promise((done) => ended.push(done)) : Promise.resolve())
  whenDropped(() => { life.abort(); waiting.abort(); endChecks() })
  phone.addEventListener("change", placeholder, { signal: life.signal })
  const shown = () => !life.signal.aborted
  let seq = 0
  // the field's own place is kept from check to check, whose answers only the latest may fill; another link's is not
  const holdPreviewPlace = () => show(preview.querySelector(".skeleton:not([data-link])") ?? previewPlace())
  const refuse = (text: string) => {
    box.className = "field bad"
    setState("bad")
    input.setAttribute("aria-invalid", "true")
    input.setAttribute("aria-describedby", errorId)
    // the same refusal again, as typing on in a refused link gives, keeps still
    if (card.querySelector(".field-error")?.textContent !== text) show(null, el("p", { class: "field-error", id: errorId }, text))
  }
  const check = async () => {
    const mine = ++seq
    waiting.abort()
    waiting = new AbortController()
    const link = input.value.trim()
    box.className = "field"
    input.removeAttribute("aria-invalid")
    input.removeAttribute("aria-describedby")
    setState(link ? "checking" : "empty")
    if (!link) {
      save("", null)
      return show(null)
    }
    // the value the field opened with, or the chain's given since, is kept as it is, even several links or one whose preview fails
    const kept = field.dataset.kept ?? value
    const keptKind = (field.dataset.keptKind as LinkKind | undefined) ?? valueKind
    const kind = takes.kind ?? (link === kept ? keptKind : null) ?? linkKind(link)
    const accept = () => {
      setState("ok")
      save(link, kind)
    }
    const known = previews.get(link)
    if (link === kept) {
      accept()
      return kept.includes(";") ? show(null, el("p", { class: "note" }, "Several links. SimpleX opens the first one.")) : show(linkPreview(link, true))
    }
    // a link too long has no kind, so the Link field, which takes either, says it is too long first
    const problem = kind ? linkProblem(kind, link) : linkTooLong(link) ? "long" : "kind"
    const held = kind !== null && kind === takes.refused() ? kind : null
    if (problem || held) {
      const other = held ?? linkKind(link)
      return refuse(problem === "long" ? "This link is too long."
        : other && takes.filled(other) ? `This is a ${KIND_TEXT[other].noun}. Paste a ${KIND_TEXT[otherKind(other)].noun} here.`
        : other ? `This is a ${linkName(other).toLowerCase()} link: paste it in the ${takes.fieldOf(other)} field.`
        : takes.kind ? `Paste a SimpleX ${linkName(takes.kind).toLowerCase()} short link.` : NOT_A_LINK)
    }
    if (known) {
      accept()
      return show(linkLine(link, known, true))
    }
    holdPreviewPlace()
    try {
      const profile = await api.previewLink(link)
      previews.set(link, profile)
      if (mine !== seq || !shown() || !field.isConnected) return
      accept()
      show(inPlace(linkLine(link, profile, true)))
    } catch (e) {
      if (mine !== seq || !shown() || !field.isConnected) return
      // the service refusing the link is about the link; a rate limit or no answer is not, and the field checks again
      if (!(e instanceof api.ApiError) || e.code === "network" || e.code === "rate_limited" || e.status >= 500) {
        const line = el("span", {})
        const notice = el("p", { class: "field-error", id: errorId }, icon("clock"), line)
        input.setAttribute("aria-describedby", errorId)
        waitOut(line, e instanceof api.ApiError && e.retryAfter ? e.retryAfter : PREVIEW_RETRY_S,
          (left) => `The link could not be checked now. Checking again in ${left}.`, () => { if (mine === seq) void check() }, waiting.signal)
        return show(null, notice)
      }
      refuse("This link could not be opened.")
    }
  }
  // one scan at a time, ended with the field's page
  async function scanned(): Promise<void> {
    let text: string | null
    scan.disabled = true
    try {
      text = await scanQr(life.signal, SCAN_HINT)
    } catch {
      if (!shown()) return
      input.setAttribute("aria-describedby", errorId)
      return show(null, el("p", { class: "field-error", id: errorId }, NO_CAMERA))
    } finally {
      scan.disabled = false
    }
    if (!shown()) return
    if (text !== null) {
      input.value = text.trim()
      input.dispatchEvent(new Event("input"))
    }
    input.focus()
  }
  input.addEventListener("input", () => void check())
  // the link is left at its start, where focus brings it back, as a browser shows a field from its last caret and scroll
  input.addEventListener("blur", () => { input.setSelectionRange(0, 0); input.scrollLeft = 0 })
  setState("empty")
  if (value) void check()
  return field
}

export interface LinkFields {
  node: HTMLElement
  fields: () => HTMLElement[]
  // puts a link the chain holds into the field for its kind, as the field's own
  show: (kind: LinkKind, link: string) => void
}

// One field takes a link of either kind; once it holds one, a text link adds a field for the other kind. `save` hears
// each kind's link as it changes, and nothing for the links the fields open with.
export function linkFieldsFor(links: api.Links, save: (kind: LinkKind, link: string) => void): LinkFields {
  const first: LinkKind = links.contact || !links.channel ? "contact" : "channel"
  // the kind the first field holds, and the second field's, once added
  let held: LinkKind | null = links[first] ? first : null
  let second: { kind: LinkKind; field: HTMLElement } | null = null
  let opening = true
  const told = (kind: LinkKind, link: string) => { if (!opening) save(kind, link) }
  const fieldOf = (kind: LinkKind) => second?.kind === kind ? linkName(kind) : ANY_LINK.name
  const add = link("", () => addSecond(otherKind(held!), "", true))
  const node = el("div", { class: "link-fields" })
  const offerAdd = () => {
    add.hidden = held === null || second !== null
    if (held) add.textContent = KIND_TEXT[otherKind(held)].add
  }
  const accepted = (field: HTMLElement | undefined) => field?.dataset.state === "ok"
  const firstField = linkField({ kind: null, refused: () => second?.kind ?? null, fieldOf, filled: (kind) => second?.kind === kind && accepted(second.field) }, links[first], (value, kind) => {
    if (held && held !== kind) told(held, "")
    if (kind) told(kind, value)
    held = kind ?? (second ? held : null)
    offerAdd()
  }, first)
  const addSecond = (kind: LinkKind, value: string, focus: boolean) => {
    const field = linkField({ kind, refused: () => null, fieldOf, filled: (other) => held === other && accepted(firstField) }, value, (v) => told(kind, v))
    second = { kind, field }
    add.before(field)
    offerAdd()
    if (focus) field.querySelector("input")!.focus()
  }
  node.append(firstField, add)
  if (links.contact && links.channel) addSecond("channel", links.channel, false)
  offerAdd()
  opening = false
  const fieldFor = (kind: LinkKind) => second?.kind === kind ? second.field : held === kind || held === null ? firstField : null
  return {
    node,
    fields: () => [firstField, ...(second ? [second.field] : [])],
    show: (kind, value) => {
      let field = fieldFor(kind)
      if (!field) {
        if (!value) return
        addSecond(kind, value, false)
        field = second!.field
      }
      const input = field.querySelector("input")!
      if (input.value === value) return
      field.dataset.kept = value
      field.dataset.keptKind = kind
      input.value = value
      input.dispatchEvent(new Event("input", { bubbles: true }))
    },
  }
}

// what a Save or Continue waiting for a link's check says
export const CHECKING_LINK = "Checking link…"

// Waits for the links being checked, after telling `waiting` that it must, then gives focus to a field still refused or
// checking; true when none is.
export async function linksSettled(fields: HTMLElement[], waiting: () => void): Promise<boolean> {
  if (fields.some((f) => f.dataset.state === "checking")) waiting()
  await Promise.all(fields.map((f) => checksEnded.get(f)?.()))
  const unsettled = fields.find((f) => f.dataset.state === "bad" || f.dataset.state === "checking")
  unsettled?.querySelector("input")!.focus()
  return unsettled === undefined
}
