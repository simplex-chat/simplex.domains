import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError, LIMITED_WAIT_S, serviceNow } from "../src/api.ts"
import { NO_LEAD } from "../src/screens/hold.ts"
import { holdEnd, holdEnder, holdFrom, holding, holdLeft, secondsLeft, startHold, tabHold } from "../src/views/hold.ts"

const DAY_MS = 86_400_000
// each test starts a day after the last, past any wait an earlier one left in the module
let start = Date.parse("2026-10-18T12:00:00Z")
const limited = (retryAfter: number | null) => new ApiError("rate_limited", 429, retryAfter, {})

beforeEach(() => {
  vi.useFakeTimers()
  start += DAY_MS
  vi.setSystemTime(start)
})
afterEach(() => {
  vi.useRealTimers()
})

describe("the tab's wait", () => {
  it("holds for the seconds started, counted down in whole seconds", () => {
    expect([holding(), holdLeft()]).toEqual([false, 0])
    startHold(5)
    expect([holding(), holdLeft()]).toEqual([true, 5])
    vi.advanceTimersByTime(4001)
    expect([holding(), holdLeft()]).toEqual([true, 1])
    vi.advanceTimersByTime(999)
    expect([holding(), holdLeft()]).toEqual([false, 0])
  })
  it("is not cut by a shorter wait met meanwhile, and is lengthened by a longer one", () => {
    startHold(30)
    startHold(5)
    expect(holdLeft()).toBe(30)
    startHold(60)
    expect(holdLeft()).toBe(60)
  })
  it("holdFrom holds for a rate limit's own wait, or the usual one when it names none", () => {
    expect(holdFrom(limited(7))).toBe(true)
    expect(holdLeft()).toBe(7)
    vi.advanceTimersByTime(7000)
    expect(holdFrom(limited(null))).toBe(true)
    expect(holdLeft()).toBe(LIMITED_WAIT_S)
  })
  it("holdFrom leaves the tab alone for any other error", () => {
    for (const e of [new ApiError("network", 0, 9, {}), new ApiError("bad_request", 400, null, {}), new Error("rate_limited"), "rate_limited"]) {
      expect(holdFrom(e), String(e)).toBe(false)
    }
    expect(holding()).toBe(false)
  })
  it("holdEnd and tabHold give the wait in service time, with no words before its countdown", () => {
    expect(tabHold()).toBeNull()
    startHold(5)
    expect(holdEnd()).toBe(serviceNow() + 5000)
    expect(tabHold()).toEqual({ until: serviceNow() + 5000, lead: NO_LEAD })
  })
  it("secondsLeft counts a hold's whole seconds up on the service's clock, and none or fewer once it is over", () => {
    const hold = { until: serviceNow() + 2500, lead: NO_LEAD }
    expect(secondsLeft(hold)).toBe(3)
    vi.advanceTimersByTime(1500)
    expect(secondsLeft(hold)).toBe(1)
    vi.advanceTimersByTime(1000)
    expect(secondsLeft(hold)).toBe(0)
    vi.advanceTimersByTime(2000)
    expect(secondsLeft(hold)).toBe(-2)
  })
})

describe("holdEnder", () => {
  it("tells the screen once the wait is over, once, however often it is told the state is held", () => {
    const ended = vi.fn()
    const watch = holdEnder(new AbortController().signal, ended)
    startHold(3)
    watch(true)
    watch(true)
    vi.advanceTimersByTime(2999)
    expect(ended).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(ended).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(10_000)
    expect(ended).toHaveBeenCalledTimes(1)
  })
  it("waits out a longer wait met while it waits", () => {
    const ended = vi.fn()
    const watch = holdEnder(new AbortController().signal, ended)
    startHold(3)
    watch(true)
    vi.advanceTimersByTime(1000)
    startHold(10)
    vi.advanceTimersByTime(2000)
    expect(ended).not.toHaveBeenCalled()
    vi.advanceTimersByTime(8000)
    expect(ended).toHaveBeenCalledTimes(1)
  })
  it("stops once the state is no longer held, and starts again when it is", () => {
    const ended = vi.fn()
    const watch = holdEnder(new AbortController().signal, ended)
    startHold(3)
    watch(true)
    watch(false)
    vi.advanceTimersByTime(5000)
    expect(ended).not.toHaveBeenCalled()
    startHold(2)
    watch(true)
    vi.advanceTimersByTime(2000)
    expect(ended).toHaveBeenCalledTimes(1)
  })
  it("ends with the screen's signal", () => {
    const ended = vi.fn()
    const screen = new AbortController()
    const watch = holdEnder(screen.signal, ended)
    startHold(3)
    watch(true)
    screen.abort()
    vi.advanceTimersByTime(5000)
    expect(ended).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
  it("a state held after the wait is over hears so at once", () => {
    const ended = vi.fn()
    holdEnder(new AbortController().signal, ended)(true)
    vi.advanceTimersByTime(0)
    expect(ended).toHaveBeenCalledTimes(1)
  })
})
