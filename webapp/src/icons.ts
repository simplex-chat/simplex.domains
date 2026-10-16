// The page's icons: line icons on a 24-unit grid, and the payment method marks from the badges webapp's icons.ts.
const SVG_NS = "http://www.w3.org/2000/svg"

const LINE_ICONS = {
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z M21 21l-4.3-4.3",
  arrow: "M5 12h14 M12 5l7 7-7 7",
  link: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71 M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
  check: "M20 6 9 17l-5-5",
  x: "M18 6 6 18 M6 6l12 12",
  shield: "M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10Z M9 12l2 2 4-4",
  copy: "M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2Z M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2",
  phone: "M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z M12 18h.01",
  key: "M15.5 7.5a4.5 4.5 0 1 1-3.9 6.7L4 21.8 2.2 20l1.8-1.8L2.2 16.4 4 14.6l1.8 1.8 4.4-4.4a4.5 4.5 0 0 1 5.3-4.5Z",
  moon: "M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z",
  sun: "M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z M12 2v2 M12 20v2 M4.9 4.9l1.4 1.4 M17.7 17.7l1.4 1.4 M2 12h2 M20 12h2 M6.3 17.7l-1.4 1.4 M19.1 4.9l-1.4 1.4",
  alert: "M12 9v4 M12 17h.01 M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
  clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z M12 6v6l4 2",
  info: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z M12 16v-4 M12 8h.01",
  refresh: "M21 12a9 9 0 1 1-3-6.7L21 8 M21 3v5h-5",
  menu: "M4 6h16 M4 12h16 M4 18h16",
  offline: "M12 20h.01 M8.5 16.43a5 5 0 0 1 7 0 M5 12.86a10 10 0 0 1 5.17-2.69 M19 12.86a10 10 0 0 0-2-1.52 M2 8.82a15 15 0 0 1 4.18-2.64 M22 8.82a15 15 0 0 0-11.29-3.76 M2 2l20 20",
  wallet: "M20 12V8H6a2 2 0 0 1 0-4h12v4 M4 6v12a2 2 0 0 0 2 2h14v-4 M18 12a2 2 0 0 0 0 4h4v-4h-4Z",
} as const

export type IconName = keyof typeof LINE_ICONS
export type Method = "card" | "btc" | "xmr"

function svgNode(tag: string, attrs: Record<string, string>, ...kids: SVGElement[]): SVGElement {
  const node = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
  node.append(...kids)
  return node as SVGElement
}

// SVG must be created with createElementNS: createElement("svg") in an HTML document draws nothing
export function icon(name: IconName): SVGElement {
  return svgNode("svg", { viewBox: "0 0 24 24", class: "i", "aria-hidden": "true" }, svgNode("path", { d: LINE_ICONS[name] }))
}

const BITCOIN = "M23.638 14.904c-1.602 6.43-8.113 10.34-14.542 8.736C2.67 22.05-1.244 15.525.362 9.105 1.962 2.67 8.475-1.243 14.9.358c6.43 1.605 10.342 8.115 8.738 14.548v-.002zm-6.35-4.613c.24-1.59-.974-2.45-2.64-3.03l.54-2.153-1.315-.33-.525 2.107c-.345-.087-.705-.167-1.064-.25l.526-2.127-1.32-.33-.54 2.165c-.285-.067-.565-.132-.84-.2l-1.815-.45-.35 1.407s.975.225.955.236c.535.136.63.486.615.766l-1.477 5.92c-.075.166-.24.406-.614.314.015.02-.96-.24-.96-.24l-.66 1.51 1.71.426.93.242-.54 2.19 1.32.327.54-2.17c.36.1.705.19 1.05.273l-.51 2.154 1.32.33.545-2.19c2.24.427 3.93.257 4.64-1.774.57-1.637-.03-2.58-1.217-3.196.854-.193 1.5-.76 1.68-1.93h.01zm-3.01 4.22c-.404 1.64-3.157.75-4.05.53l.72-2.9c.896.23 3.757.67 3.33 2.37zm.41-4.24c-.37 1.49-2.662.735-3.405.55l.654-2.64c.744.18 3.137.524 2.75 2.084v.006z"
const MONERO_TOP = "M127.998 0C57.318 0 0 57.317 0 127.999c0 14.127 2.29 27.716 6.518 40.43H44.8V60.733l83.2 83.2 83.198-83.2v107.695h38.282c4.231-12.714 6.521-26.303 6.521-40.43C256 57.314 198.681 0 127.998 0"
const MONERO_BASE = "M108.867 163.062l-36.31-36.311v67.765H18.623c22.47 36.863 63.051 61.48 109.373 61.48s86.907-24.617 109.374-61.48h-53.933V126.75l-36.31 36.31-19.13 19.129-19.128-19.128h-.002z"
const MONERO_SCALE = "scale(0.09375)"

export function methodMark(method: Method): SVGElement {
  const box = { class: "mark", viewBox: "0 0 24 24", "aria-hidden": "true", focusable: "false" }
  switch (method) {
    case "btc":
      return svgNode("svg", box, svgNode("path", { fill: "#F7931A", d: BITCOIN }))
    case "xmr":
      return svgNode("svg", box, svgNode("g", { transform: MONERO_SCALE },
        svgNode("path", { fill: "#F60", d: MONERO_TOP }), svgNode("path", { class: "monero-base", d: MONERO_BASE })))
    case "card":
      return svgNode("svg", box,
        svgNode("rect", { x: "2", y: "5", width: "20", height: "14", rx: "2", fill: "none", stroke: "currentColor", "stroke-width": "2" }),
        svgNode("line", { x1: "2", y1: "10", x2: "22", y2: "10", stroke: "currentColor", "stroke-width": "2" }))
  }
}
