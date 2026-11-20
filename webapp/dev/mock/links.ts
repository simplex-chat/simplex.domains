// The chat core's own form of a short link (simplexmq ConnShortLink strEncode): a simplex:/ link has every server's host in
// `h`, an https:// link its first host before the path and the others in `h`, joined by an escaped comma, then its port and
// key hash. Null for a link the core cannot parse.
const SHORT_LINK = /^(?:https:\/\/([^/?#]+)|simplex:)\/([aAcC])\/?#([^?]+)(?:\?(.*))?$/
const HOST_SEPARATOR = "%2C"
// the core decodes the key as base64url and refuses a text that does not encode back to itself, as one with a stray last character
const coreReadsKey = (key: string) => Buffer.from(key, "base64url").toString("base64url") === key
function coreLinkOf(link: string, deep: boolean): string | null {
  const parts = SHORT_LINK.exec(link)
  if (!parts || !coreReadsKey(parts[3])) return null
  const [, host, type, key, query = ""] = parts
  const params = new URLSearchParams(query)
  const hosts = [...(host ? [host] : []), ...(params.get("h")?.split(",") ?? [])]
  // a simplex:/ link names its servers in `h` alone
  if (hosts.length === 0) return null
  const simplex = deep || !host
  const named = simplex ? hosts : hosts.slice(1)
  const rest = (["p", "c"] as const).flatMap((k) => { const v = params.get(k); return v ? [`${k}=${v}`] : [] })
  const fields = [...(named.length ? [`h=${named.join(HOST_SEPARATOR)}`] : []), ...rest]
  return `${simplex ? "simplex:" : `https://${host}`}/${type.toLowerCase()}#${key}${fields.length ? `?${fields.join("&")}` : ""}`
}
export const deepLinkOf = (link: string) => coreLinkOf(link, true)
export const coreLink = (link: string) => coreLinkOf(link, false)
