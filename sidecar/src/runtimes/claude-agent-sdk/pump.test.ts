import assert from "node:assert/strict"
import { test } from "node:test"
import { captureClaudeRuntime } from "../../../test-support/claude-runtime.ts"
import { startAnthropicPump } from "./pump.ts"
import { createToolSessionContext } from "../../tools/session.ts"
import {
  createTerminalReplTools,
  __setNodePtyForTesting,
} from "../../tools/builtin/terminal-repl/index.ts"
import type { PtyExit } from "../../tools/builtin/terminal-repl/index.ts"

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

test(
  "native background Bash/Task jobs and tool disposal outlive the result frame",
  { skip: process.platform === "win32" },
  async (t) => {
    const events: Record<string, unknown>[] = []
    let finishTasks!: () => void
    let disposeTools!: () => void
    const tasks = new Promise<void>((resolve) => {
      finishTasks = resolve
    })
    const tools = new Promise<void>((resolve) => {
      disposeTools = resolve
    })
    let onExit: ((exit: PtyExit) => void) | undefined
    let exited = false
    t.mock.method(process, "kill", (pid: number) => {
      assert.equal(pid, -2147483647)
      if (exited) throw Object.assign(new Error("group empty"), { code: "ESRCH" })
      return true
    })
    __setNodePtyForTesting({
      spawn() {
        return {
          // A known, absent Unix group becomes provably empty after onExit.
          pid: 2147483647,
          write() {},
          onData() {},
          onExit(listener) {
            onExit = listener
          },
          kill() {
            void tools.then(() => {
              exited = true
              onExit?.({ exitCode: 0 })
            })
          },
        }
      },
    })
    t.after(() => {
      finishTasks()
      disposeTools()
      __setNodePtyForTesting(undefined)
    })
    const repl = createTerminalReplTools({ sessionId: "background-sdk" })[0]!
    const spawned = await repl.handler({
      agentId: "background-sdk",
      shell: "/bin/sh",
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    })
    assert.equal(spawned.isError, undefined)
    let closed = false
    // Tool resources are owned by an executor, not by the conversation id.
    const toolSession = createToolSessionContext({
      sessionId: "conversation-sdk",
      executorId: "background-sdk",
      sendOptions: {},
    })
    startAnthropicPump({
      sessionId: "conversation-sdk",
      sendOptions: {},
      emit: (event: Record<string, unknown>) => {
        events.push(event)
      },
      log() {},
      toolSession,
      pluginToolNameAliases: new Map(),
      mcpAutoReconnect: { onEvent() {} },
      mcpStderrSink: { end() {} },
      state: { outstandingPrompts: 1 },
      waitForProcessExit: async () => {},
      session: { closeInput() {}, drainPending() {} },
      q: {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "system",
            subtype: "background_tasks_changed",
            tasks: [{ task_id: "bash" }, { task_id: "Task" }],
          }
          yield { type: "result", subtype: "success" }
          await tasks
          yield { type: "system", subtype: "background_tasks_changed", tasks: [] }
        },
        interrupt() {},
        close() {
          closed = true
        },
      },
    } as unknown as Parameters<typeof startAnthropicPump>[0])
    await flush()
    assert.equal(
      events.some((event) => event.type === "session_ended"),
      true
    )
    assert.equal(
      events.some((event) => event.type === "session_disposed"),
      false
    )
    finishTasks()
    await flush()
    assert.equal(closed, true)
    assert.equal(
      events.some((event) => event.type === "session_disposed"),
      false
    )
    disposeTools()
    await flush()
    assert.equal(events.filter((event) => event.type === "session_disposed").length, 1)
  }
)

test("iterator end with live native SDK tasks never proves disposal", async () => {
  const { events } = captureClaudeRuntime({}, () => ({
    async *[Symbol.asyncIterator]() {
      yield { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "Task" }] }
      yield { type: "result", subtype: "success" }
    },
    interrupt() {},
    close() {},
  }))
  await flush()
  assert.equal(
    events.some((event) => event.type === "session_disposed"),
    false
  )
})

test("a steered query waits for both results and emits one terminal frame", async () => {
  const { session, events } = captureClaudeRuntime({}, ({ prompt }) => ({
    async *[Symbol.asyncIterator]() {
      for await (const message of prompt)
        yield { type: "result", subtype: "success", session_id: message.session_id }
    },
    interrupt() {},
    close() {},
  }))
  session.pushUserMessage("steer", "now")
  await flush()
  assert.equal(events.filter((event) => event.type === "sdk_session_id").length, 1)
  assert.equal(events.filter((event) => event.type === "event").length, 2)
  assert.equal(events.filter((event) => event.type === "session_ended").length, 1)
  assert.equal(session._ended, true)
  assert.equal(session.pushUserMessage("closed"), false)
})

test("provider failure results retain HTTP status through the terminal boundary", async () => {
  const { events, session } = captureClaudeRuntime({}, () => ({
    async *[Symbol.asyncIterator]() {
      yield {
        type: "result",
        subtype: "success",
        terminal_reason: "api_error",
        api_error_status: 404,
        result: "missing model",
      }
    },
    interrupt() {},
    close() {},
  }))
  await flush()
  const terminal = events.find((event) => event.type === "session_ended")!
  assert.equal(terminal.httpStatus, 404)
  assert.match(String(terminal.error), /HTTP 404.*missing model/)
  assert.equal(session._ended, true)
})

test("iterator errors settle the session once and retain the error message", async () => {
  const { events, session } = captureClaudeRuntime({}, () => ({
    async *[Symbol.asyncIterator]() {
      throw new Error("transport broke")
    },
    interrupt() {},
    close() {},
  }))
  await flush()
  assert.deepEqual(
    events.filter((event) => event.type === "session_ended"),
    [{ type: "session_ended", sessionId: "test-session", error: "transport broke" }]
  )
  assert.equal(session._ended, true)
  session.closeInput()
})

test("G3: a live native background task refuses personal admission", async () => {
  let finish!: () => void
  const done = new Promise<void>((resolve) => {
    finish = resolve
  })
  const { session } = captureClaudeRuntime({}, () => ({
    async *[Symbol.asyncIterator]() {
      yield { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "Task" }] }
      await done
      yield { type: "system", subtype: "background_tasks_changed", tasks: [] }
    },
    interrupt() {},
    close() {},
  }))
  try {
    await flush()
    await assert.rejects(
      (session as typeof session & { fencePersonalEgress(): Promise<void> }).fencePersonalEgress(),
      /isolation unconfirmed/
    )
  } finally {
    finish()
    session.closeInput()
    await flush()
  }
})

test("H3: native fence refuses an unconfirmed descendant proof after direct PIDs end", async (t) => {
  const toolSession = createToolSessionContext({ sessionId: "proof", sendOptions: {} })
  t.mock.method(toolSession, "disposeProcesses", async () => {})
  t.mock.method(toolSession, "hasRunningProcesses", async () => false)
  t.mock.method(toolSession, "hasLiveProcesses", async () => true)
  let finish!: () => void
  const running = new Promise<void>((resolve) => {
    finish = resolve
  })
  const session = {
    closeInput() {},
    drainPending() {},
    fencePersonalEgress: undefined as undefined | (() => Promise<void>),
  }
  startAnthropicPump({
    sessionId: "proof",
    sendOptions: {},
    emit() {},
    log() {},
    toolSession,
    pluginToolNameAliases: new Map(),
    mcpAutoReconnect: { onEvent() {} },
    mcpStderrSink: { end() {} },
    state: { outstandingPrompts: 1 },
    waitForProcessExit: async () => {},
    session,
    q: {
      async *[Symbol.asyncIterator]() {
        await running
      },
      interrupt() {},
      close() {
        finish()
      },
    },
  } as unknown as Parameters<typeof startAnthropicPump>[0])
  try {
    await assert.rejects(session.fencePersonalEgress!(), /isolation unconfirmed/)
  } finally {
    finish()
    await flush()
  }
})
