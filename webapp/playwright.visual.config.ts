import { defineConfig, devices } from "@playwright/test"

const PREVIEW = "http://127.0.0.1:4173"
const SIZES = { desktop: { width: 1280, height: 800 }, phone: { width: 390, height: 844 } }

export default defineConfig({
  testDir: "visual",
  snapshotPathTemplate: "{testDir}/screens/{arg}-{projectName}{ext}",
  fullyParallel: true,
  reporter: [["list"]],
  use: { baseURL: PREVIEW, reducedMotion: "reduce", serviceWorkers: "block", timezoneId: "UTC" },
  projects: Object.entries(SIZES).flatMap(([size, viewport]) => (["light", "dark"] as const).map((colorScheme) => ({
    name: `${size}-${colorScheme}`, use: { ...devices["Desktop Chrome"], viewport, colorScheme },
  }))),
  webServer: { command: "npx vite build && npx vite preview --host 127.0.0.1", url: PREVIEW, timeout: 120_000 },
})
