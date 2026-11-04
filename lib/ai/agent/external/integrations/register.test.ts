import { ProtocolAdapterRegistry } from "../protocol-adapter"
import { prepareExternalAgentConnection, registerBuiltinProtocolAdapters } from "./register"
import { buildDshChannelManifest } from "@cognia/agent-dsh/install"
import type { ExternalAgentConfig } from "@cognia/agent-contracts/external-agent"
import { dshManagedLaunchHost } from "./dsh"
import { openCodeV2RuntimePolicy } from "./opencode"
import { aiderRuntimePolicy } from "@cognia/agent-aider/manifest"

afterEach(() => jest.restoreAllMocks())

it.each(["cognia-sdk-readonly", "cognia-acp"])(
  "prepares the real installed DSH launch for %s",
  async (profile) => {
    const digest = "a".repeat(64)
    const facts = {
      manifestJson: JSON.stringify(
        buildDshChannelManifest({ lockfileDigest: digest, compositionDigest: digest })
      ),
      lockfileDigest: digest,
      compositionDigest: digest,
      nodeVersion: "v26.3.1",
      platform: "darwin-arm64",
      strayPatchPaths: [],
      hasNativeToolchain: true,
      runtimeHome: "/owned/dsh",
      nodePath: "/owned/node",
      defaultWorkspace: "/work",
      parentEnv: { PATH: "/bin" },
    }
    jest.spyOn(dshManagedLaunchHost, "readRuntimeFacts").mockResolvedValue(facts)
    const readKey = jest.spyOn(dshManagedLaunchHost, "readApiKey").mockResolvedValue("fixture-key")
    const config = {
      id: "saved",
      name: "DSH",
      enabled: true,
      protocol: profile === "cognia-acp" ? "acp" : "dsh-sdk",
      transport: "stdio",
      process: { command: "", cwd: "/project" },
      metadata: { dshProfileId: profile },
    } as ExternalAgentConfig
    const launch = await prepareExternalAgentConnection(config)
    expect(launch.process).toMatchObject({
      command: "/owned/node",
      cwd: "/project",
      args: ["/owned/dsh/launcher.mjs", expect.stringMatching(/host\.(sdk-readonly|acp)\.yml$/)],
      env: { DEEPSEEK_API_KEY: "fixture-key" },
    })
    expect(readKey).toHaveBeenCalledWith(config)
    expect(config.process?.command).toBe("")
  }
)
it("wires runtime policies beside factories without giving unknown plugins a write grant", () => {
  const registry = new ProtocolAdapterRegistry()
  registerBuiltinProtocolAdapters(registry)
  expect(registry.getProtocols()).toHaveLength(14)
  expect(registry.runtimePolicy("codex-app-server")).toMatchObject({
    ownsExecutionRetries: true,
    ownsConnectionTimeout: true,
  })
  expect(registry.runtimePolicy("codex-siwc-app-server").processWriteScope).toBe(true)
  expect(registry.runtimePolicy("acp").handleProcessExit).toEqual(expect.any(Function))
  expect(registry.runtimePolicy("opencode-v2")).toBe(openCodeV2RuntimePolicy)
  expect(registry.runtimePolicy("aider-cli")).toBe(aiderRuntimePolicy)
  expect(registry.runtimePolicy("plugin:custom").processWriteScope).toBeUndefined()
})
