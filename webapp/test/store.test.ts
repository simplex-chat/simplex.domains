import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

type StoreModule = typeof import("../src/store.ts")

// a localStorage holding `data`, or one that refuses every read and write, as a blocked one does
function storage(data: Map<string, string> | null) {
  const refuse = () => { throw new DOMException("refused", "SecurityError") }
  return {
    getItem: (k: string) => data ? data.get(k) ?? null : refuse(),
    setItem: (k: string, v: string) => data ? void data.set(k, v) : refuse(),
  }
}

describe("the chosen theme", () => {
  let store: StoreModule
  // each test starts with a page that has chosen nothing
  beforeEach(async () => {
    vi.resetModules()
    store = await import("../src/store.ts")
  })
  afterEach(() => vi.unstubAllGlobals())

  it("is none while nothing is kept, so the page follows the system's", () => {
    vi.stubGlobal("window", { localStorage: storage(new Map()) })
    expect(store.chosenTheme()).toBeNull()
  })

  it("is the one kept, chosen here or in another tab", () => {
    const data = new Map([["theme", "light"]])
    vi.stubGlobal("window", { localStorage: storage(data) })
    expect(store.chosenTheme()).toBe("light")
    store.setTheme("dark")
    expect(data.get("theme"), "kept where index.html reads it").toBe("dark")
    expect(store.chosenTheme()).toBe("dark")
  })

  it("ignores a kept value that is no theme", () => {
    vi.stubGlobal("window", { localStorage: storage(new Map([["theme", "sepia"]])) })
    expect(store.chosenTheme()).toBeNull()
  })

  it("is this page's choice when storage refuses it", () => {
    vi.stubGlobal("window", { localStorage: storage(null) })
    expect(store.chosenTheme(), "nothing chosen yet").toBeNull()
    store.setTheme("dark")
    expect(store.chosenTheme()).toBe("dark")
  })
})
