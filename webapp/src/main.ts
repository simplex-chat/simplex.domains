// The router: one page per route, redrawn on navigation.
import "./styles.css"
import { checkoutPage, ownerCodePage } from "./views/checkout.ts"
import { codePopup } from "./views/codes.ts"
import { editPage, historyPage, restorePage, trademarksPage } from "./views/names.ts"
import { orderPage } from "./views/order.ts"
import { searchPage } from "./views/search.ts"
import { go, nextRoute, setRenderer, wentBack } from "./views/shell.ts"

function render(): void {
  nextRoute()
  const query = new URLSearchParams(location.search)
  const order = query.get("order")
  const registration = query.get("registration")
  if (order || registration) return orderPage(order, registration)
  const [path, hashQuery = ""] = location.hash.replace(/^#/, "").split("?")
  const params = new URLSearchParams(hashQuery)
  if (path === "/checkout") return checkoutPage()
  if (path === "/checkout/code") return ownerCodePage()
  if (path === "/names") return historyPage()
  if (path === "/restore") return restorePage()
  if (path === "/trademarks") return trademarksPage()
  const edit = path.match(/^\/edit\/([\w-]+)$/)
  if (edit) return void editPage(edit[1])
  searchPage(params)
}

setRenderer(render, () => codePopup("check"))
window.addEventListener("popstate", (e) => {
  wentBack(e)
  render()
})
// The second click of a double click is dropped everywhere: an action that redraws the page or opens a popup puts
// another control under the pointer, where it would land (a checkbox, a payment method, the popup's backdrop).
document.addEventListener("click", (e) => {
  if (e.detail <= 1) return
  e.preventDefault()
  e.stopImmediatePropagation()
}, true)
// A link from /?order=… to /#/… changes the query, so the browser would load a new document and drop what this page
// holds in memory (all of it when storage is blocked); this page's own links switch views in place instead.
document.addEventListener("click", (e) => {
  const a = (e.target as Element | null)?.closest("a")
  const href = a?.getAttribute("href")
  if (!a || !href || a.target || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  if (!/^\/(#|\?)/.test(href)) return
  e.preventDefault()
  go(href)
})
render()
// The worker keeps this build for opening offline. Registered once the page has loaded, so its install does not slow
// the first visit; the dev server has no built worker.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  addEventListener("load", () => {
    // checked for updates past the HTTP cache, which could keep a returning reader on an old worker
    navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch((e: unknown) => console.warn("This page will not open offline:", e))
  })
}
