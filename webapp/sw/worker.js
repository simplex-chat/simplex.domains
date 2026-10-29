// The service worker: the page and its files from this browser's cache when the network is not there, so the page,
// and Your names read from this browser's storage, open offline. A classic worker script, so its export is the
// worker's own global. sw/plugin.ts writes the three constants below into the built copy; test/sw.test.ts runs that
// copy in a Node vm with a fake Cache API and reads self.sw.

const BUILD = "dev"
// the build's entry module, which only this build's shell names
const ENTRY = "/src/main.ts"
// every file of the build but the shell, each named by its content or kept under this build's cache
const PRECACHE = []

// one cache per build, so clearing out is "everything that is not this one"
const CACHE = `names-${BUILD}`
const SHELL = "/"
// past this the cached shell is served instead; an answer that arrives later is dropped
const SHELL_TIMEOUT_MS = 3000
const PRECACHED = new Set(PRECACHE)

// The whole routing decision, from the URL alone.
function strategyFor(url) {
  if (url.origin !== self.location.origin) return "bypass"
  // before anything that could reach a cache: an order, a name or a code read from a cache would show a past state
  if (/^\/(api|control)(\/|$)/.test(url.pathname)) return "network-only"
  if (url.pathname === SHELL || url.pathname === "/index.html") return "shell"
  if (PRECACHED.has(url.pathname)) return "asset"
  return "bypass"
}

// The cache is left complete or absent: a half-filled one would serve a shell whose modules are not there.
async function precache() {
  // a change to this file alone installs again against the same cache name, which the active worker serves from;
  // only a cache this install made may be deleted
  const existed = (await caches.keys()).includes(CACHE)
  const cache = await caches.open(CACHE)
  try {
    // a proxy's or portal's page can stand at the page's own path, so the shell is checked before it is kept
    const shell = await fetch(SHELL, { cache: "reload", credentials: "same-origin" })
    if (!shell.ok) throw new Error(`sw: the shell answered ${shell.status}`)
    // a page reached by a redirect, as a portal's, cannot answer a page load: the browser takes it as a network error
    if (shell.redirected) throw new Error("sw: the shell was redirected")
    if (!(await shell.clone().text()).includes(ENTRY)) throw new Error("sw: the document at / is not this build's shell")
    await cache.put(SHELL, shell)
    // past the HTTP cache, which can hold an older copy of a file whose name carries no hash, as a font's
    await cache.addAll(PRECACHE.map((path) => new Request(path, { cache: "reload" })))
  } catch (e) {
    // a failed update keeps the build already installed, which is what an offline reader has left
    if (!existed) await caches.delete(CACHE)
    throw e
  }
}

self.addEventListener("install", (event) => {
  // Waiting for the precache first, as a worker taking over with a half-filled cache would serve a shell without its
  // modules. Without skipWaiting a new build waits for every tab of the old one to close, and a reload releases none.
  // clients.claim stays out: it would change the worker under a page whose modules are already loaded.
  event.waitUntil(precache().then(() => self.skipWaiting()))
})

self.addEventListener("activate", (event) => {
  // a page of an older build still open asks for files its cache no longer has, and gets them from the network
  event.waitUntil(caches.keys().then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)))))
})

// A file kept is this build's own whatever request headers it varies on: a server's Vary: Origin would otherwise miss
// for the page's crossorigin module, stylesheet and fonts, as the install asked for them without an Origin.
const MATCH = { ignoreVary: true }

// Cache first, as each precached file is this build's own. Nothing is written here: the worker caches one build, once.
async function fromPrecache(request) {
  const hit = await (await caches.open(CACHE)).match(request, MATCH)
  return hit ?? fetch(request)
}

// Network first for the shell, the one file whose URL names no build: it decides which build a page runs, so a cached
// one first would keep a returning reader on an old build.
async function shellFirst(request) {
  let deadline
  try {
    // every page is the same document, kept under one key; reload, as the HTTP cache can keep an old build too
    const network = fetch(SHELL, { cache: "reload", credentials: "same-origin" })
    // a captive portal or a tunnel can take the connection and never answer, which fetch does not reject
    const stall = new Promise((resolve) => { deadline = setTimeout(() => resolve(undefined), SHELL_TIMEOUT_MS) })
    const fresh = await Promise.race([network, stall])
    // the browser follows a redirect of the page itself, as a portal's, which a redirected answer cannot stand for
    if (fresh?.redirected) return fetch(request)
    if (fresh?.ok) return fresh
  } catch {
    // offline, or the server is down: the cached shell is what is left
  } finally {
    clearTimeout(deadline)
  }
  const hit = await (await caches.open(CACHE)).match(SHELL, MATCH)
  return hit ?? fetch(request)
}

self.addEventListener("fetch", (event) => {
  const request = event.request
  if (request.method !== "GET") return
  const strategy = strategyFor(new URL(request.url))
  // not answering leaves the request to the browser, so the API never passes through the Cache API
  if (strategy === "network-only" || strategy === "bypass") return
  event.respondWith(strategy === "shell" ? shellFirst(request) : fromPrecache(request))
})

self.sw = { BUILD, CACHE, ENTRY, PRECACHE, SHELL, SHELL_TIMEOUT_MS, strategyFor }
