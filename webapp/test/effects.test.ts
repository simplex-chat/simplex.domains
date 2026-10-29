import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { after, every } from "../src/views/effects.ts"

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe("every", () => {
  it("runs on each interval until the screen's signal ends it", () => {
    const stop = new AbortController()
    const f = vi.fn()
    every(1000, f, stop.signal)
    vi.advanceTimersByTime(3000)
    expect(f).toHaveBeenCalledTimes(3)
    stop.abort()
    vi.advanceTimersByTime(5000)
    expect(f).toHaveBeenCalledTimes(3)
  })
  it("never starts for a screen already gone", () => {
    const f = vi.fn()
    every(1000, f, AbortSignal.abort())
    vi.advanceTimersByTime(5000)
    expect(f).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe("after", () => {
  it("runs once, after its delay", () => {
    const f = vi.fn()
    after(500, f, new AbortController().signal)
    vi.advanceTimersByTime(499)
    expect(f).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    vi.advanceTimersByTime(5000)
    expect(f).toHaveBeenCalledTimes(1)
  })
  it("is stopped by the function it returns, and by the screen's signal", () => {
    const [stopped, ended] = [vi.fn(), vi.fn()]
    const screen = new AbortController()
    const stop = after(500, stopped, screen.signal)
    after(500, ended, screen.signal)
    stop()
    screen.abort()
    vi.advanceTimersByTime(1000)
    expect(stopped).not.toHaveBeenCalled()
    expect(ended).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
  it("never starts for a screen already gone, and its stop does nothing", () => {
    const f = vi.fn()
    const stop = after(500, f, AbortSignal.abort())
    stop()
    vi.advanceTimersByTime(1000)
    expect(f).not.toHaveBeenCalled()
  })
  it("lets go of the screen's signal once it has run or been stopped", () => {
    const screen = new AbortController()
    const remove = vi.spyOn(screen.signal, "removeEventListener")
    after(500, () => undefined, screen.signal)
    vi.advanceTimersByTime(500)
    after(500, () => undefined, screen.signal)()
    expect(remove).toHaveBeenCalledTimes(2)
  })
})
