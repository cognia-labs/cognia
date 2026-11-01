import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"
import { dirname, join, relative } from "node:path"

import {
  EFFECT_PATTERN,
  MIN_REASON_LENGTH,
  analyze,
  brainCorpus,
  calledInBrain,
  effectBodies,
  effectCalls,
  effectSymbols,
  isUiOnlyModule,
  matchClose,
  moduleImports,
  pendingCount,
  reachableFrom,
  readBaseCeiling,
  readExclusions,
  reconcile,
  stripComments,
  uiOnlyKey,
} from "./check-headless-registry.mjs"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

describe("EFFECT_PATTERN", () => {
  it("matches effect-shaped names", () => {
    for (const n of [
      "installIssueRunBridge",
      "startUsageScheduler",
      "registerLocalIssueSource",
      "syncTerminalHostProfiles",
      "seedBuiltinIssueLabels",
      "attachManagedIdeBroker",
    ]) {
      assert.equal(EFFECT_PATTERN.test(n), true, n)
    }
  })

  it("does not match bare verbs or unrelated names", () => {
    for (const n of ["install", "start", "isTauri", "useEffect", "cn", "startled"]) {
      assert.equal(EFFECT_PATTERN.test(n), false, n)
    }
  })
})

describe("effectSymbols", () => {
  it("finds effects imported from @/lib and actually invoked", () => {
    const src = `
      import { installFoo } from "@/lib/foo"
      export function Init() { useEffect(() => installFoo(), []) }
    `
    assert.deepEqual(effectSymbols(src), ["installFoo"])
  })

  it("ignores type-only imports", () => {
    const src = `
      import type { InstallFooOptions } from "@/lib/foo"
      const x: InstallFooOptions = {}
    `
    assert.deepEqual(effectSymbols(src), [])
  })

  it("ignores inline type specifiers inside a value import", () => {
    const src = `
      import { installFoo, type StartBarOptions } from "@/lib/foo"
      installFoo()
    `
    assert.deepEqual(effectSymbols(src), ["installFoo"])
  })

  it("ignores an effect that is imported but never invoked", () => {
    const src = `
      import { installFoo } from "@/lib/foo"
      export const handler = installFoo
    `
    assert.deepEqual(effectSymbols(src), [])
  })

  it("reports a renamed import under its export name, which is what the brain calls", () => {
    const src = `
      import { installFoo as installRenamed } from "@/lib/foo"
      installRenamed()
    `
    assert.deepEqual(effectSymbols(src), ["installFoo"])
  })

  // ADR-0250 B6: the name shape no longer decides what an effect is.
  it("finds any @/lib symbol an effect calls, whatever its name", () => {
    const src = `
      import { refreshExpiringOAuthCredentials, jitterCadenceMs } from "@/lib/oauth"
      export function Init() {
        useEffect(() => {
          const timer = setInterval(() => void refreshExpiringOAuthCredentials(), jitterCadenceMs(60))
          return () => clearInterval(timer)
        }, [])
      }
    `
    assert.deepEqual(effectSymbols(src).sort(), [
      "jitterCadenceMs",
      "refreshExpiringOAuthCredentials",
    ])
  })

  it("follows the local functions an effect calls, transitively", () => {
    const src = `
      import { rebuildDaily } from "@/lib/cost"
      import { formatLabel } from "@/lib/format"
      async function rebuild() { await rebuildDaily() }
      const run = async () => { await rebuild() }
      export function Init() {
        const label = formatLabel("x")
        useLayoutEffect(() => { void run() }, [])
        return label
      }
    `
    assert.deepEqual(effectSymbols(src), ["rebuildDaily"])
  })

  it("does not count a non-effect-shaped call made outside any effect", () => {
    const src = `
      import { formatLabel } from "@/lib/format"
      export function Init() { return formatLabel("x") }
    `
    assert.deepEqual(effectSymbols(src), [])
  })

  it("ignores effects imported from outside @/lib", () => {
    const src = `
      import { installFoo } from "@/components/foo"
      installFoo()
    `
    assert.deepEqual(effectSymbols(src), [])
  })

  it("reads destructured dynamic imports, Promise.all slots and namespace members", () => {
    const src = `
      export function Init() {
        useEffect(() => {
          void (async () => {
            const { notify } = await import("@/lib/notifications/runtime")
            const [{ setWriter }, { createWriter: makeWriter }, external] = await Promise.all([
              import("@/lib/db/writer"),
              import("@/lib/connectors/writer"),
              import("@tauri-apps/api/event"),
            ])
            const sessions = await import("@/lib/db/sessions")
            setWriter(makeWriter())
            await sessions.listSessions()
            await notify({ title: "x" })
            external.listen()
          })()
        }, [])
      }
    `
    assert.deepEqual(
      effectCalls(src).sort((a, b) => a.symbol.localeCompare(b.symbol)),
      [
        { symbol: "createWriter", spec: "@/lib/connectors/writer" },
        { symbol: "listSessions", spec: "@/lib/db/sessions" },
        { symbol: "notify", spec: "@/lib/notifications/runtime" },
        { symbol: "setWriter", spec: "@/lib/db/writer" },
      ]
    )
  })

  it("reads bindings from import().then callbacks", () => {
    // best-of-n-recovery-initializer and harness-evolution-initializer shape.
    const src = `
      export function Init() {
        useEffect(() => {
          void import("@/lib/best-of-n/restart-recovery")
            .then(({ recoverBestOfNRunsOnStartup }) => recoverBestOfNRunsOnStartup())
          void import("@/lib/harness/runtime/run-control")
            .then(async (control) => { await control.recoverOrphanedHarnessRuns() })
        }, [])
      }
    `
    assert.deepEqual(effectSymbols(src).sort(), [
      "recoverBestOfNRunsOnStartup",
      "recoverOrphanedHarnessRuns",
    ])
  })

  it("counts a function handed to the effect by reference as called", () => {
    const src = `
      import { refreshDaily, installFoo } from "@/lib/x"
      const run = () => { refreshDaily() }
      export function A() { useEffect(run, []) }
      export function B() { useLayoutEffect(installFoo, []) }
    `
    assert.deepEqual(effectSymbols(src).sort(), ["installFoo", "refreshDaily"])
  })

  it("is not cut short by a regex literal or a TSX closing tag", () => {
    const src = `
      import { refreshDaily, refreshWeekly } from "@/lib/x"
      export function Init() {
        useEffect(() => {
          const re = /\}\)/
          if (re.test("x")) refreshDaily()
          refreshWeekly()
        }, [])
        return <div>(</div>
      }
    `
    assert.deepEqual(effectSymbols(src).sort(), ["refreshDaily", "refreshWeekly"])
  })
})

describe("matchClose", () => {
  it("skips brackets inside strings, templates and comments", () => {
    const src = 'f(a, ")", `${g(")")}`, /* ) */ b) // )\nrest'
    assert.equal(src.slice(0, matchClose(src, 1)), 'f(a, ")", `${g(")")}`, /* ) */ b)')
  })
})

describe("effectBodies", () => {
  it("returns nothing for a file with no effects", () => {
    assert.equal(effectBodies("export const x = install()"), "")
  })
})

describe("isUiOnlyModule", () => {
  const read = (files) => (file) => {
    if (!(file in files)) throw new Error("ENOENT")
    return files[file]
  }

  it("accepts a module that imports React and nothing outside the UI kit", () => {
    const files = {
      "/m.ts": 'import { useSyncExternalStore } from "react"\nimport type { X } from "@/lib/x"',
    }
    assert.equal(isUiOnlyModule("/m.ts", read(files)), true)
  })

  it("accepts an import-free module whose code touches the DOM", () => {
    const files = { "/m.ts": "export function attach() { window.addEventListener('focus', f) }" }
    assert.equal(isUiOnlyModule("/m.ts", read(files)), true)
  })

  it("does not take the word window in a string for a DOM reference", () => {
    const files = {
      "/m.ts":
        'export function refresh(deps) { const message = "window"; setInterval(deps.poll, 1000) }',
    }
    assert.equal(isUiOnlyModule("/m.ts", read(files)), false)
  })

  it("rejects an import-free module that never touches React or the DOM", () => {
    // `startVideoJobReconciler`: dependency-injected host work, no imports.
    const files = {
      "/m.ts":
        "// reads navigator.locks by default\nexport function start(deps) { setInterval(deps.poll, 1) }",
    }
    assert.equal(isUiOnlyModule("/m.ts", read(files)), false)
  })

  it("rejects a module with any non-UI value import or a dynamic import", () => {
    const withLib = {
      "/m.ts": 'import { useState } from "react"\nimport { getDb } from "@/lib/db"',
    }
    const withDynamic = { "/m.ts": 'import { useState } from "react"\nconst m = import("./x")' }
    assert.equal(isUiOnlyModule("/m.ts", read(withLib)), false)
    assert.equal(isUiOnlyModule("/m.ts", read(withDynamic)), false)
  })

  it("is false for an unreadable module", () => {
    assert.equal(isUiOnlyModule("/missing.ts", read({})), false)
  })
})

describe("effectCalls over stores", () => {
  it("counts a store module's watcher an effect calls", () => {
    const source =
      'import { installImNotifyWatcher } from "@/stores/chat/im-notify-store"\n' +
      "useEffect(() => installImNotifyWatcher({ done: (t) => t }), [t])"
    assert.deepEqual(effectSymbols(source), ["installImNotifyWatcher"])
  })
})

describe("calledInBrain", () => {
  it("is true when a reachable module calls the symbol", () => {
    const corpus = new Map([["/repo/lib/headless/runtimes/a.ts", "installFoo({ x: 1 })"]])
    assert.equal(calledInBrain("installFoo", corpus), true)
  })

  it("is false when the only occurrence is the export declaration", () => {
    // The regression this gate exists for: `lib/agent/plan/notify.ts` is
    // reachable from the brain for its other exports, but nothing calls
    // installPlanNotificationActions there.
    const corpus = new Map([
      [
        "/repo/lib/agent/plan/notify.ts",
        "export function installPlanNotificationActions() { return () => {} }",
      ],
    ])
    assert.equal(calledInBrain("installPlanNotificationActions", corpus), false)
  })

  it("is true when the defining module also calls it", () => {
    const corpus = new Map([
      [
        "/repo/lib/foo.ts",
        "export function installFoo() {}\nexport function boot() { installFoo() }",
      ],
    ])
    assert.equal(calledInBrain("installFoo", corpus), true)
  })

  it("counts a module the brain imports but whose symbol it never calls as a gap", () => {
    // Module reachability alone would pass this; the gate must not regress to it.
    const corpus = new Map([
      [
        "/repo/lib/headless/runtimes/a.ts",
        'import { otherExport } from "@/lib/oauth"\notherExport()',
      ],
      [
        "/repo/lib/oauth.ts",
        "export async function refreshExpiringOAuthCredentials() {}\nexport function otherExport() {}",
      ],
    ])
    assert.equal(calledInBrain("refreshExpiringOAuthCredentials", corpus), false)
  })

  it("is false when nothing reachable mentions it", () => {
    const corpus = new Map([["/repo/lib/headless/runtimes/a.ts", "installBar()"]])
    assert.equal(calledInBrain("installFoo", corpus), false)
  })
})

describe("brainCorpus", () => {
  const root = "/repo"
  const files = {
    "/repo/lib/automation/audit.ts":
      "/**\n * `startAutomationAuditMirror()` registers the listener.\n */\n" +
      "export async function startAutomationAuditMirror() {}\n" +
      '// scanAndRegisterLocalPacks() runs at boot\nconst url = "https://x.test/a"\n',
    "/repo/components/agent/plan/plan-halt-dock.tsx":
      "useEffect(() => { void ensurePlanStepRecovery() })",
    "/repo/hooks/use-x.ts": "installFoo()",
    "/repo/components/providers/initializers/x-initializer.tsx": "installFoo()",
    "/repo/lib/x.test.ts": "installFoo()",
    "/repo/lib/headless/runtimes/a.ts": "installBar()",
  }
  const corpus = brainCorpus(Object.keys(files), (f) => files[f], root)

  it("does not count a call named only in a comment", () => {
    assert.equal(calledInBrain("startAutomationAuditMirror", corpus), false)
    assert.equal(calledInBrain("scanAndRegisterLocalPacks", corpus), false)
    assert.match(corpus.get("/repo/lib/automation/audit.ts"), /https:\/\/x\.test\/a/)
  })

  it("drops render-only directories, initializers and tests", () => {
    assert.equal(calledInBrain("ensurePlanStepRecovery", corpus), false)
    assert.equal(calledInBrain("installFoo", corpus), false)
    assert.equal(calledInBrain("installBar", corpus), true)
    assert.deepEqual([...corpus.keys()].sort(), [
      "/repo/lib/automation/audit.ts",
      "/repo/lib/headless/runtimes/a.ts",
    ])
  })

  it("blanks block and line comments but keeps code", () => {
    assert.equal(stripComments("a() /* b() */ // c()\nd()").replace(/\s+/g, " ").trim(), "a() d()")
  })
})

describe("moduleImports", () => {
  // Resolution hits the real filesystem, so the fixture names real repo
  // modules. `lib/headless/registry.ts` and `lib/headless/types.ts` are the
  // registry's own two halves and are as stable as this gate itself.
  const entry = join(REPO_ROOT, "lib/headless/entry-fixture.ts")
  const read = () => `
    import { registerHeadlessRuntime } from "@/lib/headless/registry"
    const m = await import("@/lib/headless/bootstrap")
    export * from "./types"
    import x from "some-npm-package"
    import y from "node:path"
  `

  it("follows static, dynamic and relative specifiers", () => {
    const found = moduleImports(entry, read).map((f) => relative(REPO_ROOT, f))
    assert.ok(found.includes("lib/headless/registry.ts"), "static @/ import")
    assert.ok(found.includes("lib/headless/bootstrap.ts"), "dynamic import()")
    assert.ok(found.includes("lib/headless/types.ts"), "relative re-export")
  })

  it("skips bare package and node: specifiers", () => {
    const found = moduleImports(entry, read).map((f) => relative(REPO_ROOT, f))
    assert.equal(found.length, 3)
    assert.ok(!found.some((f) => f.includes("some-npm-package")))
    assert.ok(!found.some((f) => f.includes("node:")))
  })

  it("returns an empty list when the file cannot be read", () => {
    assert.deepEqual(
      moduleImports(entry, () => {
        throw new Error("ENOENT")
      }),
      []
    )
  })
})

describe("reachableFrom", () => {
  it("terminates on an import cycle", () => {
    // A real cycle in this repo would otherwise hang the gate.
    const graph = { "/a.ts": "/b.ts", "/b.ts": "/a.ts" }
    const read = (f) => `from "${graph[f]}"`
    assert.doesNotThrow(() => reachableFrom(["/a.ts"], read))
  })
})

describe("reconcile", () => {
  const findings = [{ file: "a.tsx", symbols: ["installOne", "installTwo"] }]

  it("excuses only the named symbols, leaving the rest as violations", () => {
    const { violations } = reconcile(findings, {
      "a.tsx": { symbols: ["installTwo"], reason: "x".repeat(MIN_REASON_LENGTH) },
    })
    // The issue-tracker shape: one renderer-bound effect excused, the rest of
    // the file still gated.
    assert.deepEqual(violations, [{ file: "a.tsx", symbols: ["installOne"] }])
  })

  it("reports no violation when every dormant symbol is excused", () => {
    const { violations } = reconcile(findings, {
      "a.tsx": { symbols: ["installOne", "installTwo"], reason: "x".repeat(MIN_REASON_LENGTH) },
    })
    assert.deepEqual(violations, [])
  })

  it("flags a row whose file is no longer dormant at all", () => {
    const { stale } = reconcile([], {
      "gone.tsx": { symbols: ["installX"], reason: "y".repeat(30) },
    })
    assert.deepEqual(stale, [{ file: "gone.tsx", symbols: ["installX"] }])
  })

  it("flags an individual symbol that got wired while its siblings did not", () => {
    const { stale } = reconcile(findings, {
      "a.tsx": { symbols: ["installOne", "installWired"], reason: "y".repeat(30) },
    })
    assert.deepEqual(stale, [{ file: "a.tsx", symbols: ["installWired"] }])
  })

  it("flags short and missing reasons", () => {
    const { unreasoned } = reconcile(findings, {
      "a.tsx": { symbols: ["installOne"], reason: "too short" },
      "b.tsx": { symbols: ["installX"] },
    })
    assert.deepEqual(unreasoned.sort(), ["a.tsx", "b.tsx"])
  })

  it("rejects a file-level exclusion that names no symbols", () => {
    const { symbolless } = reconcile(findings, {
      "a.tsx": { reason: "z".repeat(30) },
      "b.tsx": { symbols: [], reason: "z".repeat(30) },
    })
    assert.deepEqual(symbolless.sort(), ["a.tsx", "b.tsx"])
  })
})

describe("reconcile: pending debt", () => {
  const findings = [{ file: "a.tsx", symbols: ["refreshOne", "refreshTwo"] }]
  const pendingRow = (symbols) => ({ symbols, phase: "phase 1", reason: "r".repeat(30) })

  it("excuses pending symbols like exclusions", () => {
    const result = reconcile(
      findings,
      {},
      {
        pending: { "a.tsx": pendingRow(["refreshOne", "refreshTwo"]) },
        pendingCeiling: 2,
      }
    )
    assert.deepEqual(result.violations, [])
    assert.equal(result.ceilingDrift, null)
  })

  it("only shrinks: new debt above the ceiling fails", () => {
    const { ceilingDrift } = reconcile(
      findings,
      {},
      {
        pending: { "a.tsx": pendingRow(["refreshOne", "refreshTwo"]) },
        pendingCeiling: 1,
      }
    )
    assert.deepEqual(ceilingDrift, { count: 2, ceiling: 1 })
  })

  it("fails until the ceiling is lowered after debt is paid down", () => {
    const { ceilingDrift } = reconcile(
      findings,
      {},
      {
        pending: { "a.tsx": pendingRow(["refreshOne"]) },
        pendingCeiling: 2,
      }
    )
    assert.deepEqual(ceilingDrift, { count: 1, ceiling: 2 })
  })

  it("flags a pending symbol that got wired", () => {
    const { stalePending } = reconcile(
      [{ file: "a.tsx", symbols: ["refreshOne"] }],
      {},
      {
        pending: { "a.tsx": pendingRow(["refreshOne", "refreshTwo"]) },
        pendingCeiling: 2,
      }
    )
    assert.deepEqual(stalePending, [{ file: "a.tsx", symbols: ["refreshTwo"] }])
  })

  it("requires a phase and refuses a symbol booked as both decision and debt", () => {
    const result = reconcile(
      findings,
      { "a.tsx": { symbols: ["refreshOne"], reason: "y".repeat(30) } },
      {
        pending: { "a.tsx": { symbols: ["refreshOne"], reason: "r".repeat(30) } },
        pendingCeiling: 1,
      }
    )
    assert.deepEqual(result.phaseless, ["a.tsx"])
    assert.deepEqual(result.doubleBooked, [{ file: "a.tsx", symbols: ["refreshOne"] }])
  })

  it("accepts pending debt with or without blockedBy, but not a blockedBy that names nothing", () => {
    const row = (extra) => ({
      symbols: ["refreshOne"],
      phase: "phase 2",
      reason: "r".repeat(30),
      ...extra,
    })
    const ok = reconcile(
      findings,
      {},
      {
        pending: { "a.tsx": row({ blockedBy: "the subscription-vault decision" }) },
        pendingCeiling: 1,
      }
    )
    assert.deepEqual(ok.vagueBlockedBy, [])
    assert.deepEqual(
      reconcile(findings, {}, { pending: { "a.tsx": row({}) }, pendingCeiling: 1 }).vagueBlockedBy,
      []
    )
    for (const blockedBy of ["", "tbd", 7]) {
      assert.deepEqual(
        reconcile(findings, {}, { pending: { "a.tsx": row({ blockedBy }) }, pendingCeiling: 1 })
          .vagueBlockedBy,
        ["a.tsx"],
        String(blockedBy)
      )
    }
  })

  it("flags a uiOnly symbol no initializer leaves dormant any more", () => {
    const { staleUiOnly } = reconcile(
      [],
      {},
      {
        uiOnly: { "@/lib/ui": { symbols: ["paint", "gone"], reason: "u".repeat(30) } },
        // Used under another module does not keep this module's row alive.
        uiOnlyUsed: new Set([uiOnlyKey("@/lib/ui", "paint"), uiOnlyKey("@/lib/other", "gone")]),
      }
    )
    assert.deepEqual(staleUiOnly, [{ file: "@/lib/ui", symbols: ["gone"] }])
  })

  it("fails when the ceiling rises above the base branch's, even with the count matching", () => {
    const { ceilingDrift, ceilingRaised } = reconcile(
      findings,
      {},
      {
        pending: { "a.tsx": pendingRow(["refreshOne", "refreshTwo"]) },
        pendingCeiling: 2,
        baseCeiling: 1,
      }
    )
    assert.equal(ceilingDrift, null)
    assert.deepEqual(ceilingRaised, { ceiling: 2, baseCeiling: 1 })
  })

  it("reads the base ceiling at the merge-base, and gives up quietly without git", () => {
    const calls = []
    const exec = (cmd, args) => {
      calls.push(args[0])
      return args[0] === "merge-base" ? "abc123\n" : JSON.stringify({ pendingCeiling: 7 })
    }
    assert.equal(readBaseCeiling(exec), 7)
    assert.deepEqual(calls, ["merge-base", "show"])
    assert.equal(
      readBaseCeiling(() => {
        throw new Error("not a git repository")
      }),
      undefined
    )
    assert.equal(
      readBaseCeiling(() => "{}"),
      undefined
    )
  })

  it("counts pending symbols across rows", () => {
    assert.equal(pendingCount({ a: { symbols: ["x", "y"] }, b: { symbols: ["z"] } }), 3)
    assert.equal(pendingCount(undefined), 0)
  })
})

describe("the real repository", () => {
  // The audit's verified regression (ADR-0250 B6): a provider-only OAuth
  // refresh loop the brain never runs. It must be a finding, owned by the
  // ledger, not invisible to the gate.
  it("finds refreshExpiringOAuthCredentials in the provider OAuth refresh initializer", () => {
    const { findings } = analyze()
    const finding = findings.find(
      (f) => f.file === "components/providers/initializers/provider-oauth-refresh-initializer.tsx"
    )
    assert.ok(finding?.symbols.includes("refreshExpiringOAuthCredentials"), JSON.stringify(finding))
  })

  it("does not let a uiOnly row for one module excuse the same name from another", () => {
    const { findings } = analyze({
      uiOnly: {
        "@/lib/elsewhere": { symbols: ["refreshExpiringOAuthCredentials"], reason: "x".repeat(30) },
      },
    })
    assert.ok(
      findings.some((f) => f.symbols.includes("refreshExpiringOAuthCredentials")),
      "the row names a different module"
    )
  })
})

describe("the shipped exclusions ledger", () => {
  const ledger = readExclusions()

  it("gives every exclusion a substantive reason", () => {
    for (const [file, entry] of Object.entries(ledger.initializers)) {
      assert.ok(
        entry.reason && entry.reason.trim().length >= MIN_REASON_LENGTH,
        `${file} needs a reason of at least ${MIN_REASON_LENGTH} characters`
      )
    }
  })

  it("names explicit symbols on every row", () => {
    for (const [file, entry] of Object.entries(ledger.initializers)) {
      assert.ok(
        Array.isArray(entry.symbols) && entry.symbols.length > 0,
        `${file} must name the symbols it excuses, not the whole file`
      )
    }
  })

  it("names a phase on every pending row and records the pending count as its ceiling", () => {
    for (const [file, entry] of Object.entries(ledger.pending ?? {})) {
      assert.ok(entry.phase?.trim(), `${file} must name the ADR-0250 phase that moves it`)
    }
    assert.equal(ledger.pendingCeiling, pendingCount(ledger.pending))
  })

  it("owns the audit's OAuth refresh finding instead of leaving it invisible", () => {
    const file = "components/providers/initializers/provider-oauth-refresh-initializer.tsx"
    const owned = [
      ...(ledger.initializers[file]?.symbols ?? []),
      ...(ledger.pending?.[file]?.symbols ?? []),
    ]
    assert.ok(owned.includes("refreshExpiringOAuthCredentials"))
  })

  it("never excuses an effect as merely unported", () => {
    // The ledger's own rule: unported work is debt for the registry, not a
    // decision for the ledger. Catching the phrasing keeps the two apart.
    for (const [file, entry] of Object.entries(ledger.initializers)) {
      assert.doesNotMatch(
        entry.reason,
        /\b(not (yet )?ported|todo|later|for now|temporarily)\b/i,
        `${file} records debt, not a decision`
      )
    }
  })
})
