import { expect, type Page } from "@playwright/test"
import { search, shot, test } from "./helpers.ts"

const PHONE = { width: 390, height: 844 }
const LAPTOP = { width: 1280, height: 800 }

// a name with one chat of each kind the app knows, the contact with a picture of its own
const PICTURE = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxIDEiPjxyZWN0IHdpZHRoPSIxIiBoZWlnaHQ9IjEiIGZpbGw9IiNjNzZhM2IiLz48L3N2Zz4="
const chat = (kind: string, displayName: string, extra: Record<string, unknown> = {}) => ({
  type: kind === "channel" ? "channel" : "address", kind, displayName, fullName: "", image: null, subscribers: kind === "channel" ? 1 : null, profile: "ok",
  link: `https://smp8.simplex.im/${kind === "channel" ? "c" : "a"}#${kind}`, deepLink: `simplex:/${kind === "channel" ? "c" : "a"}#${kind}?h=smp8.simplex.im`, ...extra,
})
const EVERY_KIND = [chat("contact", "Ann", { image: PICTURE }), chat("channel", "News"), chat("business", "Shop"), chat("bot", "Helper")]
// a name's two chats whose profiles the service read, with the channel's link and the chat core's form of it
const CHANNEL_LINK = "https://smp9.simplex.im/c#Rk27xN4pDe9Tz1Wb3Yc5Vd7Xf9Hg2Jk4Lm"
const CHANNEL_DEEP_LINK = "simplex:/c#Rk27xN4pDe9Tz1Wb3Yc5Vd7Xf9Hg2Jk4Lm?h=smp9.simplex.im"
const BAKERY = [chat("contact", "Alice's Bakery", { fullName: "Sourdough and pastries, Lisbon" }),
  chat("channel", "Bakery news", { fullName: "Daily bakes and opening hours", subscribers: 1204, link: CHANNEL_LINK, deepLink: CHANNEL_DEEP_LINK })]

async function answerWith(page: Page, entities: unknown[]): Promise<void> {
  await page.route("**/api/name/**", (route) => route.fulfill({ json: { status: "registered", entities, owner: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", tld: "simplex", community: null } }))
}

test("a taken name shows each chat it opens as the app's default picture for its kind, or the profile's own picture", async ({ page }) => {
  await answerWith(page, EVERY_KIND)
  await search(page, "everykind")
  const chats = page.locator(".answer .row .chat")
  await expect(chats).toHaveCount(4)
  await expect(chats.nth(0).locator("img")).toHaveAttribute("src", PICTURE)
  // the app's own icons (ic_bigtop_updates_circle_filled, ic_work_filled_padded, ic_cube), by their drawings' boxes
  expect(await chats.evaluateAll((buttons) => buttons.slice(1).map((b) => b.querySelector("svg")!.getAttribute("viewBox"))))
    .toEqual(["0 -960 960 960", "0 0 1240 1240", "0 -960 960 960"])
  expect(await chats.evaluateAll((buttons) => buttons.map((b) => b.getAttribute("aria-label"))))
    .toEqual(["Ann, contact address", "News, channel", "Shop, business address", "Helper, bot"])
  // drawn in the app's secondaryVariant, a soft grey, not the page's ink
  const tint = await chats.nth(1).locator(".chat-pic").evaluate((n) => getComputedStyle(n).color)
  expect(tint).toBe("rgb(201, 209, 222)")
})

test("a chat's picture opens its profile as the app's connection alert, which Escape and a click outside close", async ({ page, context, browserName }) => {
  await page.setViewportSize(LAPTOP)
  await answerWith(page, BAKERY)
  await search(page, "bakery")
  const news = page.locator(".answer").getByRole("button", { name: "Bakery news, channel" })
  const headline = () => page.locator(".home h1").evaluate((h) => h.getBoundingClientRect().left)
  await expect(news).toBeVisible()
  const before = await headline()
  await news.click()
  const dialog = page.getByRole("dialog", { name: "Bakery news" })
  await expect(dialog).toBeVisible()
  expect(await headline(), "the page behind the popup keeps its place").toBe(before)
  expect(await page.locator(".modal-backdrop").evaluate((n) => getComputedStyle(n).backdropFilter), "a flat scrim").toBe("none")
  await expect(dialog).toContainText("#bakery.simplex")
  await expect(dialog).toContainText("Daily bakes and opening hours")
  await expect(dialog).toContainText("1,204 subscribers")
  await expect(dialog.locator("svg.qr")).toBeVisible()
  const open = dialog.getByRole("link", { name: "Open channel in SimpleX" })
  await expect(open).toBeFocused()
  // the chat core's form, which keeps the server, so the app can open it
  await expect(open).toHaveAttribute("href", CHANNEL_DEEP_LINK)
  await shot(page, "N2g-chat-popup")
  if (browserName === "chromium") {
    await context.grantPermissions(["clipboard-read", "clipboard-write"])
    await dialog.getByRole("button", { name: "Copy link" }).click()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(CHANNEL_LINK)
  }
  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
  await expect(news, "focus back on the picture that opened it").toBeFocused()

  await page.locator(".answer").getByRole("button", { name: /^Alice.s Bakery, contact address$/ }).click()
  const alice = page.getByRole("dialog", { name: /^Alice.s Bakery$/ })
  await expect(alice).toContainText("@bakery.simplex")
  await expect(alice.getByRole("link", { name: "Open in SimpleX" })).toBeVisible()
  await page.mouse.click(10, 10)
  await expect(alice).toHaveCount(0)

  // a phone leaves out the QR, which is for another device
  await page.setViewportSize(PHONE)
  await news.click()
  await expect(page.getByRole("dialog", { name: "Bakery news" }).locator("svg.qr")).toBeHidden()
  await page.getByRole("dialog", { name: "Bakery news" }).getByRole("button", { name: "Close" }).click()
  await expect(page.getByRole("dialog")).toHaveCount(0)

  // a popup open as its page is left goes with it
  await news.click()
  await expect(page.getByRole("dialog", { name: "Bakery news" })).toBeVisible()
  await page.evaluate(() => { location.hash = "#/names" })
  await expect(page.getByRole("heading", { name: "Your names" })).toBeVisible()
  await expect(page.getByRole("dialog")).toHaveCount(0)
})

// The window's layout width and where a part of the page stands across it, which a scrollbar taken away would move,
// and the box `cover` draws over the window, which must be the whole of it below `top`.
const across = (page: Page, part: string, cover: string) => page.evaluate(([part, cover]) => {
  const box = document.querySelector(cover)?.getBoundingClientRect()
  return { width: document.documentElement.clientWidth, height: innerHeight, part: Math.round(document.querySelector(part)!.getBoundingClientRect().left),
    cover: box ? { left: Math.round(box.left), right: Math.round(box.right), bottom: Math.round(Math.min(box.bottom, innerHeight)) } : null }
}, [part, cover])
const whole = (width: number, height: number) => ({ left: 0, right: width, bottom: height })

test("a popup and the phone's menu cover the whole window, moving nothing behind them, at a laptop's and a phone's size", async ({ page }) => {
  await answerWith(page, BAKERY)
  for (const size of [LAPTOP, PHONE]) {
    await page.setViewportSize(size)
    await search(page, "bakery")
    const news = page.locator(".answer").getByRole("button", { name: "Bakery news, channel" })
    await expect(news).toBeVisible()
    const shut = await across(page, ".search-field", ".modal-backdrop")
    await news.click()
    await expect(page.getByRole("dialog", { name: "Bakery news" })).toBeVisible()
    expect(await across(page, ".search-field", ".modal-backdrop"), `the popup at ${size.width}x${size.height}`).toEqual({ ...shut, cover: whole(shut.width, shut.height) })
    await page.keyboard.press("Escape")
    await expect(page.getByRole("dialog")).toHaveCount(0)
  }
  // the menu is a phone's; it covers the page under the header down to the window's foot, however far the page is scrolled
  const menu = page.getByRole("navigation", { name: "Menu" })
  const shut = await across(page, ".menu-button", "#menu")
  await page.getByRole("button", { name: "Menu" }).click()
  await expect(menu).toBeVisible()
  expect(await across(page, ".menu-button", "#menu"), `the menu at ${PHONE.width}x${PHONE.height}`).toEqual({ ...shut, cover: whole(shut.width, shut.height) })
  await page.mouse.wheel(0, PHONE.height)
  await expect.poll(() => page.evaluate(() => scrollY), "the page scrolled to its end").toBeGreaterThan(0)
  expect((await across(page, ".menu-button", "#menu")).cover, "the menu scrolled to the page's end").toEqual(whole(shut.width, shut.height))
})

test("a phone's header is the symbol and a menu button, whose menu over the page leads everywhere the header and footer do", async ({ page }) => {
  await page.setViewportSize(PHONE)
  await page.goto("/")
  const header = page.locator("body > header")
  await expect(header.getByRole("link", { name: "Check your code" })).toBeHidden()
  const button = header.getByRole("button", { name: "Menu" })
  await expect(button).toHaveAttribute("aria-expanded", "false")
  expect(Math.round((await header.boundingBox())!.height), "the header's height").toBe(54)
  await button.click()
  const menu = page.getByRole("navigation", { name: "Menu" })
  await expect(menu).toBeVisible()
  await expect(menu.getByRole("link")).toHaveText(["Find a name", "Check your code", "Your names", "Invest on Wefunder", "Trademark owners", "simplex.chat/contact"])
  await shot(page, "N0-phone-menu")
  // a capture leaves the window a laptop's
  await page.setViewportSize(PHONE)
  // the theme switches from the menu, which stays open
  await menu.getByRole("button", { name: "Dark theme" }).click()
  await expect(page.locator("html")).toHaveClass(/\bdark\b/)
  await expect(menu.getByRole("button", { name: "Light theme" })).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(menu).toBeHidden()
  await expect(header.getByRole("button", { name: "Menu" })).toBeFocused()
  await header.getByRole("button", { name: "Menu" }).click()
  await menu.getByRole("link", { name: "Check your code" }).click()
  await expect(page.getByRole("heading", { name: "Check your code" })).toBeVisible()
  await expect(menu).toBeHidden()

  // a laptop's header has the links themselves, and no menu, even one left open on a phone turned or a window widened
  await header.getByRole("button", { name: "Menu" }).click()
  await expect(menu).toBeVisible()
  await page.setViewportSize(LAPTOP)
  await expect(header.getByRole("link", { name: "Check your code" })).toBeVisible()
  await expect(header.getByRole("button", { name: "Menu" })).toBeHidden()
  await expect(menu).toBeHidden()
})

// WCAG's least contrast for text of the body's size
const TEXT_CONTRAST = 4.5

// The contrast of a field's placeholder, its colour laid over the field's ground, which is opaque.
const placeholderContrast = (page: Page) => page.locator(".field input").first().evaluate((input) => {
  const rgba = (css: string) => css.match(/[\d.]+/g)!.map(Number)
  const [r, g, b, a = 1] = rgba(getComputedStyle(input, "::placeholder").color)
  const ground = rgba(getComputedStyle(input.closest(".field")!).backgroundColor)
  const shown = [r, g, b].map((c, i) => c * a + ground[i] * (1 - a))
  const luminance = (rgb: number[]) => {
    const [lr, lg, lb] = rgb.map((c) => c / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb
  }
  const [hi, lo] = [luminance(shown), luminance(ground)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
})

test("a field's placeholder reads at the contrast of body text in either theme", async ({ page }) => {
  await page.goto("/")
  for (const dark of [false, true]) {
    await page.evaluate((d) => document.documentElement.classList.toggle("dark", d), dark)
    expect(await placeholderContrast(page), dark ? "dark" : "light").toBeGreaterThanOrEqual(TEXT_CONTRAST)
  }
})

// the open menu's items, in their order
const MENU_ITEMS = ["Find a name", "Check your code", "Your names", "Invest on Wefunder", "Trademark owners", "simplex.chat/contact", "Dark theme"]
// the name of what has focus, and whether the open menu is the topmost thing at its middle, as a reader would see it
const focused = (page: Page) => page.evaluate(() => {
  const at = document.activeElement as HTMLElement
  const box = at.getBoundingClientRect()
  const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
  return { name: at.getAttribute("aria-label") ?? at.innerText.trim(), seen: top !== null && (at === top || at.contains(top)) }
})

test("Tab keeps to the open phone menu and its button, never reaching the page under it, until the menu closes", async ({ page }) => {
  await page.setViewportSize(PHONE)
  await search(page, "bakery")
  const button = page.locator("body > header").getByRole("button", { name: "Menu" })
  await button.focus()
  await page.keyboard.press("Enter")
  const stops = []
  for (let i = 0; i <= MENU_ITEMS.length; i++) {
    await page.keyboard.press("Tab")
    stops.push(await focused(page))
  }
  expect(stops, "each Tab from the menu button").toEqual([...MENU_ITEMS, "Close menu"].map((name) => ({ name, seen: true })))
  await page.keyboard.press("Shift+Tab")
  expect(await focused(page), "Shift+Tab from the menu button").toEqual({ name: MENU_ITEMS.at(-1), seen: true })
  await expect(page.getByLabel("Name", { exact: true }), "the page under the menu").not.toBeFocused()
  await page.keyboard.press("Escape")
  await expect(button).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(page.getByRole("navigation", { name: "Menu" })).toBeHidden()
  expect((await focused(page)).seen, "the closed menu's first stop is on the page").toBe(true)

  // a menu left open as the window widens leaves the page usable
  await button.click()
  await page.setViewportSize(LAPTOP)
  await expect(page.locator(".menu-button"), "the menu closed as the window widened").toHaveAttribute("aria-expanded", "false")
  await page.getByLabel("Name", { exact: true }).focus()
  await expect(page.getByLabel("Name", { exact: true })).toBeFocused()
})

test("an empty link field pastes the link copied in the app, and its chat then shows with its kind", async ({ page, context, browserName }) => {
  test.skip(browserName !== "chromium", "only Chromium lets a test grant the page a read of what was copied")
  await context.grantPermissions(["clipboard-read", "clipboard-write"])
  await search(page, `paste${Date.now().toString(36)}`)
  await page.getByRole("button", { name: "Register" }).click()
  await page.evaluate(() => navigator.clipboard.writeText("https://smp9.simplex.im/c#PsRk27xN4pDe9Tz1Wb3Yc5Vd7Xf9Hg2J"))
  const field = page.locator(".link-field").first()
  await field.getByRole("button", { name: "Paste" }).click()
  await expect(field).toHaveAttribute("data-state", "ok")
  await expect(field.getByRole("button", { name: "Paste" }), "a field with a link offers no Paste").toBeHidden()
  await page.getByRole("textbox", { name: "Link", exact: true }).blur()
  await expect(field.locator(".entity small")).toHaveText("Channel")
  await expect(page.getByRole("button", { name: "Add a contact address" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled()
})
