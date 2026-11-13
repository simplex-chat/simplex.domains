import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { untilChainTime } from "../dev/chain-time.ts"

describe("waiting for the local chain's time", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })
  afterEach(() => vi.useRealTimers())

  it("sleeps until the wall clock reaches the time, then reads blocks until the latest one has", async () => {
    const reads: number[] = []
    const chainNow = async () => {
      reads.push(Date.now())
      return Math.floor(Date.now() / 1000) - 2
    }
    let done = false
    void untilChainTime(1_005, chainNow).then(() => { done = true })
    await vi.advanceTimersByTimeAsync(4_999)
    expect(reads, "no block read before the wall clock reaches the time").toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(reads).toEqual([1_005_000])
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(done, `done once a block reads 1005, after reads at ${reads.join(", ")}`).toBe(true)
    expect(Math.floor(reads.at(-1)! / 1000) - 2).toBe(1_005)
  })

  it("returns after one read when the chain is already there", async () => {
    const chainNow = vi.fn(async () => 2_000)
    await untilChainTime(1_000, chainNow)
    expect(chainNow).toHaveBeenCalledTimes(1)
  })
})
