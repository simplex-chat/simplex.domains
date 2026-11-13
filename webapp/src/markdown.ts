// The Markdown the community terms are written in, as blocks of text for the page to draw: headings, paragraphs and
// lists, a paragraph's or an item's lines joined into one. Any other markup reads as the text it is.

export type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }

const HEADING = /^(#{1,6})\s+(.*)$/
const BULLET = /^\s*[-*+]\s+(.*)$/
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/

export function blocksOf(text: string): Block[] {
  const blocks: Block[] = []
  // the paragraph or list a line of text goes on, until a blank line or a heading ends it
  let open: Block | null = null
  for (const line of text.split(/\r?\n/)) {
    const heading = HEADING.exec(line)
    const item = BULLET.exec(line) ?? NUMBERED.exec(line)
    if (!line.trim()) open = null
    else if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2].trim() })
      open = null
    } else if (item) {
      const ordered = !BULLET.test(line)
      if (open?.kind === "list" && open.ordered === ordered) open.items.push(item[1].trim())
      else blocks.push(open = { kind: "list", ordered, items: [item[1].trim()] })
    } else if (open?.kind === "list") open.items[open.items.length - 1] += ` ${line.trim()}`
    else if (open?.kind === "paragraph") open.text += ` ${line.trim()}`
    else blocks.push(open = { kind: "paragraph", text: line.trim() })
  }
  return blocks
}

export interface Span { text: string; strong: boolean; em: boolean }

const EMPHASIS = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/

// A block's text in runs, `**strong**` and `*emphasised*` marked as such.
export function spansOf(text: string): Span[] {
  return text.split(EMPHASIS).filter(Boolean).map((part) => {
    const strong = /^\*\*.+\*\*$/.test(part)
    const em = !strong && /^\*.+\*$/.test(part)
    return { text: strong ? part.slice(2, -2) : em ? part.slice(1, -1) : part, strong, em }
  })
}
