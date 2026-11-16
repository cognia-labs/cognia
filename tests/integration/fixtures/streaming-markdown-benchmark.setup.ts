// Browser globals for the streaming Markdown benchmark. Imported first, so the
// DOM exists before React DOM and the chat renderers load. jsdom is reached
// through jest-environment-jsdom, which owns it as a dependency.
import { createRequire } from "node:module"

const require = createRequire(__filename)
const jsdomPath = require.resolve("jsdom", {
  paths: [require.resolve("jest-environment-jsdom")],
})
// jsdom is not a direct dependency, so its types are not resolvable here.
const { JSDOM } = require(jsdomPath) as {
  JSDOM: new (html: string, options: Record<string, unknown>) => { window: unknown }
}

const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost/",
})
const win = dom.window as unknown as Window & typeof globalThis
const g = globalThis as Record<string, unknown>
for (const key of [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "Node",
  "Text",
  "DocumentFragment",
  "MutationObserver",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "Event",
  "CustomEvent",
  "KeyboardEvent",
  "MouseEvent",
  "AbortController",
  "AbortSignal",
] as const) {
  Object.defineProperty(g, key, {
    configurable: true,
    writable: true,
    value: (win as unknown as Record<string, unknown>)[key],
  })
}
class InertObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return []
  }
}
g.ResizeObserver = InertObserver
g.IntersectionObserver = InertObserver
win.ResizeObserver = InertObserver as never
win.IntersectionObserver = InertObserver as never
win.matchMedia = ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent: () => false,
})) as never
g.matchMedia = win.matchMedia
// jsdom has no scrolling; the chat renderers call these from animation frames.
win.HTMLElement.prototype.scrollTo = () => undefined
win.HTMLElement.prototype.scrollIntoView = () => undefined
win.scrollTo = () => undefined
g.IS_REACT_ACT_ENVIRONMENT = false
