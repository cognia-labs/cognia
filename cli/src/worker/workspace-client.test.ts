import { PassThrough } from "node:stream"

import fs from "node:fs"
import path from "node:path"

import {
  createWorkerWorkspaceClient,
  openWorkerTurnCapture,
  resolveWorkerWorkspaceHelper,
  WorkerWorkspaceError,
} from "./workspace-client"

describe("createWorkerWorkspaceClient", () => {
  function server(requestTimeoutMs?: number) {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const stdin = new PassThrough()
    const child = Object.assign(new PassThrough(), { stdout, stderr, stdin, kill: jest.fn() })
    const requests: Array<{ id: string; method: string; params: unknown }> = []
    stdin.on("data", (value) => requests.push(JSON.parse(String(value))))
    stdin.on("finish", () => child.emit("close", 0))
    const spawn = jest.fn(() => child as never)
    const client = createWorkerWorkspaceClient({
      dataDir: "/worker-data",
      helperPath: "helper",
      spawn,
      requestTimeoutMs,
    })
    return { client, child, stdout, requests, spawn }
  }

  it("keeps one serve process alive across begin/settle and matches out-of-order replies", async () => {
    const { client, child, stdout, requests, spawn } = server()
    const capture = client.openCapture()
    const input = {
      taskId: "task",
      sessionId: "session",
      runId: "run",
      agentId: "builtin",
      agentKind: "in-app",
      workspaceRoot: "/repo",
      observeInPlace: true as const,
    }
    const first = capture.begin(input)
    const second = capture.listTasks("session")
    expect(requests).toEqual([
      expect.objectContaining({ method: "begin", params: { input } }),
      expect.objectContaining({ method: "listTasks", params: { sessionId: "session" } }),
    ])
    stdout.write(JSON.stringify({ id: requests[1].id, result: [] }) + "\n")
    stdout.write(
      JSON.stringify({
        id: requests[0].id,
        result: { runId: "run", executionRoot: "/repo", isolationKind: "observed" },
      }) + "\n"
    )
    await expect(second).resolves.toEqual([])
    await expect(first).resolves.toMatchObject({ runId: "run" })
    const settled = capture.settle("run", "cancelled")
    stdout.write(JSON.stringify({ id: requests[2].id, result: [] }) + "\n")
    await expect(settled).resolves.toEqual([])
    expect(requests[2]).toMatchObject({
      method: "settle",
      params: { runId: "run", finalState: "cancelled" },
    })
    const quarantine = capture.markExecutorUnconfirmed("run")
    stdout.write(JSON.stringify({ id: requests[3].id, result: null }) + "\n")
    await quarantine
    expect(requests[3]).toMatchObject({
      method: "markExecutorUnconfirmed",
      params: { runId: "run" },
    })
    const recovered = capture.settle("run", "failed", true)
    stdout.write(JSON.stringify({ id: requests[4].id, result: [] }) + "\n")
    await recovered
    expect(requests[4]).toMatchObject({
      method: "settle",
      params: { runId: "run", finalState: "failed", executorStopped: true },
    })
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn).toHaveBeenCalledWith(
      "helper",
      ["serve", "--data-dir", "/worker-data"],
      expect.any(Object)
    )
    await capture.close()
    expect(child.stdin.writableEnded).toBe(true)
  })

  it("rejects malformed helper output and every outstanding request", async () => {
    const { client, stdout } = server()
    const capture = client.openCapture()
    const first = capture.getPatch("run")
    const second = capture.listRuns("task")
    stdout.write("{broken-json}\n")
    await expect(first).rejects.toThrow(/invalid.*response/i)
    await expect(second).rejects.toThrow(/invalid.*response/i)
    await capture.close()
  })

  it.each([false, true])(
    "bounds oversized response lines even across chunks (newline: %s)",
    async (newline) => {
      const { client, stdout } = server()
      const capture = client.openCapture()
      const reading = capture.getPatch("run")
      stdout.write("a".repeat(8 * 1024 * 1024))
      stdout.write("b".repeat(8 * 1024 * 1024 + 1) + (newline ? "\n" : ""))
      await expect(reading).rejects.toThrow(/response/i)
      await capture.close()
    }
  )

  it("assembles split UTF-8 replies and rejects truncated output on exit", async () => {
    const { client, child, stdout, requests } = server()
    const capture = client.openCapture()
    const first = capture.readDiff("run", "雪.txt")
    const encoded = Buffer.from(JSON.stringify({ id: requests[0].id, result: "雪 ☃" }) + "\n")
    for (const byte of encoded) stdout.write(Buffer.from([byte]))
    await expect(first).resolves.toBe("雪 ☃")
    const second = capture.getPatch("run")
    stdout.write('{"id":')
    child.emit("close", 0)
    await expect(second).rejects.toMatchObject({ code: "helper_exited" })
    await capture.close()
  })

  it("rejects pending requests on close and rejects further work", async () => {
    const { client } = server()
    const capture = client.openCapture()
    const pending = capture.listRuns("task")
    const rejection = expect(pending).rejects.toMatchObject({ code: "helper_exited" })
    await capture.close()
    await rejection
    await expect(capture.listTasks()).rejects.toThrow(/closed|exited/)
  })

  it("times out a wedged helper and clears all pending requests", async () => {
    const { client, child } = server(5)
    const capture = client.openCapture()
    const first = capture.getPatch("run")
    const second = capture.listTasks()
    await Promise.all([
      expect(first).rejects.toMatchObject({ code: "helper_timeout" }),
      expect(second).rejects.toMatchObject({ code: "helper_timeout" }),
    ])
    expect(child.kill).toHaveBeenCalledTimes(1)
    await capture.close()
  })

  it("caps in-flight request ownership at 64", async () => {
    const { client, stdout, requests } = server()
    const capture = client.openCapture()
    const pending = Array.from({ length: 64 }, () => capture.listTasks())
    await expect(capture.listTasks()).rejects.toMatchObject({ code: "request_limit" })
    expect(requests).toHaveLength(64)
    for (const request of requests)
      stdout.write(JSON.stringify({ id: request.id, result: [] }) + "\n")
    await Promise.all(pending)
    await capture.close()
  })

  it("rejects over-budget requests before sending them and surfaces typed helper errors", async () => {
    const { client, stdout, requests } = server()
    const capture = client.openCapture()
    await expect(capture.readDiff("run", "a".repeat(256 * 1024))).rejects.toThrow(/request.*limit/i)
    expect(requests).toEqual([])
    const read = capture.getPatch("run")
    stdout.write(
      JSON.stringify({
        id: requests[0].id,
        error: { code: "not_found", message: "run not found" },
      }) + "\n"
    )
    await expect(read).rejects.toMatchObject({ code: "not_found", message: "run not found" })
    await capture.close()
  })

  it("invokes the Task Workspace helper with stable refs and parses JSON", async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const stdin = new PassThrough()
    const process = Object.assign(new PassThrough(), { stdout, stderr, stdin })
    const spawn = jest.fn(() => process as never)
    const client = createWorkerWorkspaceClient({
      dataDir: "/worker-data",
      helperPath: "/bin/cognia-task-workspace-worker",
      spawn,
    })

    const pending = client.bind("repository:project-1:repo-1", "/work/repo")
    stdout.write(
      `${JSON.stringify({
        bindingRef: "repository:project-1:repo-1",
        sourceRoot: "/work/repo",
        gitCommonDir: "/work/repo/.git",
        repositoryFingerprint: "sha256:test",
        createdAt: 1,
        updatedAt: 1,
      })}\n`
    )
    process.emit("close", 0)

    await expect(pending).resolves.toMatchObject({
      bindingRef: "repository:project-1:repo-1",
    })
    expect(spawn).toHaveBeenCalledWith(
      "/bin/cognia-task-workspace-worker",
      [
        "bind",
        "--data-dir",
        "/worker-data",
        "--repository-ref",
        "repository:project-1:repo-1",
        "--path",
        "/work/repo",
      ],
      expect.objectContaining({ stdio: ["pipe", "pipe", "pipe"] })
    )
  })

  it("surfaces helper failures without accepting partial stdout", async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const stdin = new PassThrough()
    const process = Object.assign(new PassThrough(), { stdout, stderr, stdin })
    const client = createWorkerWorkspaceClient({
      dataDir: "/worker-data",
      helperPath: "helper",
      spawn: () => process as never,
    })
    const pending = client.resolve("repository:project-1:missing")
    stdout.write('{"bindingRef":"forged"}\n')
    stderr.write("workspace source is not bound")
    process.emit("close", 1)

    await expect(pending).rejects.toThrow("workspace source is not bound")
  })

  it("resolves an installed helper beside the bundled module before the Node executable", () => {
    const exists = jest
      .spyOn(fs, "existsSync")
      .mockImplementation((candidate) =>
        String(candidate).endsWith("/cli/dist/cognia-task-workspace-worker")
      )

    expect(
      resolveWorkerWorkspaceHelper(
        {},
        "file:///opt/cognia/cli/dist/chunks/workspace-client.mjs",
        "/usr/local/bin/node"
      )
    ).toBe("/opt/cognia/cli/dist/cognia-task-workspace-worker")

    exists.mockRestore()
  })
})

describe("openWorkerTurnCapture executor proof", () => {
  const input = {
    taskId: "task",
    sessionId: "session",
    runId: "run",
    agentId: "builtin",
    agentKind: "in-app" as const,
    workspaceRoot: "/repo",
  }
  function owner(supportsQuarantine = true) {
    return {
      assertExecutionAllowed: jest.fn(async () => undefined),
      begin: jest.fn(async () => ({
        ...input,
        executionRoot: input.workspaceRoot,
        workspaceId: null,
        isolationKind: "observed",
        ...(supportsQuarantine ? { executorStopUnconfirmed: false } : {}),
      })),
      settle: jest.fn(async () => []),
      markExecutorUnconfirmed: jest.fn(async () => undefined),
      close: jest.fn(async () => undefined),
    }
  }

  it("persists uncertainty before closing the owner without publishing a patch", async () => {
    const capture = owner()
    const turn = await openWorkerTurnCapture(
      { input, persist: true },
      { dataDir: "/data", openCapture: () => capture as never }
    )
    await expect(turn.finish("failed", false)).resolves.toMatchObject({
      available: false,
      reason: "capture-failed",
      runId: "run",
      workspaceRoot: "/repo",
    })
    expect(capture.markExecutorUnconfirmed).toHaveBeenCalledWith("run")
    expect(capture.settle).not.toHaveBeenCalled()
    expect(capture.close).toHaveBeenCalledTimes(1)
  })

  it("rejects an old helper before an executor can start", async () => {
    const capture = owner(false)
    const turn = await openWorkerTurnCapture(
      { input, persist: true },
      { dataDir: "/data", openCapture: () => capture as never }
    )
    await expect(turn.finish("ready")).resolves.toEqual({
      available: false,
      reason: "capture-failed",
    })
    expect(capture.close).toHaveBeenCalledTimes(1)
    expect(capture.settle).toHaveBeenCalledWith("run", "cancelled")
    expect(capture.markExecutorUnconfirmed).not.toHaveBeenCalled()
  })

  it("propagates authoritative root refusal instead of treating it as unavailable support", async () => {
    const capture = owner()
    capture.begin.mockRejectedValueOnce(
      new WorkerWorkspaceError("capture_refused", "local workspace observation is already active")
    )
    await expect(
      openWorkerTurnCapture(
        { input, persist: true },
        { dataDir: "/data", openCapture: () => capture as never }
      )
    ).rejects.toMatchObject({ code: "capture_refused" })
    expect(capture.close).toHaveBeenCalledTimes(1)
    expect(capture.settle).not.toHaveBeenCalled()
  })

  it("checks untracked admission without opening a run or creating capture bytes", async () => {
    const capture = owner()
    const turn = await openWorkerTurnCapture(
      { input, persist: false },
      { dataDir: "/data", openCapture: () => capture as never }
    )
    expect(capture.assertExecutionAllowed).toHaveBeenCalledWith("/repo")
    expect(capture.begin).not.toHaveBeenCalled()
    expect(capture.settle).not.toHaveBeenCalled()
    expect(capture.close).toHaveBeenCalledTimes(1)
    await expect(turn.finish("ready")).resolves.toEqual({
      available: false,
      reason: "persistence-disabled",
    })
  })

  it("rejects mismatched inherited execution ownership before a provider can start", async () => {
    const inherited = {
      sessionId: "other-session",
      taskId: "worker",
      runId: "worker-run",
      workspaceRoot: "/source",
      executionRoot: "/repo",
      settle: jest.fn(async () => {}),
      markExecutorUnconfirmed: jest.fn(async () => {}),
      close: jest.fn(async () => {}),
    }
    await expect(
      openWorkerTurnCapture({ input, persist: true, inherited }, { dataDir: "/data" })
    ).rejects.toMatchObject({ code: "capture_refused" })
    expect(inherited.close).toHaveBeenCalledTimes(1)
    expect(inherited.markExecutorUnconfirmed).toHaveBeenCalledTimes(1)
    expect(inherited.settle).not.toHaveBeenCalled()
  })

  it("closes compatible ownership after unknown mark delivery and keeps the receipt unavailable", async () => {
    const capture = owner()
    capture.markExecutorUnconfirmed.mockRejectedValueOnce(new Error("unknown method"))
    const turn = await openWorkerTurnCapture(
      { input, persist: true },
      { dataDir: "/data", openCapture: () => capture as never }
    )
    const unavailable = await turn.finish("failed", false)
    expect(unavailable).toMatchObject({ available: false, reason: "capture-failed", runId: "run" })
    expect(capture.close).toHaveBeenCalledTimes(1)
    expect(capture.settle).not.toHaveBeenCalled()
    await expect(turn.finish("failed", false)).resolves.toBe(unavailable)
    await expect(turn.finish("failed", true)).resolves.toMatchObject({
      available: false,
      reason: "capture-failed",
    })
    expect(capture.settle).not.toHaveBeenCalled()
    expect(capture.close).toHaveBeenCalledTimes(1)
  })

  it("closes inherited ownership after unknown mark delivery without normal settlement", async () => {
    const inherited = {
      sessionId: "session",
      taskId: "worker-task",
      runId: "worker-run",
      workspaceRoot: "/source",
      executionRoot: "/repo",
      settle: jest.fn(async () => {}),
      markExecutorUnconfirmed: jest.fn(async () => {
        throw new Error("delivery unknown")
      }),
      close: jest.fn(async () => {}),
    }
    const turn = await openWorkerTurnCapture(
      { input, persist: true, inherited },
      { dataDir: "/data" }
    )
    await expect(turn.finish("failed", false)).resolves.toMatchObject({
      available: false,
      runId: "worker-run",
      workspaceRoot: "/source",
    })
    expect(inherited.close).toHaveBeenCalledTimes(1)
    await expect(turn.finish("failed", true)).resolves.toMatchObject({
      available: false,
      reason: "capture-failed",
    })
    expect(inherited.settle).not.toHaveBeenCalled()
    expect(inherited.close).toHaveBeenCalledTimes(1)
  })
})

const nativeHelper = process.env.COGNIA_TEST_WORKSPACE_HELPER
;(nativeHelper ? it.each : it.skip.each)(["before-delivery", "after-delivery"])(
  "retains native quarantine through unknown mark outcome (%s) and closes the helper for explicit recovery",
  async (delivery) => {
    const output = path.resolve(".cache/turn-diff-fix-2026-10-30/cli")
    fs.mkdirSync(output, { recursive: true })
    const root = fs.mkdtempSync(path.join(output, "mark-delivery-"))
    const cwd = path.join(root, "cwd")
    fs.mkdirSync(cwd)
    const file = path.join(cwd, "observed.txt")
    fs.writeFileSync(file, "base\n")
    const client = createWorkerWorkspaceClient({
      dataDir: path.join(root, "data"),
      helperPath: nativeHelper,
    })
    const owner = client.openCapture()
    const input = {
      taskId: "task",
      sessionId: "session",
      runId: "run",
      agentId: "builtin",
      agentKind: "in-app" as const,
      workspaceRoot: cwd,
    }
    try {
      const turn = await openWorkerTurnCapture(
        { input, persist: true },
        {
          dataDir: path.join(root, "data"),
          openCapture: () => ({
            ...owner,
            async markExecutorUnconfirmed(runId) {
              if (delivery === "after-delivery") await owner.markExecutorUnconfirmed(runId)
              throw new Error("mark outcome unknown")
            },
          }),
        }
      )
      fs.writeFileSync(file, "still-live-writer\n")
      await expect(turn.finish("failed", false)).resolves.toMatchObject({
        available: false,
        reason: "capture-failed",
        runId: "run",
      })
      const review = client.openCapture()
      try {
        expect(await review.getPatch("run")).toBeNull()
        expect(await review.listRuns("task")).toMatchObject([
          { state: "settling", executorStopUnconfirmed: true },
        ])
        await expect(review.settle("run", "failed")).rejects.toThrow()
        await review.settle("run", "failed", true)
        expect(await review.getPatch("run")).toBeNull()
        expect(await review.listRuns("task")).toMatchObject([
          { state: "failed", executorStopUnconfirmed: false },
        ])
        await review.begin({ ...input, taskId: "next", runId: "next", observeInPlace: true })
        await review.settle("next", "cancelled")
      } finally {
        await review.close()
      }
    } finally {
      await owner.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
)
;(nativeHelper ? it : it.skip)(
  "captures and exactly undoes Unicode Local edits through the actual persistent helper",
  async () => {
    const cache = path.resolve(".cache")
    fs.mkdirSync(cache, { recursive: true })
    const root = fs.mkdtempSync(path.join(cache, "cli-turn-diff-"))
    const cwd = path.join(root, "repo")
    fs.mkdirSync(cwd)
    const relative = "a old 雪.txt"
    const file = path.join(cwd, relative)
    const baseline = Buffer.from("a/old/path\nb/new/path\n原始雪 ☃\n", "utf8")
    const edited = Buffer.from("a/old/path\nb/new/replaced\n修改雪 ☃\nextra λ\n", "utf8")
    fs.writeFileSync(file, baseline)
    const capture = createWorkerWorkspaceClient({
      helperPath: nativeHelper,
      dataDir: path.join(root, "data"),
    }).openCapture()
    try {
      const run = await capture.begin({
        taskId: "cli:session",
        sessionId: "session",
        runId: "cli-run",
        agentId: "builtin",
        agentKind: "in-app",
        workspaceRoot: cwd,
        observeInPlace: true,
        base: { kind: "workingState" },
      })
      expect(run).toMatchObject({
        runId: "cli-run",
        taskId: "cli:session",
        isolationKind: "observed",
        executionRoot: fs.realpathSync(cwd),
      })
      fs.writeFileSync(file, edited)
      const resources = await capture.settle("cli-run", "ready")
      expect(resources).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: relative, kind: "modified" })])
      )
      expect(await capture.getPatch("cli-run")).toMatchObject({
        state: "applied",
        reversible: true,
      })
      const diff = await capture.readDiff("cli-run", relative)
      expect(diff).toContain("-b/new/path")
      expect(diff).toContain("+修改雪 ☃")
      expect((await capture.listTasks("session")).map((task) => task.taskId)).toContain(
        "cli:session"
      )
      expect((await capture.listRuns("cli:session")).map((run) => run.state)).toEqual(["ready"])
      await expect(capture.undo("cli-run")).resolves.toMatchObject({ state: "reverted" })
      expect(fs.readFileSync(file)).toEqual(baseline)
    } finally {
      await capture.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  },
  30_000
)
