const RealDate = Date
let offsetMs = 0

class MockDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(RealDate.now() + offsetMs)
    else super(...(args as [number]))
  }

  static now(): number {
    return RealDate.now() + offsetMs
  }
}

globalThis.Date = MockDate as DateConstructor

export function setClock(ms: number): void {
  offsetMs = ms - RealDate.now()
}
