import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"
import { LOCAL } from "../src/config.ts"

const PORT = Number(new URL(LOCAL.cardOrigin).port)

export default defineConfig(({ mode }) => ({
  root: fileURLToPath(new URL(".", import.meta.url)),
  envDir: fileURLToPath(new URL("..", import.meta.url)),
  define: { __MAINNET__: JSON.stringify(mode === "production") },
  server: { host: "127.0.0.1", port: PORT, strictPort: true },
  preview: { host: "127.0.0.1", port: PORT, strictPort: true },
  build: { target: "es2022", outDir: fileURLToPath(new URL("../dist-card", import.meta.url)), emptyOutDir: true },
}))
