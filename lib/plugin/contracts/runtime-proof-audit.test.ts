import { execSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { auditPluginRuntimeClaims } from "./runtime-proof-audit"
import {
  CANONICAL_HOOK_POINTS,
  CANONICAL_RUNTIME_POINTS,
  DEPRECATED_HOOK_POINTS,
  RUNTIME_POINT_BINDINGS,
} from "./plugin-points"

describe("plugin runtime proof audit", () => {
  it("reports supported capabilities with executable proof metadata", () => {
    const report = auditPluginRuntimeClaims()
    const toolsCapability = report.capabilities.find((entry) => entry.id === "tools")

    expect(toolsCapability).toEqual(
      expect.objectContaining({
        id: "tools",
        support: "supported",
        proofStatus: "verified",
        missingFields: [],
      })
    )
  })

  it("verifies the native-anthropic-tool capability proof is fully wired", () => {
    const report = auditPluginRuntimeClaims()
    const nativeTool = report.capabilities.find((entry) => entry.id === "native-anthropic-tool")

    expect(nativeTool).toEqual(
      expect.objectContaining({
        id: "native-anthropic-tool",
        support: "supported",
        proofStatus: "verified",
        missingFields: [],
      })
    )
    // Lock the host-binding surface so future renames are caught.
    expect(nativeTool?.hostBindings).toEqual(
      expect.arrayContaining([
        "lib/plugin/registries/native-anthropic-tool-registry.ts",
        "lib/claude/build-options.ts",
        "sidecar/src/runtimes/claude-agent-sdk/options.ts",
      ])
    )
    expect(nativeTool?.typescriptSdk).toEqual(
      expect.arrayContaining(["packages/plugin-sdk/src/api/native-anthropic-tool.ts"])
    )
  })

  it("requires docs and tests for implemented plugin points", () => {
    const report = auditPluginRuntimeClaims()
    const chatHeaderPoint = report.points.find((entry) => entry.id === "chat.header")

    expect(chatHeaderPoint).toEqual(
      expect.objectContaining({
        id: "chat.header",
        kind: "ui-slot",
        status: "implemented",
        proofStatus: "verified",
      })
    )
    expect(chatHeaderPoint?.docs).toContain(
      "docs/content/docs/en/plugin-dev/extension-points-v2.mdx"
    )
    expect(chatHeaderPoint?.requiredTests.length).toBeGreaterThan(0)
  })

  it("no longer tracks the resolved status-projection / fallback-mock risks", () => {
    const report = auditPluginRuntimeClaims()

    // Both prior "missing_proof" risks were closed against current code: the
    // lifecycle store hard-throws via `resolveVerifiedPluginManager`, and the
    // marketplace `mock` mode was replaced by disclosed remote/degraded/demo
    // modes. Neither stale entry (nor its nonexistent path) may resurface.
    const ids = report.runtimeRisks.map((risk) => risk.id)
    expect(ids).not.toContain("plugin-store.status-projection-fallback")
    expect(ids).not.toContain("plugin-marketplace.fallback-mock")
    expect(report.runtimeRisks).toEqual([])
  })

  // ADR 0016 P1-9 / W3.4 — dispatch-reachability gate. Every canonical hook
  // must be reachable through a LIVE chain: hooks-system dispatcher → (an
  // optional `lib/claude/adapter-hooks.ts` wrapper) → a production caller.
  // The original check green-lit a hook as soon as adapter-hooks.ts called
  // the dispatcher, even when the wrapper itself was dead (the exact bug
  // that left onPreToolUse/onPostToolUse dormant while reporting healthy) —
  // and its assertion was vacuous (a found call site always passed, a
  // missing one soft-passed). The chain check below fails on either.
  describe("every canonical hook has a host call site (build-time check)", () => {
    const REPO_ROOT = resolve(__dirname, "../../..")
    const ADAPTER_HOOKS_FILE = "lib/claude/adapter-hooks.ts"

    // One shared snapshot of every production source file. Read once — the
    // per-hook checks then run over in-memory strings.
    const productionSources: Map<string, string> = (() => {
      const map = new Map<string, string>()
      let files: string[]
      try {
        const out = execSync(
          `git -C "${REPO_ROOT}" ls-files --cached --others --exclude-standard lib hooks stores app components sidecar/src`,
          {
            encoding: "utf8",
            maxBuffer: 1024 * 1024 * 32,
          }
        )
        files = out
          .split("\n")
          .filter((p) => p.endsWith(".ts") || p.endsWith(".tsx"))
          .filter(
            (p) =>
              !p.endsWith(".test.ts") &&
              !p.endsWith(".test.tsx") &&
              !p.endsWith("hooks-system.ts") &&
              !p.endsWith("plugin-points.ts")
          )
      } catch {
        throw new Error("Cannot inspect production sources: git ls-files failed")
      }
      for (const file of files) {
        try {
          map.set(file, readFileSync(resolve(REPO_ROOT, file), "utf8"))
        } catch {
          throw new Error(`Cannot read production source ${file}`)
        }
      }
      return map
    })()

    // Hook naming is inconsistent in hooks-system.ts. Most are
    // `dispatch<HookName-without-leading-on>` (e.g., onProjectCreate →
    // dispatchProjectCreate), but agent-plan, scheduled-task, and session
    // hooks keep the "On" prefix. Try both forms.
    const candidateDispatcherNames = (hookName: string): [string, string] => {
      const stripped = hookName.startsWith("on") ? hookName.slice(2) : hookName
      return [
        `dispatch${stripped}`,
        `dispatch${hookName.charAt(0).toUpperCase()}${hookName.slice(1)}`,
      ]
    }

    /** Files whose source matches `pattern`, optionally excluding some. */
    const filesMatching = (pattern: RegExp, exclude: Set<string> = new Set()): string[] => {
      const hits: string[] = []
      for (const [file, src] of productionSources) {
        if (exclude.has(file)) continue
        if (pattern.test(src)) hits.push(file)
      }
      return hits
    }

    /**
     * Names of the exported adapter-hooks wrapper functions whose bodies call
     * one of `dispatcherCandidates`. Parsed from the adapter-hooks source by
     * splitting on `export (async )function` boundaries.
     */
    const adapterWrapperNames = (dispatcherCandidates: string[]): string[] => {
      const src = productionSources.get(ADAPTER_HOOKS_FILE)
      if (!src) return []
      const names: string[] = []
      const fnRe = /export\s+(?:async\s+)?function\s+(\w+)/g
      const boundaries: Array<{ name: string; start: number }> = []
      for (let m = fnRe.exec(src); m; m = fnRe.exec(src)) {
        boundaries.push({ name: m[1], start: m.index })
      }
      for (let i = 0; i < boundaries.length; i++) {
        const body = src.slice(boundaries[i].start, boundaries[i + 1]?.start ?? src.length)
        if (dispatcherCandidates.some((d) => new RegExp(`\\.${d}\\s*\\(`).test(body))) {
          names.push(boundaries[i].name)
        }
      }
      return names
    }

    /**
     * The W3.4 chain check. Returns the production file that proves the hook
     * live, or null when the chain is broken:
     *   1. a non-adapter production file calls the dispatcher directly, OR
     *   2. adapter-hooks wraps the dispatcher AND some non-adapter production
     *      file references the wrapper (imports are accepted as proof — an
     *      unused import fails lint, so a reference implies a call).
     */
    const findLiveCallSite = (dispatcherCandidates: string[], hookName?: string): string | null => {
      for (const name of dispatcherCandidates) {
        const direct = filesMatching(new RegExp(`\\.${name}\\s*\\(`), new Set([ADAPTER_HOOKS_FILE]))
        if (direct.length > 0) return direct[0]
      }
      // Shared dispatchers take the hook name as a string argument
      // (e.g. `dispatchConnectorDecision("onConnectorInbound", …)`).
      if (hookName) {
        const literal = filesMatching(
          new RegExp(`\\.dispatch\\w*\\(\\s*["']${hookName}["']`),
          new Set([ADAPTER_HOOKS_FILE])
        )
        if (literal.length > 0) return literal[0]
        const bridges = filesMatching(new RegExp(`hookId:\\s*["']${hookName}["']`))
        if (
          bridges.length &&
          productionSources
            .get("lib/claude/plugin-hook-ipc.ts")
            ?.includes("resolveHandler(req.pluginId, req.hookId)")
        )
          return bridges[0]
      }
      const wrappers = adapterWrapperNames(dispatcherCandidates)
      for (const wrapper of wrappers) {
        const callers = filesMatching(new RegExp(`\\b${wrapper}\\b`), new Set([ADAPTER_HOOKS_FILE]))
        if (callers.length > 0) return callers[0]
      }
      return null
    }

    for (const hookName of CANONICAL_HOOK_POINTS) {
      it(`hook "${hookName}" has a live dispatch chain`, () => {
        expect(productionSources.size).toBeGreaterThan(0)
        const callSite = findLiveCallSite([...candidateDispatcherNames(hookName)], hookName)
        if (callSite === null) {
          throw new Error(
            `Canonical hook "${hookName}" has no live dispatch chain: no production file ` +
              `calls its dispatcher (directly or through a referenced adapter-hooks wrapper). ` +
              `Wire it or mark its contract unavailable.`
          )
        }
      })
    }

    it("the chain check itself fails on a deliberately-unwired dispatcher", () => {
      expect(productionSources.size).toBeGreaterThan(0)
      expect(findLiveCallSite(["dispatchThisHookDoesNotExistAnywhere"])).toBeNull()
    })

    it("follows the adapter-wrapper chain for the W3.1 tool hooks", () => {
      expect(productionSources.size).toBeGreaterThan(0)
      // Regression lock: these were the dormant hooks that motivated the
      // chain check — they must now resolve through adapter-hooks to a real
      // production caller (the chat pump).
      expect(findLiveCallSite(["dispatchPreToolUse"])).not.toBeNull()
      expect(findLiveCallSite(["dispatchPostToolUse"])).not.toBeNull()
      expect(findLiveCallSite(["dispatchOnMessageSend", "dispatchMessageSend"])).not.toBeNull()
    })

    it("DEPRECATED_HOOK_POINTS list is disjoint from CANONICAL_HOOK_POINTS", () => {
      const canonical = new Set<string>(CANONICAL_HOOK_POINTS)
      const overlap = DEPRECATED_HOOK_POINTS.filter((name) => canonical.has(name))
      expect(overlap).toEqual([])
    })

    // ── W3.4: runtime-point reachability ────────────────────────────────────
    // `contract-path-audit` only checks the binding FILE exists; a registry
    // can exist and never be fed. Here every CANONICAL_RUNTIME_POINTS binding
    // function must be referenced by some production file other than its own
    // definition file (bridges/ctx APIs count — they are the feeding path).
    describe("every canonical runtime point's binding function is referenced", () => {
      for (const point of CANONICAL_RUNTIME_POINTS) {
        const binding = RUNTIME_POINT_BINDINGS[point]
        const match = /^(\S+\.tsx?):(\w+)/.exec(binding)
        if (!match) continue // descriptive binding (no function) — path audit covers it
        const [, bindingFile, fnName] = match
        it(`runtime point "${point}" (${fnName}) is fed by production code`, () => {
          expect(productionSources.size).toBeGreaterThan(0)
          const refs = filesMatching(new RegExp(`\\b${fnName}\\b`), new Set([bindingFile]))
          // A point bound to a `ctx.*` method is fed by plugins calling that
          // method; the host's half of the wiring is the API factory that
          // builds the namespace (`createExportAPI` → `ctx.export`). Accept a
          // production reference to one of the binding file's `create*API`
          // factories as that proof.
          if (refs.length === 0 && /^lib\/plugin\/api\/[\w-]+-api\.ts$/.test(bindingFile)) {
            const bindingSource = productionSources.get(bindingFile) ?? ""
            const factories = [...bindingSource.matchAll(/export function (create\w*API)\b/g)].map(
              (m) => m[1]
            )
            for (const factory of factories) {
              refs.push(...filesMatching(new RegExp(`\\b${factory}\\b`), new Set([bindingFile])))
            }
          }
          if (refs.length === 0) {
            throw new Error(
              `Runtime point "${point}" binds ${binding}, but no production file references ` +
                `${fnName} outside its definition — the registry can never be fed. Wire the ` +
                `bridge/ctx API and its real consumer.`
            )
          }
        })
      }
    })
  })
})
