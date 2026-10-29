// The service's code limit (codeLimit in StoreService.Web.Http): the code checks and code orders a client may make in a
// minute, counted in a window that starts at its first request.
export const CODE_LIMIT = 10
const LIMIT_WINDOW_MS = 60_000
const windows = new Map<string, { count: number; started: number }>()

// The request counts, and null is returned, or the seconds left until the client's window ends.
export function takeCodeToken(client: string, now = Date.now()): number | null {
  const window = windows.get(client)
  if (window && now - window.started < LIMIT_WINDOW_MS) {
    if (window.count >= CODE_LIMIT) return Math.max(1, Math.ceil((window.started + LIMIT_WINDOW_MS - now) / 1000))
    window.count += 1
    return null
  }
  for (const [key, ended] of windows) if (now - ended.started >= LIMIT_WINDOW_MS) windows.delete(key)
  windows.set(client, { count: 1, started: now })
  return null
}
