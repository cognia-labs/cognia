import test from "node:test"
import assert from "node:assert/strict"
import { fromSystem } from "./system.ts"
import { codeRunCallFrame } from "../../../tools/builtin/run-code/trace.ts"

test("unknown and prototype-named subtypes remain diagnostics", () => {
  for (const subtype of ["__proto__", "toString", "constructor", "future"]) {
    const event = { type: "system", subtype }
    assert.deepEqual(fromSystem(event), [
      { kind: "diagnostic", runtime: "claude-agent-sdk", payload: event },
    ])
  }
})

test("task projections retain parentage and distinguish resumed runs", () => {
  assert.deepEqual(
    fromSystem({
      subtype: "task_started",
      task_id: "child",
      parent_task_id: "parent",
      run_id: "run-2",
    }),
    [{ kind: "task", phase: "started", taskId: "child", parentTaskId: "parent", runId: "run-2" }]
  )
  assert.deepEqual(
    fromSystem({
      subtype: "background_tasks_changed",
      tasks: [
        {
          task_id: "child",
          task_type: "local_agent",
          description: "work",
          parent_task_id: "parent",
          run_id: "run-2",
          subagent_type: "researcher",
          ambient: true,
        },
      ],
    }),
    [
      {
        kind: "task-inventory",
        tasks: [
          {
            taskId: "child",
            taskType: "local_agent",
            description: "work",
            parentTaskId: "parent",
            runId: "run-2",
            subagentType: "researcher",
            ambient: true,
          },
        ],
      },
    ]
  )
})

// CM-12: a run_code program's nested call is progress under the run_code call,
// built from the frame the sidecar actually emits.
test("a run_code nested call maps to progress under its parent call", () => {
  const frame = codeRunCallFrame("s-1", {
    parentToolCallId: "toolu_outer",
    call: { ordinal: 2, tool: "grep", state: "succeeded", durationMs: 41.6, resultBytes: 120 },
  })
  assert.deepEqual(fromSystem(frame.event), [
    {
      kind: "tool-progress",
      toolCallId: "toolu_outer/2",
      toolName: "grep",
      elapsedMs: 42,
      parentToolCallId: "toolu_outer",
    },
  ])
})

test("a run_code nested call without its ids projects nothing", () => {
  assert.deepEqual(
    fromSystem({ type: "system", subtype: "code_run_call", call: { tool: "x" } }),
    []
  )
})
