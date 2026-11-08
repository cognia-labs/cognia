/**
 * @jest-environment jsdom
 */

import {
  buildArtifactModuleSource,
  createArtifactRequire,
  installArtifactShellRuntime,
  pickArtifactComponent,
  type ArtifactShellScope,
} from "./artifact-shell-entry"
import { createContext, runInContext } from "node:vm"
import { readFileSync } from "node:fs"
import * as React from "react"
import { createRoot, type Root } from "react-dom/client"
import { act } from "@testing-library/react"

const transformer = createContext({})
runInContext(readFileSync("public/artifact-runtime/jsx-transform.js", "utf8"), transformer)
const transformClassic = (code: string): string =>
  transformer.CogniaArtifactJsx.transform(code).code

describe("pickArtifactComponent", () => {
  const fn = () => null

  it("prefers what a module explicitly exported over a stray global", () => {
    const other = () => null
    expect(pickArtifactComponent(other, null, null, { default: fn })).toBe(fn)
  })

  it("falls back through App, Component, Main", () => {
    expect(pickArtifactComponent(null, fn, null, null)).toBe(fn)
    expect(pickArtifactComponent(null, null, fn, null)).toBe(fn)
  })

  it("ignores non-function candidates", () => {
    expect(pickArtifactComponent("App", 42, null, { default: {} })).toBeNull()
  })
})

describe("buildArtifactModuleSource", () => {
  it("preserves classic var and function globals", () => {
    const context = createContext({ __cogniaArtifactPick: jest.fn() })
    context.window = context
    runInContext(
      buildArtifactModuleSource(
        'var palette = "blue"; function App(){return window.palette}',
        false
      ),
      context
    )
    expect(context.palette).toBe("blue")
    expect(context.App()).toBe("blue")
  })

  it("preserves top-level this even in a strict classic script", () => {
    const picked = jest.fn()
    const context = createContext({ React, __cogniaArtifactPick: picked })
    runInContext(
      buildArtifactModuleSource(
        '"use strict"; const R = this.React; function App(){return R}',
        false
      ),
      context
    )
    expect(picked.mock.calls[0][0]()).toBe(React)
  })

  it.each([
    'const App = () => "revision"',
    'function App(){return "revision"}',
    'let Component = () => "revision"',
    'class Main { static revision = "revision" }',
  ])("replaces repeated classic globals after the real JSX transform: %s", (code) => {
    const picked: unknown[] = []
    const context = createContext({
      __cogniaArtifactPick: (...candidates: unknown[]) =>
        picked.push(pickArtifactComponent(...(candidates as [unknown, unknown, unknown, unknown]))),
    })
    runInContext(
      buildArtifactModuleSource(transformClassic(code.replace("revision", "one")), false),
      context
    )
    runInContext(
      buildArtifactModuleSource(transformClassic(code.replace("revision", "two")), false),
      context
    )
    expect(picked).toHaveLength(2)
    expect(picked[1]).not.toBe(picked[0])
  })

  it("hands classic code the three global names verbatim", () => {
    const source = buildArtifactModuleSource("const App = () => null", false)
    expect(source).toContain("const App = () => null")
    expect(source).toContain('typeof App !== "undefined"')
    expect(source).not.toContain("__cogniaArtifactModule")
  })

  it("wraps downleveled ESM so module/exports/require are in scope", () => {
    const source = buildArtifactModuleSource('var _react = require("react")', true)
    expect(source).toContain("function (module, exports, require)")
    expect(source).toContain("__cogniaArtifactModule.exports")
  })

  it("keeps each queued module's exports local to its execution", () => {
    const picked: Array<() => string> = []
    const context = createContext({
      __cogniaArtifactModule: { exports: {} },
      __cogniaArtifactRequire: () => undefined,
      __cogniaArtifactPick: (
        _app: unknown,
        _component: unknown,
        _main: unknown,
        exports: unknown
      ) => {
        picked.push(pickArtifactComponent(null, null, null, exports) as () => string)
      },
    })
    runInContext(buildArtifactModuleSource('exports.App = () => "one"', true), context)
    runInContext(buildArtifactModuleSource('exports.Component = () => "two"', true), context)
    expect(picked.map((component) => component())).toEqual(["one", "two"])
  })
})

describe("createArtifactRequire", () => {
  const React = { createElement: () => null }
  const ReactDOM = { createRoot: () => ({ render: () => undefined }) }
  const require_ = createArtifactRequire({ React, ReactDOM } as never)

  it("serves the react family from the bundled globals", () => {
    expect(require_("react")).toBe(React)
    expect(require_("react-dom/client")).toBe(ReactDOM)
    expect(require_("react/jsx-runtime")).toBe(React)
  })

  it("names the module it cannot supply instead of returning undefined", () => {
    expect(() => require_("lodash")).toThrow(/lodash/)
  })
})

describe("installArtifactShellRuntime", () => {
  interface Harness {
    scope: ArtifactShellScope
    posted: unknown[]
    dispatch: (data: unknown) => void
    rendered: unknown[]
    blobs: string[]
    emit: (type: string, event: Event) => void
    dispose: () => void
    pick: (app: unknown, component: unknown, main: unknown, moduleExports: unknown) => void
  }

  function harness(options: { withReact?: boolean; realReact?: boolean } = {}): Harness {
    document.body.innerHTML = '<div id="root"></div>'
    // jsdom keeps one document across tests; the bootstrap appends to <head>.
    document.head.querySelectorAll("script").forEach((tag) => tag.remove())
    const posted: unknown[] = []
    const rendered: unknown[] = []
    const blobs: string[] = []
    const events = new EventTarget()
    let reactRoot: Root | undefined
    const scope = {
      document,
      parent: { postMessage: (message: unknown) => void posted.push(message) },
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      URL: {
        createObjectURL: (blob: Blob) => {
          blobs.push(String((blob as unknown as { __source?: string }).__source ?? ""))
          return `blob:test-${blobs.length}`
        },
        revokeObjectURL: () => undefined,
      },
      Blob: class FakeBlob {
        __source: string
        constructor(parts: string[]) {
          this.__source = parts.join("")
        }
      } as unknown as typeof Blob,
    } as unknown as ArtifactShellScope
    if (options.withReact !== false) {
      ;(scope as Record<string, unknown>).React = React
      ;(scope as Record<string, unknown>).ReactDOM = {
        createRoot: options.realReact
          ? (host: Element) => (reactRoot = createRoot(host))
          : () => ({ render: (node: unknown) => void rendered.push(node) }),
      }
    }
    const dispose = installArtifactShellRuntime(scope)
    return {
      scope,
      pick: scope.__cogniaArtifactPick as Harness["pick"],
      posted,
      rendered,
      blobs,
      dispose: () => {
        if (reactRoot) act(() => reactRoot?.unmount())
        dispose()
      },
      dispatch: (data: unknown) => events.dispatchEvent(new MessageEvent("message", { data })),
      emit: (_type, event) => {
        events.dispatchEvent(event)
      },
    }
  }

  it("announces itself so the host knows the frame is alive", () => {
    const h = harness()
    expect(h.posted).toContainEqual({ type: "artifact-shell-ready" })
    h.dispose()
  })

  it("executes artifact code as a blob: script, never inline and never via eval", () => {
    // Measured: a srcdoc child inherits the shell CSP, which allows `blob:` and
    // nothing else executable. An inline script or `new Function` runs nowhere.
    const h = harness()
    h.dispatch({ type: "render-component", code: "function App(){return null}" })
    expect(h.blobs).toHaveLength(1)
    expect(h.blobs[0]).toContain("function App(){return null}")
    expect(document.head.querySelector("script")?.getAttribute("src")).toBe("blob:test-1")
    h.dispose()
  })

  it("creates the root once across repeated renders", () => {
    // A root per message was both a leak and the reason an edit needed a full
    // iframe re-navigation to show up.
    const h = harness()
    let roots = 0
    ;(h.scope as Record<string, unknown>).ReactDOM = {
      createRoot: () => {
        roots += 1
        return { render: (node: unknown) => void h.rendered.push(node) }
      },
    }
    h.pick(() => null, null, null, null)
    h.pick(() => null, null, null, null)
    expect(roots).toBe(1)
    expect(h.rendered).toHaveLength(2)
    h.dispose()
  })

  it.each([
    'const App = () => React.createElement("p", null, "revision")',
    'function App(){return React.createElement("p", null, "revision")}',
    'class App extends React.Component { render(){return React.createElement("p", null, "revision")} }',
  ])("replaces revision one with revision two using generated classic code: %s", async (code) => {
    const h = harness({ realReact: true })
    const context = createContext({ React, __cogniaArtifactPick: h.pick })
    try {
      for (const [revision, label] of [
        [1, "one"],
        [2, "two"],
      ] as const) {
        await act(async () => {
          h.dispatch({
            type: "render-component",
            revision,
            code: transformClassic(code.replace("revision", label)),
          })
          runInContext(h.blobs.at(-1)!, context)
        })
        expect(document.getElementById("root")).toHaveTextContent(label)
        expect(h.posted).toContainEqual({ type: "artifact-preview-ready", revision })
      }
      expect(document.getElementById("root")).not.toHaveTextContent("one")
    } finally {
      h.dispose()
    }
  })

  it("ignores a queued older blob's picker after a newer revision starts", () => {
    const h = harness()
    h.dispatch({ type: "render-component", code: "function App(){}", revision: 1 })
    h.dispatch({ type: "render-component", code: "function App(){}", revision: 2 })
    const script = document.head.querySelector("script")!
    jest.spyOn(document, "currentScript", "get").mockReturnValueOnce(script)
    h.pick(() => null, null, null, null)
    expect(h.rendered).toHaveLength(0)
    h.pick(() => null, null, null, null)
    expect(h.rendered).toHaveLength(1)
    jest.restoreAllMocks()
    h.dispose()
  })

  it.each([
    'var palette = "blue"; function App(){ return React.createElement("p", null, window.palette) }',
    '"use strict"; const R = this.React; function App(){ return R.createElement("p", null, "blue") }',
  ])("renders classic global semantics through the shell: %s", async (code) => {
    const h = harness({ realReact: true })
    const context = createContext({ React, __cogniaArtifactPick: h.pick })
    context.window = context
    try {
      await act(async () => {
        h.dispatch({ type: "render-component", revision: 1, code: transformClassic(code) })
        runInContext(h.blobs.at(-1)!, context)
      })
      expect(document.getElementById("root")).toHaveTextContent("blue")
      expect(h.posted).toContainEqual({ type: "artifact-preview-ready", revision: 1 })
    } finally {
      h.dispose()
    }
  })

  it("reports ready only after the component committed, once per revision", async () => {
    const h = harness({ realReact: true })
    const Component = () => React.createElement("p", null, "committed")
    await act(async () => {
      h.dispatch({ type: "render-component", code: "", revision: 1 })
      h.pick(Component, null, null, null)
      expect(h.posted).not.toContainEqual(
        expect.objectContaining({ type: "artifact-preview-ready" })
      )
    })
    expect(document.getElementById("root")).toHaveTextContent("committed")
    await act(async () => {
      h.dispatch({ type: "render-component", code: "", revision: 2 })
      h.pick(() => React.createElement("p", null, "updated"), null, null, null)
    })
    expect(document.getElementById("root")).toHaveTextContent("updated")
    expect(
      h.posted.filter((m) => (m as { type: string }).type === "artifact-preview-ready")
    ).toEqual([
      { type: "artifact-preview-ready", revision: 1 },
      { type: "artifact-preview-ready", revision: 2 },
    ])
    h.dispose()
  })

  it("reports a throwing component without ready, then recovers on the next revision", async () => {
    const logged = jest.spyOn(console, "error").mockImplementation(() => undefined)
    const h = harness({ realReact: true })
    try {
      await act(async () => {
        h.dispatch({ type: "render-component", code: "", revision: 1 })
        h.pick(
          () => {
            throw new Error("render exploded")
          },
          null,
          null,
          null
        )
      })
      expect(h.posted).toContainEqual({
        type: "artifact-preview-error",
        revision: 1,
        message: "render exploded",
      })
      expect(h.posted).not.toContainEqual(
        expect.objectContaining({ type: "artifact-preview-ready" })
      )
      await act(async () => {
        h.dispatch({ type: "render-component", code: "", revision: 2 })
        h.pick(() => React.createElement("p", null, "fixed"), null, null, null)
      })
      expect(document.getElementById("root")).toHaveTextContent("fixed")
      expect(h.posted).toContainEqual({ type: "artifact-preview-ready", revision: 2 })
    } finally {
      h.dispose()
      logged.mockRestore()
    }
  })

  it("does not announce ready when a component throws during its layout effect", async () => {
    const logged = jest.spyOn(console, "error").mockImplementation(() => undefined)
    const h = harness({ realReact: true })
    function ThrowOnCommit() {
      React.useLayoutEffect(() => {
        throw new Error("commit exploded")
      }, [])
      return React.createElement("p", null, "never ready")
    }
    try {
      await act(async () => {
        h.dispatch({ type: "render-component", revision: 1, code: "" })
        h.pick(ThrowOnCommit, null, null, null)
      })
      expect(h.posted).toContainEqual({
        type: "artifact-preview-error",
        revision: 1,
        message: "commit exploded",
      })
      expect(h.posted).not.toContainEqual(
        expect.objectContaining({ type: "artifact-preview-ready" })
      )
    } finally {
      h.dispose()
      logged.mockRestore()
    }
  })

  it("keeps a post-ready React render failure terminal through the error boundary", async () => {
    const logged = jest.spyOn(console, "error").mockImplementation(() => undefined)
    const h = harness({ realReact: true })
    function App() {
      const [broken, setBroken] = React.useState(false)
      if (broken) throw new Error("later render failed")
      return React.createElement("button", { onClick: () => setBroken(true) }, "break render")
    }
    try {
      await act(async () => {
        h.dispatch({ type: "render-component", revision: 1, code: "function App(){}" })
        h.pick(App, null, null, null)
      })
      expect(h.posted).toContainEqual({ type: "artifact-preview-ready", revision: 1 })
      await act(async () => document.querySelector("button")!.click())
      expect(h.posted).toContainEqual({
        type: "artifact-preview-error",
        revision: 1,
        message: "later render failed",
      })
      expect(document.getElementById("root")).toHaveTextContent("later render failed")
    } finally {
      h.dispose()
      logged.mockRestore()
    }
  })

  it.each([false, true])(
    "relays owned script errors and rejections (module=%s), ignoring shell and old-run errors",
    (module) => {
      const h = harness()
      h.dispatch({
        type: "run-scripts",
        revision: 1,
        scripts: [{ code: "throw new Error('boom')", module }],
      })
      h.emit("error", new ErrorEvent("error", { message: "boom", filename: "blob:test-1" }))
      expect(h.posted).toContainEqual({
        type: "artifact-preview-error",
        revision: 1,
        message: "boom",
      })
      document.head.querySelector("script")!.dispatchEvent(new Event("load"))
      expect(h.posted).not.toContainEqual(
        expect.objectContaining({ type: "artifact-preview-ready" })
      )
      h.dispatch({ type: "run-scripts", revision: 2, scripts: [{ code: "next", module }] })
      const count = h.posted.length
      h.emit("error", new ErrorEvent("error", { message: "shell", filename: "/artifact-shell.js" }))
      h.emit("error", new ErrorEvent("error", { message: "old", filename: "blob:test-1" }))
      expect(h.posted).toHaveLength(count)
      const reason = new Error("async exploded")
      reason.stack = "Error: async exploded\n at blob:test-2:1:1"
      const rejection = new Event("unhandledrejection")
      Object.defineProperty(rejection, "reason", { value: reason })
      h.emit("unhandledrejection", rejection)
      expect(h.posted).toContainEqual({
        type: "artifact-preview-error",
        revision: 2,
        message: "async exploded",
      })
      h.dispose()
      const afterDispose = h.posted.length
      h.emit("error", new ErrorEvent("error", { message: "disposed", filename: "blob:test-2" }))
      expect(h.posted).toHaveLength(afterDispose)
    }
  )

  it.each(["error", "unhandledrejection"])(
    "keeps post-ready %s non-terminal and preserves the rendered DOM",
    async (type) => {
      const h = harness({ realReact: true })
      try {
        await act(async () => {
          h.dispatch({ type: "render-component", revision: 1, code: "function App(){}" })
          h.pick(() => React.createElement("button", null, "still usable"), null, null, null)
        })
        expect(h.posted).toContainEqual({ type: "artifact-preview-ready", revision: 1 })
        const before = document.body.innerHTML
        const error = new Error("handler exploded")
        error.stack = "Error: handler exploded\n at blob:test-1:1:1"
        const event =
          type === "error"
            ? new ErrorEvent("error", { message: error.message, filename: "blob:test-1", error })
            : Object.defineProperty(new Event(type), "reason", { value: error })
        h.emit(type, event)
        expect(h.posted).not.toContainEqual(
          expect.objectContaining({ type: "artifact-preview-error" })
        )
        expect(document.body.innerHTML).toBe(before)
        h.dispatch({ type: "capture-snapshot", requestId: "after-handler" })
        expect(h.posted).toContainEqual(
          expect.objectContaining({
            type: "artifact-capture-result",
            requestId: "after-handler",
            html: expect.stringContaining("still usable"),
          })
        )
      } finally {
        h.dispose()
      }
    }
  )

  it("says the runtime failed when React never loaded", () => {
    const h = harness({ withReact: false })
    h.dispatch({
      type: "artifact-shell-config",
      messages: { runtimeInitFailed: "boom", noComponentFound: "none" },
    })
    h.dispatch({ type: "render-component", code: "function App(){}" })
    expect(h.posted).toContainEqual({ type: "artifact-preview-error", message: "boom" })
    h.dispose()
  })

  it("uses the host's wording for a document that exports nothing", () => {
    const h = harness()
    h.dispatch({
      type: "artifact-shell-config",
      messages: { runtimeInitFailed: "boom", noComponentFound: "nothing here" },
    })
    h.pick(null, null, null, null)
    expect(document.querySelector("[data-artifact-shell]")?.textContent).toBe("nothing here")
    h.dispose()
  })

  it("renders error text through textContent so an artifact cannot inject markup", () => {
    const h = harness({ withReact: false })
    h.dispatch({
      type: "artifact-shell-config",
      messages: { runtimeInitFailed: "<img src=x onerror=alert(1)>", noComponentFound: "n" },
    })
    h.dispatch({ type: "render-component", code: "" })
    const box = document.querySelector('[data-artifact-shell="error"]')
    expect(box?.querySelector("img")).toBeNull()
    expect(box?.textContent).toBe("<img src=x onerror=alert(1)>")
    h.dispose()
  })

  it("runs interactive scripts in order, marking only modules as modules", () => {
    const h = harness()
    h.dispatch({
      type: "run-scripts",
      scripts: [{ code: "one" }, { code: "two", module: true }, { code: "three" }],
    })
    expect(h.blobs).toEqual(["one", "two", "three"])
    const tags = Array.from(document.head.querySelectorAll("script"))
    expect(tags.map((t) => t.getAttribute("src"))).toEqual([
      "blob:test-1",
      "blob:test-2",
      "blob:test-3",
    ])
    // async=false is what keeps dynamically inserted scripts in insertion order.
    expect(tags[0].async).toBe(false)
    expect(tags[1].type).toBe("module")
    h.dispose()
  })

  it("reports ready for an interactive document that has nothing to run", () => {
    const h = harness()
    h.dispatch({ type: "run-scripts", scripts: [] })
    expect(h.posted).toContainEqual({ type: "artifact-preview-ready" })
    h.dispose()
  })

  it("ignores messages it does not own", () => {
    const h = harness()
    const before = h.posted.length
    h.dispatch({ type: "something-else" })
    h.dispatch(null)
    expect(h.posted).toHaveLength(before)
    h.dispose()
  })
})

describe("theme variables over the parent-context channel", () => {
  it("applies custom properties the host pushes in", () => {
    // The frame is opaque-origin, so `contentDocument` is null to the host —
    // postMessage is the only way a palette can reach it.
    document.body.innerHTML = '<div id="root"></div>'
    document.head.querySelectorAll("script").forEach((tag) => tag.remove())
    const inbox: { listener?: (event: MessageEvent) => void } = {}
    const scope = {
      document,
      parent: { postMessage: () => undefined },
      addEventListener: (_t: "message", h: (event: MessageEvent) => void) => {
        if (_t === "message") inbox.listener = h
      },
      removeEventListener: () => undefined,
      URL: { createObjectURL: () => "blob:x", revokeObjectURL: () => undefined },
      Blob,
    } as unknown as ArtifactShellScope
    const dispose = installArtifactShellRuntime(scope)
    inbox.listener?.({
      data: {
        type: "artifact-preview-parent-context",
        themeVariables: { "--background": "#123456", evil: "x" },
      },
    } as MessageEvent)
    expect(document.documentElement.style.getPropertyValue("--background")).toBe("#123456")
    expect(document.documentElement.style.getPropertyValue("evil")).toBe("")
    dispose()
  })
})

describe("capture-snapshot", () => {
  const scopeWith = (posted: unknown[], inbox: { listener?: (e: MessageEvent) => void }) =>
    ({
      document,
      parent: { postMessage: (message: unknown) => posted.push(message) },
      addEventListener: (_t: "message", h: (event: MessageEvent) => void) => {
        if (_t === "message") inbox.listener = h
      },
      removeEventListener: () => undefined,
      URL: { createObjectURL: () => "blob:x", revokeObjectURL: () => undefined },
      Blob,
    }) as unknown as ArtifactShellScope

  it("answers with a static snapshot of what the frame drew", () => {
    // Rasterising cannot happen in here: a sandboxed `allow-scripts` document
    // is opaque-origin and cannot read its own child iframe, which is exactly
    // what html2canvas needs. So the frame hands out markup and the parent
    // renders it.
    document.body.innerHTML = '<div id="root"><h1 style="color:#334">Drawn</h1></div>'
    document.head.querySelectorAll("script").forEach((tag) => tag.remove())
    const posted: unknown[] = []
    const inbox: { listener?: (e: MessageEvent) => void } = {}
    const dispose = installArtifactShellRuntime(scopeWith(posted, inbox))

    inbox.listener?.({ data: { type: "capture-snapshot", requestId: "req-1" } } as MessageEvent)

    const reply = posted.find(
      (m) => (m as { type?: string }).type === "artifact-capture-result"
    ) as { requestId: string; html: string; width: number; height: number }
    expect(reply.requestId).toBe("req-1")
    expect(reply.html).toContain("<!DOCTYPE html>")
    expect(reply.html).toContain("Drawn")
    expect(reply.html).toContain('style="color:#334"')
    expect(reply.width).toBeGreaterThan(0)
    expect(reply.height).toBeGreaterThan(0)
    dispose()
  })

  it("addresses a failure to the request instead of the preview", () => {
    // A generic `artifact-preview-error` would leave the caller waiting for a
    // timeout rather than telling it why the capture failed.
    document.body.innerHTML = '<div id="root"></div>'
    const posted: unknown[] = []
    const inbox: { listener?: (e: MessageEvent) => void } = {}
    const scope = scopeWith(posted, inbox)
    const dispose = installArtifactShellRuntime(scope)
    const original = Object.getOwnPropertyDescriptor(Document.prototype, "documentElement")
    Object.defineProperty(document, "documentElement", {
      configurable: true,
      get() {
        throw new Error("serialisation blew up")
      },
    })
    try {
      inbox.listener?.({ data: { type: "capture-snapshot", requestId: "req-2" } } as MessageEvent)
    } finally {
      delete (document as unknown as Record<string, unknown>).documentElement
      if (original) Object.defineProperty(Document.prototype, "documentElement", original)
    }
    expect(posted).toContainEqual({
      type: "artifact-capture-error",
      requestId: "req-2",
      message: "serialisation blew up",
    })
    dispose()
  })
})
