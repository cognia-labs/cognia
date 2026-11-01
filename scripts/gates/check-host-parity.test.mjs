import { strict as assert } from "node:assert"
import { describe, it } from "node:test"

import {
  CLASSIFICATIONS,
  ENFORCE_RATCHET,
  isFileAnnotation,
  stripComments,
  censusRuntimeGuards,
  checkAnnotations,
  checkLocalTransportPins,
  collect,
  pruneLocalTransportPins,
  RPC_HOST_FILE,
  classifyDesktopContracts,
  collectLocalTransportUses,
  eventNames,
  headlessAbsentAccessors,
  isTypedDynamicBypass,
  localTransportUses,
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

describe("type-only imports beside a dynamic runtime import", () => {
  const typed = 'import type { Event } from "@tauri-apps/api/event"\n'
  const dynamic = 'const { listen } = await import("@tauri-apps/api/event")\nlisten("x", f)\n'

  it("reports a file that imports the types statically and the runtime dynamically", () => {
    const files = { "lib/a/audit.ts": typed + dynamic, "lib/a/types.ts": typed }
    assert.deepEqual(findSeamBypasses(Object.keys(files), io(files)), ["A:lib/a/audit.ts"])
    assert.equal(isTypedDynamicBypass(typed + dynamic), true)
  })

  it("leaves a dynamic import alone without a static one (counted separately, ledger X21)", () => {
    assert.equal(isTypedDynamicBypass(dynamic), false)
    assert.equal(isTypedDynamicBypass(typed + `// ${dynamic}`), false)
  })
})

describe("accessor-style headless refusals", () => {
  const rpcHost = `
impl RpcHost for DesktopHost {
    fn codex_app_host(&self) -> Option<Box<dyn X>> {
        None
    }
}

impl RpcHost for Arc<HeadlessServices> {
    fn headless(&self) -> Option<&Arc<HeadlessServices>> {
        Some(self)
    }
    fn gateway(&self) -> Option<&GatewayState> {
        Some(self.gateway.as_ref())
    }
    fn automation(&self) -> Option<HostAutomation<'_>> {
        None
    }
    // fn ghost(&self) -> Option<u8> { None }
    fn codex_app_host(&self) -> Option<Box<dyn cognia_codex_app::CodexAppHost + '_>> {
        None
    }
}
`

  it("reads the accessors the headless host answers with a literal None", () => {
    assert.deepEqual(headlessAbsentAccessors(rpcHost), ["automation", "codex_app_host"])
    assert.deepEqual(headlessAbsentAccessors("impl RpcHost for Other {}"), [])
  })

  it("attributes a dispatch-level refusal to every arm of that dispatch fn", () => {
    const src = `
fn helper(host: &dyn RpcHost, name: &str) -> Result<A, E> {
    host.automation().ok_or_else(|| RpcError::headless_unsupported(name))
}

pub(super) async fn dispatch(name: &str, host: &dyn RpcHost) -> Result<Value, E> {
    let app = host
        .codex_app_host()
        .ok_or_else(|| RpcError::headless_unsupported(name))?;
    match name {
        "codex_app_a" => a(app),
        "codex_app_b" | "codex_app_c" => b(app),
        _ => unknown(name),
    }
}

async fn other(name: &str, host: &dyn RpcHost) -> Result<Value, E> {
    match name {
        "other_a" => {
            let auto = host.automation().ok_or_else(|| RpcError::headless_unsupported(name))?;
            run(auto)
        }
        "other_b" => {
            let s = host.companion_server().ok_or_else(|| RpcError::internal("x"))?;
            s.go()
        }
        "other_c" => helper(host, name).map(run),
    }
}
`
    const gated = parseHostGatedArms(src, ["automation", "codex_app_host", "companion_server"])
    assert.deepEqual(gated.map((g) => `${g.command}:${g.side}`).sort(), [
      "codex_app_a:desktop-only",
      "codex_app_b:desktop-only",
      "codex_app_c:desktop-only",
      "other_a:desktop-only",
      // `helper` refuses through the same accessor, so its caller is gated too.
      "other_c:desktop-only",
    ])
    // Without the accessor list the rule is off.
    assert.deepEqual(parseHostGatedArms(src), [])
  })
})

describe("physical seam pins: dynamic imports and event names", () => {
  const note = "inter-window channel"
  const annotate = (physicalSeam) => ({
    "lib/x/win.ts": { classification: "physically-impossible", note, physicalSeam },
  })
  const source =
    'import { emitTo, listen as on } from "@tauri-apps/api/event"\n' +
    'export const PING = "win://ping"\n' +
    'emitTo("main", PING, 1)\n' +
    'on("win://pong", f)\n'

  it("pins event names, resolving same-file constants and the emitTo label argument", () => {
    const files = { "lib/x/win.ts": source }
    const ok = classifyPhysicalSeams(
      ["A:lib/x/win.ts"],
      annotate({ imports: ["emitTo", "listen"], events: ["win://ping", "win://pong"] }),
      io(files)
    )
    assert.deepEqual(ok.errors, [])
    assert.deepEqual(ok.classified, ["A:lib/x/win.ts"])
  })

  it("fails on an unpinned event, an unused pin, or a function handed on as a value", () => {
    const files = { "lib/x/win.ts": source + 'on("win://extra", g)\n' }
    assert.deepEqual(
      classifyPhysicalSeams(
        ["A:lib/x/win.ts"],
        annotate({ imports: ["emitTo", "listen"], events: ["win://ping", "win://pong"] }),
        io(files)
      ).errors,
      ["lib/x/win.ts: uses events win://extra beyond its physical seam"]
    )
    assert.deepEqual(
      classifyPhysicalSeams(
        ["A:lib/x/win.ts"],
        annotate({ imports: ["emitTo", "listen"], events: ["win://ping", "win://pong", "gone"] }),
        io({ "lib/x/win.ts": source })
      ).errors,
      ["lib/x/win.ts: physical seam pins events it no longer uses: gone"]
    )
    const bindings = { locals: new Map([["emitTo", new Set(["emitTo"])]]), namespaces: new Set() }
    assert.deepEqual(eventNames("const send = emitTo\nemitTo(label, NAME, 1)", bindings), [
      "<dynamic:NAME>",
      "<reference>",
    ])
  })

  it("fails a seam file that also imports Tauri dynamically", () => {
    const files = {
      "lib/x/win.ts": source + 'const { invoke } = await import("@tauri-apps/api/core")\n',
    }
    assert.deepEqual(
      classifyPhysicalSeams(
        ["A:lib/x/win.ts"],
        annotate({ imports: ["emitTo", "listen"], events: ["win://ping", "win://pong"] }),
        io(files)
      ).errors,
      ["lib/x/win.ts: imports Tauri dynamically, which its physical seam cannot pin"]
    )
  })
})

describe("localTransport pins", () => {
  it("reads calls, members and value hand-offs, through import and destructuring renames", () => {
    assert.deepEqual(
      localTransportUses(
        'import { isTauri, localTransport as transport } from "@/lib/tauri"\n' +
          'transport.call<Snapshot>("companion_status", {})\n' +
          "transport.call(command, args)\n" +
          'if (!transport.subscribeAttached) throw new Error("x")\n' +
          '// localTransport.call("commented_out")\n'
      ),
      {
        uses: ["call:<dynamic:command>", "call:companion_status", "member:subscribeAttached"],
        references: 0,
      }
    )
    assert.deepEqual(
      localTransportUses(
        'const { localTransport: transport } = await import("@/lib/tauri")\n' +
          'return transport.call<Record<string, Array<number>>>("auth_config", {})\n' +
          "const local = isTauri() ? localTransport : routed\n" +
          "localTransport.subscribe(`evt-${id}`, f)\n"
      ),
      { uses: ["call:auth_config", "subscribe:<dynamic>"], references: 1 }
    )
  })

  it("collects renderer files only, never the owners or tests", () => {
    const files = {
      "lib/tauri/transport-instance.ts": "export const localTransport = make()",
      "lib/a/x.test.ts": 'localTransport.call("t")',
      "lib/a/x.ts": 'localTransport.call("a_cmd")',
      "lib/a/y.ts": "const n = 1",
    }
    assert.deepEqual(collectLocalTransportUses(Object.keys(files), io(files)), {
      "lib/a/x.ts": { uses: ["call:a_cmd"], references: 0 },
    })
  })

  it("fails an unpinned use, an unused pin, a changed hand-off count and a stale file", () => {
    const found = { "lib/a/x.ts": { uses: ["call:a_cmd", "call:b_cmd"], references: 1 } }
    assert.deepEqual(
      checkLocalTransportPins(found, {
        "lib/a/x.ts": { uses: ["call:a_cmd", "call:gone"], references: 0 },
        "lib/a/old.ts": { uses: ["call:z"], references: 0 },
      }),
      [
        "lib/a/x.ts: unpinned localTransport use call:b_cmd",
        "lib/a/x.ts: localTransport pin lists unused call:gone",
        "lib/a/x.ts: hands localTransport on as a value 1 time(s), pinned 0",
        "lib/a/old.ts: localTransport pin for a file that no longer uses it",
      ]
    )
    assert.deepEqual(checkLocalTransportPins(found, { "lib/a/x.ts": found["lib/a/x.ts"] }), [])
  })
})

describe("review: localTransport reached by member access, re-export and multi-property destructure", () => {
  it("reads calls through a module member and a member alias", () => {
    assert.deepEqual(
      localTransportUses(
        'import * as tauri from "@/lib/tauri"\n' +
          'tauri.localTransport.call("member_cmd")\n' +
          "let local = transportModule.localTransport\n" +
          'local.call("alias_cmd")\n' +
          'void (await import("@/lib/tauri")).localTransport.listen("evt", f)\n'
      ),
      { uses: ["call:alias_cmd", "call:member_cmd", "listen:evt"], references: 1 }
    )
  })

  it("reads a plain alias's calls, and counts the alias as a hand-off", () => {
    assert.deepEqual(localTransportUses('const lt = localTransport\nlt.call("via_alias")\n'), {
      uses: ["call:via_alias"],
      references: 1,
    })
  })

  it("pins a non-owner re-export, which would otherwise launder the name", () => {
    assert.deepEqual(
      localTransportUses('export { localTransport as quiet, isTauri } from "@/lib/tauri"\n'),
      { uses: ["export:quiet"], references: 0 }
    )
    const files = { "lib/a/barrel.ts": 'export * from "@/lib/tauri"\n' }
    assert.deepEqual(collectLocalTransportUses(Object.keys(files), io(files)), {
      "lib/a/barrel.ts": { uses: ["export:*"], references: 0 },
    })
  })

  it("binds every localTransport property of a destructure, not only a lone one", () => {
    assert.deepEqual(
      localTransportUses(
        'const { transport, localTransport: lt } = await import("@/lib/tauri")\n' +
          'lt.call("multi_cmd")\n' +
          'const { localTransport } = await import("@/lib/tauri")\n' +
          'localTransport.call("short_cmd")\n'
      ),
      { uses: ["call:multi_cmd", "call:short_cmd"], references: 0 }
    )
  })

  it("records a concatenated or templated command as dynamic, never its literal prefix", () => {
    assert.deepEqual(
      localTransportUses(
        'localTransport.call("pinned_cmd" + suffix)\nlocalTransport.call(`a_${x}`)\n'
      ),
      { uses: ["call:<dynamic>"], references: 0 }
    )
  })

  it("counts a string-keyed access as a hand-off", () => {
    assert.equal(localTransportUses('mod["localTransport"].call("x")\n').references, 1)
  })
})

describe("review: the localTransport prune writer only ever removes", () => {
  it("drops unused uses, lowers counts and removes files, but refuses anything new", () => {
    const pinned = {
      "lib/a/x.ts": { uses: ["call:a", "call:gone"], references: 2 },
      "lib/a/old.ts": { uses: ["call:z"], references: 0 },
    }
    assert.deepEqual(
      pruneLocalTransportPins({ "lib/a/x.ts": { uses: ["call:a"], references: 1 } }, pinned),
      { pins: { "lib/a/x.ts": { uses: ["call:a"], references: 1 } }, refused: [] }
    )
    const grown = pruneLocalTransportPins(
      {
        "lib/a/x.ts": { uses: ["call:a", "call:new"], references: 3 },
        "lib/a/fresh.ts": { uses: ["call:f"], references: 0 },
      },
      pinned
    )
    assert.deepEqual(grown.refused, [
      "lib/a/fresh.ts: not pinned",
      "lib/a/x.ts: unpinned localTransport use call:new",
      "lib/a/x.ts: hands localTransport on as a value 3 time(s), pinned 2",
    ])
  })
})

describe("review: event and invoke pins read whole arguments", () => {
  const bindings = (fn, ns = []) => ({
    locals: new Map([[fn, new Set([fn])]]),
    namespaces: new Set(ns),
    reexports: new Set(),
  })

  it("reads templates and concatenations as dynamic", () => {
    assert.deepEqual(
      eventNames("listen(`win://${id}`, f)\nlisten('a' + b, g)\n", bindings("listen")),
      ["<dynamic>"]
    )
  })

  it("skips a nested label call and an array label to the real event argument", () => {
    assert.deepEqual(
      eventNames(
        'emitTo(label(pick(a), b), "win://nested", 1)\nemitTo(["main", "pet"], "win://array")\n',
        bindings("emitTo")
      ),
      ["win://array", "win://nested"]
    )
    assert.deepEqual(eventNames('emitTo(["a", "win://leak"])\n', bindings("emitTo")), ["<dynamic>"])
  })

  it("treats a re-export and a bare namespace as hand-offs", () => {
    const reexport = { locals: new Map(), namespaces: new Set(), reexports: new Set(["listen"]) }
    assert.deepEqual(eventNames("", reexport), ["<reference>"])
    assert.deepEqual(eventNames('const t2 = t\nt.listen("x", f)\n', bindings("none", ["t"])), [
      "<reference>",
      "x",
    ])
  })

  it("requires both pins of a namespace seam and fails a re-exported invoke", () => {
    const note = "n"
    const files = {
      "lib/x/ns.ts": 'import * as core from "@tauri-apps/api/core"\ncore.invoke("cmd_a")\n',
      "lib/x/re.ts": 'export { invoke } from "@tauri-apps/api/core"\n',
    }
    const ann = {
      "lib/x/ns.ts": {
        classification: "physically-impossible",
        note,
        physicalSeam: { imports: ["*"] },
      },
      "lib/x/re.ts": {
        classification: "physically-impossible",
        note,
        physicalSeam: { imports: ["invoke"], invokes: [] },
      },
    }
    assert.deepEqual(
      classifyPhysicalSeams(["A:lib/x/ns.ts", "A:lib/x/re.ts"], ann, io(files)).errors,
      [
        "lib/x/ns.ts: invokes cmd_a beyond its physical seam",
        "lib/x/re.ts: invokes <reference> beyond its physical seam",
      ]
    )
  })
})

describe("review: accessor refusals fail closed", () => {
  const absent = ["automation", "codex_app_host"]

  it("reads rustfmt's block closure and ok_or", () => {
    const src = `
async fn dispatch(name: &str, host: &dyn RpcHost) -> R {
    match name {
        "block_cmd" => {
            let a = host.automation().ok_or_else(|| {
                RpcError::headless_unsupported(name)
            })?;
            a.go()
        }
        "ok_or_cmd" => host.codex_app_host().ok_or(RpcError::headless_unsupported(name))?.go(),
        "brain_cmd" => {
            let s = host.headless().ok_or_else(|| {
                RpcError::headless_host_required(name)
            })?;
            s.go()
        }
    }
}
`
    assert.deepEqual(
      parseHostGatedArms(src, absent)
        .map((g) => `${g.command}:${g.side}`)
        .sort(),
      ["block_cmd:desktop-only", "brain_cmd:headless-only", "ok_or_cmd:desktop-only"]
    )
  })

  it("ignores fn text in comments and strings, and keeps a nested fn from swallowing later arms", () => {
    const src = `
async fn dispatch(name: &str, host: &dyn RpcHost) -> R {
    let app = host.codex_app_host().ok_or_else(|| RpcError::headless_unsupported(name))?;
    // fn not_a_fn(x) is how the old code read
    let label = "fn also_not(";
    fn local_helper(x: u8) -> u8 { x }
    match name {
        "codex_a" => a(app),
        "codex_b" => b(app),
    }
}
`
    assert.deepEqual(
      parseHostGatedArms(src, absent)
        .map((g) => g.command)
        .sort(),
      ["codex_a", "codex_b"]
    )
  })

  it("attributes a refusing helper to the arms that call it, through other helpers and modules", () => {
    const helpers = `
fn host_auto(host: &dyn RpcHost, name: &str) -> Result<A, E> {
    host.automation().ok_or_else(|| RpcError::headless_unsupported(name))
}
pub(super) fn auto_state(host: &dyn RpcHost, name: &str) -> Result<S, E> {
    Ok(host_auto(host, name)?.state)
}
`
    const dispatch = `
async fn dispatch(name: &str, host: &dyn RpcHost) -> R {
    match name {
        "uses_helper" => to_json(super::helpers::auto_state(host, name)?),
        "plain" => Ok(Value::Null),
    }
}
`
    const { findings } = findOneSidedArms(
      [
        { path: "rpc/helpers.rs", source: helpers },
        { path: "rpc/d.rs", source: dispatch },
      ],
      new Map(),
      new Set(["uses_helper", "plain"]),
      absent
    )
    assert.deepEqual(findings, ["C:uses_helper:desktop-only"])
  })

  it("refuses to run with no headless accessor list", () => {
    const files = { [RPC_HOST_FILE]: "impl RpcHost for Arc<HeadlessServices> {\n}\n" }
    assert.match(
      collect([], {
        read: (p) => files[p] ?? (p.endsWith(".json") ? "{}" : ""),
      }).errors.join("\n"),
      /no headless accessor/
    )
  })
})

describe("review 2: comments are lexed, not pattern-matched", () => {
  it("keeps code after comment markers inside strings, templates, regexes and globs", () => {
    const source = [
      'const sep = "//"; localTransport.call("after_string")',
      'const mime = "image/*"; localTransport.call("after_glob_string")',
      'const t = `a//b ${x /* c */}`; localTransport.call("after_template")',
      'const re = /\\/\\//g; localTransport.call("after_regex")',
      "// Mirrors crates/x/src/* in Rust",
      'localTransport.call("between_comments")',
      "/** doc */",
    ].join("\n")
    assert.deepEqual(localTransportUses(source).uses, [
      "call:after_glob_string",
      "call:after_regex",
      "call:after_string",
      "call:after_template",
      "call:between_comments",
    ])
    assert.equal(stripComments("a /* x */ + b // y\nc").replace(/\s+/g, " ").trim(), "a + b c")
  })
})

describe("review 2: localTransport hand-offs that used to vanish", () => {
  it("follows a destructuring default as an alias and a hand-off", () => {
    assert.deepEqual(
      localTransportUses(
        'function makeClient({ transport = localTransport } = {}) { return transport.call("evil_cmd") }\n'
      ),
      { uses: ["call:evil_cmd"], references: 1 }
    )
  })

  it("does not let an export-from statement swallow the statements before it", () => {
    assert.deepEqual(
      localTransportUses('export default localTransport\nexport { helper } from "./helper"\n'),
      { uses: [], references: 1 }
    )
  })

  it("names an identifier argument, so a second dynamic call is not hidden by the first", () => {
    assert.deepEqual(
      localTransportUses("localTransport.call(cmd)\nlocalTransport.call(other)\n").uses,
      ["call:<dynamic:cmd>", "call:<dynamic:other>"]
    )
  })

  it("pins a star re-export through a relative path", () => {
    const files = { "lib/a/barrel.ts": 'export * from "../tauri"\n' }
    assert.deepEqual(collectLocalTransportUses(Object.keys(files), io(files)), {
      "lib/a/barrel.ts": { uses: ["export:*"], references: 0 },
    })
  })

  it("resolves an event constant only when one top-level declaration names it", () => {
    const bindings = { locals: new Map([["listen", new Set(["listen"])]]), namespaces: new Set() }
    assert.deepEqual(
      eventNames(
        'const EVT = "pinned:evt"\nfunction a() { const EVT = "evil:evt"; listen(EVT, f) }\n',
        bindings
      ),
      ["<dynamic:EVT>"]
    )
    assert.deepEqual(
      eventNames('const EVT = "pinned:evt"\nfunction b(EVT) { listen(EVT, f) }\n', bindings),
      ["<dynamic:EVT>"]
    )
    assert.deepEqual(eventNames('export const EVT = "pinned:evt"\nlisten(EVT, f)\n', bindings), [
      "pinned:evt",
    ])
  })
})

describe("review 2: every gate kind is scoped to its fn, through helpers", () => {
  const absent = ["automation"]
  const gates = (src, known) =>
    findOneSidedArms([{ path: "rpc/m.rs", source: src }], new Map(), new Set(known), absent)
      .findings

  it("attributes a tauri_app or headless gate in a helper to the arms that call it", () => {
    const src = `
async fn dispatch(name: &str, host: &dyn RpcHost) -> R {
    match name {
        "a_cmd" => need_app(host, name).map(run),
        "b_cmd" => Ok(Value::Null),
        "c_cmd" => need_brain::<S>(host, name).map(run),
    }
}
fn need_app(host: &dyn RpcHost, name: &str) -> Result<App, E> {
    host.tauri_app(name)
}
fn need_brain<T>(host: &dyn RpcHost, name: &str) -> Result<T, E> {
    host.headless().ok_or_else(|| RpcError::headless_host_required(name))
}
`
    assert.deepEqual(gates(src, ["a_cmd", "b_cmd", "c_cmd"]), [
      "C:a_cmd:desktop-only",
      "C:c_cmd:headless-only",
    ])
  })

  it("treats a helper with its own string match as a helper, judged by real commands", () => {
    const src = `
async fn dispatch(name: &str, host: &dyn RpcHost) -> R {
    match name {
        "real_cmd" => pick(host, name, "x"),
    }
}
fn pick(host: &dyn RpcHost, name: &str, mode: &str) -> R {
    let a = host.automation().ok_or_else(|| RpcError::headless_unsupported(name))?;
    match mode {
        "x" => a.x(),
        _ => a.y(),
    }
}
`
    assert.deepEqual(gates(src, ["real_cmd"]), ["C:real_cmd:desktop-only"])
  })

  it("matches a helper in another module only through its path or a use of it", () => {
    const helperModule = `
fn require(host: &dyn RpcHost, name: &str) -> Result<A, E> {
    host.automation().ok_or_else(|| RpcError::headless_unsupported(name))
}
`
    const unrelated = `
fn require(x: u8) -> u8 { x }
async fn dispatch(name: &str, host: &dyn RpcHost) -> R {
    match name {
        "y_cmd" => Ok(require(1).into()),
    }
}
`
    const viaUse = `
use super::guards::require;
async fn dispatch(name: &str, host: &dyn RpcHost) -> R {
    match name {
        "z_cmd" => require(host, name).map(run),
    }
}
`
    assert.deepEqual(
      findOneSidedArms(
        [
          { path: "rpc/guards.rs", source: helperModule },
          { path: "rpc/y.rs", source: unrelated },
          { path: "rpc/z.rs", source: viaUse },
        ],
        new Map(),
        new Set(["y_cmd", "z_cmd"]),
        absent
      ).findings,
      ["C:z_cmd:desktop-only"]
    )
  })

  it("reads a let-else refusal", () => {
    const src = `
async fn dispatch(name: &str, host: &dyn RpcHost) -> R {
    match name {
        "le_cmd" => {
            let Some(a) = host.automation() else {
                return Err(RpcError::headless_unsupported(name));
            };
            a.go()
        }
    }
}
`
    assert.deepEqual(gates(src, ["le_cmd"]), ["C:le_cmd:desktop-only"])
  })

  it("survives a non-BMP char literal, a label continued from a comment and a const-generic signature", () => {
    const src = `
async fn dispatch(name: &str, host: &dyn RpcHost) -> Foo<{ 1 + 1 }> {
    let marks = ['😀', '"'];
    match name {
        // was "old" |
        "b_cmd" => {
            let app = host.tauri_app(name)?;
            app.go()
        }
        "c_cmd" => Ok(Value::Null),
    }
}
`
    assert.deepEqual(gates(src, ["b_cmd", "c_cmd", "old"]), ["C:b_cmd:desktop-only"])
  })
})

describe("review 3: comments come from the TypeScript parser", () => {
  it("never reads JSX text as a comment opener", () => {
    const jsx = (text) =>
      localTransportUses(
        `export function A() {\n  return <p>${text}</p>\n}\nlocalTransport.call("after_jsx")\n`,
        "components/a.tsx"
      ).uses
    assert.deepEqual(jsx("Drop image/* here"), ["call:after_jsx"])
    assert.deepEqual(jsx("see https://example.dev"), ["call:after_jsx"])
    assert.deepEqual(jsx("don't"), ["call:after_jsx"])
  })

  it("reads division after a non-null assertion or a postfix increment as division", () => {
    const source =
      "const label = `${(bytes! / 1024).toFixed(1)} KB/s`\n" +
      "let i = 0; const r = i++ / 2\n" +
      "const glob = `${dir}/*.json`\n" +
      'localTransport.call("after_division")\n'
    assert.deepEqual(localTransportUses(source).uses, ["call:after_division"])
  })

  it("still drops real comments, in JSX files too", () => {
    const source =
      '// localTransport.call("line")\n/* localTransport.call("block") */\n' +
      'const A = () => <div>{/* localTransport.call("jsx") */}</div>\n'
    assert.deepEqual(localTransportUses(source, "components/a.tsx").uses, [])
  })
})

describe("review 3: localTransport defaults and namespaces", () => {
  it("follows a default whose expression only contains localTransport", () => {
    for (const fallback of [
      "isTauri() ? localTransport : remote",
      "o.t ?? localTransport",
      "x || localTransport",
    ]) {
      assert.deepEqual(
        localTransportUses(`function f({ t = ${fallback} } = {}) { return t.call("cmd") }\n`),
        { uses: ["call:cmd"], references: 1 },
        fallback
      )
    }
  })

  it("counts a lib/tauri namespace handed on as a hand-off", () => {
    const files = {
      "lib/a/ns.ts":
        'import * as t from "@/lib/tauri"\nexport { t }\nconst k = t["local" + "Transport"]\n',
    }
    assert.deepEqual(collectLocalTransportUses(Object.keys(files), io(files)), {
      "lib/a/ns.ts": { uses: [], references: 2 },
    })
  })

  it("does not resolve a constant a destructure or a nested-paren parameter list shadows", () => {
    const run = (body) =>
      localTransportUses(`const CMD = "pinned_cmd"\n${body}\nlocalTransport.call(CMD)\n`).uses
    assert.deepEqual(run("function g(o) { const { CMD } = o }"), ["call:<dynamic:CMD>"])
    assert.deepEqual(run("function h(cb: () => void, CMD: string) {}"), ["call:<dynamic:CMD>"])
    assert.deepEqual(run("function k() {}"), ["call:pinned_cmd"])
  })
})

describe("review 3: Rust helpers through use globs, parents and aliases", () => {
  const absent = ["automation"]
  const refusing = `
pub(crate) fn need(host: &dyn RpcHost, name: &str) -> Result<A, E> {
    host.automation().ok_or_else(|| RpcError::headless_unsupported(name))
}
`
  const caller = (body) => `
${body}
async fn dispatch(name: &str, host: &dyn RpcHost) -> R {
    match name {
        "c_cmd" => CALL.map(run),
        "d_cmd" => Ok(Value::Null),
    }
}
`
  const run = (helperPath, callerSource) =>
    findOneSidedArms(
      [
        { path: helperPath, source: refusing },
        { path: "src/rpc/family.rs", source: callerSource },
      ],
      new Map(),
      new Set(["c_cmd", "d_cmd"]),
      absent
    ).findings

  it("reaches a parent module's helper through use super::* or super::", () => {
    assert.deepEqual(
      run("src/rpc.rs", caller("use super::*;").replace("CALL", "need(host, name)")),
      ["C:c_cmd:desktop-only"]
    )
    assert.deepEqual(run("src/rpc.rs", caller("").replace("CALL", "super::need(host, name)")), [
      "C:c_cmd:desktop-only",
    ])
  })

  it("reaches a sibling's helper through a glob use, a renamed use and a module alias", () => {
    const at = "src/rpc/guards.rs"
    assert.deepEqual(run(at, caller("use super::guards::*;").replace("CALL", "need(host, name)")), [
      "C:c_cmd:desktop-only",
    ])
    assert.deepEqual(
      run(at, caller("use super::guards::need as ensure;").replace("CALL", "ensure(host, name)")),
      ["C:c_cmd:desktop-only"]
    )
    assert.deepEqual(
      run(at, caller("use super::guards as g;").replace("CALL", "g::need(host, name)")),
      ["C:c_cmd:desktop-only"]
    )
    // Not imported and not qualified: another module's `need`.
    assert.deepEqual(run(at, caller("").replace("CALL", "need(host, name)")), [])
  })

  it("keeps a helper that refuses before its own command match, and stops at a wildcard arm", () => {
    const src = `
async fn dispatch(name: &str, host: &dyn RpcHost) -> R {
    match name {
        "x_cmd" => need(host, name),
        "y_cmd" => Ok(Value::Null),
        _ => {
            let app = host.tauri_app(name)?;
            fallback(app)
        }
    }
}
fn need(host: &dyn RpcHost, name: &str) -> R {
    host.automation().ok_or_else(|| RpcError::headless_unsupported(name))?;
    match name {
        "z_cmd" => Ok(Value::Null),
        _ => Ok(Value::Null),
    }
}
`
    assert.deepEqual(
      findOneSidedArms(
        [{ path: "src/rpc/m.rs", source: src }],
        new Map(),
        new Set(["x_cmd", "y_cmd", "z_cmd"]),
        absent
      ).findings,
      ["C:x_cmd:desktop-only", "C:z_cmd:desktop-only"]
    )
  })

  it("reads an arm whose guard holds braces", () => {
    const src = `
async fn dispatch(name: &str, host: &dyn RpcHost) -> R {
    match name {
        "y_cmd" => Ok(Value::Null),
        "x_cmd" if matches!(m, A { .. }) => {
            let app = host.tauri_app(name)?;
            app.go()
        }
    }
}
`
    assert.deepEqual(
      parseHostGatedArms(src).map((g) => g.command),
      ["x_cmd"]
    )
  })
})

describe("review 3: a bare helper call never matches a path into another crate", () => {
  it("does not read other_crate::module::dispatch( as the module's own refusing dispatch", () => {
    const src = `
pub(super) async fn dispatch(name: &str, host: &dyn RpcHost) -> R {
    let app = host.tauri_app(name)?;
    match name {
        "a_cmd" => app.go(),
    }
}
async fn other(name: &str, host: &dyn RpcHost) -> R {
    match name {
        "b_cmd" => cognia_companion::org_policy::dispatch(name).await,
        "c_cmd" => dispatch(name, host).await,
    }
}
`
    assert.deepEqual(
      findOneSidedArms(
        [{ path: "src/rpc/m.rs", source: src }],
        new Map(),
        new Set(["a_cmd", "b_cmd", "c_cmd"]),
        []
      ).findings,
      ["C:a_cmd:desktop-only", "C:c_cmd:desktop-only"]
    )
  })
})
