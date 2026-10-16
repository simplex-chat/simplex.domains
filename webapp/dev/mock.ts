// The mock names service's HTTP server: the API under /api, and controls for tests under /control.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import {
  cancelInvoice, checkCode, controlInvoice, controlRegistration, controlSearch, controlTake, createInvoice, dump, editRecords, find,
  HttpError, issueCode, oneOrderAtATime, setCodeState, previewLink, readInvoice, readRegistration, registerWithCode, retarget, retry, reveal, search, takenCode,
} from "./mock/service.ts"

const PORT = Number(process.env.MOCK_PORT ?? "8099")
// all interfaces only where the network around is private, as compose's
const HOST = process.env.MOCK_HOST ?? "127.0.0.1"
const MAX_BODY = 16384

type Handler = (match: RegExpMatchArray, body: Record<string, unknown>, query: URLSearchParams) => Promise<unknown> | unknown

const routes: [string, RegExp, Handler][] = [
  ["GET", /^\/api\/name\/([^/]+)$/, (m, _, q) => search(m[1], q.get("length"))],
  ["POST", /^\/api\/link\/preview$/, (_, b) => previewLink(b)],
  ["POST", /^\/api\/code\/check$/, (_, b) => checkCode(b)],
  ["POST", /^\/api\/invoice$/, (_, b) => oneOrderAtATime(() => createInvoice(b))],
  ["GET", /^\/api\/invoice\/([^/]+)$/, (m, _, q) => readInvoice(m[1], q.get("wait"), q.get("seenPhase"), q.get("seenPaid"), q.get("seenFull") === "1")],
  ["POST", /^\/api\/invoice\/([^/]+)\/cancel$/, (m) => cancelInvoice(m[1])],
  ["POST", /^\/api\/name\/register$/, (_, b) => oneOrderAtATime(() => registerWithCode(b))],
  ["POST", /^\/api\/name\/records$/, (_, b) => editRecords(b)],
  ["POST", /^\/api\/registration\/find$/, (_, b) => find(b)],
  ["GET", /^\/api\/registration\/([^/]+)$/, (m, _, q) => readRegistration(m[1], q.get("seenPhase"))],
  ["POST", /^\/api\/registration\/([^/]+)\/reveal$/, (m, b) => reveal(m[1], b)],
  ["POST", /^\/api\/registration\/([^/]+)\/name$/, (m, b) => oneOrderAtATime(() => retarget(m[1], b))],
  ["POST", /^\/api\/registration\/([^/]+)\/code$/, (m, b) => oneOrderAtATime(() => takenCode(m[1], b))],
  ["POST", /^\/api\/registration\/([^/]+)\/retry$/, (m) => retry(m[1])],
  ["POST", /^\/control\/(settle|partial|confirming|expire)\/([^/]+)$/, (m) => controlInvoice(m[1], m[2])],
  ["POST", /^\/control\/(fail)\/([^/]+)$/, (m) => controlRegistration(m[1], m[2])],
  ["POST", /^\/control\/take$/, (_, b) => controlTake(b.label)],
  ["POST", /^\/control\/search$/, (_, b) => controlSearch(b)],
  ["POST", /^\/control\/code\/state$/, (_, b) => setCodeState(b.code, b.state)],
  ["POST", /^\/control\/code$/, (_, b) => ({ code: issueCode(Number(b.minLength), Number(b.years ?? 2), (b.state ?? "unused") as never) })],
  ["GET", /^\/control\/state$/, () => dump()],
]

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new HttpError(400, "bad_request")
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    return typeof body === "object" && body !== null ? body : {}
  } catch {
    throw new HttpError(400, "bad_request")
  }
}

function reply(res: ServerResponse, status: number, body: unknown, retryAfter: number | null = null): void {
  const text = JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v))
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...(retryAfter ? { "retry-after": String(retryAfter) } : {}) })
  res.end(text)
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://mock")
  const route = routes.find(([method, path]) => method === req.method && path.test(url.pathname))
  if (!route) return reply(res, 404, { error: "not_found" })
  try {
    const body = req.method === "POST" ? await readBody(req) : {}
    reply(res, 200, await route[2](url.pathname.match(route[1])!, body, url.searchParams))
  } catch (e) {
    if (e instanceof HttpError) return reply(res, e.status, e.body, e.retryAfter)
    console.error(e)
    reply(res, 500, { error: "internal" })
  }
})

server.listen(PORT, HOST, () => {
  console.log(`mock names service on http://${HOST}:${PORT}`)
  const seeded = { unused: issueCode(6, 5, "unused"), used: issueCode(6, 2, "used"), longer: issueCode(8, 2, "unused") }
  console.log(`prepaid codes: ${JSON.stringify(seeded)}`)
})
