// The name and link rules the page checks before sending, and the service checks again.

export const MIN_LABEL_LENGTH = 6
export const MAX_LABEL_LENGTH = 63
// a record value's bound, as the service enforces it
export const LINK_MAX_BYTES = 4096

export type LabelProblem = "short" | "long" | "chars"

// simplexmq's nameLabelP: a-z and 0-9, each hyphen between a letter or digit on both sides
const LABEL = /^[a-z0-9]+(-[a-z0-9]+)*$/

// characters that show nothing, as a link pasted from a chat can carry: a name typed with them is the name without them
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF]/g

// the search box shows ".simplex" after the input, so a name typed with it is the same name
export function foldLabel(input: string): string {
  return input.replace(INVISIBLE, "").trim().toLowerCase().replace(/\.simplex$/, "")
}

export function labelProblem(label: string): LabelProblem | null {
  if (!LABEL.test(label)) return "chars"
  if (label.length < MIN_LABEL_LENGTH) return "short"
  if (label.length > MAX_LABEL_LENGTH) return "long"
  return null
}

export type LinkKind = "contact" | "channel"

// The app reads a name's first short link of the right type, so only one short link per key is useful. A link's query may
// carry its other servers' hosts, joined by an escaped comma, as the chat core writes them.
const SHORT_LINK: Record<LinkKind, RegExp> = {
  contact: /^(https:\/\/[a-z0-9.-]+\/a|simplex:\/a)#[A-Za-z0-9_-]+(\?([A-Za-z0-9_=&.-]|%2C)*)?$/,
  channel: /^(https:\/\/[a-z0-9.-]+\/c|simplex:\/c)#[A-Za-z0-9_-]+(\?([A-Za-z0-9_=&.-]|%2C)*)?$/,
}

export const linkTooLong = (link: string) => new TextEncoder().encode(link).length > LINK_MAX_BYTES

export function linkProblem(kind: LinkKind, link: string): "kind" | "long" | null {
  if (linkTooLong(link)) return "long"
  return SHORT_LINK[kind].test(link) ? null : "kind"
}

export function linkKind(link: string): LinkKind | null {
  if (linkProblem("contact", link) === null) return "contact"
  if (linkProblem("channel", link) === null) return "channel"
  return null
}
