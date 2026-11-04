// anvil mines a block a second, so the chain is read this often, for a receipt or its time; viem would poll every 4 s
export const BLOCK_POLL_MS = 250

// the service's termStart: a name's paid years start on 1 January 2027, and the days before it are free (owner, 2026-10-20)
export const TERM_START_S = Date.UTC(2027, 0, 1) / 1000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// The contract checks a commitment's age by block time: once the latest block reaches it, every block after does too.
export async function untilChainTime(seconds: number, chainNow: () => Promise<number>): Promise<void> {
  const early = seconds * 1000 - Date.now()
  if (early > 0) await sleep(early)
  while ((await chainNow()) < seconds) await sleep(BLOCK_POLL_MS)
}
