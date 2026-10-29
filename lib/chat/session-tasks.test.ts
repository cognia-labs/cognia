import type { UIMessage } from "ai"

import {
  deriveSessionTasks,
  diffTaskSnapshots,
  parseCreatedTaskId,
  parseTaskListOutput,
  taskToolKind,
} from "./session-tasks"

let seq = 0
function tool(
  name: string,
  input: unknown,
  extra: { output?: unknown; state?: string; dynamic?: boolean; id?: string } = {}
) {
  seq += 1
  return extra.dynamic
    ? {
        type: "dynamic-tool",
        toolName: name,
        toolCallId: extra.id ?? `call-${seq}`,
        state: extra.state ?? "output-available",
        input,
        output: extra.output,
      }
    : {
        type: `tool-${name}`,
        toolCallId: extra.id ?? `call-${seq}`,
        state: extra.state ?? "output-available",
        input,
        output: extra.output,
      }
}

function assistant(...parts: unknown[]): UIMessage {
  seq += 1
  return { id: `m-${seq}`, role: "assistant", parts: parts as UIMessage["parts"] }
}

function user(text: string): UIMessage {
  seq += 1
  return { id: `u-${seq}`, role: "user", parts: [{ type: "text", text }] }
}

const todos = (...items: Array<[string, string]>) => ({
  todos: items.map(([content, status]) => ({ content, status })),
})

describe("taskToolKind", () => {
  it.each([
    [{ type: "tool-TodoWrite" }, "todo_write"],
    [{ type: "tool-mcp__cognia-tools__TodoWrite" }, "todo_write"],
    [{ type: "tool-mcp__cognia-plugin-tools__TaskCreate" }, "task_create"],
    [{ type: "dynamic-tool", toolName: "TaskUpdate" }, "task_update"],
    [{ type: "tool-TaskList" }, "task_list"],
    [{ type: "tool-mcp__someone-else__TodoWrite" }, null],
    [{ type: "tool-Bash" }, null],
    [{ type: "text", text: "TodoWrite" }, null],
    [null, null],
  ])("classifies %j", (part, kind) => {
    expect(taskToolKind(part)).toBe(kind)
  })
})

describe("parseCreatedTaskId", () => {
  it("reads sidecar JSON", () => {
    expect(parseCreatedTaskId('{"task":{"id":"7","subject":"x"}}')).toBe("7")
  })
  it("reads SDK text", () => {
    expect(parseCreatedTaskId("Task #3 created successfully: Run tests")).toBe("3")
  })
  it("reads MCP text content blocks", () => {
    expect(parseCreatedTaskId([{ type: "text", text: '{"task":{"id":"a1"}}' }])).toBe("a1")
  })
  it("returns null without an id", () => {
    expect(parseCreatedTaskId(undefined)).toBeNull()
    expect(parseCreatedTaskId("created")).toBeNull()
  })
})

describe("parseTaskListOutput", () => {
  it("reads sidecar JSON", () => {
    expect(
      parseTaskListOutput('{"tasks":[{"id":"1","subject":"A","status":"completed"}]}')
    ).toEqual([{ id: "1", subject: "A", status: "completed" }])
  })
  it("reads SDK lines", () => {
    expect(parseTaskListOutput("#1 [completed] A\n#2 [in_progress] B (owner: x)")).toEqual([
      { id: "1", subject: "A", status: "completed" },
      { id: "2", subject: "B (owner: x)", status: "in_progress" },
    ])
  })
  it("reads an empty list", () => {
    expect(parseTaskListOutput("No tasks found")).toEqual([])
  })
  it("returns null for unrelated text", () => {
    expect(parseTaskListOutput("hello")).toBeNull()
  })
})

describe("deriveSessionTasks", () => {
  it("returns no current list for a transcript without task tools", () => {
    expect(deriveSessionTasks([user("hi"), assistant(tool("Bash", {}))]).current).toBeNull()
  })

  it("keeps the latest TodoWrite snapshot across later turns that write none", () => {
    const messages = [
      assistant(tool("TodoWrite", todos(["a", "completed"], ["b", "in_progress"]))),
      user("next"),
      assistant(tool("Bash", { command: "ls" })),
    ]
    const { current } = deriveSessionTasks(messages)
    expect(current?.family).toBe("todo")
    expect(current?.items.map((i) => [i.title, i.status])).toEqual([
      ["a", "completed"],
      ["b", "in_progress"],
    ])
  })

  it("includes dynamic-tool TodoWrite calls", () => {
    const { current } = deriveSessionTasks([
      assistant(tool("TodoWrite", todos(["x", "pending"]), { dynamic: true })),
    ])
    expect(current?.items[0]?.title).toBe("x")
  })

  it("replays TaskCreate / TaskUpdate by id", () => {
    const messages = [
      assistant(
        tool(
          "TaskCreate",
          { subject: "Write code", activeForm: "Writing code" },
          {
            output: '{"task":{"id":"1","subject":"Write code"}}',
          }
        ),
        tool("TaskCreate", { subject: "Test" }, { output: "Task #2 created successfully: Test" }),
        tool("TaskUpdate", { taskId: "1", status: "in_progress" })
      ),
      assistant(
        tool("TaskUpdate", { taskId: "1", status: "completed" }),
        tool("TaskUpdate", { taskId: "2", status: "deleted" })
      ),
    ]
    const { current } = deriveSessionTasks(messages)
    expect(current?.family).toBe("tasks")
    expect(current?.items).toEqual([
      { id: "1", title: "Write code", status: "completed", activeForm: "Writing code" },
    ])
  })

  it("keeps an in-flight TaskCreate under a provisional id", () => {
    const { current } = deriveSessionTasks([
      assistant(tool("TaskCreate", { subject: "A" }, { state: "input-available", id: "c1" })),
    ])
    expect(current?.items).toEqual([{ id: "pending:c1", title: "A", status: "pending" }])
  })

  it("treats TaskList output as the authoritative list", () => {
    const { current } = deriveSessionTasks([
      assistant(
        tool("TaskCreate", { subject: "A", activeForm: "Doing A" }, { output: "Task #1 created" })
      ),
      assistant(tool("TaskList", {}, { output: "#1 [in_progress] A\n#5 [pending] E" })),
    ])
    expect(current?.items).toEqual([
      { id: "1", title: "A", status: "in_progress", activeForm: "Doing A" },
      { id: "5", title: "E", status: "pending" },
    ])
  })

  it("shows an update for a task created before the loaded history by id", () => {
    const { current } = deriveSessionTasks([
      assistant(tool("TaskUpdate", { taskId: "9", status: "in_progress" })),
    ])
    expect(current?.items).toEqual([{ id: "9", title: "#9", status: "in_progress" }])
  })

  it("lets the family called last win, without merging", () => {
    const messages = [
      assistant(tool("TaskCreate", { subject: "A" }, { output: "Task #1 created" })),
      assistant(tool("TodoWrite", todos(["t", "pending"]))),
    ]
    expect(deriveSessionTasks(messages).current?.items.map((i) => i.title)).toEqual(["t"])
    const back = [...messages, assistant(tool("TaskUpdate", { taskId: "1", status: "completed" }))]
    const { current } = deriveSessionTasks(back)
    expect(current?.family).toBe("tasks")
    expect(current?.items.map((i) => [i.title, i.status])).toEqual([["A", "completed"]])
  })

  it("ignores failed calls and user messages", () => {
    const { current } = deriveSessionTasks([
      assistant(tool("TodoWrite", todos(["a", "pending"]))),
      assistant(tool("TodoWrite", todos(["b", "pending"]), { state: "output-error" })),
      { id: "u", role: "user", parts: [tool("TodoWrite", todos(["c", "pending"]))] } as UIMessage,
    ])
    expect(current?.items.map((i) => i.title)).toEqual(["a"])
  })

  it("records before/after per tool call", () => {
    const first = tool("TodoWrite", todos(["a", "in_progress"]), { id: "t1" })
    const second = tool("TodoWrite", todos(["a", "completed"]), { id: "t2" })
    const { byToolCallId, current } = deriveSessionTasks([assistant(first), assistant(second)])
    expect(byToolCallId.get("t1")?.before).toEqual([])
    expect(byToolCallId.get("t2")?.before[0]?.status).toBe("in_progress")
    expect(byToolCallId.get("t2")?.after[0]?.status).toBe("completed")
    expect(current?.lastToolCallId).toBe("t2")
  })

  it("reuses per-message extraction for unchanged messages", () => {
    const message = assistant(tool("TodoWrite", todos(["a", "pending"])))
    const a = deriveSessionTasks([message]).current?.items
    const b = deriveSessionTasks([message]).current?.items
    expect(b).toEqual(a)
  })
})

describe("diffTaskSnapshots", () => {
  it("reports completed, started, added and removed items", () => {
    const before = [
      { id: "1", title: "a", status: "in_progress" as const },
      { id: "2", title: "b", status: "pending" as const },
      { id: "3", title: "c", status: "pending" as const },
    ]
    const after = [
      { id: "1", title: "a", status: "completed" as const },
      { id: "2", title: "b", status: "in_progress" as const },
      { id: "4", title: "d", status: "pending" as const },
    ]
    const diff = diffTaskSnapshots(before, after, "tasks")
    expect(diff.completed.map((i) => i.title)).toEqual(["a"])
    expect(diff.started.map((i) => i.title)).toEqual(["b"])
    expect(diff.added.map((i) => i.title)).toEqual(["d"])
    expect(diff.removed.map((i) => i.title)).toEqual(["c"])
    expect([diff.done, diff.total]).toEqual([1, 3])
  })

  it("matches TodoWrite items by title, not position", () => {
    const before = [
      { id: "todo-0", title: "a", status: "pending" as const },
      { id: "todo-1", title: "b", status: "pending" as const },
    ]
    const after = [
      { id: "todo-0", title: "b", status: "completed" as const },
      { id: "todo-1", title: "a", status: "pending" as const },
    ]
    const diff = diffTaskSnapshots(before, after, "todo")
    expect(diff.completed.map((i) => i.title)).toEqual(["b"])
    expect(diff.added).toEqual([])
  })
})
