import { describe, expect, it } from "vitest"
import { blocksOf, spansOf } from "../src/markdown.ts"

describe("blocksOf", () => {
  it("reads headings, paragraphs whose lines it joins, and lists whose items continue on the lines under them", () => {
    const text = "# Terms\n\nThese terms apply to every name\non the list.\n\n## What a name is for\n\nThe holder must not:\n\n"
      + "- use the name for other\n  purposes;\n- keep it idle.\n\n1. first\n2) second\n"
    expect(blocksOf(text)).toEqual([
      { kind: "heading", level: 1, text: "Terms" },
      { kind: "paragraph", text: "These terms apply to every name on the list." },
      { kind: "heading", level: 2, text: "What a name is for" },
      { kind: "paragraph", text: "The holder must not:" },
      { kind: "list", ordered: false, items: ["use the name for other purposes;", "keep it idle."] },
      { kind: "list", ordered: true, items: ["first", "second"] },
    ])
  })

  it("ends a paragraph or a list at a heading or a blank line, and starts another list where the kind of item changes", () => {
    expect(blocksOf("a\n# b\nc\r\n\r\nd\n- e\n1. f")).toEqual([
      { kind: "paragraph", text: "a" },
      { kind: "heading", level: 1, text: "b" },
      { kind: "paragraph", text: "c" },
      { kind: "paragraph", text: "d" },
      { kind: "list", ordered: false, items: ["e"] },
      { kind: "list", ordered: true, items: ["f"] },
    ])
  })

  it("reads any other markup as the text it is", () => {
    expect(blocksOf("#no heading\n---\n> quoted\n[a link](https://simplex.chat)")).toEqual([
      { kind: "paragraph", text: "#no heading --- > quoted [a link](https://simplex.chat)" },
    ])
    expect(blocksOf("")).toEqual([])
  })
})

describe("spansOf", () => {
  it("marks **strong** and *emphasised* runs, and keeps the rest as it is", () => {
    expect(spansOf("use it **in good faith**, for *its* community")).toEqual([
      { text: "use it ", strong: false, em: false },
      { text: "in good faith", strong: true, em: false },
      { text: ", for ", strong: false, em: false },
      { text: "its", strong: false, em: true },
      { text: " community", strong: false, em: false },
    ])
    expect(spansOf("2 * 3 = 6, a_b_c")).toEqual([{ text: "2 * 3 = 6, a_b_c", strong: false, em: false }])
  })
})
