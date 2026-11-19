const RealDate = Date
let offsetMs = 0

class MockDate extends RealDate {
  constructor(...args: [] | [string | number | Date]) {
    if (args.length === 0) super(RealDate.now() + offsetMs)
    else super(args[0])
  }

  static now(): number {
    return RealDate.now() + offsetMs
  }
}

globalThis.Date = MockDate as DateConstructor

export function setClock(ms: number): void {
  offsetMs = ms - RealDate.now()
}
