import { describe, expect, it } from "vitest"
import { CODE_LIMIT, takeCodeToken } from "../dev/mock/limits.ts"

const START = Date.UTC(2026, 9, 22, 12)
const SECOND_MS = 1000
const WINDOW_MS = 60 * SECOND_MS

describe("the mock's code limit", () => {
  it("counts a client's first requests in a minute, then refuses each with the seconds left to the minute's end", () => {
    for (let i = 0; i < CODE_LIMIT; i++) expect(takeCodeToken("10.0.0.1", START + i * SECOND_MS), `request ${i + 1}`).toBeNull()
    expect(takeCodeToken("10.0.0.1", START + 15 * SECOND_MS)).toBe(45)
    expect(takeCodeToken("10.0.0.1", START + 15 * SECOND_MS + 1), "a part of a second is a whole one").toBe(45)
    expect(takeCodeToken("10.0.0.1", START + WINDOW_MS - 1), "never less than a second").toBe(1)
  })

  it("keeps each client's count apart", () => {
    for (let i = 0; i < CODE_LIMIT; i++) takeCodeToken("10.0.0.2", START)
    expect(takeCodeToken("10.0.0.2", START)).not.toBeNull()
    expect(takeCodeToken("10.0.0.3", START)).toBeNull()
  })

  it("starts a new minute at a client's first request after the last one ended, refusals included", () => {
    for (let i = 0; i <= CODE_LIMIT; i++) takeCodeToken("10.0.0.4", START)
    expect(takeCodeToken("10.0.0.4", START + WINDOW_MS)).toBeNull()
    for (let i = 1; i < CODE_LIMIT; i++) expect(takeCodeToken("10.0.0.4", START + WINDOW_MS + 2 * SECOND_MS), `request ${i + 1}`).toBeNull()
    expect(takeCodeToken("10.0.0.4", START + WINDOW_MS + 2 * SECOND_MS)).toBe(58)
  })
})
