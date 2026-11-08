/**
 * The in-frame bootstrap shared by both scripted artifact previews: the React
 * runtime shell and the opt-in interactive HTML sandbox.
 *
 * Bundled by `scripts/build/build-artifact-runtime.mjs` into
 * `public/artifact-runtime/artifact-shell.js` and loaded by the preview as
 * `<script src="…/artifact-shell.js">`. It is a FILE and not an inline
 * `<script>` because of a measured fact (ADR-0158): in the packaged desktop
 * shell an `about:srcdoc` child — sandboxed, opaque origin, with any meta CSP
 * you like — inherits `src-tauri/tauri.conf.json`'s policy, which carries no
 * `'unsafe-inline'` and no `'unsafe-eval'`. The two things that DO run there are
 * a same-origin URL and a `blob:` script, so those are the only two mechanisms
 * this file uses.
 *
 * Three rules it exists to keep:
 *
 * 1. **One root, ever.** The previous shell called `ReactDOM.createRoot` on
 *    every message, which leaked a root per keystroke in a Canvas split view
 *    and forced the host to re-navigate the whole frame to show an edit.
 * 2. **No eval, anywhere.** Artifact code arrives already transformed (the host
 *    runs Babel in a Worker) and executes as a `blob:` script.
 * 3. **Nothing is written as HTML.** Error text goes through `textContent`, so
 *    an artifact's own failure message cannot inject markup.
 */

/**
 * The shell's half of the element picker.
 *
 * Only the `allow-scripts` frames (React artifacts, and the opt-in interactive
 * HTML mode) need it. Their document is opaque-origin, so the host cannot reach
 * `contentDocument` and install the picker itself the way it does for the
 * `allow-same-origin` html/svg frames — postMessage is the only channel there
 * is. The picker LOGIC is not duplicated for that: `element-pick.ts` is
 * imported relatively so esbuild inlines the same module into this bundle.
 */
import { PICKER_NODE_ATTRIBUTE, installElementPicker } from "./element-pick"
import type { ComponentType, ReactNode } from "react"

/** Strings the host hands the frame; the frame never hard-codes user-facing text. */
export interface ArtifactShellMessages {
  noComponentFound: string
  runtimeInitFailed: string
}

/** One executable unit handed to the frame. */
export interface ArtifactShellScript {
  code: string
  /** `true` for `<script type="module">`; classic script otherwise. */
  module?: boolean
}

/** Messages the host may send into the frame. */
export type ArtifactShellInboundMessage =
  | { type: "artifact-shell-config"; messages: ArtifactShellMessages }
  | { type: "render-component"; code: string; isModule?: boolean; revision?: number }
  | { type: "run-scripts"; scripts: ArtifactShellScript[]; revision?: number }
  | { type: "artifact-preview-parent-context"; themeVariables?: Record<string, string> }
  | { type: "capture-snapshot"; requestId: string }
  | { type: "artifact-set-select-mode"; on: boolean; originLabel?: string }

interface ArtifactRoot {
  render(node: unknown): void
}

interface ArtifactReactGlobals {
  React: Pick<typeof import("react"), "createElement" | "useLayoutEffect" | "Component">
  ReactDOM: { createRoot(container: Element): ArtifactRoot }
  ReactJSXRuntime?: unknown
}

/**
 * The subset of a window the bootstrap touches. Narrow on purpose so the unit
 * test can drive it with a stub instead of a real frame.
 */
export interface ArtifactShellScope {
  document: Document
  parent: { postMessage(message: unknown, targetOrigin: string): void }
  addEventListener<K extends keyof WindowEventMap>(
    type: K,
    listener: (event: WindowEventMap[K]) => void
  ): void
  removeEventListener<K extends keyof WindowEventMap>(
    type: K,
    listener: (event: WindowEventMap[K]) => void
  ): void
  URL: { createObjectURL(blob: Blob): string; revokeObjectURL(url: string): void }
  Blob: typeof Blob
  [key: string]: unknown
}

const DEFAULT_MESSAGES: ArtifactShellMessages = {
  // Replaced by the host's localized strings on the first config message. These
  // literals only surface if the host never sends one.
  noComponentFound: "No component found.",
  runtimeInitFailed: "The artifact runtime failed to initialize.",
}

/** Wrap transformed React artifact code so its component reaches the picker. */
export function buildArtifactModuleSource(code: string, isModule: boolean): string {
  if (isModule) {
    // Babel downleveled ESM to CommonJS, so the code expects module/exports/require.
    return `(function () {\nconst __cogniaArtifactModule = { exports: {} };\n(function (module, exports, require) {\n${code}\n})(__cogniaArtifactModule, __cogniaArtifactModule.exports, __cogniaArtifactRequire);\n__cogniaArtifactPick(null, null, null, __cogniaArtifactModule.exports);\n})();\n`
  }
  // Each revision owns its declarations; the picker stays in the same scope
  // so both lexical bindings and hoisted function declarations are visible.
  return `(function () {\n${code}\n;__cogniaArtifactPick(typeof App !== "undefined" ? App : null, typeof Component !== "undefined" ? Component : null, typeof Main !== "undefined" ? Main : null, null);\n})();\n`
}

/**
 * Resolve the component an artifact meant to export. Module exports win over
 * globals: a file that says `export default` said which one it meant.
 */
export function pickArtifactComponent(
  app: unknown,
  component: unknown,
  main: unknown,
  moduleExports: unknown
): unknown {
  const exported = moduleExports as Record<string, unknown> | null | undefined
  const candidates = [
    exported?.default,
    exported?.App,
    exported?.Component,
    exported?.Main,
    app,
    component,
    main,
  ]
  return candidates.find((value) => typeof value === "function") ?? null
}

/** The `require` an artifact's downleveled `import` lands on. */
export function createArtifactRequire(globals: ArtifactReactGlobals) {
  return function artifactRequire(specifier: string): unknown {
    switch (specifier) {
      case "react":
        return globals.React
      case "react-dom":
      case "react-dom/client":
        return globals.ReactDOM
      case "react/jsx-runtime":
      case "react/jsx-dev-runtime":
        return globals.ReactJSXRuntime ?? globals.React
      default:
        throw new Error(`Artifact previews cannot import "${specifier}" — only react is bundled.`)
    }
  }
}

/**
 * Install the bootstrap into `scope`. Returns a disposer so the unit test can
 * tear it down; the frame itself never calls it.
 */
export function installArtifactShellRuntime(scope: ArtifactShellScope): () => void {
  const globals = scope as unknown as ArtifactReactGlobals
  const doc = scope.document
  let messages = DEFAULT_MESSAGES
  let root: ArtifactRoot | null = null
  interface Run {
    revision?: number
    failed: boolean
    ready: boolean
  }
  let activeRun: Run = { failed: false, ready: false }
  /** The armed picker's disposer, or null when select mode is off. */
  let disposePicker: (() => void) | null = null
  const objectUrls: string[] = []
  const scriptRuns = new Map<string, Run>()
  const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))
  const beginRun = (revision?: number) => {
    activeRun = { revision, failed: false, ready: false }
    return activeRun
  }

  const post = (message: unknown) => {
    try {
      scope.parent.postMessage(message, "*")
    } catch {
      // A frame whose host has gone away is not an artifact error.
    }
  }

  const container = () => doc.getElementById("root")

  const showText = (text: string, tone: "error" | "muted") => {
    // Once React owns #root, never replace its DOM behind its back. A script
    // error can arrive between commits; keep that diagnostic outside the root.
    const host = root ? doc.body : (container() ?? doc.body)
    if (!host) return
    const box = doc.createElement("div")
    box.setAttribute("data-artifact-shell", tone)
    box.style.cssText =
      tone === "error"
        ? "color:#b91c1c;background:#fee2e2;border-radius:8px;padding:16px;font:13px/1.5 system-ui,sans-serif"
        : "color:#6b7280;padding:16px;font:13px/1.5 system-ui,sans-serif"
    // textContent, never innerHTML: the text can be an artifact's own error.
    box.textContent = text
    if (host === container()) host.replaceChildren(box)
    else host.appendChild(box)
  }

  const fail = (message: string, run = activeRun, display = true) => {
    if (run !== activeRun || run.failed) return
    run.failed = true
    if (display) showText(message, "error")
    post({
      type: "artifact-preview-error",
      message,
      ...(run.revision === undefined ? {} : { revision: run.revision }),
    })
  }

  const announceReady = (run = activeRun) => {
    if (run !== activeRun || run.failed || run.ready) return
    run.ready = true
    post({
      type: "artifact-preview-ready",
      ...(run.revision === undefined ? {} : { revision: run.revision }),
    })
  }

  const ownsError = (filename: string, error: unknown) => {
    const stack = error && typeof error === "object" && "stack" in error ? String(error.stack) : ""
    return Array.from(scriptRuns).some(
      ([url, run]) => run === activeRun && (filename === url || stack.includes(`${url}:`))
    )
  }
  const onExecutionError = (event: ErrorEvent) => {
    if (ownsError(event.filename, event.error)) fail(event.message || errorText(event.error))
  }
  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    if (ownsError("", event.reason)) fail(errorText(event.reason))
  }

  /**
   * Execute one source string as a `blob:` script. `async = false` is what keeps
   * dynamically-inserted scripts in insertion order — without it an artifact's
   * second `<script>` can run before its first.
   */
  const runBlobScript = (source: string, asModule: boolean, onDone?: () => void) => {
    const run = activeRun
    let url: string
    try {
      url = scope.URL.createObjectURL(new scope.Blob([source], { type: "text/javascript" }))
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
      return
    }
    objectUrls.push(url)
    scriptRuns.set(url, run)
    const script = doc.createElement("script")
    if (asModule) script.type = "module"
    else script.async = false
    script.src = url
    script.addEventListener("error", () => {
      // Load/CSP failures use this event; execution failures use window.error.
      fail(messages.runtimeInitFailed, run)
    })
    if (onDone)
      script.addEventListener("load", () => {
        if (run === activeRun && !run.failed) onDone()
      })
    doc.head.appendChild(script)
  }

  const renderComponent = (candidate: unknown) => {
    const run = activeRun
    if (run.failed) return
    if (typeof candidate !== "function") {
      showText(messages.noComponentFound, "muted")
      fail(messages.noComponentFound, run, false)
      return
    }
    if (!root) {
      const host = container()
      if (!host || typeof globals.ReactDOM?.createRoot !== "function") {
        fail(messages.runtimeInitFailed)
        return
      }
      root = globals.ReactDOM.createRoot(host)
    }
    doc.querySelectorAll("[data-artifact-shell]").forEach((box) => {
      if (!container()?.contains(box)) box.remove()
    })
    const React = globals.React
    // The effect cannot run for an aborted render. The boundary also pins a
    // delayed render failure to the revision that actually threw.
    function CommittedArtifact() {
      React.useLayoutEffect(() => {
        // Let commit-phase errors reach the boundary before publishing ready.
        queueMicrotask(() => announceReady(run))
      }, [])
      return React.createElement(candidate as ComponentType)
    }
    class ArtifactErrorBoundary extends React.Component<
      { children?: ReactNode },
      { message: string | null }
    > {
      state = { message: null as string | null }
      static getDerivedStateFromError(error: unknown) {
        return { message: errorText(error) }
      }
      componentDidCatch(error: unknown) {
        fail(errorText(error), run, false)
      }
      render() {
        return this.state.message === null
          ? this.props.children
          : React.createElement("div", { "data-artifact-shell": "error" }, this.state.message)
      }
    }
    root.render(
      React.createElement(ArtifactErrorBoundary, null, React.createElement(CommittedArtifact))
    )
  }

  scope.__cogniaArtifactPick = (
    app: unknown,
    component: unknown,
    main: unknown,
    moduleExports: unknown
  ) => {
    const scriptRun = scriptRuns.get((doc.currentScript as HTMLScriptElement | null)?.src ?? "")
    if (scriptRun && scriptRun !== activeRun) return
    try {
      renderComponent(pickArtifactComponent(app, component, main, moduleExports))
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    }
  }
  scope.__cogniaArtifactRequire = createArtifactRequire(globals)

  const onMessage = (event: MessageEvent) => {
    const data = event.data as ArtifactShellInboundMessage | undefined
    if (!data || typeof data !== "object") return
    try {
      if (data.type === "artifact-shell-config") {
        messages = { ...DEFAULT_MESSAGES, ...data.messages }
        return
      }
      if (data.type === "artifact-preview-parent-context") {
        // An opaque-origin frame cannot be reached through `contentDocument`,
        // so the palette arrives over the same channel everything else does.
        for (const [name, value] of Object.entries(data.themeVariables ?? {})) {
          if (name.startsWith("--")) doc.documentElement.style.setProperty(name, value)
        }
        return
      }
      if (data.type === "render-component") {
        beginRun(data.revision)
        if (!globals.React || typeof globals.ReactDOM?.createRoot !== "function") {
          fail(messages.runtimeInitFailed)
          return
        }
        runBlobScript(
          buildArtifactModuleSource(String(data.code ?? ""), data.isModule === true),
          false
        )
        return
      }
      if (data.type === "artifact-set-select-mode") {
        // Idempotent in both directions: the host re-sends `on` after every
        // re-render (the document it was armed on may have been replaced) and
        // disarms on unmount. Disposing first means a stale picker can never
        // outlive its document and leave the artifact swallowing every click.
        disposePicker?.()
        disposePicker = null
        if (!data.on) return
        disposePicker = installElementPicker(doc, {
          originLabel: data.originLabel,
          onPick: (selection, modifiers) => {
            post({ type: "artifact-element-selected", selection, modifiers })
          },
          onCancel: () => {
            disposePicker?.()
            disposePicker = null
            post({ type: "artifact-element-pick-cancelled" })
          },
        })
        return
      }
      if (data.type === "capture-snapshot") {
        // Rasterising happens in the PARENT, not here. html2canvas clones the
        // document into a child iframe and reads it back, and a sandboxed
        // `allow-scripts` document has an opaque origin, so it cannot read its
        // OWN about:blank child. Verified, not assumed. What the frame CAN do
        // is hand out a static snapshot of what it drew, which the parent then
        // renders in the same-origin capture frame it already uses for `html`.
        // The picker's highlight and label live in THIS document, so an
        // export taken while select mode is armed would bake them into the
        // PNG/PDF. Clone, strip, serialize — never mutate the live document,
        // which would make the highlight flicker mid-pick.
        const clone = doc.documentElement.cloneNode(true) as Element
        for (const node of Array.from(clone.querySelectorAll(`[${PICKER_NODE_ATTRIBUTE}]`))) {
          node.remove()
        }
        const snapshot = `<!DOCTYPE html>${clone.outerHTML}`
        post({
          type: "artifact-capture-result",
          requestId: data.requestId,
          html: snapshot,
          width: Math.max(doc.documentElement.scrollWidth, doc.body?.scrollWidth ?? 0, 1),
          height: Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0, 1),
        })
        return
      }
      if (data.type === "run-scripts") {
        const run = beginRun(data.revision)
        const scripts = Array.isArray(data.scripts) ? data.scripts : []
        if (scripts.length === 0) {
          announceReady(run)
          return
        }
        scripts.forEach((script, index) => {
          const last = index === scripts.length - 1
          runBlobScript(
            String(script.code ?? ""),
            script.module === true,
            last ? () => announceReady(run) : undefined
          )
        })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // A capture is a request/response pair. Answering it with the generic
      // preview error would leave the caller waiting for its timeout instead of
      // getting a reason, so the reply is addressed to the request.
      if (data.type === "capture-snapshot") {
        post({ type: "artifact-capture-error", requestId: data.requestId, message })
        return
      }
      fail(message)
    }
  }

  scope.addEventListener("message", onMessage)
  scope.addEventListener("error", onExecutionError)
  scope.addEventListener("unhandledrejection", onUnhandledRejection)
  post({ type: "artifact-shell-ready" })

  return () => {
    activeRun = { failed: true, ready: false }
    scope.removeEventListener("message", onMessage)
    scope.removeEventListener("error", onExecutionError)
    scope.removeEventListener("unhandledrejection", onUnhandledRejection)
    disposePicker?.()
    disposePicker = null
    for (const url of objectUrls.splice(0)) {
      try {
        scope.URL.revokeObjectURL(url)
      } catch {
        // Already revoked, or a scope that never had one.
      }
    }
    delete scope.__cogniaArtifactPick
    delete scope.__cogniaArtifactRequire
    scriptRuns.clear()
  }
}
