// The router: one page per route, redrawn on navigation.
import { codesOnly } from "./mode.ts"
import { checkoutStepOf, EDIT_PATH, fromOrder, viewOf } from "./screens/routes.ts"
import * as session from "./session.ts"
import { checkoutPage } from "./views/checkout.ts"
import { setUpChrome } from "./views/chrome.ts"
import { checkCodePage, editPage, historyPage, trademarksPage } from "./views/names.ts"
import { orderPage } from "./views/order.ts"
import { searchPage } from "./views/search.ts"
import { go, historyMoved, nextRoute, setRenderer } from "./views/shell.ts"

function render(): void {
  const query = new URLSearchParams(location.search)
  const [path, hashQuery = ""] = location.hash.replace(/^#/, "").split("?")
  const view = viewOf(query, path)
  nextRoute()
  switch (view) {
    case "order": return orderPage(query.get("order"), query.get("registration"))
    case "checkout": return checkoutPage(checkoutStepOf(path))
    case "names": return historyPage()
    case "trademarks": return trademarksPage()
    case "code": return checkCodePage(fromOrder(new URLSearchParams(hashQuery)))
    case "edit": return void editPage(EDIT_PATH.exec(path)![1])
    case "search": return searchPage(new URLSearchParams(hashQuery))
  }
}

setRenderer(render)
// a balance pays nothing in codes-only mode, so one this tab took before pays no more
if (codesOnly()) session.setActiveBalance(null)
setUpChrome()
window.addEventListener("popstate", (e) => {
  if (historyMoved(e)) render()
})
// The second click of a double click is dropped everywhere: an action that redraws the page or opens a popup puts
// another control under the pointer, where it would land (a checkbox, a payment method, the popup's backdrop).
document.addEventListener("click", (e) => {
  if (e.detail <= 1) return
  e.preventDefault()
  e.stopImmediatePropagation()
}, true)
document.addEventListener("keydown", (e) => {
  if (e.key !== " " || !(e.target instanceof Element) || !e.target.matches('a[role="button"]')) return
  e.preventDefault()
  if (!e.repeat) (e.target as HTMLElement).click()
})
// A link from /?order=… to /#/… would load a new document, dropping what this page holds in memory, so its views switch in place.
document.addEventListener("click", (e) => {
  const a = (e.target as Element | null)?.closest("a")
  const href = a?.getAttribute("href")
  if (!a || !href || a.target || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  if (!/^\/(#|\?)/.test(href)) return
  e.preventDefault()
  go(href)
})
render()
// The worker keeps this build for opening offline, registered after load so it does not slow the first visit; the dev server has none.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  addEventListener("load", () => {
    // checked for updates past the HTTP cache, which could keep a returning reader on an old worker
    navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch((e: unknown) => console.warn("This page will not open offline:", e))
  })
}
