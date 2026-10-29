import { readFileSync } from "node:fs"
import vm from "node:vm"
import { afterEach, describe, expect, it, vi } from "vitest"
import { serviceWorker, WORKER_TEMPLATE, workerSource, type WorkerBuild } from "../sw/plugin.ts"

const ORIGIN = "https://simplex.domains"
const BUILD: WorkerBuild = { build: "0123456789abcdef", entry: "/assets/index-AAAA.js", precache: ["/assets/index-AAAA.js", "/assets/index-BBBB.css", "/fonts/Manrope/Manrope-Medium-latin.woff2"] }
const SHELL_HTML = `<!doctype html><script type="module" src="${BUILD.entry}"></script>`
// a captive portal's or a proxy's page, served at the page's own path
const PORTAL_HTML = "<!doctype html><title>Sign in to the network</title>"

// a single-use body, as Cache.put refuses a body already read
interface FakeResponse { url: string; ok: boolean; status: number; body: string; redirected: boolean; bodyUsed: boolean; clone(): FakeResponse; text(): Promise<string> }
function response(url: string, status: number, body: string, redirected = false): FakeResponse {
  let used = false
  return {
    url, status, body, redirected, ok: status >= 200 && status < 300,
    get bodyUsed() { return used },
    clone() {
      if (used) throw new TypeError("Response body is already used")
      return response(url, status, body, redirected)
    },
    async text() {
      if (used) throw new TypeError("Response body is already used")
      used = true
      return body
    },
  }
}

// the worker's Request, with what the network sees of it
class FakeRequest {
  readonly url: string
  readonly cache: string
  constructor(url: string, init: { cache?: string } = {}) {
    this.url = url
    this.cache = init.cache ?? "default"
  }
}

const keyOf = (key: unknown) => new URL(typeof key === "string" ? key : (key as { url: string }).url, `${ORIGIN}/`).href

class FakeNet {
  readonly requests: { path: string; init?: unknown; cache: string }[] = []
  readonly routes = new Map<string, { status: number; body: string; redirected?: boolean }>()
  readonly stalled = new Set<string>()
  offline = false
  serve(path: string, status: number, body: string, redirected = false): void { this.routes.set(path, { status, body, redirected }) }
  readonly fetch = async (input: unknown, init?: unknown): Promise<FakeResponse> => {
    const url = keyOf(input)
    const path = url.slice(ORIGIN.length)
    const cache = (init as { cache?: string } | undefined)?.cache ?? (input instanceof FakeRequest ? input.cache : "default")
    this.requests.push({ path, init, cache })
    if (this.offline) throw new TypeError("Failed to fetch")
    if (this.stalled.has(path)) return new Promise(() => undefined)
    const hit = this.routes.get(path)
    return response(url, hit?.status ?? 404, hit?.body ?? "not found", hit?.redirected)
  }
  get paths(): string[] { return this.requests.map((r) => r.path) }
}

// whether a request carries an Origin header, as a page's crossorigin module, stylesheet and font requests do
const sendsOrigin = (key: unknown) => typeof key === "object" && (key as { mode?: string }).mode === "cors"

class FakeCache {
  readonly entries = new Map<string, FakeResponse>()
  readonly withOrigin = new Map<string, boolean>()
  private readonly net: FakeNet
  constructor(net: FakeNet) { this.net = net }
  // A new response each time, as the browser's Cache.match gives. Every answer of the fake server varies on Origin, as
  // vite preview's do, so a request differing in it misses unless the match ignores Vary.
  async match(key: unknown, options: { ignoreVary?: boolean } = {}) {
    if (!options.ignoreVary && this.withOrigin.get(keyOf(key)) !== sendsOrigin(key)) return undefined
    return this.entries.get(keyOf(key))?.clone()
  }
  async put(key: unknown, res: FakeResponse) {
    if (res.bodyUsed) throw new TypeError("Failed to execute 'put' on 'Cache': Response body is already used")
    this.entries.set(keyOf(key), res)
    this.withOrigin.set(keyOf(key), sendsOrigin(key))
  }
  // all of them or none, as the browser's addAll
  async addAll(keys: readonly string[]) {
    const got = await Promise.all(keys.map(async (k) => [k, await this.net.fetch(k)] as const))
    const bad = got.find(([, res]) => !res.ok)
    if (bad) throw new TypeError(`addAll: ${bad[0]} answered ${bad[1].status}`)
    for (const [k, res] of got) await this.put(k, res)
  }
}

class FakeCaches {
  readonly stores = new Map<string, FakeCache>()
  private readonly net: FakeNet
  constructor(net: FakeNet) { this.net = net }
  async open(name: string) {
    if (!this.stores.has(name)) this.stores.set(name, new FakeCache(this.net))
    return this.stores.get(name)!
  }
  async keys() { return [...this.stores.keys()] }
  async delete(name: string) { return this.stores.delete(name) }
}

interface Exports { BUILD: string; CACHE: string; ENTRY: string; PRECACHE: string[]; SHELL_TIMEOUT_MS: number; strategyFor(url: URL): string }
type Listener = (event: unknown) => void

// The built worker, run as the browser runs a classic worker script: its listeners, what it exports, and its world.
function startWorker(build = BUILD) {
  const net = new FakeNet()
  const caches = new FakeCaches(net)
  const listeners = new Map<string, Listener>()
  const skipWaiting = vi.fn(async () => undefined)
  const self = { location: new URL(`${ORIGIN}/`), addEventListener: (type: string, f: Listener) => listeners.set(type, f), skipWaiting } as { sw?: Exports }
  vm.runInNewContext(workerSource(readFileSync(WORKER_TEMPLATE, "utf8"), build), { self, caches, fetch: net.fetch, Request: FakeRequest, setTimeout, clearTimeout, URL, Promise, Set, Error })
  const lifecycle = async (type: "install" | "activate") => {
    const waits: Promise<unknown>[] = []
    listeners.get(type)!({ waitUntil: (p: Promise<unknown>) => waits.push(p) })
    await Promise.all(waits)
  }
  // what the worker answers a page's request with, or null when it leaves the request to the browser
  const request = (path: string, method = "GET", mode = "no-cors"): Promise<FakeResponse> | null => {
    let answer: Promise<FakeResponse> | null = null
    listeners.get("fetch")!({ request: { url: new URL(path, ORIGIN).href, method, mode }, respondWith: (p: Promise<FakeResponse>) => { answer = p } })
    return answer
  }
  return { net, caches, skipWaiting, sw: self.sw!, lifecycle, request }
}

function servedBuild(net: FakeNet, shell = SHELL_HTML): void {
  net.serve("/", 200, shell)
  for (const path of BUILD.precache) net.serve(path, 200, `contents of ${path}`)
}

afterEach(() => {
  vi.useRealTimers()
})

describe("service worker routing", () => {
  it("takes the shell from the network first, this build's files from its cache, and leaves the rest to the browser", () => {
    const { sw } = startWorker()
    const strategy = (url: string) => sw.strategyFor(new URL(url, ORIGIN))
    expect(strategy("/")).toBe("shell")
    expect(strategy("/index.html")).toBe("shell")
    // an order's link is the same document
    expect(strategy("/?order=abc#/x")).toBe("shell")
    expect(strategy("/assets/index-AAAA.js")).toBe("asset")
    expect(strategy("/fonts/Manrope/Manrope-Medium-latin.woff2")).toBe("asset")
    // an older build's file is not this build's
    expect(strategy("/assets/index-OLD.js")).toBe("bypass")
    expect(strategy("https://js.stripe.com/v3/")).toBe("bypass")
  })

  it("never answers the service's API or the test controls from a cache", () => {
    const { sw } = startWorker()
    for (const path of ["/api", "/api/name/ab", "/api/invoice/x?wait=1", "/control/search"]) expect(sw.strategyFor(new URL(path, ORIGIN)), path).toBe("network-only")
    expect(sw.strategyFor(new URL("/apiary", ORIGIN))).toBe("bypass")
  })
})

describe("service worker install and activate", () => {
  it("keeps the checked shell and every file of the build, and only then takes over", async () => {
    const w = startWorker()
    servedBuild(w.net)
    await w.lifecycle("install")
    const cache = w.caches.stores.get(w.sw.CACHE)!
    expect([...cache.entries.keys()].map((k) => k.slice(ORIGIN.length)).sort()).toEqual(["/", ...BUILD.precache].sort())
    expect(w.sw.CACHE).toBe(`names-${BUILD.build}`)
    // every file is asked of the server, past the HTTP cache, which can hold an old build's shell or font
    expect(w.net.requests.map((r) => `${r.path} ${r.cache}`).sort()).toEqual(["/", ...BUILD.precache].map((p) => `${p} reload`).sort())
    expect(w.skipWaiting).toHaveBeenCalledOnce()
  })

  it("refuses a page at / that is not this build's shell, and leaves no half-filled cache", async () => {
    const w = startWorker()
    servedBuild(w.net, PORTAL_HTML)
    await expect(w.lifecycle("install")).rejects.toThrow("not this build's shell")
    expect(w.caches.stores.has(w.sw.CACHE)).toBe(false)
    expect(w.skipWaiting).not.toHaveBeenCalled()
  })

  it("refuses a shell reached by a redirect, as a portal's, which could not answer a page load", async () => {
    const w = startWorker()
    servedBuild(w.net)
    w.net.serve("/", 200, SHELL_HTML, true)
    await expect(w.lifecycle("install")).rejects.toThrow("redirected")
    expect(w.caches.stores.has(w.sw.CACHE)).toBe(false)
  })

  it("leaves no cache when a file of the build is missing", async () => {
    const w = startWorker()
    servedBuild(w.net)
    w.net.routes.delete(BUILD.precache[1])
    await expect(w.lifecycle("install")).rejects.toThrow("answered 404")
    expect(w.caches.stores.has(w.sw.CACHE)).toBe(false)
  })

  it("keeps the installed cache when an update of this same build fails", async () => {
    const w = startWorker()
    servedBuild(w.net)
    await w.lifecycle("install")
    w.net.serve("/", 503, "down")
    await expect(w.lifecycle("install")).rejects.toThrow("answered 503")
    expect(w.caches.stores.get(w.sw.CACHE)?.entries.size).toBe(BUILD.precache.length + 1)
  })

  it("deletes every other build's cache once it is active", async () => {
    const w = startWorker()
    await w.caches.open("names-0000000000000000")
    servedBuild(w.net)
    await w.lifecycle("install")
    await w.lifecycle("activate")
    expect([...w.caches.stores.keys()]).toEqual([w.sw.CACHE])
  })
})

describe("service worker answers", () => {
  const installed = async () => {
    const w = startWorker()
    servedBuild(w.net)
    await w.lifecycle("install")
    w.net.requests.length = 0
    return w
  }

  it("serves the shell fresh from the network while it answers", async () => {
    const w = await installed()
    w.net.serve("/", 200, `${SHELL_HTML}<!-- newer -->`)
    expect(await (await w.request("/?order=abc"))!.text()).toContain("newer")
  })

  it("leaves a redirected page load to the browser, which follows the redirect itself", async () => {
    const w = await installed()
    w.net.serve("/", 200, PORTAL_HTML, true)
    w.net.serve("/?order=abc", 302, "")
    const answer = await w.request("/?order=abc")!
    // the page's own request, asked again as it was, rather than the redirected answer or the kept shell
    expect(answer.status).toBe(302)
    expect(w.net.paths).toEqual(["/", "/?order=abc"])
  })

  it("serves the kept shell offline, when the server fails, and when an answer stalls past its deadline", async () => {
    const w = await installed()
    w.net.offline = true
    expect(await (await w.request("/"))!.text()).toBe(SHELL_HTML)
    w.net.offline = false
    w.net.serve("/", 502, "bad gateway")
    expect(await (await w.request("/"))!.text()).toBe(SHELL_HTML)
    vi.useFakeTimers()
    const stalling = startWorker()
    servedBuild(stalling.net)
    await stalling.lifecycle("install")
    stalling.net.stalled.add("/")
    const answer = stalling.request("/")!
    await vi.advanceTimersByTimeAsync(stalling.sw.SHELL_TIMEOUT_MS)
    expect(await (await answer).text()).toBe(SHELL_HTML)
  })

  it("serves this build's files from its cache without asking the network, and a file not kept from the network", async () => {
    const w = await installed()
    w.net.offline = true
    expect(await (await w.request(BUILD.precache[0]))!.text()).toBe(`contents of ${BUILD.precache[0]}`)
    // the page loads its module, stylesheet and fonts crossorigin, with an Origin the install's requests had not
    for (const path of BUILD.precache) expect(await (await w.request(path, "GET", "cors"))!.text(), path).toBe(`contents of ${path}`)
    expect(w.net.paths).toEqual([])
    w.net.offline = false
    w.caches.stores.get(w.sw.CACHE)!.entries.delete(keyOf(BUILD.precache[1]))
    expect((await w.request(BUILD.precache[1]))!).toMatchObject({ status: 200 })
    expect(w.net.paths).toEqual([BUILD.precache[1]])
  })

  it("leaves the API, other origins, unknown paths and anything but GET to the browser", async () => {
    const w = await installed()
    for (const path of ["/api/name/ab", "/control/search", "https://js.stripe.com/v3/", "/assets/index-OLD.js"]) expect(w.request(path), path).toBeNull()
    expect(w.request("/", "POST")).toBeNull()
  })
})

describe("the build's worker", () => {
  const PUBLIC = new URL("../public/", import.meta.url).pathname
  // generateBundle as Vite calls it, on a bundle of the given file names
  const build = (files: { fileName: string; type: "chunk" | "asset"; isEntry?: boolean }[]) => {
    const plugin = serviceWorker() as unknown as { configResolved(c: unknown): void; generateBundle(this: unknown, o: unknown, b: unknown): void }
    plugin.configResolved({ publicDir: PUBLIC })
    let emitted = ""
    const context = { emitFile: (f: { fileName: string; source: string }) => { expect(f.fileName).toBe("sw.js"); emitted = f.source }, error: (m: string) => { throw new Error(m) } }
    plugin.generateBundle.call(context, {}, Object.fromEntries(files.map((f) => [f.fileName, f])))
    const self: { sw?: Exports } = {}
    vm.runInNewContext(emitted, { self: Object.assign(self, { location: new URL(`${ORIGIN}/`), addEventListener: () => undefined }), URL, Set })
    return self.sw!
  }
  const FILES = [
    { fileName: "index.html", type: "asset" as const },
    { fileName: "assets/index-AAAA.js", type: "chunk" as const, isEntry: true },
    { fileName: "assets/index-AAAA.js.map", type: "asset" as const },
    { fileName: "assets/index-BBBB.css", type: "asset" as const },
  ]

  it("names the entry module and precaches the bundle and public files, but not the shell, maps or robots.txt", () => {
    const sw = build(FILES)
    expect(sw.ENTRY).toBe("/assets/index-AAAA.js")
    expect(sw.PRECACHE).toContain("/assets/index-BBBB.css")
    expect(sw.PRECACHE).toContain("/favicon.ico")
    expect(sw.PRECACHE.some((p) => p.startsWith("/fonts/") && p.endsWith(".woff2"))).toBe(true)
    for (const p of ["/index.html", "/robots.txt", "/assets/index-AAAA.js.map", "/sw.js"]) expect(sw.PRECACHE).not.toContain(p)
    expect(sw.BUILD).toMatch(/^[0-9a-f]{16}$/)
  })

  it("is another build, with another cache, when any file changes", () => {
    const before = build(FILES)
    const after = build(FILES.map((f) => f.fileName.endsWith(".css") ? { ...f, fileName: "assets/index-CCCC.css" } : f))
    expect(after.BUILD).not.toBe(before.BUILD)
    expect(build(FILES).BUILD).toBe(before.BUILD)
  })

  it("refuses a bundle with no entry module, and a template missing one of its constants", () => {
    expect(() => build(FILES.filter((f) => f.type !== "chunk"))).toThrow("no entry module")
    expect(() => workerSource("const BUILD = 1\nconst ENTRY = 2\n", BUILD)).toThrow("no PRECACHE constant")
  })
})
