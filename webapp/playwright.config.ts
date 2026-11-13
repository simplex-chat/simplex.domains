import { defineConfig, devices } from "@playwright/test"
import { mockUrl, pagePort, pageUrl } from "./e2e/slots.ts"

// BASE_URL points the tests at another server, such as `npx vite preview` of the production build
const BASE_URL = process.env.BASE_URL
// one worker per backend slot, as each slot's chain has one sending key and runs its orders one at a time
const SLOTS = BASE_URL ? 1 : Number(process.env.SLOTS ?? "4")

const CHROME = { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] }
const FIREFOX = { ...devices["Desktop Firefox"], viewport: { width: 1280, height: 900 } }
const SAFARI = { ...devices["Desktop Safari"], viewport: { width: 1280, height: 900 } }

const FRAMES = /frames\.spec\.ts$/
const WEBKIT_WORKERS = 2
// A Firefox 158 or later, named by FIREFOX_158. It reports its own version rather than the one Playwright's device names,
// and finds its own libraries, which the library path set for Playwright's bundled browsers would replace.
const FIREFOX_158 = process.env.FIREFOX_158
const FIREFOX_158_PROJECT = FIREFOX_158
  ? [{ name: "firefox158", testMatch: FRAMES, use: { ...FIREFOX, userAgent: undefined, launchOptions: { channel: "moz-firefox", executablePath: FIREFOX_158, env: { ...process.env, LD_LIBRARY_PATH: "" } } } }]
  : []

// The dev backend (dev/start.sh with as many SLOTS: anvil, contracts, mock) must already run; each worker uses its own.
export default defineConfig({
  testDir: "e2e",
  workers: SLOTS,
  fullyParallel: true,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: { baseURL: BASE_URL, reducedMotion: "reduce" },
  // Firefox grants clipboard writes from a click without a permission, and has no permission to grant
  projects: [
    { name: "chromium", use: CHROME },
    { name: "firefox", testIgnore: FRAMES, use: FIREFOX },
    // WebKit draws its frames on the CPU, and three or more workers at once starve the frames its motion checks count
    { name: "webkit", testIgnore: FRAMES, workers: WEBKIT_WORKERS, use: SAFARI },
    ...FIREFOX_158_PROJECT,
  ],
  webServer: BASE_URL ? undefined : Array.from({ length: SLOTS }, (_, slot) => ({
    command: `npx vite --host 127.0.0.1 --port ${pagePort(slot)}`,
    url: pageUrl(slot),
    env: { MOCK_URL: mockUrl(slot) },
    reuseExistingServer: true,
  })),
})
