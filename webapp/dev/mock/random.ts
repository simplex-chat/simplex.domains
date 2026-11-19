import { createHash, randomBytes as systemBytes } from "node:crypto"

let seeded: { seed: string; next: number } | null = null

export function seedRandom(seed: string | null): void {
  seeded = seed === null ? null : { seed, next: 0 }
}

export function randomBytes(size: number): Buffer {
  if (seeded === null) return systemBytes(size)
  const out = Buffer.alloc(size)
  for (let filled = 0; filled < size; filled += 32) {
    createHash("sha256").update(`${seeded.seed} ${seeded.next++}`).digest().copy(out, filled)
  }
  return out
}
