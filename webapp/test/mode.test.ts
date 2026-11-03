import { readFileSync } from "node:fs"
import { afterEach, describe, expect, it, vi } from "vitest"
import { withMode } from "../dev/mode.ts"
import { codesOnly, MODE_META, modeOf, pageMode } from "../src/mode.ts"

const INDEX = readFileSync(new URL("../index.html", import.meta.url), "utf8")

// a document whose head holds the mode's meta with this content, or none
function pageWith(content: string | null): void {
  const meta = content === null ? null : { getAttribute: (name: string) => name === "content" ? content : null }
  vi.stubGlobal("document", { querySelector: (selector: string) => selector === `meta[name="${MODE_META}"]` ? meta : null })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("modeOf", () => {
  it("reads codes only from the word codes, around any spaces", () => {
    expect(modeOf("codes")).toBe("codes")
    expect(modeOf(" codes\n")).toBe("codes")
  })
  it("reads open from open, an empty or missing content and any other word", () => {
    expect(modeOf("open")).toBe("open")
    expect(modeOf("")).toBe("open")
    expect(modeOf(null)).toBe("open")
    expect(modeOf(undefined)).toBe("open")
    expect(modeOf("Codes"), "the service writes the word in lower case").toBe("open")
    expect(modeOf("codes_only")).toBe("open")
  })
})

describe("pageMode", () => {
  it("is the meta's mode, as the service rewrote it", () => {
    pageWith("codes")
    expect(pageMode()).toBe("codes")
    expect(codesOnly()).toBe(true)
    pageWith("open")
    expect(pageMode()).toBe("open")
    expect(codesOnly()).toBe(false)
  })
  it("is open on a page without the meta, as an older cached shell", () => {
    pageWith(null)
    expect(pageMode()).toBe("open")
    expect(codesOnly()).toBe(false)
  })
})

describe("index.html", () => {
  it("carries the meta exactly as the service looks for it, saying open", () => {
    expect(INDEX).toContain('<meta name="simplex-names-mode" content="open">')
    expect(INDEX.match(/simplex-names-mode/g)).toHaveLength(1)
  })
})

describe("withMode", () => {
  it("rewrites the meta's content to the mode, as the service does", () => {
    const codes = withMode(INDEX, "codes")
    expect(codes).toContain('<meta name="simplex-names-mode" content="codes">')
    expect(codes).not.toContain('content="open"')
    expect(codes.replace('content="codes"', 'content="open"')).toBe(INDEX)
  })
  it("leaves the page as it is for open", () => {
    expect(withMode(INDEX, "open")).toBe(INDEX)
  })
})
