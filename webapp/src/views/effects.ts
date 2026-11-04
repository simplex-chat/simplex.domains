export function every(ms: number, f: () => void, signal: AbortSignal): void {
  if (signal.aborted) return
  const id = setInterval(f, ms)
  signal.addEventListener("abort", () => clearInterval(id), { once: true })
}

export function after(ms: number, f: () => void, signal: AbortSignal): () => void {
  if (signal.aborted) return () => undefined
  const stop = () => clearTimeout(id)
  const id = setTimeout(() => {
    signal.removeEventListener("abort", stop)
    f()
  }, ms)
  signal.addEventListener("abort", stop, { once: true })
  return () => {
    stop()
    signal.removeEventListener("abort", stop)
  }
}
