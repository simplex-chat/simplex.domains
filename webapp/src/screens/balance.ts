import { holdsPayment, type InvoiceView } from "../api.ts"
import { timeOf } from "../format.ts"

// A held balance is read again no sooner than this after the last read, whatever its holder does meanwhile, and at this
// pace while the holder's payment is being confirmed, which has no set end.
export const BALANCE_READ_MS = 3000
export const CONFIRMING_READ_MS = 15_000

// how long a balance stays held: until its holder's invoice expires, or while money that reached it is being confirmed
export const heldWords = (heldUntil: string | null) => heldUntil ? `until ${timeOf(Date.parse(heldUntil))}` : "while its payment is being confirmed"

// The holder's invoice is followed while it is open and says nothing new of the hold: money reaching it ends the hold's
// time, which the view, read again, then shows as a payment being confirmed.
export const holderStill = (invoice: InvoiceView | null, heldUntil: string | null) =>
  invoice?.status === "open" && !(heldUntil !== null && holdsPayment(invoice))

// The wait before a held balance is read again, from the read at `readAt`: until its holder's invoice expires, or a
// confirming pause, and never less than the minimum. A hold that may have ended, its holder followed until it closed or
// no longer named by find, needs only the minimum.
export function holdWait(heldUntil: string | null, ended: boolean, readAt: number, now: number): number {
  const due = ended ? readAt : heldUntil ? Date.parse(heldUntil) : readAt + CONFIRMING_READ_MS
  return Math.max(0, Math.max(due, readAt + BALANCE_READ_MS) - now)
}
