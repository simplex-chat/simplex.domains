import { expect, test as base, type APIRequestContext, type Browser, type BrowserContext, type BrowserContextOptions, type Locator, type Page } from "@playwright/test"
import { randomInt } from "node:crypto"
import { mkdirSync, readFileSync } from "node:fs"
import { createPublicClient, createTestClient, createWalletClient, encodeFunctionData, http, namehash, parseAbi, parseEventLogs, toFunctionSelector, type Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { foundry } from "viem/chains"
import { labelHash, YEAR_S } from "../src/crypto/registration.ts"
import { checksumAddress, hex } from "../src/crypto/wallet.ts"
import { newOwnerCode, walletOf } from "../src/flow.ts"
import { readQr } from "../src/scan.ts"
import { qrPixels } from "../test/qr-image.ts"
import { mockUrl, pageUrl } from "./slots.ts"

const SCREENSHOTS = process.env.SCREENSHOTS_DIR ?? "screenshots"
const TAKE_SHOTS = process.env.SHOTS === "1"
const SLOT = Number(process.env.TEST_PARALLEL_INDEX ?? "0")
export const MOCK = process.env.MOCK_URL ?? mockUrl(SLOT)
const DESKTOP = { width: 1280, height: 800 }
const PHONE = { width: 390, height: 844 }
// the sizes a page must fit without scrolling, a laptop's and a phone's
export const FIT_SIZES = [DESKTOP, PHONE]
// commit age plus mining, signing and the register transaction, with room for a slow chain
export const REGISTRATION_MS = 120_000

export function uniqueLabel(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`
}

// a name of 7 letters, which costs $200 for its 2 years where one of 8 or more costs $100
export const sevenLetters = () => `b${Math.random().toString(36).slice(2).replace(/[^a-z]/g, "")}bbbbbb`.slice(0, 7)

// A link's key, led by a tag that tells the mock what profile to give it, in whole base64url groups, which the chat core reads
const LINK_KEY_CHARS = 32
const linkKey = (tag: string, rest: string) => `${tag}${rest}`.slice(0, LINK_KEY_CHARS)
export const contactLink = (tag: string) => `https://smp8.simplex.im/a#${linkKey(tag, "Y8m3qT0vLw2Ab7cD9eF1gH3jK5mN7pQ9rS")}`
export const channelLink = (tag: string) => `https://smp9.simplex.im/c#${linkKey(tag, "Rk27xN4pDe9Tz1Wb3Yc5Vd7Xf9Hg2Jk4Lm")}`

export async function control(request: APIRequestContext, path: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = await request.post(`${MOCK}/control/${path}`, { data: body })
  expect(res.ok(), `control ${path}: ${await res.text()}`).toBeTruthy()
  return res.json()
}

export async function registrationOf(request: APIRequestContext, invoiceId: string): Promise<string> {
  const res = await request.get(`${MOCK}/api/invoice/${invoiceId}`)
  return (await res.json()).registration.id
}

interface MockRegistration { invoiceId: string | null; phase: string; revealAfter: number | null; createdAt: string }

export async function mockRegistration(request: APIRequestContext, invoiceId: string): Promise<MockRegistration> {
  const res = await request.get(`${MOCK}/control/state`)
  const { registrations } = await res.json() as { registrations: MockRegistration[] }
  return registrations.find((r) => r.invoiceId === invoiceId)!
}

// The worker's chain, read directly: the expiry the registrar holds and the price the oracle quotes.
const deployment = JSON.parse(readFileSync(new URL(`../dev/local-chain-${SLOT}.json`, import.meta.url), "utf8")) as
  { rpcUrl: string; chainId: number; tld: string; ens: Hex; resolver: Hex; controller: Hex; baseRegistrar: Hex; namePolicy: Hex; generalTermsLink: string; generalTermsHash: Hex
    communityTermsLink: string; communityTermsHash: Hex; ownerKey: Hex }
const chain = createPublicClient({ transport: http(deployment.rpcUrl) })
const CHAIN_ABI = parseAbi([
  "function nameExpires(uint256 id) view returns (uint256)",
  "function rentPriceUSD(string label, uint256 duration) view returns ((uint256 base, uint256 premium))",
  "function setResolver(bytes32 node, address resolver)",
  "function setText(bytes32 node, string key, string value)",
  "event GeneralTermsAccepted(string name, address indexed holder, bytes32 termsHash)",
  "event CommunityTermsAccepted(string name, address indexed holder, bytes32 termsHash)",
  "function addCommunityNames(string[] names)",
])
// the terms dev/deploy.ts linked on chain, by their hashes, and the terms an order of a plain and of a community name signs
export const GENERAL_TERMS_HASH = deployment.generalTermsHash
export const COMMUNITY_TERMS_HASH = deployment.communityTermsHash
export const PLAIN_TERMS = GENERAL_TERMS_HASH.slice(2)
export const COMMUNITY_TERMS = `community/${COMMUNITY_TERMS_HASH.slice(2)}`
export const NAME_POLICY = deployment.namePolicy
// gas for a few of an owner's own transactions, which anvil gives the owner's wallet
const OWNER_GAS_WEI = 10n ** 18n
// SimplexPriceOracle's attoUSD to the cent
const ATTO_PER_CENT = 10n ** 16n

const TEXT_CHANGED_ABI = parseAbi(["event TextChanged(bytes32 indexed node, string indexed indexedKey, string key, string value)"])
const MULTICALL = toFunctionSelector("multicall(bytes[])")

// The records a mined transaction set on the resolver, in order, and whether it was the resolver's multicall.
export async function textChangesOf(tx: string): Promise<{ multicall: boolean; changes: [string, string][] }> {
  const [receipt, sent] = await Promise.all([chain.getTransactionReceipt({ hash: tx as Hex }), chain.getTransaction({ hash: tx as Hex })])
  expect(receipt.status, "the edit's transaction").toBe("success")
  const logs = parseEventLogs({ abi: TEXT_CHANGED_ABI, logs: receipt.logs.filter((l) => l.address.toLowerCase() === deployment.resolver.toLowerCase()) })
  return { multicall: sent.input.startsWith(MULTICALL), changes: logs.map((l) => [l.args.key, l.args.value]) }
}

// the time of the block that mined a transaction
export async function blockTimeOf(tx: string): Promise<number> {
  const receipt = await chain.getTransactionReceipt({ hash: tx as Hex })
  return Number((await chain.getBlock({ blockNumber: receipt.blockNumber })).timestamp)
}

export const chainExpiry = async (label: string) =>
  Number(await chain.readContract({ address: deployment.baseRegistrar, abi: CHAIN_ABI, functionName: "nameExpires", args: [BigInt(hex(labelHash(label)))] }))

// A name's owner changing it from its own wallet, as it may outside the store.
async function asOwner(ownerCode: string, to: Hex, data: Hex): Promise<void> {
  const account = privateKeyToAccount(hex(walletOf(ownerCode)!.privateKey) as Hex)
  const transport = http(deployment.rpcUrl)
  await createTestClient({ mode: "anvil", transport }).setBalance({ address: account.address, value: OWNER_GAS_WEI })
  const hash = await createWalletClient({ account, chain: { ...foundry, id: deployment.chainId }, transport }).sendTransaction({ to, data })
  expect((await chain.waitForTransactionReceipt({ hash })).status, "the owner's own transaction").toBe("success")
}

const nodeOf = (label: string) => namehash(`${label}.${deployment.tld}`)

export const ownerSetsResolver = (ownerCode: string, label: string, resolver: Hex) =>
  asOwner(ownerCode, deployment.ens, encodeFunctionData({ abi: CHAIN_ABI, functionName: "setResolver", args: [nodeOf(label), resolver] }))

export const ownerSetsText = (ownerCode: string, label: string, key: string, value: string) =>
  asOwner(ownerCode, deployment.resolver, encodeFunctionData({ abi: CHAIN_ABI, functionName: "setText", args: [nodeOf(label), key, value] }))

// The terms the owner accepted for the commitment before its register, of the name's kind, as the register's own
// GeneralTermsAccepted or CommunityTermsAccepted event records them: the register consumes the acceptance, so the policy's
// acceptedTerms reads zero after it.
export async function acceptedOnChain(registerTx: string): Promise<{ kind: "general" | "community"; name: string; holder: string; termsHash: Hex } | null> {
  const receipt = await chain.getTransactionReceipt({ hash: registerTx as Hex })
  const [log] = parseEventLogs({ abi: CHAIN_ABI, eventName: ["GeneralTermsAccepted", "CommunityTermsAccepted"], logs: receipt.logs })
  return log ? { kind: log.eventName === "CommunityTermsAccepted" ? "community" : "general", ...log.args } : null
}

// The contracts' owner lists the name on the name policy's community list from its own key, for a case that also runs
// against the service, which has no /control/community.
export async function contractsOwnerLists(label: string): Promise<void> {
  const account = privateKeyToAccount(deployment.ownerKey)
  const hash = await createWalletClient({ account, chain: { ...foundry, id: deployment.chainId }, transport: http(deployment.rpcUrl) })
    .writeContract({ address: deployment.namePolicy, abi: CHAIN_ABI, functionName: "addCommunityNames", args: [[label]] })
  expect((await chain.waitForTransactionReceipt({ hash })).status, "the owner's listing").toBe("success")
}

export async function oracleQuote(label: string, years: number): Promise<number> {
  const quote = await chain.readContract({ address: deployment.controller, abi: CHAIN_ABI, functionName: "rentPriceUSD", args: [label, BigInt(years * YEAR_S)] })
  return Number(quote.base / ATTO_PER_CENT)
}

export async function searchName(request: APIRequestContext, label: string): Promise<Record<string, unknown>> {
  const { labelHash } = await import("../src/crypto/registration.ts")
  const { hex } = await import("../src/crypto/wallet.ts")
  const res = await request.get(`${MOCK}/api/name/${hex(labelHash(label))}?length=${label.length}`)
  return res.json()
}

// The page in light and dark, on a desktop and on a phone; the theme is a class, so no redraw is needed.
export async function shot(page: Page, name: string): Promise<void> {
  if (!TAKE_SHOTS) return
  // Chromium's captures are the reviewed set; other browsers keep theirs beside them, to compare
  const browser = page.context().browser()!.browserType().name()
  const dir = browser === "chromium" ? SCREENSHOTS : `${SCREENSHOTS}/${browser}`
  mkdirSync(dir, { recursive: true })
  // fonts.ready can settle before a face first used on this page has loaded, so every declared face is loaded first
  await page.evaluate(() => Promise.all([...document.fonts].map((f) => f.load().catch(() => undefined))).then(() => document.fonts.ready))
  // a face that just loaded, or a colour just switched, is painted on a later frame
  const painted = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  await painted()
  // the pointer is moved off the page's controls, so no capture shows a hover
  await page.mouse.move(0, 0)
  // an open dialog is seen over the window, which its backdrop covers whole
  const dialogOpen = await page.locator(".modal[open]").count() > 0
  // Playwright's WebKit on Linux, drawing in software, takes each capture after a theme switch slower than the last,
  // past a test's time; its captures are a comparison set, so it keeps the light ones
  const themes = browser === "webkit" ? [false] : [false, true]
  for (const [device, size] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
    await page.setViewportSize(size)
    for (const dark of themes) {
      await page.evaluate((d) => document.documentElement.classList.toggle("dark", d), dark)
      await painted()
      await page.screenshot({ path: `${dir}/${name}-${device}-${dark ? "dark" : "light"}.png`, fullPage: !dialogOpen, animations: "disabled" })
    }
  }
  await page.evaluate(() => document.documentElement.classList.remove("dark"))
  await page.setViewportSize(DESKTOP)
}

// How far the middle of the furthest line of what an element draws, its words or its picture, stands from the middle of
// its parent's content box, in pixels.
export const offCentre = (node: Locator) => node.evaluate((n) => {
  const range = document.createRange()
  range.selectNodeContents(n)
  const lines = new Map<number, { left: number; right: number }>()
  for (const r of range.getClientRects()) {
    const line = lines.get(Math.round(r.bottom))
    lines.set(Math.round(r.bottom), { left: Math.min(r.left, line?.left ?? r.left), right: Math.max(r.right, line?.right ?? r.right) })
  }
  const parent = n.parentElement!
  const box = parent.getBoundingClientRect()
  const style = getComputedStyle(parent)
  const middle = (box.left + parseFloat(style.paddingLeft) + box.right - parseFloat(style.paddingRight)) / 2
  return Math.max(...[...lines.values()].map((l) => Math.abs((l.left + l.right) / 2 - middle)))
})

// the size of a heading drawn smaller for a long name, as the mockup's, on a laptop and on a phone
const SMALL_HEADING_PX = [26, 22]
const PHONE_MEDIA = "(max-width: 520px)"

// The names in rows and headings drawn over more than one line, though their letters together would fit the line whole:
// a row's, or the column a heading spans, at its smaller size.
export const brokenNames = (page: Page) => page.evaluate(([[laptop, phone], media]) => [...document.querySelectorAll("body > main :is(.row > .name, h1 .nt)")].filter((name) => {
  const line = name.closest(".row, .screen-head")!
  const style = getComputedStyle(line)
  const room = line.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
  const scale = line.matches(".row") ? 1 : (matchMedia(media).matches ? phone : laptop) / parseFloat(getComputedStyle(name).fontSize)
  const range = document.createRange()
  const walker = document.createTreeWalker(name, NodeFilter.SHOW_TEXT)
  const parts: DOMRect[] = []
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    range.selectNodeContents(text)
    parts.push(...range.getClientRects())
  }
  return new Set(parts.map((p) => Math.round(p.bottom))).size > 1 && parts.reduce((sum, p) => sum + p.width, 0) * scale <= room
}).map((name) => name.textContent), [SMALL_HEADING_PX, PHONE_MEDIA] as const)

// how far anything in the answer's row reaches past the row, what in it is too narrow for its own content, the row's
// height, the room above and under its content inside its border, and the lines its name takes
export const rowFit = (page: Page) => page.evaluate(() => {
  const shown = document.querySelector(".answer .row")!
  const row = shown.getBoundingClientRect()
  const parts = [...shown.children].map((n) => n.getBoundingClientRect()).filter((b) => b.height > 0)
  const inside = [...document.querySelectorAll(".answer .row *")].map((n) => n.getBoundingClientRect()).filter((b) => b.height > 0)
  const name = document.querySelector(".answer .row .name")!
  const rest = name.nextElementSibling!.getBoundingClientRect()
  const clipped = [...document.querySelectorAll<HTMLElement>(".answer .row *")].filter((n) => n.clientWidth > 0 && n.scrollWidth > n.clientWidth).map((n) => n.className)
  return { spill: Math.round(Math.max(0, ...inside.map((b) => Math.max(b.bottom - row.bottom, row.top - b.top, b.right - row.right, row.left - b.left)))), clipped,
    height: Math.round(row.height), room: [Math.min(...parts.map((b) => b.top)) - row.top - shown.clientTop, row.bottom - shown.clientTop - Math.max(...parts.map((b) => b.bottom))].map(Math.round),
    nameLines: Math.round(name.getBoundingClientRect().height / parseFloat(getComputedStyle(name).lineHeight)),
    ownLine: Math.round(name.getBoundingClientRect().bottom) <= Math.round(rest.top) }
})

export async function search(page: Page, label: string): Promise<void> {
  await page.goto("/")
  await page.getByLabel("Name", { exact: true }).fill(label)
  await page.getByLabel("Name", { exact: true }).press("Enter")
}

interface OrderOptions {
  method?: "card" | "btc" | "xmr"
  shots?: string
}

const METHOD_NAMES = { card: "Card", btc: "Bitcoin", xmr: "Monero" }

// the screen in view, a purchase step or any other: main holds one at a time
export const onStep = (page: Page) => page.locator("body > main > section")
export const payButton = (page: Page) => onStep(page).getByRole("button", { name: /^Pay / })

// what the card page's note says of its name, in brief
export const AVAILABLE_BRIEF = /^Available at \d\d:\d\d\. If someone registers it first, you keep the payment as balance\.$/
export const TAKEN_BRIEF = /^Taken at \d\d:\d\d\. Don't pay this invoice: cancel it and choose another name\.$/

// a configured key makes the order's page load Stripe.js, wherever the page is first opened
export const withStripeKey = (page: Page) => page.route((url) => url.pathname === "/", async (route) => {
  const res = await route.fetch()
  await route.fulfill({ response: res, body: (await res.text()).replace('name="stripe-publishable-key" content=""', 'name="stripe-publishable-key" content="pk_test_e2e"') })
})

// Check your code's field, which takes a prepaid code or a name code
export const codeField = (page: Page) => onStep(page).getByRole("textbox", { name: "Code", exact: true })

// A prepaid code entered in Check your code, which then pays for the names this tab finds.
export async function useCode(page: Page, code: string): Promise<void> {
  await page.goto("/#/code")
  await codeField(page).fill(code)
  await onStep(page).getByRole("button", { name: "Find a name" }).and(page.locator(":enabled")).click()
  await expect(page.getByLabel("Name", { exact: true })).toBeVisible()
}

// A name code entered in Check your code, which finds its order and adds it to Your names.
export async function addNameCode(page: Page, code: string): Promise<void> {
  await page.goto("/#/code")
  await codeField(page).fill(code)
  await onStep(page).getByRole("button", { name: "Add to Your names" }).click()
  await expect(onStep(page).getByRole("heading", { name: "Your names" })).toBeVisible()
}

// A name code added in another browser, whose order, not registered yet, is then opened from its row in Your names.
export async function restoreOrder(page: Page, ownerCode: string, label: string): Promise<void> {
  await addNameCode(page, ownerCode)
  await page.locator(".list-row", { hasText: `${label}.simplex` }).getByRole("button", { name: "Open", exact: true }).click()
}

// the name code on a page, shown first, as a page shows it only on Show
export async function shownCode(page: Page): Promise<Locator> {
  const box = onStep(page).locator(".code-display", { has: page.getByTestId("owner-code") })
  await box.getByRole("button", { name: "Show" }).click()
  return page.getByTestId("owner-code")
}

// The text of a QR code as qrSvg draws it: its path's runs of dark modules, read back by jsQR.
export async function qrText(svg: Locator): Promise<string | null> {
  const { d, span } = await svg.evaluate((s) => ({ d: s.querySelector("path")!.getAttribute("d")!, span: Number(s.getAttribute("viewBox")!.split(" ")[2]) }))
  const modules = Array.from({ length: span }, () => new Array<boolean>(span).fill(false))
  for (const [, x, y, run] of d.matchAll(/M(\d+) (\d+)h(\d+)/g)) modules[Number(y)].fill(true, Number(x), Number(x) + Number(run))
  return readQr(qrPixels(modules))
}

// where session.ts keeps the tab's checkout, with the owner code made for it
export const CHECKOUT_KEY = "simplex-names-checkout"
export const checkoutOwnerCode = (page: Page) => page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)!).ownerCode as string, CHECKOUT_KEY)
// the name code this browser keeps with the order of an invoice
export const orderOwnerCode = (page: Page, invoiceId: string) => page.evaluate((id) => Object.values({ ...localStorage }).map((v) => { try { return JSON.parse(v) } catch { return null } })
  .find((o) => o?.invoiceId === id)?.ownerCode as string | undefined, invoiceId)

export const LINKS_HEADING = "Your name's links"
export const CODE_HEADING = "Save your name code"
export const SAVED = "I have saved my name code"
export const AGREE = /^I agree to SimpleX general terms/
export const COMMUNITY_HEADING = "Community terms"
export const ACCEPT = /^I accept the community terms/

// An available name's Register, then Skip for now, up to the name code step, which makes the code.
export async function toCodeStep(page: Page): Promise<void> {
  await onStep(page).getByRole("button", { name: "Register" }).click()
  await expect(onStep(page).getByRole("heading", { name: LINKS_HEADING })).toBeVisible()
  await onStep(page).getByRole("button", { name: "Skip for now" }).click()
  await expect(onStep(page).getByRole("heading", { name: CODE_HEADING })).toBeVisible()
}

// On from the name code step, its box ticked, to Check your order, through a community name's terms step, accepted, or a
// plain name's terms agreed to unless `agree` is false.
export async function savedToReview(page: Page, agree = true): Promise<void> {
  const box = onStep(page).getByRole("checkbox", { name: SAVED })
  // a code step gone back to keeps its box ticked
  if (!await box.isChecked()) await onStep(page).getByText(SAVED).click()
  await expect(box).toBeChecked()
  await onStep(page).getByRole("button", { name: "Continue" }).click()
  const review = onStep(page).getByRole("heading", { name: "Check your order" })
  const community = onStep(page).getByRole("heading", { name: COMMUNITY_HEADING })
  await expect(review.or(community)).toBeVisible()
  const listed = await community.isVisible()
  if (listed) await acceptCommunityTerms(page)
  await expect(review).toBeVisible()
  if (agree && !listed) await agreeToTerms(page)
}

// A community name's terms step: its text shown, its box ticked, and Continue.
export async function acceptCommunityTerms(page: Page): Promise<void> {
  await expect(onStep(page).locator(".terms-text")).toBeVisible()
  await tick(page, ACCEPT)
  await onStep(page).getByRole("button", { name: "Continue" }).click()
}

// The general terms' box ticked, which a plain name's order waits for, or a community name's own box in its place.
export async function agreeToTerms(page: Page): Promise<void> {
  await tick(page, await onStep(page).getByRole("checkbox", { name: ACCEPT }).count() ? ACCEPT : AGREE)
}

// A terms box ticked, pressed on its square, as its words hold links; a box gone back to keeps its tick.
async function tick(page: Page, name: RegExp): Promise<void> {
  const box = onStep(page).getByRole("checkbox", { name })
  if (!await box.isChecked()) await onStep(page).locator(".check.terms", { has: page.getByRole("checkbox", { name }) }).locator(".box").click()
  await expect(box).toBeChecked()
}

// An available name's Register, through the links skipped and the name code saved, to Check your order.
export async function toReview(page: Page, agree = true): Promise<void> {
  await toCodeStep(page)
  await savedToReview(page, agree)
}

// a link fetch the mock is told to slow down, long enough to act on the page while it runs
export const SLOW_FETCH_MS = 1500

// Each link field's profile of the link it holds, shown once focus has left the field, which shows its link alone while focused.
export async function previewsShown(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  for (const field of await onStep(page).locator(".link-field").all()) {
    const link = (await field.locator("input").inputValue()).trim()
    await expect(field.locator(".entity:not(.skeleton)").and(page.locator(`[data-link="${link}"]`))).toBeVisible()
  }
}

// The Links step's two links: one in its Link field, the other kind in the field its text link adds.
export async function fillLinks(page: Page, contact: string, channel: string): Promise<void> {
  const step = onStep(page)
  await step.getByRole("textbox", { name: "Link", exact: true }).fill(contact)
  await step.getByRole("button", { name: "Add a channel link" }).click()
  await step.getByRole("textbox", { name: "Channel" }).fill(channel)
}

// Search, Register, both links and the name code saved, to Check your order: the review at its fullest.
export async function toFullReview(page: Page, label: string): Promise<void> {
  await search(page, label)
  const step = onStep(page)
  await step.getByRole("button", { name: "Register" }).click()
  await fillLinks(page, contactLink("R1"), channelLink("R2"))
  await previewsShown(page)
  await step.getByRole("button", { name: "Continue" }).click()
  await expect(step.getByRole("heading", { name: CODE_HEADING })).toBeVisible()
  await savedToReview(page)
  // the review's rise ends before it is measured
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))))
}

// Samples every frame from the next one, keeping what `sample` returns other than null; resolves once a frame is sampled.
// With `eachPage`, every page loaded from now on is sampled from its start instead. `sample` runs in the page, by its source.
export async function recordFrames(page: Page, sample: () => unknown, eachPage = false): Promise<void> {
  const recorder = `new Promise((started) => {
    const frames = window.__frames = []
    const sample = ${sample}
    const look = () => {
      const seen = sample()
      if (seen !== null) frames.push(seen)
      started()
      requestAnimationFrame(look)
    }
    requestAnimationFrame(look)
  })`
  if (eachPage) await page.addInitScript(recorder)
  else await page.evaluate(recorder)
}

export const recordedFrames = <T>(page: Page) => page.evaluate(() => (window as unknown as { __frames: T[] }).__frames)

// Search and checkout, up to the order's page; returns the invoice and the owner code the browser made for it.
export async function startOrder(page: Page, label: string, opts: OrderOptions = {}): Promise<{ invoiceId: string; ownerCode: string }> {
  await search(page, label)
  await toReview(page)
  await page.getByRole("radio", { name: METHOD_NAMES[opts.method ?? "btc"] }).click()
  const pay = payButton(page)
  await expect(pay).toBeEnabled()
  const ownerCode = await checkoutOwnerCode(page)
  if (opts.shots) await shot(page, `${opts.shots}-checkout`)
  await pay.click()
  await page.waitForURL(/\?order=/)
  // the order's page has replaced the checkout in view, whose Pay a later locator would find otherwise
  await expect(onStep(page).getByRole("heading", { name: "Check your order" })).toHaveCount(0)
  return { invoiceId: new URL(page.url()).searchParams.get("order")!, ownerCode }
}

const CSP_REPORT = "reportCspViolation"

// The mock counts its rate limits per client, by X-Forwarded-For as the service behind a proxy does, so each test is a
// client of its own, and so is each browser it opens.
const OCTET = 256
export const newClient = () => ({ "x-forwarded-for": `10.${randomInt(OCTET)}.${randomInt(OCTET)}.${randomInt(OCTET)}` })

// Every page's CSP refusals fail its test, in the test's own context and in every context it opens; only a server that
// sends the policy, as `vite preview` does, makes any.
export const test = base.extend<{ cspViolations: void }>({
  baseURL: async ({ baseURL }, use) => use(baseURL ?? pageUrl(SLOT)),
  extraHTTPHeaders: async ({ extraHTTPHeaders }, use) => use({ ...extraHTTPHeaders, ...newClient() }),
  cspViolations: [async ({ context, browser }, use) => {
    const refused: string[] = []
    const watch = async (watched: BrowserContext) => {
      await watched.exposeBinding(CSP_REPORT, (_source, text: string) => { refused.push(text) })
      await watched.addInitScript((report) => document.addEventListener("securitypolicyviolation", (e) => {
        const send = (window as unknown as Record<string, (text: string) => void>)[report]
        void send(`${e.effectiveDirective} refused ${e.blockedURI || "inline"} ${e.sample}`.trim())
      }, true), CSP_REPORT)
    }
    await watch(context)
    // the browser is the worker's: the maker set on it is deleted after the test, so its class's own shows again
    const newContext = browser.newContext.bind(browser)
    browser.newContext = async (options?: BrowserContextOptions) => {
      const made = await newContext({ ...options, extraHTTPHeaders: { ...newClient(), ...options?.extraHTTPHeaders } })
      await watch(made)
      return made
    }
    try {
      await use()
    } finally {
      delete (browser as Partial<Browser>).newContext
    }
    expect(refused, "CSP violations").toEqual([])
  }, { auto: true }],
})

// a paid order's page once someone registered its name first, which keeps the payment as the order's balance
export const takenHeading = (label: string) => `${label}.simplex was taken`

// An order paid in Bitcoin whose name a rival registers first, up to its taken page.
export async function takenOrder(page: Page, request: APIRequestContext, label: string): Promise<{ invoiceId: string; ownerCode: string }> {
  const order = await startOrder(page, label, { method: "btc" })
  await control(request, "take", { label })
  await control(request, `settle/${order.invoiceId}`)
  await expect(page.getByRole("heading", { name: takenHeading(label) })).toBeVisible({ timeout: REGISTRATION_MS })
  return order
}

// An order paid in Bitcoin whose registration fails, up to its page.
export async function failedOrder(page: Page, request: APIRequestContext, label: string): Promise<{ invoiceId: string; registrationId: string; ownerCode: string }> {
  const order = await startOrder(page, label, { method: "btc" })
  const registrationId = await registrationOf(request, order.invoiceId)
  await control(request, `fail/${registrationId}`)
  await control(request, `settle/${order.invoiceId}`)
  await expect(page.getByRole("heading", { name: "Paid, not registered" })).toBeVisible({ timeout: REGISTRATION_MS })
  return { ...order, registrationId }
}

// The page's searches of a name answer that it is reserved, as for one the controller's owner reserved after an order's commit.
export const answersReserved = (page: Page, label: string) =>
  page.route(`**/api/name/${hex(labelHash(label))}*`, (route) => route.fulfill({ json: { status: "reserved", community: null } }))

export async function waitRegistered(page: Page, label: string): Promise<void> {
  await expect(page.getByRole("heading", { name: `${label}.simplex is yours` })).toBeVisible({ timeout: REGISTRATION_MS })
}

export const CHAIN = { resolver: "0x8A791620dd6260079BF849Dc5567aDC3F2FdC318", sponsor: "0x0B306BF915C4d645ff596e518fAf3F9669b97016", chainId: 31337, tld: "simplex" }
// the terms an available name's answer asks the buyer to agree to, as dev/deploy.ts links them
export const TERMS = { hash: GENERAL_TERMS_HASH, link: deployment.generalTermsLink }
export const LISTED_TERMS = { hash: COMMUNITY_TERMS_HASH, link: deployment.communityTermsLink }

export interface KeptOrder { registrationId: string; invoiceId: string | null; label: string; ownerCode: string; owner: string; request: { labelHash: string; commitment: string } }

// An order of `label` this browser keeps under a name code of its own, as a checkout stores one, with no service behind it.
export async function keepOrder(page: Page, registrationId: string, invoiceId: string | null, label: string, links = { contact: "", channel: "" }): Promise<KeptOrder> {
  const ownerCode = newOwnerCode()
  const owner = checksumAddress(walletOf(ownerCode)!.address)
  const request = { labelHash: hex(labelHash(label)), length: label.length, duration: 2 * YEAR_S, owner, commitment: `0x${"01".repeat(32)}`, sealed: "sealed" }
  const record = { registrationId, invoiceId, label, ownerCode, owner, ...links, method: invoiceId ? "btc" : "code", paid: 10000, years: 2, tld: "simplex",
    createdAt: new Date().toISOString(), request }
  await page.goto("/#/trademarks")
  await page.evaluate((r) => localStorage.setItem(`simplex-names:order:${r.registrationId}`, JSON.stringify(r)), record)
  return record
}

// The service's view of a kept order's registration, as its API answers it.
export const registrationView = (o: KeptOrder, change: Record<string, unknown> = {}) => ({
  ...CHAIN, id: o.registrationId, version: 1, unread: [], moves: 0, phase: "unpaid", labelHash: o.request.labelHash, label: o.label, owner: o.owner, commitment: o.request.commitment, sealed: "sealed",
  years: 2, duration: 2 * YEAR_S, price: 10000, fromBalance: 0, balance: null, commitTx: null, registerTx: null, revealAfter: null, revealBefore: null, intentNonce: null, acceptance: null, expiresAt: null, error: null, linksRefused: false, latePayment: null,
  community: null, terms: PLAIN_TERMS, ...change,
})

// A registered name of this browser's code, as the service answers it, holding `links` until `records` answers otherwise.
export async function fakeRegisteredName(page: Page, label: string, links: { contact: string; channel: string },
  records: () => { links: { contact: string; channel: string }; nonce: number } = () => ({ links, nonce: 0 })): Promise<KeptOrder> {
  const order = await keepOrder(page, `reg-${label.slice(0, 12)}`, null, label, links)
  const expiresAt = Math.floor(Date.now() / 1000) + YEAR_S
  await page.route(`**/api/registration/${order.registrationId}*`, (route) => route.fulfill({ json: registrationView(order, { phase: "registered", commitTx: "0x02", registerTx: "0x03", expiresAt }) }))
  await page.route("**/api/name/**", (route) => {
    const now = records()
    return route.fulfill({ json: { status: "registered", entities: [], owner: order.owner, resolver: CHAIN.resolver, chainId: CHAIN.chainId, records: now.links, recordsNonce: now.nonce,
      recordEdits: { left: 3, nextAt: null }, expiresAt, tld: "simplex", community: null } })
  })
  return order
}

// The first character of each line a text is drawn in.
export const lineStarts = (text: Locator) => text.evaluate((root) => {
  const starts: string[] = []
  let top = -Infinity
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    for (let i = 0; i < node.textContent!.length; i++) {
      const range = document.createRange()
      range.setStart(node, i)
      range.setEnd(node, i + 1)
      const at = range.getBoundingClientRect().top
      if (at > top + 1) starts.push(node.textContent![i])
      top = Math.max(top, at)
    }
  }
  return starts
})
