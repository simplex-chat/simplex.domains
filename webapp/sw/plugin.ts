// Puts the service worker into the build: sw/worker.js with the build's hash, its entry module and every file it ships,
// so a worker and the shell it keeps are always of one build.
import { createHash } from "node:crypto"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import type { Plugin } from "vite"

export interface WorkerBuild { build: string; entry: string; precache: string[] }

export const WORKER_TEMPLATE = new URL("./worker.js", import.meta.url)
// the shell is fetched and checked on its own; the rest the page never asks for
const NOT_PRECACHED = /^(index\.html|robots\.txt|sw\.js)$|\.map$/
const BUILD_ID_LENGTH = 16

export function workerSource(template: string, { build, entry, precache }: WorkerBuild): string {
  let source = template
  const set = (name: string, value: unknown) => {
    const line = new RegExp(`^const ${name} = .*$`, "m")
    if (!line.test(source)) throw new Error(`sw: worker.js has no ${name} constant`)
    source = source.replace(line, `const ${name} = ${JSON.stringify(value)}`)
  }
  set("BUILD", build)
  set("ENTRY", entry)
  set("PRECACHE", precache)
  return source
}

// public/ holds per-file links, which the build copies as the files they point at
function filesIn(dir: string, under = ""): string[] {
  return readdirSync(join(dir, under)).flatMap((name) => {
    const path = under ? `${under}/${name}` : name
    return statSync(join(dir, path)).isDirectory() ? filesIn(dir, path) : [path]
  })
}

export function serviceWorker(): Plugin {
  let publicDir = ""
  return {
    name: "service-worker",
    apply: "build",
    configResolved(config) {
      publicDir = config.publicDir
    },
    generateBundle(_, bundle) {
      const hash = createHash("sha256")
      const precache: string[] = []
      let entry = ""
      // a bundled file's name carries a hash of its content
      for (const file of Object.values(bundle)) {
        if (NOT_PRECACHED.test(file.fileName)) continue
        precache.push(`/${file.fileName}`)
        hash.update(file.fileName)
        if (file.type === "chunk" && file.isEntry) entry = `/${file.fileName}`
      }
      for (const path of filesIn(publicDir)) {
        if (NOT_PRECACHED.test(path)) continue
        precache.push(`/${path}`)
        hash.update(path).update(readFileSync(join(publicDir, path)))
      }
      if (!entry) this.error("sw: the build has no entry module")
      const build = hash.digest("hex").slice(0, BUILD_ID_LENGTH)
      this.emitFile({ type: "asset", fileName: "sw.js", source: workerSource(readFileSync(WORKER_TEMPLATE, "utf8"), { build, entry, precache: precache.sort() }) })
    },
  }
}
