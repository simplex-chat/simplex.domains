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
const CONFIG = "/api/config"
const PRECACHED = new Set(PRECACHE)

// The whole routing decision, from the URL alone.
function strategyFor(url) {
  if (url.origin !== self.location.origin) return "bypass"
  if (url.pathname === CONFIG) return "config"
  // before anything that could reach a cache: an order, a name or a code read from a cache would show a past state
  if (/^\/(api|control)(\/|$)/.test(url.pathname)) return "network-only"
  if (url.pathname === SHELL || url.pathname === "/index.html") return "shell"
  if (PRECACHED.has(url.pathname)) return "asset"
  return "bypass"
}

const isThisBuildsShell = async (response) => (await response.clone().text()).includes(ENTRY)

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
    if (!(await isThisBuildsShell(shell))) throw new Error("sw: the document at / is not this build's shell")
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

// Network first for the shell, the one file whose URL names no build: it decides which build a page runs, so a
// reachable server's answer always wins, however long it takes.
async function shellFirst(event) {
  let fresh
  try {
    // every page is the same document, kept under one key; reload, as the HTTP cache can keep an old build too
    fresh = await fetch(SHELL, { cache: "reload", credentials: "same-origin" })
  } catch {
    // offline, or the server is down: the cached shell is what is left
  }
  // the browser follows a redirect of the page itself, as a portal's, which a redirected answer cannot stand for
  if (fresh?.redirected) return fetch(event.request)
  if (fresh?.ok) {
    event.waitUntil(keepShell(fresh.clone()))
    return fresh
  }
  const hit = await (await caches.open(CACHE)).match(SHELL, MATCH)
  return hit ?? fetch(event.request)
}

// A newer build's shell names modules this cache does not have, and a portal's page names none.
async function keepShell(shell) {
  if (await isThisBuildsShell(shell)) await (await caches.open(CACHE)).put(SHELL, shell)
}

// Network first, as the mode decides what a page offers; offline, the service's last answer, so the page opens in
// the mode it gave then.
async function configFirst(event) {
  let fresh
  try {
    fresh = await fetch(event.request)
  } catch {}
  if (fresh?.ok) {
    event.waitUntil(caches.open(CACHE).then((cache) => cache.put(CONFIG, fresh.clone())))
    return fresh
  }
  const hit = await (await caches.open(CACHE)).match(CONFIG, MATCH)
  return hit ?? fresh ?? fetch(event.request)
}

self.addEventListener("fetch", (event) => {
  const request = event.request
  if (request.method !== "GET") return
  const strategy = strategyFor(new URL(request.url))
  // not answering leaves the request to the browser, so the API never passes through the Cache API
  if (strategy === "network-only" || strategy === "bypass") return
  if (strategy === "shell" && request.mode !== "navigate") return
  event.respondWith(strategy === "config" ? configFirst(event) : strategy === "shell" ? shellFirst(event) : fromPrecache(request))
})

self.sw = { BUILD, CACHE, CONFIG, ENTRY, PRECACHE, SHELL, strategyFor }
