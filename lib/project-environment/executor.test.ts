const platformMock = jest.fn(() => "macos")
jest.mock("@tauri-apps/plugin-os", () => ({ platform: () => platformMock() }))

let tauri = true
const ensureExecutionPortLease = jest.fn()
jest.mock("@/lib/task-workspace/execution-port-lease", () => ({
  ensureExecutionPortLease: (...args: unknown[]) => ensureExecutionPortLease(...args),
}))
const callMock = jest.fn()
jest.mock("@/lib/tauri", () => ({
  isTauri: () => tauri,
  transport: { call: (...args: unknown[]) => callMock(...args) },
}))

const updateInitializationMock = jest.fn().mockResolvedValue(true)
const getEnvironmentMock = jest.fn()
jest.mock("@/lib/db/project-environments", () => ({
  updateProjectEnvironmentInitialization: (...args: unknown[]) => updateInitializationMock(...args),
  getProjectEnvironment: (...args: unknown[]) => getEnvironmentMock(...args),
}))

let workspaceFiles: Record<string, string> = {}
let workspacePaths = new Set<string>()
let workspaceStatFails = false
jest.mock("@/lib/files/workspace-fs", () => ({
  readWorkspaceFile: async (_root: string, relPath: string) => {
    if (relPath in workspaceFiles) return workspaceFiles[relPath]
    throw new Error(`missing ${relPath}`)
  },
  statWorkspaceFile: async (_root: string, relPath: string) => {
    if (workspaceStatFails) throw new Error("unavailable workspace")
    return {
      exists: relPath in workspaceFiles || workspacePaths.has(relPath),
      isDir: workspacePaths.has(relPath),
      size: workspaceFiles[relPath]?.length ?? 0,
      mtimeMs: 1,
    }
  },
}))
jest.mock("@/lib/data/crypto", () => ({
  sha256Hex: async (value: string) =>
    jest
      .requireActual<typeof import("node:crypto")>("node:crypto")
      .createHash("sha256")
      .update(value)
      .digest("hex"),
}))
let projectsMock: unknown[] = []
jest.mock("@/lib/db/projects", () => ({ getAllProjects: async () => projectsMock }))
let restrictedMock = false
jest.mock("@/lib/workspace/trust-gate", () => ({
  isWorkspaceRestricted: async () => restrictedMock,
}))
jest.mock("@/lib/db/settings", () => ({ getSettings: async () => ({}) }))

import { executeProjectEnvironment, resolveEnvironmentScript } from "./executor"
import { createHash } from "node:crypto"
import { MISE_STEP_FALLBACK, miseStepId, readMiseFiles } from "@/lib/workspace/mise-step"
import type { ProjectEnvironment } from "@/types/project-environment"
import {
  __setPromptOverrideSnapshotForTests,
  buildPromptOverrideSnapshot,
} from "@/lib/prompts/snapshot"
import { BOOTSTRAP_SYSTEM_PROMPTS } from "./bootstrap-prompts"
import {
  __resetRoutingForTests,
  setActiveRemoteEndpoint,
  setActiveRemoteTransport,
  type RemoteHostEndpoint,
} from "@/lib/tauri/transport-routing"
import {
  clearActiveRuntimeTargetContext,
  setActiveRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"
import type { Transport } from "@/lib/tauri/transport-types"

const environment: ProjectEnvironment = {
  id: "env-1",
  projectId: "project-1",
  name: "Development",
  isEnabled: true,
  setupScript: { default: "install", byOs: { macos: "pnpm install" } },
  actions: [{ id: "test", name: "Test", script: { default: "pnpm test" } }],
  variables: { NODE_ENV: "development" },
  keyringReferences: [{ variable: "API_TOKEN", keyringRef: "project:token" }],
  createdAt: 1,
  updatedAt: 1,
}

beforeEach(() => {
  __resetRoutingForTests()
  clearActiveRuntimeTargetContext()
  ensureExecutionPortLease.mockReset().mockResolvedValue(null)
  tauri = true
  callMock.mockReset().mockResolvedValue({
    stdout: "ok",
    stderr: "",
    exit_code: 0,
    timed_out: false,
  })
  updateInitializationMock.mockClear()
  getEnvironmentMock.mockReset().mockResolvedValue(undefined)
  workspaceFiles = {}
  workspacePaths = new Set()
  workspaceStatFails = false
  platformMock.mockReset().mockReturnValue("macos")
  projectsMock = []
  restrictedMock = false
})

it("keeps host script selection and keyring values inside the execution host", async () => {
  const result = await executeProjectEnvironment({
    environment,
    executionRoot: "/worktree",
    scope: "managedWorktree",
    surface: "interactive",
  })

  expect(result).toEqual(expect.objectContaining({ success: true, bypassed: false }))
  expect(ensureExecutionPortLease).toHaveBeenCalledWith({
    cwd: "/worktree",
    projectId: environment.projectId,
  })
  expect(ensureExecutionPortLease.mock.invocationCallOrder[0]).toBeLessThan(
    callMock.mock.invocationCallOrder[0]
  )
  expect(callMock).toHaveBeenCalledWith("project_environment_execute", {
    script: { default: "install", byOs: { macos: "pnpm install" } },
    cwd: "/worktree",
    variables: { NODE_ENV: "development" },
    keyringReferences: [{ variable: "API_TOKEN", keyringRef: "project:token" }],
    policy: { network: "on", requireSandbox: false },
    timeoutSecs: undefined,
  })
  expect(updateInitializationMock).toHaveBeenLastCalledWith(
    "env-1",
    expect.objectContaining({ status: "succeeded", executionRoot: "/worktree" }),
    expect.any(Number)
  )
})

it("returns lease allocation errors without bypassing or executing setup", async () => {
  const error = new Error("portRangeStart/portRangeEnd/portBlockSize exhausted")
  ensureExecutionPortLease.mockRejectedValueOnce(error)
  await expect(
    executeProjectEnvironment({
      environment,
      executionRoot: "/repo",
      scope: "local",
      surface: "interactive",
      bypassOnFailure: true,
    })
  ).resolves.toEqual({ success: false, bypassed: false, error: error.message })
  expect(callMock).not.toHaveBeenCalled()
  expect(updateInitializationMock).toHaveBeenLastCalledWith(
    environment.id,
    expect.objectContaining({ status: "failed", error: error.message }),
    expect.any(Number)
  )
})

it("returns lease allocation errors for actions without changing setup initialization", async () => {
  const error = new Error("portRangeStart exhausted")
  ensureExecutionPortLease.mockRejectedValueOnce(error)
  await expect(
    executeProjectEnvironment({
      environment,
      executionRoot: "/repo",
      scope: "local",
      surface: "interactive",
      actionId: "test",
    })
  ).resolves.toEqual({ success: false, bypassed: false, error: error.message })
  expect(callMock).not.toHaveBeenCalled()
  expect(updateInitializationMock).not.toHaveBeenCalled()
})

it("allows only interactive setup failures to be bypassed", async () => {
  callMock.mockResolvedValue({ stdout: "", stderr: "bad", exit_code: 1, timed_out: false })
  await expect(
    executeProjectEnvironment({
      environment,
      executionRoot: "/repo",
      scope: "local",
      surface: "interactive",
      bypassOnFailure: true,
    })
  ).resolves.toEqual(expect.objectContaining({ success: true, bypassed: true }))

  await expect(
    executeProjectEnvironment({
      environment,
      executionRoot: "/repo",
      scope: "local",
      surface: "scheduled",
      bypassOnFailure: true,
    })
  ).resolves.toEqual(expect.objectContaining({ success: false, bypassed: false }))
})

it("executes reusable actions without overwriting setup initialization state", async () => {
  await executeProjectEnvironment({
    environment,
    executionRoot: "/repo",
    scope: "local",
    surface: "interactive",
    actionId: "test",
  })
  expect(callMock).toHaveBeenCalledWith(
    "project_environment_execute",
    expect.objectContaining({ script: { default: "pnpm test" } })
  )
  expect(updateInitializationMock).not.toHaveBeenCalled()
})

it("routes web execution through the existing transport with a fail-closed cloud policy", async () => {
  tauri = false
  await expect(
    executeProjectEnvironment({
      environment,
      executionRoot: "/repo",
      scope: "local",
      surface: "interactive",
    })
  ).resolves.toEqual(expect.objectContaining({ success: true, bypassed: false }))
  expect(callMock).toHaveBeenCalledWith(
    "project_environment_execute",
    expect.objectContaining({
      script: environment.setupScript,
      policy: { network: "off", requireSandbox: true },
    })
  )
})

it("uses the default script when the host has no override", () => {
  expect(resolveEnvironmentScript(environment.setupScript, "linux")).toBe("install")
})

describe("setup reuse", () => {
  const reusable: ProjectEnvironment = {
    ...environment,
    setupReuse: { enabled: true, inputs: ["pnpm-lock.yaml"], outputs: ["node_modules"] },
  }
  const input = {
    environment: reusable,
    executionRoot: "/worktree",
    scope: "managedWorktree" as const,
    surface: "scheduled" as const,
  }

  /** Run setup once and hand back the fingerprint it recorded. */
  async function recordedFingerprint(): Promise<string> {
    await executeProjectEnvironment(input)
    const finished = updateInitializationMock.mock.calls
      .map((call) => call[1])
      .filter((record) => record.status === "succeeded")
      .pop()
    expect(finished?.fingerprint).toEqual(expect.any(String))
    return finished.fingerprint
  }

  function storedWith(
    fingerprint: string,
    status = "succeeded",
    hostKey: string | undefined = "local"
  ): ProjectEnvironment {
    return {
      ...reusable,
      initializationHistory: [
        {
          status: status as "succeeded",
          scope: "managedWorktree",
          executionRoot: "/worktree",
          ...(hostKey !== undefined ? { hostKey } : {}),
          startedAt: 1,
          completedAt: 2,
          exitCode: 0,
          fingerprint,
        },
      ],
    }
  }

  beforeEach(() => {
    workspaceFiles = { "pnpm-lock.yaml": "lock-v1" }
    workspacePaths = new Set(["node_modules"])
  })

  it("records a fingerprint on success and skips the next identical setup", async () => {
    const fingerprint = await recordedFingerprint()
    callMock.mockClear()
    updateInitializationMock.mockClear()
    getEnvironmentMock.mockResolvedValue(storedWith(fingerprint))

    const result = await executeProjectEnvironment(input)

    expect(result).toEqual({ success: true, bypassed: false, exitCode: 0, reused: true })
    expect(callMock).not.toHaveBeenCalled()
    // A reuse is not a setup and leaves the history alone.
    expect(updateInitializationMock).not.toHaveBeenCalled()
  })

  it("runs again when an input changes", async () => {
    const fingerprint = await recordedFingerprint()
    getEnvironmentMock.mockResolvedValue(storedWith(fingerprint))
    workspaceFiles = { "pnpm-lock.yaml": "lock-v2" }
    callMock.mockClear()

    const result = await executeProjectEnvironment(input)

    expect(result.reused).toBeUndefined()
    expect(callMock).toHaveBeenCalledTimes(1)
  })

  it("runs again when a declared output is gone", async () => {
    const fingerprint = await recordedFingerprint()
    getEnvironmentMock.mockResolvedValue(storedWith(fingerprint))
    workspacePaths = new Set()
    callMock.mockClear()

    await executeProjectEnvironment(input)

    expect(callMock).toHaveBeenCalledTimes(1)
  })

  it("runs again after a failed setup in the same root", async () => {
    const fingerprint = await recordedFingerprint()
    getEnvironmentMock.mockResolvedValue(storedWith(fingerprint, "failed"))
    callMock.mockClear()

    await executeProjectEnvironment(input)

    expect(callMock).toHaveBeenCalledTimes(1)
  })

  it("always runs when forced", async () => {
    const fingerprint = await recordedFingerprint()
    getEnvironmentMock.mockResolvedValue(storedWith(fingerprint))
    callMock.mockClear()

    await executeProjectEnvironment({ ...input, force: true })

    expect(callMock).toHaveBeenCalledTimes(1)
  })

  it("does not record a fingerprint for a failed setup", async () => {
    callMock.mockResolvedValue({ stdout: "", stderr: "", exit_code: 1, timed_out: false })

    await executeProjectEnvironment(input)

    const failed = updateInitializationMock.mock.calls.map((call) => call[1]).pop()
    expect(failed.status).toBe("failed")
    expect(failed).not.toHaveProperty("fingerprint")
  })

  it("never reuses for an environment that did not opt in", async () => {
    const fingerprint = await recordedFingerprint()
    getEnvironmentMock.mockClear().mockResolvedValue(storedWith(fingerprint))
    callMock.mockClear()

    await executeProjectEnvironment({ ...input, environment: environment })

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(getEnvironmentMock).not.toHaveBeenCalled()
  })
})

describe("concurrent setups in one root", () => {
  const input = {
    environment,
    executionRoot: "/worktree",
    scope: "managedWorktree" as const,
    surface: "scheduled" as const,
  }

  function deferredHostCall() {
    let finish: (value: unknown) => void = () => undefined
    let enter!: () => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    callMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
          enter()
        })
    )
    return {
      entered,
      finish: (exitCode: number) =>
        finish({ stdout: "", stderr: "", exit_code: exitCode, timed_out: false }),
    }
  }

  it("joins an identical setup already in flight instead of running it twice", async () => {
    const { finish, entered } = deferredHostCall()
    const first = executeProjectEnvironment(input)
    const second = executeProjectEnvironment(input)
    await entered
    finish(0)

    await expect(first).resolves.toEqual(expect.objectContaining({ success: true }))
    await expect(second).resolves.toEqual({
      success: true,
      bypassed: false,
      exitCode: 0,
      joined: true,
    })
    expect(callMock).toHaveBeenCalledTimes(1)
  })

  it("makes its own attempt after an in-flight setup fails", async () => {
    const { finish, entered } = deferredHostCall()
    const first = executeProjectEnvironment(input)
    const second = executeProjectEnvironment(input)
    await entered
    finish(1)

    await expect(first).resolves.toEqual(expect.objectContaining({ success: false }))
    await expect(second).resolves.toEqual(expect.objectContaining({ success: true }))
    expect(callMock).toHaveBeenCalledTimes(2)
  })

  it("waits for, but does not join, a setup with a different definition", async () => {
    const { finish, entered } = deferredHostCall()
    const first = executeProjectEnvironment(input)
    const second = executeProjectEnvironment({
      ...input,
      environment: { ...environment, variables: { NODE_ENV: "test" } },
    })
    await entered
    expect(callMock).toHaveBeenCalledTimes(1)
    finish(0)

    await first
    const result = await second
    expect(result.joined).toBeUndefined()
    expect(callMock).toHaveBeenCalledTimes(2)
  })

  it("does not serialize setups in different roots", async () => {
    const { finish } = deferredHostCall()
    const first = executeProjectEnvironment(input)
    const other = executeProjectEnvironment({ ...input, executionRoot: "/other" })

    await expect(other).resolves.toEqual(expect.objectContaining({ success: true }))
    finish(0)
    await first
    expect(callMock).toHaveBeenCalledTimes(2)
  })
})

describe("bootstrap Agent initialization", () => {
  const bootstrapEnvironment: ProjectEnvironment = {
    ...environment,
    keyringReferences: [{ variable: "BOOTSTRAP_KEY", keyringRef: "provider:test" }],
    bootstrapAgent: {
      enabled: true,
      task: "Repair $(literal) 'quoted' dependencies",
      baseUrl: "https://api.example.com/v1",
      model: "test-model",
      apiKeyEnv: "BOOTSTRAP_KEY",
      checks: [{ name: "ready", command: "test -d node_modules" }],
    },
  }
  const input = {
    environment: bootstrapEnvironment,
    executionRoot: "/repo",
    scope: "local" as const,
    surface: "scheduled" as const,
  }

  it("launches before full runtime, retains host policy and sends literal config only in variables", async () => {
    await executeProjectEnvironment({
      ...input,
      environment: {
        ...bootstrapEnvironment,
        policy: { requiredRuntimeCapabilities: [], network: "off", requireSandbox: true },
      },
    })
    const args = callMock.mock.calls[0][1]
    expect(args.cwd).toBe("/repo")
    expect(args.policy).toEqual({
      requiredRuntimeCapabilities: [],
      network: "off",
      requireSandbox: true,
    })
    expect(args.keyringReferences).toEqual(bootstrapEnvironment.keyringReferences)
    expect(args.timeoutSecs).toBe(605)
    expect(args.script.byOs.macos).toContain("init --config-env COGNIA_BOOTSTRAP_CONFIG")
    expect(args.script.default).not.toContain("Repair")
    expect(JSON.parse(args.variables.COGNIA_BOOTSTRAP_CONFIG_MACOS)).toMatchObject({
      task: bootstrapEnvironment.bootstrapAgent!.task,
      setupCommand: "pnpm install",
    })
  })

  it("propagates manual force and preserves the CLI cleanup budget", async () => {
    await executeProjectEnvironment({ ...input, force: true, timeoutSecs: 1 })
    const args = callMock.mock.calls[0][1]
    expect(args.timeoutSecs).toBe(605)
    expect(args.script.byOs.linux).toContain("--force")
    expect(args.script.default).toContain("--force")
  })

  describe("Prompt Center override", () => {
    const nativePrompt = BOOTSTRAP_SYSTEM_PROMPTS.native
    const publish = (
      rows: Array<{ scope: "account" | "workspace"; targetId: string; body: string }>
    ) =>
      __setPromptOverrideSnapshotForTests(
        buildPromptOverrideSnapshot(
          "test-db",
          rows.map((row, index) => ({
            bindingId: `pob-${index}`,
            promptId: nativePrompt.id,
            revisionId: `por-${index}`,
            contractVersion: nativePrompt.contractVersion,
            ...row,
          }))
        )
      )
    const sentConfig = () =>
      JSON.parse(callMock.mock.calls[0][1].variables.COGNIA_BOOTSTRAP_CONFIG) as Record<
        string,
        unknown
      >

    afterEach(() => __setPromptOverrideSnapshotForTests(null))

    it("sends no system prompt without an override, so the runtime keeps its default", async () => {
      publish([])
      await executeProjectEnvironment(input)
      expect(sentConfig()).not.toHaveProperty("systemPrompt")
    })

    it("sends the environment workspace's override", async () => {
      publish([
        { scope: "account", targetId: "", body: "Account bootstrap rules." },
        { scope: "workspace", targetId: environment.projectId, body: "Workspace bootstrap rules." },
      ])
      await executeProjectEnvironment(input)
      expect(sentConfig()).toMatchObject({ systemPrompt: "Workspace bootstrap rules." })
    })

    it("keeps the environment's own system prompt over an override", async () => {
      publish([{ scope: "account", targetId: "", body: "Account bootstrap rules." }])
      await executeProjectEnvironment({
        ...input,
        environment: {
          ...bootstrapEnvironment,
          bootstrapAgent: { ...bootstrapEnvironment.bootstrapAgent!, systemPrompt: "Own rules." },
        },
      })
      expect(sentConfig()).toMatchObject({ systemPrompt: "Own rules." })
    })
  })

  it("runs with an empty setup script and never intercepts actions", async () => {
    await executeProjectEnvironment({
      ...input,
      environment: { ...bootstrapEnvironment, setupScript: { default: "" } },
    })
    expect(callMock).toHaveBeenCalledTimes(1)
    expect(
      JSON.parse(callMock.mock.calls[0][1].variables.COGNIA_BOOTSTRAP_CONFIG)
    ).not.toHaveProperty("setupCommand")
    callMock.mockClear()
    await executeProjectEnvironment({ ...input, actionId: "test" })
    expect(callMock.mock.calls[0][1]).toMatchObject({
      script: { default: "pnpm test" },
      variables: environment.variables,
    })
  })

  it("leaves ordinary execution unchanged when bootstrap is disabled", async () => {
    await executeProjectEnvironment({
      ...input,
      environment: {
        ...bootstrapEnvironment,
        bootstrapAgent: { ...bootstrapEnvironment.bootstrapAgent!, enabled: false },
      },
    })
    expect(callMock.mock.calls[0][1]).toMatchObject({
      script: environment.setupScript,
      variables: environment.variables,
    })
    expect(callMock.mock.calls[0][1].timeoutSecs).toBeUndefined()
  })

  it.each([
    { stdout: "Agent says ready", stderr: "", exit_code: 1, timed_out: false },
    { stdout: "Agent says ready", stderr: "", exit_code: 0, timed_out: true },
  ])("accepts only a checked zero exit without timeout", async (result) => {
    callMock.mockResolvedValue(result)
    expect((await executeProjectEnvironment(input)).success).toBe(false)
    expect(updateInitializationMock).toHaveBeenLastCalledWith(
      "env-1",
      expect.objectContaining({ status: "failed" }),
      expect.any(Number)
    )
  })

  it("rejects scheduled bypass and fails closed on an invalid stored definition", async () => {
    expect((await executeProjectEnvironment({ ...input, bypassOnFailure: true })).success).toBe(
      false
    )
    expect(callMock).not.toHaveBeenCalled()
    const result = await executeProjectEnvironment({
      ...input,
      environment: { ...bootstrapEnvironment, keyringReferences: [] },
    })
    expect(result.success).toBe(false)
    expect(callMock).not.toHaveBeenCalled()
  })

  it("invalidates successful reuse when bootstrap settings change", async () => {
    const reusable = {
      ...bootstrapEnvironment,
      setupReuse: { enabled: true, inputs: [], outputs: [] },
    }
    await executeProjectEnvironment({ ...input, environment: reusable })
    const previous = updateInitializationMock.mock.calls.at(-1)![1]
    getEnvironmentMock.mockResolvedValue({ ...reusable, lastInitialization: previous })
    callMock.mockClear()
    expect(
      (await executeProjectEnvironment({ ...input, environment: reusable })).reused
    ).toBeUndefined()
    expect(callMock.mock.calls.at(-1)![1].script.default).not.toContain("--force")
    callMock.mockClear()
    await executeProjectEnvironment({
      ...input,
      environment: {
        ...reusable,
        bootstrapAgent: { ...reusable.bootstrapAgent!, model: "new-model" },
      },
    })
    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock.mock.calls[0][1].script.default).toContain("--force")
  })

  it("hashes bootstrap inputs, forces setup when their content changes and always runs readiness", async () => {
    const configured: ProjectEnvironment = {
      ...bootstrapEnvironment,
      bootstrapAgent: {
        ...bootstrapEnvironment.bootstrapAgent!,
        reuse: { inputs: ["package.json"], outputs: ["node_modules"] },
      },
    }
    workspaceFiles = { "package.json": "v1" }
    workspacePaths.add("node_modules")
    await executeProjectEnvironment({ ...input, environment: configured })
    const previous = updateInitializationMock.mock.calls.at(-1)![1]
    expect(previous.fingerprint).toEqual(expect.any(String))
    getEnvironmentMock.mockResolvedValue({ ...configured, lastInitialization: previous })
    callMock.mockClear()
    await executeProjectEnvironment({ ...input, environment: configured })
    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock.mock.calls.at(-1)![1].script.default).not.toContain("--force")
    workspaceFiles["package.json"] = "v2"
    await executeProjectEnvironment({ ...input, environment: configured })
    expect(callMock.mock.calls.at(-1)![1].script.default).toContain("--force")
    expect(updateInitializationMock.mock.calls.at(-1)![1].fingerprint).not.toBe(
      previous.fingerprint
    )
  })

  it("forces setup for absent bootstrap outputs and prior success without a fingerprint", async () => {
    const configured: ProjectEnvironment = {
      ...bootstrapEnvironment,
      bootstrapAgent: {
        ...bootstrapEnvironment.bootstrapAgent!,
        reuse: { outputs: ["node_modules"] },
      },
    }
    await executeProjectEnvironment({ ...input, environment: configured })
    const previous = updateInitializationMock.mock.calls.at(-1)![1]
    getEnvironmentMock.mockResolvedValue({ ...configured, lastInitialization: previous })
    await executeProjectEnvironment({ ...input, environment: configured })
    expect(callMock.mock.calls.at(-1)![1].script.default).toContain("--force")
    workspacePaths.add("node_modules")
    getEnvironmentMock.mockResolvedValue({
      ...configured,
      lastInitialization: { ...previous, fingerprint: undefined },
    })
    await executeProjectEnvironment({ ...input, environment: configured })
    expect(callMock.mock.calls.at(-1)![1].script.default).toContain("--force")
  })

  it("fails closed on bootstrap fingerprint I/O and invalid imported paths", async () => {
    const configured: ProjectEnvironment = {
      ...bootstrapEnvironment,
      bootstrapAgent: {
        ...bootstrapEnvironment.bootstrapAgent!,
        reuse: { inputs: ["package.json"] },
      },
    }
    workspaceStatFails = true
    await executeProjectEnvironment({ ...input, environment: configured })
    expect(callMock.mock.calls.at(-1)![1].script.default).toContain("--force")
    callMock.mockClear()
    const result = await executeProjectEnvironment({
      ...input,
      environment: {
        ...configured,
        bootstrapAgent: { ...configured.bootstrapAgent!, reuse: { inputs: ["C:\\outside"] } },
      },
    })
    expect(result).toMatchObject({ success: false, bootstrapValidationCode: "reuse" })
    expect(callMock).not.toHaveBeenCalled()
    expect(updateInitializationMock.mock.calls.at(-1)![1].status).toBe("failed")
  })

  it("serializes simultaneous bootstrap requests while running fresh readiness for each", async () => {
    let release!: (value: unknown) => void
    let enter!: () => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    callMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
          enter()
        })
    )
    const first = executeProjectEnvironment(input)
    const second = executeProjectEnvironment(input)
    await entered
    expect(callMock).toHaveBeenCalledTimes(1)
    release({ stdout: "ok", stderr: "", exit_code: 0, timed_out: false })
    await expect(first).resolves.toMatchObject({ success: true })
    const result = await second
    expect(result.success).toBe(true)
    expect(result.joined).toBeUndefined()
    expect(callMock).toHaveBeenCalledTimes(2)
  })
})

describe("mise install (ADR-0147, 2026-11-08 amendment)", () => {
  const MISE_TOML = '[tools]\nnode = "22"\n'
  const input = {
    environment,
    executionRoot: "/worktree",
    scope: "managedWorktree" as const,
    surface: "scheduled" as const,
  }

  async function digestOf(files: Record<string, string>): Promise<string> {
    const read = await readMiseFiles("/worktree", {
      readFile: async (_root, relPath) => {
        if (!(relPath in files)) throw new Error("missing")
        return files[relPath]!
      },
      sha256Hex: async (value) => createHash("sha256").update(value).digest("hex"),
    })
    return read!.digest
  }

  async function accept(files: Record<string, string>) {
    projectsMock = [
      {
        id: environment.projectId,
        roots: [{ id: "r1", path: "/repo", isPrimary: true }],
        workspaceProvisioning: {
          accepted: [miseStepId(await digestOf(files))],
          reviewed: [miseStepId(await digestOf(files))],
        },
      },
    ]
  }

  const scripts = () => callMock.mock.calls.map(([, args]) => (args as { script: unknown }).script)

  it("never runs before the user accepted these exact files, and says so", async () => {
    workspaceFiles = { "mise.toml": MISE_TOML }
    projectsMock = [{ id: environment.projectId, roots: [], workspaceProvisioning: undefined }]

    const result = await executeProjectEnvironment(input)

    expect(scripts()).toEqual([environment.setupScript])
    expect(result.notices).toEqual(["miseNotApproved"])
    expect(updateInitializationMock).toHaveBeenLastCalledWith(
      environment.id,
      expect.objectContaining({ status: "succeeded", notices: ["miseNotApproved"] }),
      expect.any(Number)
    )
  })

  it("sends only the approved mise snapshot and keeps the setup variables out of it", async () => {
    workspaceFiles = { "mise.toml": MISE_TOML, "mise.lock": "lock" }
    await accept(workspaceFiles)
    workspaceFiles[".mise.toml"] = '[tools]\nnode = "24"\n'

    const variables = { ...environment.variables, MISE_NODE_VERSION: "24" }
    const result = await executeProjectEnvironment({
      ...input,
      environment: { ...environment, variables },
    })

    expect(result).toEqual(expect.objectContaining({ success: true }))
    expect(result.notices).toBeUndefined()
    expect(callMock).toHaveBeenNthCalledWith(1, "project_environment_execute", {
      script: { default: MISE_STEP_FALLBACK, mise: { config: MISE_TOML, lockfile: "lock" } },
      cwd: "/worktree",
      variables: {},
      keyringReferences: [],
      policy: { network: "on", requireSandbox: false },
      timeoutSecs: undefined,
    })
    expect(scripts()[1]).toEqual(environment.setupScript)
    expect(callMock.mock.calls[1][1]).toEqual(expect.objectContaining({ variables }))
  })

  it("skips with a notice when the workspace is not trusted", async () => {
    workspaceFiles = { "mise.toml": MISE_TOML }
    await accept(workspaceFiles)
    restrictedMock = true

    const result = await executeProjectEnvironment(input)

    expect(scripts()).toEqual([environment.setupScript])
    expect(result.notices).toEqual(["miseUntrusted"])
  })

  it.each(["miseMissing", "miseIsolationUnavailable"])(
    "reports %s, continues setup and does not cache the skipped install",
    async (notice) => {
      workspaceFiles = { "mise.toml": MISE_TOML }
      await accept(workspaceFiles)
      callMock.mockResolvedValueOnce({
        stdout: `cognia-setup-notice:${notice}\n`,
        stderr: "",
        exit_code: 0,
        timed_out: false,
      })

      const result = await executeProjectEnvironment({
        ...input,
        environment: {
          ...environment,
          setupReuse: { enabled: true, inputs: ["mise.toml"], outputs: [] },
        },
      })

      expect(result).toEqual(expect.objectContaining({ success: true, notices: [notice] }))
      expect(scripts()).toHaveLength(2)
      expect(updateInitializationMock.mock.calls.at(-1)?.[1]).not.toHaveProperty("fingerprint")
    }
  )

  it("fails setup when mise install fails, without running the script", async () => {
    workspaceFiles = { "mise.toml": MISE_TOML }
    await accept(workspaceFiles)
    callMock.mockResolvedValueOnce({ stdout: "", stderr: "boom", exit_code: 2, timed_out: false })

    const result = await executeProjectEnvironment(input)

    expect(result).toEqual(
      expect.objectContaining({ success: false, error: "mise install exited with code 2" })
    )
    expect(scripts()).toEqual([{ default: MISE_STEP_FALLBACK, mise: { config: MISE_TOML } }])
  })

  it("runs the step alone for an environment with no setup script", async () => {
    workspaceFiles = { "mise.toml": MISE_TOML }
    await accept(workspaceFiles)

    const result = await executeProjectEnvironment({
      ...input,
      environment: { ...environment, setupScript: { default: "" } },
    })

    expect(result).toEqual(expect.objectContaining({ success: true }))
    expect(scripts()).toEqual([{ default: MISE_STEP_FALLBACK, mise: { config: MISE_TOML } }])
  })

  it("never runs it for an action", async () => {
    workspaceFiles = { "mise.toml": MISE_TOML }
    await accept(workspaceFiles)

    await executeProjectEnvironment({ ...input, surface: "interactive", actionId: "test" })

    expect(scripts()).toEqual([{ default: "pnpm test" }])
  })

  it("fingerprints a reusable setup over the mise files too", async () => {
    const reusable: ProjectEnvironment = {
      ...environment,
      setupReuse: { enabled: true, inputs: ["pnpm-lock.yaml"], outputs: [] },
    }
    const fingerprintFor = async (lock: string) => {
      workspaceFiles = { "pnpm-lock.yaml": "p", "mise.toml": MISE_TOML, "mise.lock": lock }
      await accept(workspaceFiles)
      updateInitializationMock.mockClear()
      await executeProjectEnvironment({ ...input, environment: reusable })
      return updateInitializationMock.mock.calls.map((call) => call[1]).pop()?.fingerprint
    }
    const first = await fingerprintFor("lock-1")
    const second = await fingerprintFor("lock-2")
    expect(first).toEqual(expect.any(String))
    expect(second).toEqual(expect.any(String))
    expect(second).not.toBe(first)
  })
})

it("S2 never bypasses a producer egress denial before native setup", async () => {
  const result = await executeProjectEnvironment({
    environment,
    executionRoot: "/s2-denied",
    scope: "local",
    surface: "interactive",
    bypassOnFailure: true,
    credentialContext: { personalEgressBlocked: true },
  })
  expect(result).toMatchObject({ success: false, bypassed: false })
  expect(callMock).not.toHaveBeenCalled()
})

describe("audit regressions (F1, F2, F3, F5, F7)", () => {
  const reusable: ProjectEnvironment = {
    ...environment,
    setupReuse: { enabled: true, inputs: ["pnpm-lock.yaml"], outputs: ["node_modules"] },
  }

  function endpoint(id: string): RemoteHostEndpoint {
    return {
      remoteHost: { id, label: id },
      baseUrl: `https://${id}.example`,
      deviceId: `dev-${id}`,
      devicePrivateKeyJwk: { kty: "EC" },
      deviceKeyThumbprint: `thumb-${id}`,
      serverVersion: "4",
    }
  }

  function remoteTransport(call: jest.Mock): Transport {
    return {
      call: call as unknown as Transport["call"],
      subscribe: jest.fn(() => () => undefined),
    }
  }

  it("F1: does not join an in-flight setup when a tracked input file changed mid-flight", async () => {
    workspaceFiles = { "pnpm-lock.yaml": "lock-v1" }
    workspacePaths = new Set(["node_modules"])
    let finishFirst!: (value: unknown) => void
    let enteredFirst!: () => void
    const firstEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve
    })
    callMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = resolve
          enteredFirst()
        })
    )

    const req = {
      environment: reusable,
      executionRoot: "/repo-f1",
      scope: "local" as const,
      surface: "scheduled" as const,
    }
    const first = executeProjectEnvironment(req)
    await firstEntered

    // Input file changes while the first setup is running; second request arrives.
    workspaceFiles["pnpm-lock.yaml"] = "lock-v2"
    const second = executeProjectEnvironment(req)

    finishFirst({ stdout: "v1", stderr: "", exit_code: 0, timed_out: false })
    const [firstResult, secondResult] = await Promise.all([first, second])

    expect(firstResult.success).toBe(true)
    expect(secondResult.success).toBe(true)
    expect(secondResult.joined).toBeUndefined()
    expect(callMock).toHaveBeenCalledTimes(2)
    // First run observed lockfile mutation mid-flight so it must not stamp a stale fingerprint.
    const records = updateInitializationMock.mock.calls.map((call) => call[1])
    const succeededRecords = records.filter((record) => record.status === "succeeded")
    expect(succeededRecords[0]).not.toHaveProperty("fingerprint")
    expect(succeededRecords[1].fingerprint).toEqual(expect.any(String))
  })

  it("F2: does not reuse an earlier success when a later running attempt never settled", async () => {
    workspaceFiles = { "pnpm-lock.yaml": "lock-v1" }
    workspacePaths = new Set(["node_modules"])
    const req = {
      environment: reusable,
      executionRoot: "/repo-f2",
      scope: "local" as const,
      surface: "scheduled" as const,
    }
    await executeProjectEnvironment(req)
    const succeeded = updateInitializationMock.mock.calls
      .map((call) => call[1])
      .find((record) => record.status === "succeeded")
    expect(succeeded?.fingerprint).toEqual(expect.any(String))

    getEnvironmentMock.mockResolvedValue({
      ...reusable,
      initializationHistory: [
        succeeded,
        {
          status: "running",
          scope: "local",
          executionRoot: "/repo-f2",
          hostKey: "local",
          attemptId: "crashed-attempt",
          startedAt: (succeeded.completedAt ?? succeeded.startedAt) + 100,
        },
      ],
    })
    callMock.mockClear()

    const result = await executeProjectEnvironment(req)
    expect(result.reused).toBeUndefined()
    expect(callMock).toHaveBeenCalledTimes(1)
  })

  it("F3: serializes concurrent setups targeting the same root across profiles, scopes, and path aliases", async () => {
    let finishFirst!: (value: unknown) => void
    let enteredFirst!: () => void
    const firstEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve
    })
    callMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = resolve
          enteredFirst()
        })
    )

    const first = executeProjectEnvironment({
      environment,
      executionRoot: "/repo-f3",
      scope: "local",
      surface: "scheduled",
    })
    const second = executeProjectEnvironment({
      environment: { ...environment, id: "env-2" },
      executionRoot: "/repo-f3/",
      scope: "managedWorktree",
      surface: "scheduled",
    })
    await firstEntered
    expect(callMock).toHaveBeenCalledTimes(1)

    finishFirst({ stdout: "", stderr: "", exit_code: 0, timed_out: false })
    const [r1, r2] = await Promise.all([first, second])
    expect(r1.success).toBe(true)
    expect(r2.success).toBe(true)
    expect(r2.joined).toBeUndefined()
    expect(callMock).toHaveBeenCalledTimes(2)
  })

  it("F5: forwards AbortSignal cancellation with operationId, records cancelled without bypass, and exposes output flags", async () => {
    const controller = new AbortController()
    let releaseExec!: (value: unknown) => void
    let sentOperationId: string | undefined
    callMock.mockImplementation((name: string, args: Record<string, unknown>) => {
      if (name === "project_environment_execute") {
        sentOperationId = args.operationId as string | undefined
        return new Promise((resolve) => {
          releaseExec = resolve
        })
      }
      if (name === "project_environment_cancel") {
        releaseExec({
          stdout: "partial",
          stderr: "terminated",
          exit_code: null,
          timed_out: false,
          cancelled: true,
          stdout_truncated: true,
          stderr_truncated: true,
        })
        return Promise.resolve({ cancelled: true, terminated: true })
      }
      return Promise.resolve({})
    })

    const running = executeProjectEnvironment({
      environment,
      executionRoot: "/repo-f5",
      scope: "local",
      surface: "interactive",
      bypassOnFailure: true,
      signal: controller.signal,
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(sentOperationId).toEqual(expect.any(String))
    controller.abort()

    const result = await running
    expect(callMock).toHaveBeenCalledWith("project_environment_cancel", {
      operationId: sentOperationId,
    })
    expect(result).toMatchObject({
      success: false,
      bypassed: false,
      cancelled: true,
      stdout: "partial",
      stderr: "terminated",
      stdoutTruncated: true,
      stderrTruncated: true,
    })
    expect(updateInitializationMock).toHaveBeenLastCalledWith(
      environment.id,
      expect.objectContaining({ status: "cancelled", hostKey: "local" }),
      expect.any(Number)
    )
    expect(updateInitializationMock.mock.calls.at(-1)?.[1]).not.toHaveProperty("fingerprint")
  })

  it("F5: cancels a queued setup immediately when aborted while waiting on another flight", async () => {
    let finishFirst!: (value: unknown) => void
    let enteredFirst!: () => void
    const firstEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve
    })
    callMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = resolve
          enteredFirst()
        })
    )

    const first = executeProjectEnvironment({
      environment,
      executionRoot: "/repo-f5-queue",
      scope: "local",
      surface: "interactive",
    })
    await firstEntered

    const controller = new AbortController()
    const queued = executeProjectEnvironment({
      environment,
      executionRoot: "/repo-f5-queue",
      scope: "local",
      surface: "interactive",
      signal: controller.signal,
    })
    controller.abort()

    await expect(queued).resolves.toMatchObject({
      success: false,
      bypassed: false,
      cancelled: true,
    })

    finishFirst({ stdout: "", stderr: "", exit_code: 0, timed_out: false })
    await expect(first).resolves.toMatchObject({ success: true })
  })

  it("F7: does not reuse Host A setup history when executing on Host B at the same path", async () => {
    workspaceFiles = { "pnpm-lock.yaml": "lock-v1" }
    workspacePaths = new Set(["node_modules"])
    const hostACall = jest.fn().mockResolvedValue({
      stdout: "host-a",
      stderr: "",
      exit_code: 0,
      timed_out: false,
    })
    const hostBCall = jest.fn().mockResolvedValue({
      stdout: "host-b",
      stderr: "",
      exit_code: 0,
      timed_out: false,
    })

    setActiveRemoteEndpoint(endpoint("host-a"))
    setActiveRemoteTransport(remoteTransport(hostACall))
    const req = {
      environment: reusable,
      executionRoot: "/shared/repo",
      scope: "local" as const,
      surface: "scheduled" as const,
    }
    await executeProjectEnvironment(req)
    const hostASucceeded = updateInitializationMock.mock.calls
      .map((call) => call[1])
      .find((record) => record.status === "succeeded")
    expect(hostASucceeded?.hostKey).toBe("remote:host-a")

    getEnvironmentMock.mockResolvedValue({
      ...reusable,
      initializationHistory: [hostASucceeded],
    })
    setActiveRemoteEndpoint(endpoint("host-b"))
    setActiveRemoteTransport(remoteTransport(hostBCall))

    const hostBResult = await executeProjectEnvironment(req)
    expect(hostBResult.reused).toBeUndefined()
    expect(hostBCall).toHaveBeenCalledTimes(1)
  })

  it("F7: fails closed without bypassing when a paired client switches Hosts mid-flight", async () => {
    setActiveRuntimeTargetContext("acct-01", "host-a", 1)
    ensureExecutionPortLease.mockImplementationOnce(async () => {
      setActiveRuntimeTargetContext("acct-01", "host-b", 2)
      return null
    })

    const result = await executeProjectEnvironment({
      environment,
      executionRoot: "/paired-repo",
      scope: "local",
      surface: "interactive",
      bypassOnFailure: true,
    })

    expect(result.success).toBe(false)
    expect(result.bypassed).toBe(false)
    expect(result.error).toMatch(/no longer the connected one/)
    expect(callMock).not.toHaveBeenCalled()
  })
})
