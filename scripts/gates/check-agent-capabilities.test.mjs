import assert from "node:assert/strict"
import { test } from "node:test"

import {
  checkCapabilityManifest,
  checkSecurityPolicyParity,
  declaredExecutableProtocols,
  externalOnlyCapabilityIds,
  presetCommands,
  bundledPresetCommands,
  registeredProtocols,
  runChecks,
  rustStrArray,
  specCapabilityIds,
  stringsIn,
  checkCliAllowlistSource,
} from "./check-agent-capabilities.mjs"

test("the repo currently passes its own gate", () => {
  assert.deepEqual(runChecks(), [])
})

test("stringsIn ignores ids quoted inside comments", () => {
  const block = `
    // "cline" was removed here
    /* "ghost" */
    "real",
  `
  assert.deepEqual(stringsIn(block), ["real"])
})

test("rustStrArray reads a &[&str] literal", () => {
  const source = `const BINARY_ALLOWLIST: &[&str] = &[\n    "a",\n    // "b" is gone\n    "c",\n];\n`
  assert.deepEqual(rustStrArray(source, "BINARY_ALLOWLIST"), ["a", "c"])
})

test("registeredProtocols reads the manager's register() calls, not its comments", () => {
  const source = `
    // protocolAdapterRegistry.register('http', () => new HttpClientAdapter());
    protocolAdapterRegistry.register("acp", () => new AcpClientAdapter())
    protocolAdapterRegistry.register(
      "dsh-sdk",
      () => new DshSdkClientAdapter()
    )
  `
  assert.deepEqual(registeredProtocols(source), ["acp", "dsh-sdk"])
})

test("registeredProtocols follows the invoked built-in helper and ignores unrelated registries", () => {
  const helper = `
export function registerBuiltinProtocolAdapters(target: ProtocolAdapterRegistry): void {
  target.register("acp", () => new Adapter())
  // target.register("ghost", () => new Adapter())
  target.register(
    "pi-rpc", () => new Adapter()
  )
}
other.register("unrelated", () => new Adapter())
`
  assert.deepEqual(registeredProtocols(helper), [])
  assert.deepEqual(
    registeredProtocols(`${helper}\nregisterBuiltinProtocolAdapters(protocolAdapterRegistry)`),
    ["acp", "pi-rpc"]
  )
  // Moving the composition root must not make an uncalled registration count.
  assert.deepEqual(
    registeredProtocols(
      'import { registerBuiltinProtocolAdapters } from "./integrations/register"',
      helper
    ),
    []
  )
  assert.deepEqual(
    registeredProtocols("registerBuiltinProtocolAdapters(otherRegistry)", helper),
    []
  )
  assert.deepEqual(
    registeredProtocols("registerBuiltinProtocolAdapters(protocolAdapterRegistry)", helper),
    ["acp", "pi-rpc"]
  )
})

test("specCapabilityIds and externalOnlyCapabilityIds read the frozen lists", () => {
  const execution = `export const AGENT_CAPABILITY_IDS: readonly AgentCapabilityId[] = [\n  "streaming",\n  "mcp",\n]\n`
  const contract = `export const EXTERNAL_ONLY_CAPABILITY_IDS: readonly ExternalOnlyCapabilityId[] = [\n  "mcp.logs",\n]\n`
  assert.deepEqual(specCapabilityIds(execution), ["streaming", "mcp"])
  assert.deepEqual(externalOnlyCapabilityIds(contract), ["mcp.logs"])
})

test("declaredExecutableProtocols reads the contract's protocol list", () => {
  const contract = `export const BUILTIN_EXECUTABLE_EXTERNAL_AGENT_PROTOCOLS: readonly BuiltinExecutableExternalAgentProtocol[] =\n  ["acp", "a2a"]\n`
  assert.deepEqual(declaredExecutableProtocols(contract), ["acp", "a2a"])
})

const VOCAB = ["streaming", "mcp"]

function manifest(overrides = {}) {
  return {
    capabilityIds: VOCAB,
    protocols: {
      acp: {
        capabilities: {
          streaming: { level: "native", evidence: "protocol-spec" },
          mcp: { level: "native", evidence: "protocol-spec" },
        },
      },
    },
    presetRefinements: {},
    ...overrides,
  }
}

test("an omitted capability is an error, because absent reads as unsupported", () => {
  const broken = manifest()
  delete broken.protocols.acp.capabilities.mcp
  const errors = checkCapabilityManifest(broken, VOCAB, ["acp"])
  assert.equal(errors.length, 1)
  assert.match(errors[0], /omits "mcp"/)
})

test("`none` evidence cannot back a verdict", () => {
  const broken = manifest()
  broken.protocols.acp.capabilities.mcp = { level: "unsupported", evidence: "none", reasonKey: "x" }
  const errors = checkCapabilityManifest(broken, VOCAB, ["acp"])
  assert.ok(errors.some((e) => /claims "unsupported" with no evidence/.test(e)))
})

test("a non-native verdict must carry a reasonKey", () => {
  const broken = manifest()
  broken.protocols.acp.capabilities.mcp = { level: "unsupported", evidence: "protocol-spec" }
  const errors = checkCapabilityManifest(broken, VOCAB, ["acp"])
  assert.ok(errors.some((e) => /needs a reasonKey/.test(e)))
})

test("a registered protocol with no manifest row fails", () => {
  const errors = checkCapabilityManifest(manifest(), VOCAB, ["acp", "pi-rpc"])
  assert.ok(errors.some((e) => /no row for "pi-rpc"/.test(e)))
})

test("a manifest row for an unregistered protocol fails", () => {
  const errors = checkCapabilityManifest(manifest(), VOCAB, [])
  assert.ok(errors.some((e) => /row for "acp", which .* registers no adapter/.test(e)))
})

const RUST_PRESETS = `
const BINARY_ALLOWLIST: &[&str] = &[
    "codex",
];
const NPX_PACKAGE_ALLOWLIST: &[&str] = &[
    "pi-acp",
];
`
function policy(overrides = {}) {
  return {
    binaryAllowlist: { commands: ["codex"], manualOnly: {} },
    npxPackageAllowlist: { packages: ["pi-acp"] },
    ...overrides,
  }
}

test("parity passes when the two languages agree", () => {
  const errors = checkSecurityPolicyParity(policy(), RUST_PRESETS, new Set(["codex"]))
  assert.deepEqual(errors, [])
})

test("a binary Rust allows but the policy does not is caught", () => {
  // This is the `cline` shape: an entry that existed only in the Rust literal.
  const rust = RUST_PRESETS.replace('    "codex",', '    "codex",\n    "cline",')
  const errors = checkSecurityPolicyParity(policy(), rust, new Set(["codex"]))
  assert.ok(errors.some((e) => /"cline" is in Rust but not in/.test(e)))
})

test("a preset command Rust refuses is caught", () => {
  // This is the `claude-agent-acp` shape: the shipped preset spawns a binary
  // the policy never allowlisted, so every headless spawn was refused.
  const errors = checkSecurityPolicyParity(
    policy(),
    RUST_PRESETS,
    new Set(["codex", "claude-agent-acp"])
  )
  assert.ok(errors.some((e) => /"claude-agent-acp" is not allowlisted/.test(e)))
})

test("a binary no preset spawns needs a written reason", () => {
  const unjustified = policy({
    binaryAllowlist: { commands: ["codex", "mystery"], manualOnly: {} },
  })
  const rust = RUST_PRESETS.replace('    "codex",', '    "codex",\n    "mystery",')
  const errors = checkSecurityPolicyParity(unjustified, rust, new Set(["codex"]))
  assert.ok(errors.some((e) => /"mystery" is reachable from no shipped preset/.test(e)))
})

test("a manualOnly reason that explains nothing is rejected", () => {
  const thin = policy({
    binaryAllowlist: { commands: ["codex", "mystery"], manualOnly: { mystery: "because" } },
  })
  const rust = RUST_PRESETS.replace('    "codex",', '    "codex",\n    "mystery",')
  const errors = checkSecurityPolicyParity(thin, rust, new Set(["codex"]))
  assert.ok(errors.some((e) => /must actually explain why/.test(e)))
})

test("a stale manualOnly row is caught", () => {
  const stale = policy({
    binaryAllowlist: {
      commands: ["codex"],
      manualOnly: { gone: "a long-since-removed binary that no longer appears anywhere" },
    },
  })
  const errors = checkSecurityPolicyParity(stale, RUST_PRESETS, new Set(["codex"]))
  assert.ok(errors.some((e) => /stale entry "gone"/.test(e)))
})

test("presetCommands reads command literals from both preset sources", () => {
  const ecosystem = `process: { command: "codex", args: ["app-server"] }`
  const presets = `process: { command: "opencode", args: [] }, process: { command: "", args: [] }`
  const commands = presetCommands(ecosystem, presets)
  assert.ok(commands.has("codex"))
  assert.ok(commands.has("opencode"))
  // The DSH presets carry an EMPTY command until the installer fills it in;
  // treating "" as a preset command would demand an allowlist entry for it.
  assert.ok(!commands.has(""))
})

const CLI_DERIVED = `
import {
  AGENT_STATE_KEY_ENV,
  EXTERNAL_AGENT_BINARY_ALLOWLIST,
  EXTERNAL_AGENT_NPX_ALLOWLIST,
} from "@/lib/ai/agent/external/policy/security-policy"
const BINARY_ALLOWLIST: ReadonlySet<string> = new Set(EXTERNAL_AGENT_BINARY_ALLOWLIST)
const NPX_ALLOWLIST: ReadonlySet<string> = new Set(EXTERNAL_AGENT_NPX_ALLOWLIST)
`

test("the CLI backend passes when it builds its allowlist from the policy", () => {
  assert.deepEqual(checkCliAllowlistSource(CLI_DERIVED), [])
})

test("a literal CLI allowlist is caught, as the duplicated `cline` once was", () => {
  const literal = CLI_DERIVED.replace(
    "new Set(EXTERNAL_AGENT_BINARY_ALLOWLIST)",
    'new Set([\n  "codex",\n  "cline",\n  "cline",\n])'
  )
  const errors = checkCliAllowlistSource(literal)
  assert.ok(errors.some((error) => error.includes("BINARY_ALLOWLIST must be")))
  assert.ok(errors.some((error) => error.includes("a literal allowlist duplicates")))
})

test("an extra literal allowlist next to the derived one is caught", () => {
  const extra = `${CLI_DERIVED}\nconst EXTRA_ALLOWLIST = new Set(["sh"])\n`
  assert.ok(checkCliAllowlistSource(extra).some((error) => error.includes("literal allowlist")))
})

test("an allowlist that does not come from the policy module is caught", () => {
  const elsewhere = CLI_DERIVED.replace(
    '"@/lib/ai/agent/external/policy/security-policy"',
    '"./my-allowlist"'
  )
  assert.ok(checkCliAllowlistSource(elsewhere).some((error) => error.includes("policy module")))
})

test("bundled Node exceptions require the exact Codebuff source contract", () => {
  const security = policy({
    bundledNodeBridges: { codebuff: { file: "codebuff.cjs", args: ["--cognia-codebuff-bridge"] } },
  })
  const source =
    'codebuff: nativeAgentAdapter({id:"codebuff",command:"node",args:[],protocol:"codebuff-sdk",metadata:{bundledBridge:"codebuff"}})'
  assert.deepEqual([...bundledPresetCommands(source, "", security).commands], ["node"])
  assert.deepEqual(bundledPresetCommands(source, "", security).errors, [])
  for (const invalid of [
    source.replace("args:[]", 'args:["--eval","arbitrary()"]'),
    source.replace('bundledBridge:"codebuff"', 'bundledBridge:"unknown"'),
    source.replace('protocol:"codebuff-sdk"', 'protocol:"acp"'),
    'process: {command:"node",args:["untrusted.js"]}',
  ]) {
    const checked = bundledPresetCommands(invalid, "", security)
    assert.equal(checked.commands.size, 0)
    assert.equal(checked.errors.length, 1)
  }
  assert.equal(bundledPresetCommands(source, "", policy()).errors.length, 1)
  assert.ok(
    checkSecurityPolicyParity(policy(), RUST_PRESETS, new Set(["node"])).some((error) =>
      error.includes('preset command "node"')
    )
  )
})
