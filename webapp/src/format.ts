// How amounts, dates and addresses read on the page.

export function dollars(cents: number, withCents = false): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: withCents ? 2 : 0, maximumFractionDigits: withCents ? 2 : 0 })}`
}

// word joiners keep a shortened address on one line
export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}\u2060…\u2060${address.slice(-4)}`
}

export function letters(n: number): string {
  return n === 1 ? "1 letter" : `${n} letters`
}

export function shortHash(hash: string): string {
  return `${hash.slice(0, 6)}…${hash.slice(-4)}`
}

// the day stays with its month on one line
export function dateOf(seconds: number, short = false): string {
  return new Date(seconds * 1000).toLocaleDateString("en-GB", { day: "numeric", month: short ? "short" : "long", year: "numeric", timeZone: "UTC" }).replace(" ", "\u00a0")
}

// a dot between parts of a line moves to the next line with the part after it, never left at a line's end
export const SEP = " \u00b7\u00a0"

// what a registration of these years runs to, counted from now: the paid years and the 30 bonus days
export function untilFromNow(years: number): number {
  return Math.floor(Date.now() / 1000) + (years * 365 + 30) * 86400
}

export function termText(years: number): string {
  return `${years} years + 30 days`
}

export function seconds(n: number): string {
  return n === 1 ? "1 second" : `${n} seconds`
}

export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

export function methodName(method: string): string {
  return ({ card: "Card", btc: "Bitcoin", xmr: "Monero", code: "Code" } as Record<string, string>)[method] ?? method
}
