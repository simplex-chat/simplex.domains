import { defineConfig, devices } from "@playwright/test"

// BASE_URL points the tests at another server, such as `npx vite preview` of the production build
const BASE_URL = process.env.BASE_URL

// The dev backend (dev/start.sh: anvil, contracts, mock) must already run; the tests share its chain.
export default defineConfig({
  testDir: "e2e",
  // one chain and one sending key: orders run one at a time
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  // The page's motion fades content out over what replaces it, which text queries would see twice; the specs check what
  // the page does with the motion off, as a reader who asks for less motion gets it, and motion.spec.ts checks the motion.
  use: { baseURL: BASE_URL ?? "http://127.0.0.1:5173", reducedMotion: "reduce" },
  // Firefox grants clipboard writes from a click without a permission, and has no permission to grant
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"], viewport: { width: 1280, height: 900 } } },
    // the engine behind Safari
    { name: "webkit", use: { ...devices["Desktop Safari"], viewport: { width: 1280, height: 900 } } },
  ],
  webServer: BASE_URL ? undefined : { command: "npx vite --host 127.0.0.1", url: "http://127.0.0.1:5173", reuseExistingServer: true },
})
