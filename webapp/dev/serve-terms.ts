import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const PORT = 8098
const DIR = process.env.TERMS_DIR ?? new URL("./terms/", import.meta.url).pathname
const FILE = /^\/terms\/([0-9a-f]{64}\.md)$/

export function savedTerms(text: Uint8Array | string): string {
  const digest = createHash("sha256").update(text).digest("hex")
  mkdirSync(DIR, { recursive: true })
  writeFileSync(join(DIR, `${digest}.md`), text)
  return `http://127.0.0.1:${PORT}/terms/${digest}.md#sha256=${digest}`
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  createServer(async (req, res) => {
    const file = FILE.exec(req.url ?? "")?.[1]
    const text = req.method === "GET" && file ? await readFile(join(DIR, file)).catch(() => null) : null
    if (text) res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" }).end(text)
    else res.writeHead(404).end()
  }).listen(PORT, process.env.TERMS_HOST ?? "127.0.0.1", () => console.log(`terms texts on http://127.0.0.1:${PORT}/terms/`))
}
