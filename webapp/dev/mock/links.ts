// The chat core's own form of a short link (simplexmq ConnShortLink strEncode): every server's host in `h`, the link's
// host first, joined by an escaped comma, then its port and key hash. Null for a link the core cannot parse.
const SHORT_LINK = /^(?:https:\/\/([^/?#]+)|simplex:)\/([ac])#([^?]+)(?:\?(.*))?$/
const HOST_SEPARATOR = "%2C"
// the core decodes the key as base64url and refuses a text that does not encode back to itself, as one with a stray last character
const coreReadsKey = (key: string) => Buffer.from(key, "base64url").toString("base64url") === key
export function deepLinkOf(link: string): string | null {
  const parts = SHORT_LINK.exec(link)
  if (!parts || !coreReadsKey(parts[3])) return null
  const [, host, type, key, query = ""] = parts
  const params = new URLSearchParams(query)
  const hosts = [...(host ? [host] : []), ...(params.get("h")?.split(",") ?? [])]
  // a simplex:/ link names its servers in `h` alone
  if (hosts.length === 0) return null
  const rest = (["p", "c"] as const).flatMap((k) => { const v = params.get(k); return v ? [`${k}=${v}`] : [] })
  return `simplex:/${type}#${key}?${[`h=${hosts.join(HOST_SEPARATOR)}`, ...rest].join("&")}`
}
