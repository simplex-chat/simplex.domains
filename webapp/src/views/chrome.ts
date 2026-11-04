// The header's parts that change: the phone's menu, which its button opens over the page, and the tab's active code or balance.
import { el } from "../dom.ts"
import { dollars } from "../format.ts"
import * as session from "../session.ts"
import { onDrawn, onPageLeft, refresh } from "./shell.ts"

const menuButton = () => document.querySelector<HTMLButtonElement>(".menu-button")!
const menu = () => document.querySelector<HTMLElement>("#menu")!
const PHONE = "(max-width: 520px)"
const COVERED = "body > main, body > .invest, body > footer"

function setMenu(open: boolean): void {
  menu().hidden = !open
  for (const part of document.querySelectorAll<HTMLElement>(COVERED)) part.inert = open
  menuButton().setAttribute("aria-expanded", String(open))
  menuButton().setAttribute("aria-label", open ? "Close menu" : "Menu")
}

function closeMenu(): void {
  if (!menu().hidden) setMenu(false)
}

function keepFocusIn(e: KeyboardEvent): void {
  const stops = [menuButton(), ...menu().querySelectorAll<HTMLElement>("a, button")]
  const [edge, next] = e.shiftKey ? [stops[0], stops.at(-1)!] : [stops.at(-1)!, stops[0]]
  if (document.activeElement !== edge) return
  e.preventDefault()
  next.focus()
}

const chip = () => document.querySelector<HTMLElement>(".code-chip")!

// the active code or balance takes the place of Check your code, with what it pays
function showChip(): void {
  const code = session.activeCode()
  const balance = session.activeBalance()
  chip().hidden = code === null && balance === null
  chip().classList.toggle("balance", balance !== null)
  document.querySelector<HTMLElement>(".check-link")!.hidden = !chip().hidden
  chip().querySelector("button")!.setAttribute("aria-label", balance ? "Stop using the balance" : "Remove code")
  const what = chip().querySelector(".what")!
  if (balance) what.replaceChildren(el("span", { class: "code-word" }, "Balance: "), dollars(balance.amount))
  else if (code) what.replaceChildren(el("span", { class: "code-word" }, "Code: "), `${code.minLength}+ letters, ${code.years} years`)
}

// a code or balance taken off leaves the checkout it pays for too, unless its order is on its way
function removeChip(): void {
  const code = session.activeCode()
  const balance = session.activeBalance()
  session.setActiveCode(null)
  session.setActiveBalance(null)
  const c = session.checkout()
  if (c && !session.isSending(c)) {
    if (c.code && c.code.display === code?.display) session.updateCheckout(c.label, { code: null })
    if (c.balance && c.balance.source === balance?.source) session.updateCheckout(c.label, { balance: null, balanceChange: undefined })
  }
  refresh()
}

function markCurrent(): void {
  const here = location.search ? null : location.hash.split("?")[0] || "#/"
  for (const a of document.querySelectorAll<HTMLAnchorElement>(".top-links a, .menu a")) {
    if (a.getAttribute("href")?.slice(1) === here) a.setAttribute("aria-current", "page")
    else a.removeAttribute("aria-current")
  }
}

export function setUpChrome(): void {
  chip().querySelector("button")!.addEventListener("click", removeChip)
  onDrawn(showChip)
  onDrawn(markCurrent)
  menuButton().addEventListener("click", () => setMenu(menu().hidden))
  // a link in the menu leaves it closed behind the page it opens, as does any other page reached meanwhile
  menu().addEventListener("click", (e) => { if ((e.target as Element).closest("a")) closeMenu() })
  document.addEventListener("keydown", (e) => {
    if (menu().hidden) return
    if (e.key === "Tab") return keepFocusIn(e)
    if (e.key !== "Escape") return
    closeMenu()
    menuButton().focus()
  })
  onPageLeft(closeMenu)
  matchMedia(PHONE).addEventListener("change", (e) => { if (!e.matches) closeMenu() })
}
