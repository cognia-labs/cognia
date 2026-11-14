import type {
  DelegateAcceptancePortInput,
  AcceptanceRunSpec,
} from "@/lib/router-fusion/verify/code-acceptance-host"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs"
import { resolve, join } from "node:path"
import { execFileSync, spawnSync } from "node:child_process"
import type { SourceControlService } from "./service"
const buildUtilityLlmClient = jest.fn(() => ({ complete: jest.fn(async () => "[]") }))
jest.mock("@/lib/ai/generation/utility-client", () => ({
  buildUtilityLlmClient: (...args: unknown[]) => buildUtilityLlmClient(...(args as [])),
}))

const gitStatus = jest.fn()
const gitBranches = jest.fn()
const gitCreateBranch = jest.fn(async () => undefined)
const gitReset = jest.fn(async () => undefined)
const gitDiscardAll = jest.fn(async () => undefined)
jest.mock("@/lib/git/commands", () => ({
  gitStatus: (...a: unknown[]) => gitStatus(...a),
  gitBranches: (...a: unknown[]) => gitBranches(...a),
  gitCreateBranch: (...a: unknown[]) => gitCreateBranch(...(a as [])),
  gitReset: (...a: unknown[]) => gitReset(...(a as [])),
  gitDiscardAll: (...a: unknown[]) => gitDiscardAll(...(a as [])),
  gitDiffRefsFile: jest.fn(),
  gitReadBlobAtRef: jest.fn(async () => null),
}))

const acquireWorkspaceBundle = jest.fn()
const archiveManagedWorkspace = jest.fn(async () => undefined)
const pinManagedWorkspace = jest.fn(async () => undefined)
jest.mock("@/lib/task-workspace/client", () => ({
  acquireWorkspaceBundle: (...a: unknown[]) => acquireWorkspaceBundle(...a),
  archiveManagedWorkspace: (...a: unknown[]) => archiveManagedWorkspace(...(a as [])),
  pinManagedWorkspace: (...a: unknown[]) => pinManagedWorkspace(...(a as [])),
}))
jest.mock("@/lib/task-workspace/user-action", () => ({
  runWorkspaceUserAction: jest.fn((_command, action) => action()),
}))
// The Host selected now; a test switches it mid-check (postfix review P05).
let selectedOrigin: { kind: "local" } | { kind: "remote"; hostId: string } = { kind: "local" }
const callTaskWorkspaceOrigin = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("@/lib/task-workspace/origin", () => ({
  ...jest.requireActual("@/lib/task-workspace/origin"),
  captureTaskWorkspaceOrigin: () => selectedOrigin,
  callTaskWorkspaceOrigin: (...a: unknown[]) => callTaskWorkspaceOrigin(...a),
}))
jest.mock("@/lib/task-workspace/workspace-provisioning", () => ({
  bundleProvisioningForPath: jest.fn(async () => ({ provisioning: { sparsePaths: ["app"] } })),
}))
const statWorkspaceFile = jest.fn(async (..._args: unknown[]) => ({ exists: true }))
const deleteWorkspaceEntry = jest.fn<Promise<void>, unknown[]>(async () => undefined)
jest.mock("@/lib/files/workspace-fs", () => ({
  statWorkspaceFile: (...a: unknown[]) => statWorkspaceFile(...(a as [])),
  deleteWorkspaceEntry: (...a: unknown[]) => deleteWorkspaceEntry(...(a as [])),
}))
const sandboxRun = jest.fn()

const createDelegateAcceptancePort = jest.fn((input: DelegateAcceptancePortInput) => ({
  runProfile: async () => ({ kind: "refused", code: "X", message: "x" }),
  input,
}))
jest.mock("@/lib/router-fusion/verify/code-acceptance-host", () => ({
  createDelegateAcceptancePort: (input: never) => createDelegateAcceptancePort(input),
  defaultAcceptanceSandboxHost: jest.fn(() => ({ availability: jest.fn(), run: sandboxRun })),
  resolveProjectContainerImage: jest.fn(async () => null),
}))
jest.mock("@/lib/router-fusion/runtime/delegate-host-ports", () => ({
  acceptanceProfileResolver: jest.fn(() => async () => ({
    ok: false,
    code: "MISSING",
    message: "m",
  })),
}))

const reviewChangeset = jest.fn(async () => ({
  changeset: {},
  policy: null,
  risk: null,
  agent: null,
  checks: [],
}))
jest.mock("./review/review-changeset", () => ({
  ...jest.requireActual("./review/review-changeset"),
  reviewChangeset: (...a: unknown[]) => reviewChangeset(...(a as [])),
}))
const integrateChangesets = jest.fn(async () => ({ kind: "published" }))
jest.mock("./integration/orchestrator", () => ({
  ...jest.requireActual("./integration/orchestrator"),
  integrateChangesets: (...a: unknown[]) => integrateChangesets(...(a as [])),
}))

import type { ScmHost } from "./host"
import {
  VERIFICATION_STOP_GRACE_MS,
  createScmRuntime,
  reviewClientFor,
  scmGitPortsFor,
} from "./runtime"

const changeset = {
  changesetId: "cs-1",
  headSha: "h1",
  sourceRoot: "/source",
  executionRoot: "/data/ws-1",
}
const host = { getChangeset: jest.fn(async () => changeset) } as unknown as ScmHost
const signal = new AbortController().signal
function profileSpec(root: string | null, logicalStepId: string): AcceptanceRunSpec {
  return {
    runId: "check",
    logicalStepId,
    tier: "os",
    worktreeRoot: root!,
    cwd: ".",
    argv: ["test"],
    env: {},
    limits: { cpuSeconds: 1, memoryMb: 128, pids: 8, timeoutMs: 1000 },
    reportPath: "ignored/report.json",
    reportMaxBytes: 1024,
    image: null,
    signal,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  host.getChangeset = jest.fn(async () => changeset) as never
  acquireWorkspaceBundle.mockResolvedValue({
    state: "active",
    leases: [{ workspaceId: "verify", role: "primary", aliasPath: "/frozen" }],
  })
  sandboxRun.mockResolvedValue({ exitCode: 0 })
  gitReset.mockResolvedValue(undefined)
  gitDiscardAll.mockResolvedValue(undefined)
  statWorkspaceFile.mockResolvedValue({ exists: true })
  deleteWorkspaceEntry.mockResolvedValue(undefined)
})

describe("reviewClientFor", () => {
  it("uses the Source Control panel's AI-review model choice when AI review is on", () => {
    reviewClientFor({
      gitSettings: { reviewAI: { enabled: true, model: "m1", providerOverride: "p1" } },
    } as never)
    expect(buildUtilityLlmClient).toHaveBeenCalledWith(
      expect.objectContaining({
        session: null,
        override: { providerOverride: "p1", model: "m1" },
        featureId: "scm.reviewChangeset",
      })
    )
  })

  it("has no reviewer while AI review is off, its default", () => {
    expect(
      reviewClientFor({ gitSettings: { reviewAI: { enabled: false, model: "m1" } } } as never)
    ).toBeNull()
    expect(reviewClientFor(null)).toBeNull()
    expect(buildUtilityLlmClient).not.toHaveBeenCalled()
  })
})

describe("createScmRuntime", () => {
  afterEach(() => {
    selectedOrigin = { kind: "local" }
  })

  it("keeps a check's checkout on the Host it started on after another is selected", async () => {
    const hostA = { kind: "remote" as const, hostId: "A" }
    selectedOrigin = hostA
    reviewChangeset.mockImplementationOnce(async () => {
      const portInput = createDelegateAcceptancePort.mock.results[0].value.input
      const root = await portInput.rootForRevision("h1")
      selectedOrigin = { kind: "remote", hostId: "B" }
      // Nothing of the run reaches B: it is refused before the reset.
      await expect(portInput.sandbox.run(profileSpec(root, "test"))).rejects.toThrow(
        "selected Host changed"
      )
      return { changeset: {}, checks: [], policy: null, risk: null, agent: null }
    })
    await createScmRuntime({ projectId: "p", appSettings: null, host }).review("cs-1", signal)

    expect(acquireWorkspaceBundle).toHaveBeenCalledWith(expect.anything(), {
      signal,
      origin: hostA,
    })
    expect(pinManagedWorkspace).toHaveBeenNthCalledWith(1, "verify", true, hostA)
    expect(pinManagedWorkspace).toHaveBeenNthCalledWith(2, "verify", false, hostA)
    expect(archiveManagedWorkspace).toHaveBeenCalledWith("verify", hostA)
    expect(sandboxRun).not.toHaveBeenCalled()
    expect(gitReset).not.toHaveBeenCalled()
  })

  it("sends a bound check's Git calls to its own Host", async () => {
    const hostA = { kind: "remote" as const, hostId: "A" }
    selectedOrigin = hostA
    reviewChangeset.mockImplementationOnce(async () => {
      const portInput = createDelegateAcceptancePort.mock.results[0].value.input
      const root = await portInput.rootForRevision("h1")
      sandboxRun.mockResolvedValueOnce({ exitCode: 0 })
      await portInput.sandbox.run(profileSpec(root, "test"))
      return { changeset: {}, checks: [], policy: null, risk: null, agent: null }
    })
    await createScmRuntime({ projectId: "p", appSettings: null, host }).review("cs-1", signal)
    const via = (gitReset.mock.calls[0] as unknown[])[3] as {
      call: (command: string, args: Record<string, unknown>) => Promise<unknown>
    }
    selectedOrigin = { kind: "remote", hostId: "B" }
    await via.call("git_reset", { repoPath: "/frozen", mode: "hard", target: "h1" })
    expect(callTaskWorkspaceOrigin).toHaveBeenCalledWith(
      hostA,
      "git_reset",
      { repoPath: "/frozen", mode: "hard", target: "h1" },
      expect.any(Boolean)
    )
  })

  it("refuses a head changed during checkout acquisition and cleans up without running code", async () => {
    host.getChangeset = jest
      .fn()
      .mockResolvedValueOnce(changeset)
      .mockResolvedValueOnce({ ...changeset, headSha: "moved" }) as never
    reviewChangeset.mockImplementationOnce(async () => {
      const port = createDelegateAcceptancePort.mock.results[0].value.input
      await port.rootForRevision("h1")
      return { changeset: {}, checks: [], policy: null, risk: null, agent: null }
    })
    await expect(
      createScmRuntime({ projectId: "p", appSettings: null, host }).review("cs-1", signal)
    ).rejects.toThrow("head changed")
    expect(sandboxRun).not.toHaveBeenCalled()
    expect(archiveManagedWorkspace).toHaveBeenCalledWith("verify", { kind: "local" })
  })
  it("tests the broken pinned Git tree even when the live checkout and an earlier profile repair it", async () => {
    const fixture = mkdtempSync(resolve(".cache/change-lifecycle-fix-2026-11-13/check-head-"))
    const live = join(fixture, "live")
    const frozen = join(fixture, "verification")
    mkdirSync(live)
    const git = (root: string, ...args: string[]) =>
      execFileSync(
        "git",
        [
          "-C",
          root,
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "user.name=Regression",
          "-c",
          "user.email=regression@example.invalid",
          ...args,
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
      ).trim()
    try {
      git(live, "init", "-b", "main")
      writeFileSync(join(live, "state.txt"), "broken")
      writeFileSync(join(live, ".gitignore"), "ignored/\n")
      git(live, "add", ".")
      git(live, "commit", "-m", "broken pinned head")
      const headSha = git(live, "rev-parse", "HEAD")
      writeFileSync(join(live, "state.txt"), "fixed")
      host.getChangeset = jest.fn(async () => ({
        ...changeset,
        sourceRoot: live,
        executionRoot: live,
        headSha,
      })) as never
      acquireWorkspaceBundle.mockImplementationOnce(async () => {
        execFileSync("git", ["clone", "--quiet", live, frozen], { stdio: "pipe" })
        return {
          state: "active",
          leases: [{ workspaceId: "verify", role: "primary", aliasPath: frozen }],
        }
      })
      const service = {
        resetVerificationCheckout: async (root: string, sha: string) => {
          git(root, "reset", "--hard", sha)
          git(root, "clean", "-fd")
        },
      } as SourceControlService
      statWorkspaceFile.mockImplementation(async (root, path) => ({
        exists: existsSync(join(String(root), String(path))),
      }))
      deleteWorkspaceEntry.mockImplementation(async (root, path) => {
        rmSync(join(String(root), String(path)))
      })
      const outcomes: number[] = []
      sandboxRun.mockImplementation(async (spec: AcceptanceRunSpec) => {
        expect(readFileSync(join(spec.worktreeRoot, "state.txt"), "utf8")).toBe("broken")
        expect(existsSync(join(spec.worktreeRoot, spec.reportPath))).toBe(false)
        const actual = spawnSync(
          process.execPath,
          [
            "-e",
            "process.exit(require('fs').readFileSync('state.txt','utf8') === 'fixed' ? 0 : 1)",
          ],
          { cwd: spec.worktreeRoot }
        )
        outcomes.push(actual.status!)
        writeFileSync(join(spec.worktreeRoot, "state.txt"), "fixed")
        mkdirSync(join(spec.worktreeRoot, "ignored"), { recursive: true })
        writeFileSync(join(spec.worktreeRoot, spec.reportPath), "old passing report")
        return { exitCode: actual.status }
      })
      reviewChangeset.mockImplementationOnce(async () => {
        const port = createDelegateAcceptancePort.mock.results[0].value.input
        const root = await port.rootForRevision(headSha)
        for (const id of ["first", "second"]) await port.sandbox.run(profileSpec(root, id))
        return { changeset: {}, checks: [], policy: null, risk: null, agent: null }
      })
      await createScmRuntime({ projectId: "p", appSettings: null, host, service }).review(
        "cs-1",
        signal
      )
      expect(outcomes).toEqual([1, 1])
      expect(readFileSync(join(live, "state.txt"), "utf8")).toBe("fixed")
      expect(acquireWorkspaceBundle).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
  it("reviews with the project's acceptance port bound to the changeset's head", async () => {
    reviewChangeset.mockImplementationOnce(async () => {
      const portInput = createDelegateAcceptancePort.mock.results[0].value.input
      expect(await portInput.rootForRevision("other")).toBeNull()
      expect(acquireWorkspaceBundle).not.toHaveBeenCalled()
      expect(await portInput.rootForRevision("h1")).toBe("/frozen")
      return { changeset: {}, checks: [], policy: null, risk: null, agent: null }
    })
    const runtime = createScmRuntime({ projectId: "project-1", appSettings: null, host })
    await runtime.review("cs-1", signal)
    const [, deps] = reviewChangeset.mock.calls[0] as unknown as [
      string,
      { acceptancePort: unknown; host: unknown },
    ]
    expect(deps.host).toBe(host)
    expect(deps.acceptancePort).not.toBeNull()
    const { input } = createDelegateAcceptancePort.mock.results[0].value as {
      input: { rootForRevision: (r: string) => Promise<string | null>; runId: string }
    }
    expect(input.runId).toBe("changeset:cs-1")
    expect(acquireWorkspaceBundle).toHaveBeenCalledTimes(1)
    expect(acquireWorkspaceBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        base: { kind: "gitRef", gitRef: "h1" },
        provisioning: { sparsePaths: ["app"] },
        roots: [expect.objectContaining({ sourceRoot: "/source", role: "primary" })],
      }),
      { signal, origin: { kind: "local" } }
    )
    expect(archiveManagedWorkspace).toHaveBeenCalledWith("verify", { kind: "local" })
  })

  it("resets the same checkout and removes even ignored or committed reports before each profile", async () => {
    const observed: string[] = []
    reviewChangeset.mockImplementationOnce(async () => {
      const portInput = createDelegateAcceptancePort.mock.results[0].value.input
      const root = await portInput.rootForRevision("h1")
      for (const logicalStepId of ["first", "second"]) {
        await portInput.sandbox.run(profileSpec(root, logicalStepId))
      }
      return { changeset: {}, checks: [], policy: null, risk: null, agent: null }
    })
    gitReset.mockImplementation(async () => {
      observed.push("reset")
    })
    gitDiscardAll.mockImplementation(async () => {
      observed.push("clean")
    })
    deleteWorkspaceEntry.mockImplementation(async () => {
      observed.push("remove-report")
    })
    sandboxRun.mockImplementation(async () => {
      observed.push("run")
      return { exitCode: 0 }
    })
    await createScmRuntime({ projectId: "p", appSettings: null, host }).review("cs-1", signal)
    expect(observed).toEqual([
      "reset",
      "clean",
      "remove-report",
      "run",
      "reset",
      "clean",
      "remove-report",
      "run",
    ])
    expect(gitReset).toHaveBeenNthCalledWith(2, "/frozen", "hard", "h1", expect.anything())
    expect(deleteWorkspaceEntry).toHaveBeenCalledWith("/frozen", "ignored/report.json")
    expect(acquireWorkspaceBundle).toHaveBeenCalledTimes(1)
  })

  it("retains the pinned checkout when a sandbox failure does not prove executor stop", async () => {
    sandboxRun.mockRejectedValueOnce(new Error("transport disconnected"))
    reviewChangeset.mockImplementationOnce(async () => {
      const portInput = createDelegateAcceptancePort.mock.results[0].value.input
      const root = await portInput.rootForRevision("h1")
      await expect(portInput.sandbox.run(profileSpec(root, "test"))).rejects.toThrow("disconnected")
      await expect(portInput.sandbox.run(profileSpec(root, "test"))).rejects.toThrow(
        "stop is unproven"
      )
      return { changeset: {}, checks: [], policy: null, risk: null, agent: null }
    })
    await expect(
      createScmRuntime({ projectId: "p", appSettings: null, host }).review("cs-1", signal)
    ).rejects.toThrow("stop is unproven")
    expect(pinManagedWorkspace).toHaveBeenCalledWith("verify", true, { kind: "local" })
    expect(archiveManagedWorkspace).not.toHaveBeenCalled()
    expect(gitReset).toHaveBeenCalledTimes(1)
  })

  it("reports, while an integration check's stop is unproven, when the Host has killed it", async () => {
    const service = { resetVerificationCheckout: jest.fn(async () => undefined) }
    const runtime = createScmRuntime({
      projectId: "project-1",
      appSettings: null,
      host,
      service: service as never,
    })
    await runtime.integrate({ changesetIds: ["cs-1"], targetRef: "refs/heads/main" } as never)
    const [, deps] = integrateChangesets.mock.calls[0] as unknown as [
      unknown,
      {
        acceptancePortFor: (run: unknown) => unknown
        executorStopUnproven: () => boolean
        executorStopRetainUntil: () => number | null
      },
    ]
    deps.acceptancePortFor({ integrationId: "int-1", candidateSha: "c1", worktreePath: "/wt" })
    const { input } = createDelegateAcceptancePort.mock.results[0].value as {
      input: { sandbox: { run: (spec: AcceptanceRunSpec) => Promise<unknown> } }
    }
    const now = jest.spyOn(Date, "now").mockReturnValue(10_000)
    try {
      sandboxRun.mockResolvedValueOnce({ exitCode: 0 })
      await input.sandbox.run(profileSpec("/wt", "unit"))
      expect(deps.executorStopUnproven()).toBe(false)
      expect(deps.executorStopRetainUntil()).toBeNull()
      sandboxRun.mockRejectedValueOnce(new Error("transport disconnected"))
      await expect(input.sandbox.run(profileSpec("/wt", "unit"))).rejects.toThrow("disconnected")
      expect(deps.executorStopUnproven()).toBe(true)
      // The spec's wall clock (1 s) plus the kill grace.
      expect(deps.executorStopRetainUntil()).toBe(10_000 + 1_000 + VERIFICATION_STOP_GRACE_MS)
    } finally {
      now.mockRestore()
    }
  })

  it("runs no checks without a project, so required checks stay shut", async () => {
    const runtime = createScmRuntime({ projectId: null, appSettings: null, host })
    await runtime.review("cs-1", signal)
    const [, deps] = reviewChangeset.mock.calls[0] as unknown as [
      string,
      { acceptancePort: unknown },
    ]
    expect(deps.acceptancePort).toBeNull()
    expect(createDelegateAcceptancePort).not.toHaveBeenCalled()

    await runtime.integrate({ changesetIds: [], targetRef: "refs/heads/main" } as never)
    const [, integrationDeps] = integrateChangesets.mock.calls[0] as unknown as [
      unknown,
      { acceptancePortFor: unknown },
    ]
    expect(integrationDeps.acceptancePortFor).toBeNull()
  })

  it("verifies an integration candidate in the run's own worktree", async () => {
    const runtime = createScmRuntime({ projectId: "project-1", appSettings: null, host })
    await runtime.integrate({ changesetIds: ["cs-1"], targetRef: "refs/heads/main" } as never)
    const [, deps] = integrateChangesets.mock.calls[0] as unknown as [
      unknown,
      { acceptancePortFor: (run: unknown) => unknown },
    ]
    deps.acceptancePortFor({
      integrationId: "int-1",
      candidateSha: "c1",
      worktreePath: "/data/integration/k",
    })
    const { input } = createDelegateAcceptancePort.mock.results[0].value as {
      input: { rootForRevision: (r: string) => Promise<string | null>; runId: string }
    }
    expect(input.runId).toBe("integration:int-1")
    await expect(input.rootForRevision("c1")).resolves.toBe("/data/integration/k")
  })
})

describe("scmGitPortsFor", () => {
  it("reads the current branch, finds only local branches, and creates without checkout", async () => {
    const scmGitPorts = scmGitPortsFor()
    gitStatus.mockResolvedValueOnce({ branch: "main" })
    await expect(scmGitPorts.currentBranch("/repo")).resolves.toBe("main")
    gitBranches.mockResolvedValue([
      { name: "agent/run/integrated", isRemote: true },
      { name: "feature", isRemote: false },
    ])
    await expect(scmGitPorts.branchExists("/repo", "agent/run/integrated")).resolves.toBe(false)
    await expect(scmGitPorts.branchExists("/repo", "feature")).resolves.toBe(true)
    await scmGitPorts.createBranch("/repo", "agent/run/integrated", "HEAD")
    expect(gitCreateBranch).toHaveBeenCalledWith("/repo", "agent/run/integrated", false, "HEAD")
  })
})
