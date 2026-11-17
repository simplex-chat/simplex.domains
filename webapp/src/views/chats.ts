// The chats a name opens, drawn as the app draws them: its default pictures, and its connection alert as a popup.
import type * as api from "../api.ts"
import { copyButton, el } from "../dom.ts"
import { chatIcon } from "../icons.ts"
import { qrSvg } from "../qr.ts"
import { POPUP_TITLE, showPopup } from "./shell.ts"

const KIND_NAMES: Record<api.ChatKind, string> = { contact: "Contact address", channel: "Channel", business: "Business address", bot: "Bot" }
// links from the service come from records on chain, which anyone can write: only SimpleX and https links are followed
const SAFE_LINK = /^(simplex:\/|https:\/\/)/
// a profile the service did not read shows the kind's default picture, and no name
export const chatPicture = (p: api.Profile) => el("span", { class: "chat-pic" }, p.profile === "ok" && p.image ? el("img", { src: p.image, alt: "" }) : chatIcon(p.kind))
const chatName = (p: api.Profile) => p.displayName || KIND_NAMES[p.kind]

// a link's profile on one line, with what kind of chat it is where nothing else says so
export const profileLine = (p: api.Profile, withKind = false) => el("span", { class: "entity" }, chatPicture(p),
  p.displayName ? el("b", { title: p.displayName }, p.displayName) : null, withKind || !p.displayName ? el("small", {}, KIND_NAMES[p.kind]) : null)

// `name` is the name with its TLD, which the popup shows as the app's alert does; `key` brings focus back to the button
export function chatButton(e: api.Entity, name: string, key: string, community = false): HTMLButtonElement {
  const titled = e.displayName ? `${e.displayName} · ${KIND_NAMES[e.kind]}` : KIND_NAMES[e.kind]
  return el("button", { class: "chat", type: "button", title: titled, "aria-label": e.displayName ? `${e.displayName}, ${KIND_NAMES[e.kind].toLowerCase()}` : KIND_NAMES[e.kind],
    "aria-haspopup": "dialog", "data-focus": key, onclick: () => openChat(e, name, key, community) }, chatPicture(e))
}

const subscribers = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "subscriber" : "subscribers"}`

// After the app's connection plan alert (ConnectPlan.kt, AlertManager.showOpenChatAlert): the profile, its link as a QR, open and copy.
function openChat(e: api.Entity, name: string, key: string, community: boolean): void {
  const target = e.deepLink ?? e.link
  const open = SAFE_LINK.test(target) ? el("a", { class: "btn", href: target }, e.kind === "channel" ? "Open channel in SimpleX" : "Open in SimpleX") : null
  const qr = SAFE_LINK.test(e.link) ? qrSvg(e.link, `QR code of the link to ${chatName(e)}`) : null
  showPopup(key, [
    chatPicture(e),
    el("h2", { id: POPUP_TITLE }, chatName(e)),
    el("span", { class: "soft" }, `${e.kind === "channel" ? "#" : "@"}${name}${community ? " · Community name" : ""}`),
    e.fullName ? el("span", {}, e.fullName) : null,
    e.subscribers === null ? null : el("span", { class: "soft" }, subscribers(e.subscribers)),
    qr && el("div", { class: "pop-qr" }, qr),
    el("div", { class: "pop-acts" }, open, copyButton(e.link, "btn quiet", "Copy link", "Copy link")),
  ], open)
}
