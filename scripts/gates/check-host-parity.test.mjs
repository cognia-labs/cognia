import { strict as assert } from "node:assert"
import { describe, it } from "node:test"

import {
  CLASSIFICATIONS,
  ENFORCE_RATCHET,
  isFileAnnotation,
  stripComments,
  censusRuntimeGuards,
  checkAnnotations,
  classifyDesktopContracts,
  classifyPhysicalSeams,
  diffAgainstBaseline,
  findCapabilityMisreports,
  findDesktopOnlySections,
  findOneSidedArms,
  findSeamBypasses,
  isAuxiliaryFile,
  isRendererSource,
  parseHostFeatures,
  parseHostGatedArms,
  subsystemOf,
  tauriRuntimeImports,
} from "./check-host-parity.mjs"

const io = (files) => ({ read: (p) => files[p] ?? "" })

describe("file classification", () => {
  it("treats tests, specs, stories and mocks as auxiliary", () => {
    assert.equal(isAuxiliaryFile("lib/x.test.ts"), true)
    assert.equal(isAuxiliaryFile("lib/x.spec.tsx"), true)
    assert.equal(isAuxiliaryFile("components/x.stories.tsx"), true)
    assert.equal(isAuxiliaryFile("lib/__mocks__/x.ts"), true)
    assert.equal(isAuxiliaryFile("lib/x.ts"), false)
  })

  it("counts only shipped renderer source", () => {
    assert.equal(isRendererSource("lib/a/b.ts"), true)
    assert.equal(isRendererSource("components/a/b.tsx"), true)
    assert.equal(isRendererSource("packages/ocr/src/a.ts"), true)
    assert.equal(isRendererSource("lib/a/b.test.ts"), false)
    assert.equal(isRendererSource("src-tauri/src/lib.rs"), false)
    assert.equal(isRendererSource("scripts/gates/x.mjs"), false)
  })

  it("keys subsystems on the first two path segments", () => {
    assert.equal(subsystemOf("lib/connectors/adapters/lark/index.ts"), "lib/connectors")
    assert.equal(subsystemOf("lib/tauri.ts"), "lib/tauri.ts")
  })
})

describe("class A — transport-seam bypass", () => {
  it("flags a direct @tauri-apps import in renderer source", () => {
    const files = {
      "lib/x/a.ts": 'import { invoke } from "@tauri-apps/api/core"',
      "lib/x/b.ts": 'import { listen } from "@tauri-apps/api/event"',
      "lib/x/c.ts": 'import { transport } from "@/lib/tauri"',
    }
    assert.deepEqual(findSeamBypasses(Object.keys(files), io(files)), [
      "A:lib/x/a.ts",
      "A:lib/x/b.ts",
    ])
  })

  it("exempts the seam owners themselves", () => {
    const files = {
      "lib/tauri/transport-tauri.ts": 'import { invoke } from "@tauri-apps/api/core"',
      "lib/connectors/events.ts": 'import { listen } from "@tauri-apps/api/event"',
      "lib/connectors/tauri/commands.ts": 'import { invoke } from "@tauri-apps/api/core"',
    }
    assert.deepEqual(findSeamBypasses(Object.keys(files), io(files)), [])
  })

  it("ignores type-only imports, which are erased and call nothing", () => {
    const files = {
      "lib/x/a.ts": 'import type { UnlistenFn } from "@tauri-apps/api/event"',
      "lib/x/b.ts":
        'import { transport } from "@/lib/tauri"\nimport type { UnlistenFn } from "@tauri-apps/api/event"',
      "lib/x/c.ts": 'import {\n  invoke,\n  type InvokeArgs,\n} from "@tauri-apps/api/core"',
      "lib/x/d.ts": 'export { invoke } from "@tauri-apps/api/core"',
    }
    assert.deepEqual(findSeamBypasses(Object.keys(files), io(files)), [
      "A:lib/x/c.ts",
      "A:lib/x/d.ts",
    ])
  })

  it("ignores tests and stories, which never ship as a host path", () => {
    const files = {
      "lib/x/a.test.ts": 'import { invoke } from "@tauri-apps/api/core"',
      "components/x/a.stories.tsx": 'import { invoke } from "@tauri-apps/api/core"',
    }
    assert.deepEqual(findSeamBypasses(Object.keys(files), io(files)), [])
  })
})

describe("class B — desktop-only UI sections", () => {
  it("extracts section ids marked desktopOnly", () => {
    const source = `
      { id: "gateway", label: "Gateway", desktopOnly: true },
      { id: "chat", label: "Chat" },
      { id: "fleet", label: "Fleet", desktopOnly: true },
    `
    assert.deepEqual(findDesktopOnlySections(source), ["B:fleet", "B:gateway"])
  })

  it("does not let an entry claim the next entry's desktopOnly flag", () => {
    // The lazy span must stop at the following `id:`, or "chat" absorbs the
    // flag that belongs to "gateway".
    const source = `{ id: "chat", label: "Chat" }, { id: "gateway", desktopOnly: true }`
    assert.deepEqual(findDesktopOnlySections(source), ["B:gateway"])
  })

  it("gives up rather than pairing across a large unrelated span", () => {
    const source = `{ id: "chat" },${"x".repeat(500)} desktopOnly: true`
    assert.deepEqual(findDesktopOnlySections(source), [])
  })
})

describe("class C — one-sided RPC arms", () => {
  it("reads the common desktop-only idiom", () => {
    const src = `"a_cmd" => { let app = host.tauri_app(name)?; }`
    assert.deepEqual(parseHostGatedArms(src), [{ command: "a_cmd", side: "desktop-only" }])
  })

  it("reads the belt-and-braces desktop-only idiom as desktop, not headless", () => {
    // automation_consent_* rejects headless explicitly BEFORE taking the app.
    const src = `"a_cmd" => {
      if host.headless().is_some() { return Err(RpcError::headless_unsupported(name)); }
      let app = host.tauri_app(name)?;
    }`
    const sides = parseHostGatedArms(src).map((g) => g.side)
    assert.deepEqual([...new Set(sides)], ["desktop-only"])
  })

  it("does not read a host-kind label or a match guard as a rejection", () => {
    // gateway_plane.rs `with_gateway` labels the host; data_sync.rs passes
    // `is_some()` into the next arm's guard. Neither refuses a headless host.
    const label = `fn with_gateway() { f(g, if host.headless().is_some() { "headless" } else { "desktop" }) }
      match name { "gateway_status" => with_gateway(), "gateway_list_models" => with_gateway() }`
    assert.deepEqual(parseHostGatedArms(label), [])
    const guard = `"background_monitor_register_scheduled" => { run().await }
      "workflow_approval_list" | "workflow_approval_respond"
          if needs_ts_authority(
              name,
              host.headless().is_some(),
          ) =>
      { bridge() }`
    assert.deepEqual(parseHostGatedArms(guard), [])
  })

  it("attributes a gate inside a guarded arm to that arm", () => {
    const src = `"a_cmd" => { ok() }
      "b_cmd" | "c_cmd" if wants(name) => { let app = host.tauri_app(name)?; }`
    assert.deepEqual(parseHostGatedArms(src), [
      { command: "b_cmd", side: "desktop-only" },
      { command: "c_cmd", side: "desktop-only" },
    ])
  })

  it("reads the headless-only idiom across rustfmt's line breaks", () => {
    const src = `"a_cmd" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
        }`
    assert.deepEqual(parseHostGatedArms(src), [{ command: "a_cmd", side: "headless-only" }])
  })

  it("attributes a multi-pattern arm to every name it dispatches", () => {
    const src = `"a_cmd" | "b_cmd" => { let app = host.tauri_app(name)?; }`
    assert.deepEqual(parseHostGatedArms(src), [
      { command: "a_cmd", side: "desktop-only" },
      { command: "b_cmd", side: "desktop-only" },
    ])
  })

  it("treats a gate before the first arm as guarding the whole family", () => {
    // rpc/codex_app.rs gates its entire family at the top of dispatch.
    const src = `let app = host.tauri_app(name)?;
      match name { "a_cmd" => x(), "b_cmd" => y() }`
    assert.deepEqual(parseHostGatedArms(src), [
      { command: "a_cmd", side: "desktop-only" },
      { command: "b_cmd", side: "desktop-only" },
    ])
  })

  it("drops labels that are not real commands", () => {
    // rpc.rs maps error codes with the same `"name" =>` shape.
    const modules = [{ path: "rpc.rs", source: `"spawn_failed" => { host.tauri_app(name)?; }` }]
    const { findings } = findOneSidedArms(modules, new Map(), new Set(["real_cmd"]))
    assert.deepEqual(findings, [])
  })

  it("flags a headless-only arm a paired device can still address", () => {
    const modules = [
      {
        path: "rpc/service_plane.rs",
        source: `"spawn_external_agent" => { host.headless().ok_or_else(|| RpcError::headless_unsupported(name))?; }`,
      },
    ]
    const manifest = new Map([
      ["spawn_external_agent", { target: "execution", transports: ["http", "websocket"] }],
    ])
    const { findings, remotelyReachable } = findOneSidedArms(modules, manifest)
    assert.deepEqual(findings, ["C:spawn_external_agent:headless-only"])
    assert.deepEqual(remotelyReachable, ["spawn_external_agent"])
  })

  it("skips an internal-only headless arm the desktop serves as its own command", () => {
    // connectors_matrix_crypto_*: the brain's service-plane route to what the
    // desktop runs as a Tauri command of the same name.
    const gate = `host.headless().ok_or_else(|| RpcError::headless_host_required(name))?;`
    const modules = [
      {
        path: "rpc/service_plane.rs",
        source: `"crypto_backup" => { ${gate} } "only_headless" => { ${gate} } "remote_cmd" => { ${gate} }`,
      },
    ]
    const manifest = new Map([
      ["crypto_backup", { target: "service", transports: ["internal"] }],
      ["only_headless", { target: "service", transports: ["internal"] }],
      ["remote_cmd", { target: "execution", transports: ["internal", "http"] }],
    ])
    const { findings } = findOneSidedArms(
      modules,
      manifest,
      new Set(["crypto_backup", "remote_cmd"])
    )
    assert.deepEqual(findings, ["C:only_headless:headless-only", "C:remote_cmd:headless-only"])
  })

  it("does not flag an internal-only headless arm as remotely reachable", () => {
    const modules = [
      {
        path: "rpc/service_plane.rs",
        source: `"connectors_register" => { host.headless().ok_or_else(|| RpcError::headless_unsupported(name))?; }`,
      },
    ]
    const manifest = new Map([
      ["connectors_register", { target: "service", transports: ["internal"] }],
    ])
    const { remotelyReachable } = findOneSidedArms(modules, manifest)
    assert.deepEqual(remotelyReachable, [])
  })
})

describe("class D — runtime-guard census", () => {
  it("aggregates guard sites per subsystem and skips auxiliary files", () => {
    const files = {
      "lib/git/a.ts": "if (isTauri()) {} if (isTauri()) {}",
      "lib/git/b.ts": "usePlatform()",
      "lib/git/b.test.ts": "isTauri() isTauri() isTauri()",
      "components/x/c.tsx": "isHeadlessHost()",
    }
    const census = censusRuntimeGuards(Object.keys(files), io(files))
    assert.deepEqual(census.get("lib/git"), { files: 2, sites: 3 })
    assert.deepEqual(census.get("components/x"), { files: 1, sites: 1 })
  })
})

describe("class E — capability tables vs. the manifest", () => {
  it("flags a tauri-only feature whose operations are not desktop-gated", () => {
    const features = [
      { feature: "source-control.git", hosts: ["tauri"], operations: ["git_status"] },
    ]
    assert.deepEqual(findCapabilityMisreports(features, new Set()), [
      "E:source-control.git:under-reported-headless",
    ])
  })

  it("stays silent when the feature really is desktop-gated", () => {
    const features = [
      { feature: "automation.hitl", hosts: ["tauri"], operations: ["automation_consent_respond"] },
    ]
    const gated = new Set(["automation_consent_respond"])
    assert.deepEqual(findCapabilityMisreports(features, gated), [])
  })

  it("stays silent for a feature that already claims more than one host", () => {
    const features = [
      { feature: "ocr.server", hosts: ["tauri", "headless"], operations: ["ocr_extract_native"] },
    ]
    assert.deepEqual(findCapabilityMisreports(features, new Set()), [])
  })

  it("reads hosts and operations out of the manifest module's guards", () => {
    const source = `
  if (platform === "tauri") {
    features["source-control.git"] = {
      version: 1,
      operations: ["git_status", "git_commit"],
    }
  }
`
    const parsed = parseHostFeatures(io({ "lib/platform/host-feature-manifest.ts": source }))
    assert.deepEqual(parsed, [
      { feature: "source-control.git", hosts: ["tauri"], operations: ["git_status", "git_commit"] },
    ])
  })
})

describe("ratchet", () => {
  it("reports nothing when the findings match the baseline", () => {
    const { added, fixed } = diffAgainstBaseline(["A:x", "B:y"], ["A:x", "B:y"])
    assert.deepEqual(added, [])
    assert.deepEqual(fixed, [])
  })

  it("reports a new finding as added", () => {
    const { added, fixed } = diffAgainstBaseline(["A:x", "A:new"], ["A:x"])
    assert.deepEqual(added, ["A:new"])
    assert.deepEqual(fixed, [])
  })

  it("reports a closed gap as fixed so the baseline can shrink", () => {
    const { added, fixed } = diffAgainstBaseline(["A:x"], ["A:x", "B:gone"])
    assert.deepEqual(added, [])
    assert.deepEqual(fixed, ["B:gone"])
  })

  it("enforces now that the paydown batch has landed", () => {
    // Guards the documented switch in both directions: flipping this constant
    // is the whole migration from buffer period to hard failure, and turning it
    // back off would silently reopen a buffer ADR-0059 D7 called "not
    // open-ended". Either change must be deliberate.
    assert.equal(ENFORCE_RATCHET, true)
  })
})

describe("annotations", () => {
  const census = new Map([
    ["lib/git", { files: 1, sites: 1 }],
    ["lib/tray", { files: 1, sites: 1 }],
  ])

  it("reports a subsystem nobody has classified", () => {
    const { missing } = checkAnnotations(census, { "lib/git": { classification: "unmigrated" } })
    assert.deepEqual(missing, ["lib/tray"])
  })

  it("rejects a classification outside the known set", () => {
    const annotations = {
      "lib/git": { classification: "unmigrated" },
      "lib/tray": { classification: "probably-fine" },
    }
    const { invalid } = checkAnnotations(census, annotations)
    assert.deepEqual(invalid, ["lib/tray"])
  })

  it("reports an annotation whose subsystem no longer has guards", () => {
    const annotations = {
      "lib/git": { classification: "unmigrated" },
      "lib/tray": { classification: "physically-impossible" },
      "lib/removed": { classification: "unmigrated" },
    }
    const { stale } = checkAnnotations(census, annotations)
    assert.deepEqual(stale, ["lib/removed"])
  })

  it("names seam-infrastructure as a first-class classification", () => {
    // lib/tauri alone carries 121 guards; they are the seam, not a gap.
    assert.ok(CLASSIFICATIONS.includes("seam-infrastructure"))
  })
})

describe("annotation granularity", () => {
  // Annotations come at two granularities. Comparing a FILE key against the
  // subsystem census reported every per-file judgment as stale on every run —
  // `lib/native/codex-app-dispatch.ts` carries a dated, fully reasoned
  // classification and was listed as stale forever.
  it("tells a file annotation from a subsystem annotation", () => {
    assert.equal(isFileAnnotation("lib/native/codex-app-dispatch.ts"), true)
    assert.equal(isFileAnnotation("components/foo/bar.tsx"), true)
    assert.equal(isFileAnnotation("lib/connectors"), false)
    assert.equal(isFileAnnotation("app/issues"), false)
  })

  it("keeps a file annotation while its file exists", () => {
    const census = new Map([["lib/git", { files: 1, sites: 1 }]])
    const annotations = {
      "lib/git": { classification: "unmigrated" },
      "lib/native/codex-app-dispatch.ts": { classification: "physically-impossible" },
    }
    const { stale } = checkAnnotations(census, annotations, () => true)
    assert.deepEqual(stale, [])
  })

  it("reports a file annotation whose file is gone", () => {
    const census = new Map([["lib/git", { files: 1, sites: 1 }]])
    const annotations = {
      "lib/git": { classification: "unmigrated" },
      "lib/native/deleted.ts": { classification: "physically-impossible" },
    }
    const { stale } = checkAnnotations(census, annotations, () => false)
    assert.deepEqual(stale, ["lib/native/deleted.ts"])
  })

  it("validates the classification on file annotations too", () => {
    const { invalid } = checkAnnotations(
      new Map(),
      { "lib/native/x.ts": { classification: "made-up" } },
      () => true
    )
    assert.deepEqual(invalid, ["lib/native/x.ts"])
  })
})

describe("stripComments", () => {
  // `lib/agent-trace` entered the inventory on the strength of one doc comment
  // reading "callers guard with `isTauri()` upstream" — a subsystem with zero
  // guards demanding a parity classification.
  it("drops guards that appear only in prose", () => {
    const source = [
      "/** callers guard with `isTauri()` upstream. */",
      "// also isHeadlessHost() here",
      "export function f() { return 1 }",
    ].join("\n")
    assert.equal(/\b(isTauri|isHeadlessHost|usePlatform)\s*\(/.test(stripComments(source)), false)
  })

  it("keeps real guards", () => {
    const source = "// a note\nif (isTauri()) return null"
    assert.equal(stripComments(source).includes("isTauri()"), true)
  })

  it("does not eat the scheme in a url inside code", () => {
    assert.equal(stripComments('const u = "https://x.dev"').includes("https://x.dev"), true)
  })
})

describe("exact physical desktop contracts", () => {
  const contract = {
    classification: "physically-impossible",
    side: "desktop-only",
    reason: "OS input engine",
    implementation: "native.rs",
    test: "tests.rs",
    testName: "rejects_headless",
  }
  const source = io({
    "native.rs": '#[cfg(feature = "tauri-host")] fn automation_status(state: AutomationState) {}',
    "tests.rs":
      'fn rejects_headless() { dispatch("automation_status").expect_err("headless_unsupported");\n}',
  })
  it("classifies only the verified exact desktop command", () => {
    const result = classifyDesktopContracts(
      ["C:automation_status:desktop-only", "C:other_command:desktop-only"],
      { automation_status: contract },
      source
    )
    assert.deepEqual(result.findings, ["C:other_command:desktop-only"])
    assert.deepEqual(result.classified, ["C:automation_status:desktop-only"])
    assert.deepEqual(result.errors, [])
  })
  it("keeps an unclassified command as new debt even when other debt shrinks", () => {
    const result = classifyDesktopContracts(["C:other_command:desktop-only"], {}, source)
    assert.deepEqual(
      diffAgainstBaseline(result.findings, ["C:old_one:desktop-only", "C:old_two:desktop-only"])
        .added,
      ["C:other_command:desktop-only"]
    )
  })
  it("rejects stale contracts and guards whose host direction changed", () => {
    for (const findings of [[], ["C:automation_status:headless-only"]]) {
      const result = classifyDesktopContracts(findings, { automation_status: contract }, source)
      assert.match(result.errors[0], /stale or mismatched/)
      assert.deepEqual(result.classified, [])
    }
  })
  it("rejects broad names, wrong classifications and missing rejection evidence", () => {
    for (const change of [
      { side: "headless-only" },
      { classification: "unmigrated" },
      { reason: "" },
      { implementation: "missing.rs" },
      { testName: "missing_test" },
    ]) {
      const result = classifyDesktopContracts(
        ["C:automation_status:desktop-only"],
        { automation_status: { ...contract, ...change } },
        source
      )
      assert.equal(result.errors.length, 1)
      assert.deepEqual(result.findings, ["C:automation_status:desktop-only"])
    }
    assert.equal(
      classifyDesktopContracts(
        ["C:automation_*:desktop-only"],
        { "automation_*": contract },
        source
      ).errors.length,
      1
    )
  })
})

describe("class A — verified physical seams", () => {
  it("lists the runtime names a file binds from Tauri", () => {
    assert.deepEqual(
      tauriRuntimeImports(
        'import { Channel, invoke as call, type InvokeArgs } from "@tauri-apps/api/core"\n' +
          'import type { UnlistenFn } from "@tauri-apps/api/event"\n' +
          'import * as events from "@tauri-apps/api/event"'
      ),
      ["*", "Channel", "invoke"]
    )
  })

  const note = "a Channel carries raw frames"
  const files = {
    "lib/x/seam.ts":
      'import { Channel, invoke } from "@tauri-apps/api/core"\n' +
      'invoke("frames_subscribe", { channel: new Channel() })',
  }
  const annotate = (physicalSeam, extra = {}) => ({
    "lib/x/seam.ts": { classification: "physically-impossible", note, physicalSeam, ...extra },
  })

  it("classifies a finding whose imports and commands match its pin", () => {
    const result = classifyPhysicalSeams(
      ["A:lib/x/seam.ts", "A:lib/x/other.ts"],
      annotate({ imports: ["Channel", "invoke"], invokes: ["frames_subscribe"] }),
      io(files)
    )
    assert.deepEqual(result, {
      findings: ["A:lib/x/other.ts"],
      classified: ["A:lib/x/seam.ts"],
      errors: [],
    })
  })

  it("fails on an import or a command beyond the pin", () => {
    const narrower = classifyPhysicalSeams(
      ["A:lib/x/seam.ts"],
      annotate({ imports: ["Channel"] }),
      io(files)
    )
    assert.deepEqual(narrower.errors, ["lib/x/seam.ts: imports invoke beyond its physical seam"])
    const commands = classifyPhysicalSeams(
      ["A:lib/x/seam.ts"],
      annotate({ imports: ["Channel", "invoke"], invokes: [] }),
      io(files)
    )
    assert.deepEqual(commands.errors, [
      "lib/x/seam.ts: invokes frames_subscribe beyond its physical seam",
    ])
    assert.deepEqual(commands.findings, ["A:lib/x/seam.ts"])
  })

  it("follows aliases, namespaces and values of invoke, and counts star re-exports", () => {
    const pin = annotate({ imports: ["Channel", "invoke"], invokes: ["frames_subscribe"] })
    const run = (extra) =>
      classifyPhysicalSeams(
        ["A:lib/x/seam.ts"],
        pin,
        io({ "lib/x/seam.ts": files["lib/x/seam.ts"] + extra })
      ).errors
    assert.deepEqual(
      run('\nimport { invoke as direct } from "@tauri-apps/api/core"\ndirect("other_cmd")'),
      ["lib/x/seam.ts: invokes other_cmd beyond its physical seam"]
    )
    assert.deepEqual(run('\nconst f = invoke\nf("other_cmd")'), [
      "lib/x/seam.ts: invokes <reference> beyond its physical seam",
    ])
    assert.deepEqual(run('\nexport * from "@tauri-apps/api/core"'), [
      "lib/x/seam.ts: imports * beyond its physical seam",
    ])
    assert.deepEqual(
      run('\nimport * as tauri from "@tauri-apps/api/core"\ntauri.invoke("other_cmd")'),
      ["lib/x/seam.ts: imports * beyond its physical seam"]
    )
    assert.deepEqual(run('\ninvoke<string>("frames_subscribe", {})'), [])
    assert.deepEqual(
      run(
        '\nexport const unpinned = () => invoke("other_cmd")\n' +
          'export type { Summary } from "@/lib/browser/session-types"'
      ),
      ["lib/x/seam.ts: invokes other_cmd beyond its physical seam"]
    )
  })

  it("rejects a pin on a non-physical or stale annotation", () => {
    assert.deepEqual(
      classifyPhysicalSeams(
        ["A:lib/x/seam.ts"],
        annotate({ imports: ["Channel", "invoke"] }, { classification: "unmigrated" }),
        io(files)
      ).errors,
      ["lib/x/seam.ts: invalid physical seam annotation"]
    )
    assert.deepEqual(
      classifyPhysicalSeams([], annotate({ imports: ["Channel", "invoke"] }), io(files)).errors,
      ["lib/x/seam.ts: stale physical seam (the file no longer imports Tauri directly)"]
    )
  })
})
