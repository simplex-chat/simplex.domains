// How amounts, dates and addresses read on the page.
import { YEAR_S } from "./crypto/registration.ts"

// cents only where an amount has them, as "$100" and "$100.50"
export function dollars(cents: number): string {
  const digits = cents % 100 === 0 ? 0 : 2
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
}

// word joiners keep a shortened address on one line
export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}\u2060…\u2060${address.slice(-4)}`
}

export function letters(n: number): string {
  return n === 1 ? "1 letter" : `${n} letters`
}

// the day stays with its month on one line
export function dateOf(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).replace(" ", "\u00a0")
}

// a dot between parts of a line stays at the end of the part before it, never starting a line
export const SEP = "\u00a0\u00b7 "

const DAY_S = 86400

// the days before the paid years start, which cost nothing
export const freeDays = (termStart: number, nowS: number) => Math.max(0, Math.ceil((termStart - nowS) / DAY_S))

// the free days that follow the paid years in a term: "2 years and 72 days"
export const bonusDays = (free: number) => free === 1 ? "and 1 day" : `and ${free} days`

export const bonusHint = (years: number, termStart: number) => `Early adopter bonus: your ${years} years start on ${dateOf(termStart)}.`

// Where a term ends before it is registered: its paid years of 365 days from its start, or from now once the start has
// passed. These are not calendar years: 2 years from 1 January 2027 end on 31 December 2028.
export const termEnd = (years: number, termStart: number, nowS: number) => Math.max(nowS, termStart) + years * YEAR_S

export function seconds(n: number): string {
  return n === 1 ? "1 second" : `${n} seconds`
}

export function clock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

// a time of day on the reader's clock, as "09:05"
export const timeOf = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })

export function methodName(method: string): string {
  return ({ card: "Card", btc: "Bitcoin", xmr: "Monero", code: "Code" } as Record<string, string>)[method] ?? method
}
