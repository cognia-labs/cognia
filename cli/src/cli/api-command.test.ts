import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { apiCommand, API_HELP, type ApiCommandDeps } from "./api-command"
import { parseArgv } from "./args"
import { API_COMMANDS } from "../api/generated/command-index"
import { EXIT_OK, EXIT_FAILURE, EXIT_USAGE } from "./errors"
import type { OutputSink } from "./output"
import type { CommandOutcome, HostTransport, RequestOptions } from "../api/transport"

interface Recorded {
  kind: "execute" | "request"
  name: string
  body: unknown
  options?: RequestOptions
}

function sink(): OutputSink & { stdout: string; stderr: string[] } {
  const captured = {
    stdout: "",
    stderr: [] as string[],
    write(text: string) {
      captured.stdout += text
    },
    error(text: string) {
      captured.stderr.push(text)
    },
    json(value: unknown) {
      captured.stdout += `${JSON.stringify(value)}\n`
    },
  }
  return captured
}

function transport(
  wire: "internal" | "http",
  answers: CommandOutcome[]
): HostTransport & { calls: Recorded[] } {
  const queue = [...answers]
  const calls: Recorded[] = []
  return {
    wire,
    label: `test ${wire} host`,
    calls,
    async execute(name, body, options) {
      calls.push({ kind: "execute", name, body, options })
      return queue.shift() ?? { ok: true, result: {} }
    },
    async request(method, routePath, body, options) {
      calls.push({ kind: "request", name: `${method} ${routePath}`, body, options })
      return queue.shift() ?? { ok: true, result: {} }
    },
  }
}

function deps(
  host: (HostTransport & { calls: Recorded[] }) | null,
  extra: Partial<Omit<ApiCommandDeps, "out">> = {}
): ApiCommandDeps & { out: ReturnType<typeof sink> } {
  const out = sink()
  return {
    out,
    env: {},
    home: "/home/.cognia",
    cwd: "/repo",
    resolve: () => ({ skipped: [{ leg: "environment", reason: "nothing set" }] }),
    connect: async () =>
      host
        ? { ok: true, transport: host }
        : {
            ok: false,
            failure: {
              error: "no Cognia host is configured",
              cause: "no-host",
              fix: ["cognia-agent host add local --endpoint https://127.0.0.1:27890"],
            },
          },
    ...extra,
  }
}

function run(argv: string[], commandDeps: ApiCommandDeps): Promise<number> {
  return apiCommand(parseArgv(argv), { ...commandDeps, argv })
}

describe("help and usage", () => {
  it("prints help and exits 2 with no subcommand", async () => {
    const d = deps(null)
    expect(await run(["api"], d)).toBe(EXIT_USAGE)
    expect(d.out.stdout).toBe(API_HELP)
  })

  it("prints help and exits 0 for an explicit --help", async () => {
    const d = deps(null)
    expect(await run(["api", "list", "--help"], d)).toBe(EXIT_OK)
    expect(d.out.stdout).toBe(API_HELP)
  })

  it("refuses an unknown subcommand with a pointer to help", async () => {
    const d = deps(null)
    expect(await run(["api", "frobnicate"], d)).toBe(EXIT_USAGE)
    expect(d.out.stderr[0]).toContain("unknown api subcommand")
  })

  it("refuses an unreadable --format before touching a host", async () => {
    const d = deps(null)
    expect(await run(["api", "list", "--format", "yaml"], d)).toBe(EXIT_USAGE)
    expect(d.out.stderr[0]).toContain("Cause: invalid-request")
  })
})

describe("api list and groups", () => {
  it("lists every command by default", async () => {
    const d = deps(null)
    expect(await run(["api", "list", "--format", "raw"], d)).toBe(EXIT_OK)
    expect(JSON.parse(d.out.stdout)).toHaveLength(API_COMMANDS.length)
  })

  it("filters to one wire", async () => {
    const d = deps(null)
    await run(["api", "list", "--wire", "http", "--format", "raw"], d)
    expect(JSON.parse(d.out.stdout)).toHaveLength(
      API_COMMANDS.filter((entry) => entry.wires.includes("http")).length
    )
  })

  it("filters by group and search together", async () => {
    const d = deps(null)
    await run(["api", "list", "--group", "plugin", "--search", "install", "--format", "raw"], d)
    const rows = JSON.parse(d.out.stdout) as Array<{ command: string }>
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((row) => row.command.startsWith("plugin_"))).toBe(true)
    expect(rows.every((row) => row.command.includes("install"))).toBe(true)
  })

  it("renders a table for the default pretty format", async () => {
    const d = deps(null)
    await run(["api", "list", "--group", "adapter"], d)
    expect(d.out.stdout).toContain("command")
    expect(d.out.stdout).toContain("adapter_update_policy")
  })

  it("lists the groups with their counts", async () => {
    const d = deps(null)
    await run(["api", "groups", "--wire", "http", "--format", "raw"], d)
    const groups = JSON.parse(d.out.stdout) as Array<{ group: string; count: number }>
    expect(groups.reduce((total, group) => total + group.count, 0)).toBe(
      API_COMMANDS.filter((entry) => entry.wires.includes("http")).length
    )
  })
})

describe("api describe and schema", () => {
  it("describes a command without needing a host", async () => {
    const d = deps(null)
    expect(await run(["api", "describe", "adapter_update_policy", "--format", "raw"], d)).toBe(
      EXIT_OK
    )
    const described = JSON.parse(d.out.stdout) as Record<string, unknown>
    expect(described.command).toBe("adapter_update_policy")
    expect(described.wires).toBe("internal, http")
    expect((described.fields as unknown[]).length).toBeGreaterThan(0)
  })

  it("suggests near misses for an unknown command", async () => {
    const d = deps(null)
    expect(await run(["api", "describe", "plugin_lst"], d)).toBe(EXIT_USAGE)
    expect(d.out.stderr[0]).toContain("plugin_list")
  })

  it("needs a command name", async () => {
    const d = deps(null)
    expect(await run(["api", "describe"], d)).toBe(EXIT_USAGE)
    expect(d.out.stderr[0]).toContain("needs a <command>")
  })

  it("prints a fillable template as JSON even under --format pretty", async () => {
    const d = deps(null)
    await run(["api", "schema", "adapter_update_policy", "--template", "--format", "pretty"], d)
    const template = JSON.parse(d.out.stdout) as Record<string, unknown>
    expect(template.id).toBe("")
    expect(template.defaultMode).toBe("auto")
  })

  it("prints the complete input schema without --template", async () => {
    const d = deps(null)
    await run(["api", "schema", "adapter_update_policy", "--format", "raw"], d)
    const schema = JSON.parse(d.out.stdout) as { properties: Record<string, unknown> }
    expect(schema.properties.id).toEqual({ type: "string" })
  })
})

describe("api call", () => {
  it("sends the validated body and prints the result", async () => {
    const host = transport("internal", [{ ok: true, result: { updated: true } }])
    const d = deps(host)
    expect(
      await run(
        [
          "api",
          "call",
          "adapter_update_policy",
          "--id",
          "bot_1",
          "--default-mode",
          "auto",
          "--format",
          "raw",
        ],
        d
      )
    ).toBe(EXIT_OK)
    expect(host.calls[0].name).toBe("adapter_update_policy")
    expect(host.calls[0].body).toEqual({ id: "bot_1", defaultMode: "auto" })
    expect(JSON.parse(d.out.stdout)).toEqual({ updated: true })
  })

  it("mints an idempotency key for a command that requires one", async () => {
    const host = transport("internal", [{ ok: true, result: {} }])
    await run(["api", "call", "adapter_update_policy", "--id", "b"], deps(host))
    expect(host.calls[0].options?.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )
  })

  it("refuses a missing required field without opening a connection", async () => {
    const host = transport("internal", [{ ok: true, result: {} }])
    const d = deps(host)
    expect(await run(["api", "call", "adapter_update_policy"], d)).toBe(EXIT_USAGE)
    expect(d.out.stderr[0]).toContain("missing id")
    expect(host.calls).toHaveLength(0)
  })

  it("refuses an unknown field locally rather than letting the host answer 422", async () => {
    const host = transport("internal", [{ ok: true, result: {} }])
    const d = deps(host)
    expect(await run(["api", "call", "adapter_update_policy", "--id", "b", "--nope", "1"], d)).toBe(
      EXIT_USAGE
    )
    expect(d.out.stderr[0]).toContain("--nope")
    expect(host.calls).toHaveLength(0)
  })

  it("treats a boolean field as a flag with no value", async () => {
    const host = transport("internal", [{ ok: true, result: {} }])
    await run(["api", "call", "adapter_update_policy", "--muted", "--id", "b"], deps(host))
    expect(host.calls[0].body).toEqual({ muted: true, id: "b" })
  })

  it("merges --data with flags, letting the flag win", async () => {
    const host = transport("internal", [{ ok: true, result: {} }])
    await run(
      [
        "api",
        "call",
        "adapter_update_policy",
        "--data",
        '{"id":"from-data","muted":true}',
        "--id",
        "from-flag",
      ],
      deps(host)
    )
    expect(host.calls[0].body).toEqual({ id: "from-flag", muted: true })
  })

  it("names the fix when the host refuses for a missing lease", async () => {
    const host = transport("http", [
      {
        ok: false,
        cause: "refused",
        message: "a current device-bound approval lease is required",
        status: 428,
        code: "interactive_approval_required",
        requestId: "req_9",
      },
    ])
    const d = deps(host)
    // `agent_task_cancel` is interactive, so passing a lease gets past the
    // local preflight and lets the host's own refusal be the thing under test.
    expect(
      await run(
        [
          "api",
          "call",
          "agent_task_cancel",
          "--agent-id",
          "a",
          "--task-id",
          "t",
          "--data",
          '{"adminLease":"stale"}',
        ],
        d
      )
    ).toBe(EXIT_FAILURE)
    const block = d.out.stderr[0]
    expect(block).toContain("Fix: cognia-agent api call host_admin_lease_issue")
    expect(block).toContain("Diagnostics: status=428")
    expect(block).toContain("Diagnostics: requestId=req_9")
    expect(block).toContain("Diagnostics: wire=http")
  })

  it("refuses an interactive command on the device wire before sending it", async () => {
    const host = transport("http", [{ ok: true, result: {} }])
    const d = deps(host)
    expect(
      await run(["api", "call", "agent_task_cancel", "--agent-id", "a", "--task-id", "t"], d)
    ).toBe(EXIT_FAILURE)
    expect(d.out.stderr[0]).toContain("host_admin_lease_issue")
    expect(host.calls).toHaveLength(0)
  })

  it("lets the same command through on the headless wire", async () => {
    const host = transport("internal", [{ ok: true, result: { cancelled: true } }])
    const d = deps(host)
    expect(
      await run(["api", "call", "agent_task_cancel", "--agent-id", "a", "--task-id", "t"], d)
    ).toBe(EXIT_OK)
    expect(host.calls).toHaveLength(1)
  })

  it("reports an accepted call and how to follow it", async () => {
    const host = transport("internal", [
      { ok: true, accepted: true, result: {}, operationId: "op_7" },
    ])
    const d = deps(host)
    expect(await run(["api", "call", "adapter_update_policy", "--id", "b"], d)).toBe(EXIT_OK)
    expect(d.out.stderr.join(" ")).toContain("op_7")
    expect(d.out.stderr.join(" ")).toContain("--wait")
  })

  it("follows an accepted call under --wait", async () => {
    const host = transport("internal", [
      { ok: true, accepted: true, result: {}, operationId: "op_8" },
      { ok: true, result: { status: "completed", result: { done: true } } },
    ])
    const d = deps(host, { sleep: async () => undefined })
    expect(
      await run(
        ["api", "call", "adapter_update_policy", "--id", "b", "--wait", "--format", "raw"],
        d
      )
    ).toBe(EXIT_OK)
    expect(JSON.parse(d.out.stdout)).toEqual({ done: true })
  })

  it("reports the no-host failure with its fix", async () => {
    const d = deps(null)
    expect(await run(["api", "call", "adapter_update_policy", "--id", "b"], d)).toBe(EXIT_FAILURE)
    expect(d.out.stderr[0]).toContain("Cause: no-host")
    expect(d.out.stderr[0]).toContain("host add")
  })

  it("logs the request envelope under --debug", async () => {
    const host = transport("internal", [{ ok: true, result: {} }])
    const d = deps(host)
    await run(["api", "call", "adapter_update_policy", "--id", "b", "--debug"], d)
    expect(d.out.stderr.join(" ")).toContain("[debug]")
    expect(d.out.stderr.join(" ")).toContain("adapter_update_policy")
  })

  it("needs a command name", async () => {
    const d = deps(null)
    expect(await run(["api", "call"], d)).toBe(EXIT_USAGE)
    expect(d.out.stderr[0]).toContain("needs a <command>")
  })
})

describe("api request", () => {
  it("sends an arbitrary route through the resolved host", async () => {
    const host = transport("internal", [{ ok: true, result: { devices: [] } }])
    const d = deps(host)
    expect(await run(["api", "request", "GET", "/api/devices", "--format", "raw"], d)).toBe(EXIT_OK)
    expect(host.calls[0].name).toBe("GET /api/devices")
  })

  it("refuses a path that is not a path", async () => {
    const d = deps(null)
    expect(await run(["api", "request", "GET", "api/devices"], d)).toBe(EXIT_USAGE)
    expect(d.out.stderr[0]).toContain('must start with "/"')
  })

  it("needs both a method and a path", async () => {
    const d = deps(null)
    expect(await run(["api", "request", "GET"], d)).toBe(EXIT_USAGE)
  })

  it("reports a route failure with the status", async () => {
    const host = transport("internal", [
      { ok: false, cause: "unknown-command", message: "not found", status: 404 },
    ])
    const d = deps(host)
    expect(await run(["api", "request", "GET", "/nope"], d)).toBe(EXIT_FAILURE)
    expect(d.out.stderr[0]).toContain("Diagnostics: status=404")
  })
})

describe("transport lifetime (ADR-0224 A4)", () => {
  /**
   * A relay room holds a socket open; a CLI that never closed it would sit
   * there after printing its answer.
   */
  it("closes the transport after a command, whether it succeeded or failed", async () => {
    const ok = transport("internal", [{ ok: true, result: {} }])
    const closeOk = jest.fn()
    await run(
      ["api", "call", "adapter_update_policy", "--id", "b"],
      deps({ ...ok, close: closeOk })
    )
    expect(closeOk).toHaveBeenCalledTimes(1)

    const failed = transport("internal", [
      {
        ok: false,
        cause: "network",
        message: "the host answered neither on its address nor through its relay room",
        details: ["direct: ECONNREFUSED", "relay: room did not open"],
      },
    ])
    const closeFailed = jest.fn()
    const d = deps({ ...failed, close: closeFailed })
    expect(await run(["api", "call", "adapter_update_policy", "--id", "b"], d)).toBe(EXIT_FAILURE)
    expect(closeFailed).toHaveBeenCalledTimes(1)
    // Both routes' reasons reach the operator.
    expect(d.out.stderr.join("\n")).toContain("relay: room did not open")
  })

  it("closes the transport after a raw request", async () => {
    const host = transport("internal", [{ ok: true, result: {} }])
    const close = jest.fn()
    await run(["api", "request", "GET", "/api/devices"], deps({ ...host, close }))
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe("API contract regression cases", () => {
  it("redacts credentials recursively from debug output", async () => {
    const d = deps(transport("internal", [{ ok: true, result: null }]))
    const code = await run(
      [
        "api",
        "call",
        "host_provider_credential_set",
        "--data",
        '{"providerId":"p","apiKey":"CANARY_SECRET"}',
        "--debug",
        "--json",
      ],
      d
    )
    expect(code).toBe(0)
    expect(d.out.stderr.join(" ")).not.toContain("CANARY_SECRET")
  })
  it("uses device workspace coordinates rather than service paths", async () => {
    const host = transport("http", [{ ok: true, result: {} }])
    const d = deps(host)
    expect(
      await run(["api", "call", "git_status", "--data", '{"workspaceId":"w"}', "--json"], d)
    ).toBe(0)
    expect(host.calls[0].body).toEqual({ workspaceId: "w" })
  })
  it("preserves explicit false and nullable null through derived boolean parsing", async () => {
    const host = transport("internal", [{ ok: true, result: null }])
    const d = deps(host)
    expect(
      await run(
        [
          "api",
          "call",
          "adapter_update_policy",
          "--id",
          "a",
          "--muted=false",
          "--a2ui-enabled=null",
          "--json",
        ],
        d
      )
    ).toBe(0)
    expect(host.calls[0].body).toMatchObject({ muted: false, a2uiEnabled: null })
  })
  it("separates a body intent key from its transport UUID", async () => {
    const host = transport("internal", [{ ok: true, result: {} }])
    const d = deps(host)
    expect(
      await run(
        [
          "api",
          "call",
          "execution_run_create",
          "--mode",
          "cascade",
          "--text",
          "test",
          "--body-idempotency-key",
          "intent",
          "--idempotency-key",
          "11111111-1111-4111-8111-111111111111",
          "--json",
        ],
        d
      )
    ).toBe(0)
    expect(host.calls[0].body).toMatchObject({ idempotencyKey: "intent" })
    expect(host.calls[0].options?.idempotencyKey).toBe("11111111-1111-4111-8111-111111111111")
  })
  it("does not report a cancelled operation as success", async () => {
    const host = transport("internal", [
      { ok: true, accepted: true, operationId: "op", result: {} },
      { ok: true, result: { id: "op", done: true, status: "cancelled" } },
    ])
    const d = deps(host, { sleep: async () => {} })
    expect(await run(["api", "call", "session_list", "--wait", "--json"], d)).not.toBe(0)
  })
})

describe("complete API workflows", () => {
  it("exports the complete selected-wire input schema", async () => {
    const d = deps(null)
    expect(await run(["api", "schema", "git_status", "--wire", "http", "--json"], d)).toBe(0)
    expect(JSON.parse(d.out.stdout)).toMatchObject({
      type: "object",
      required: ["workspaceId"],
      additionalProperties: false,
    })
  })
  it("validates nested data and unknown fields before dispatch", async () => {
    const host = transport("internal", [])
    const d = deps(host)
    expect(
      await run(
        [
          "api",
          "call",
          "adapter_update_policy",
          "--data",
          '{"id":42,"muted":"false","unknownField":true}',
          "--json",
        ],
        d
      )
    ).toBe(2)
    expect(host.calls).toHaveLength(0)
    expect(JSON.parse(d.out.stderr[0])).toMatchObject({ ok: false, cause: "invalid-request" })
  })
  it("aggregates bounded page-token pages", async () => {
    const host = transport("internal", [
      { ok: true, result: { items: [{ id: "a" }], nextPageToken: "b" } },
      { ok: true, result: { items: [{ id: "b" }] } },
    ])
    const d = deps(host)
    expect(await run(["api", "call", "session_list", "--all", "--json"], d)).toBe(0)
    expect(JSON.parse(d.out.stdout).items).toEqual([{ id: "a" }, { id: "b" }])
    expect(host.calls[1].body).toEqual({ pageToken: "b" })
  })
  it("forwards idempotency keys through raw HTTP", async () => {
    const host = transport("internal", [{ ok: true, result: {} }])
    const d = deps(host)
    expect(
      await run(
        [
          "api",
          "request",
          "POST",
          "/internal/_rpc/write",
          "--idempotency-key",
          "11111111-1111-4111-8111-111111111111",
          "--json",
        ],
        d
      )
    ).toBe(0)
    expect(host.calls[0].options?.idempotencyKey).toBe("11111111-1111-4111-8111-111111111111")
  })
})

describe("live authenticated discovery", () => {
  it("calls an admitted newer command using the Host schema", async () => {
    const host = transport("internal", [
      {
        ok: true,
        result: {
          contractVersion: 3,
          commands: [
            {
              name: "new_command",
              target: "execution",
              capability: "client.read",
              risk: "low",
              approval: "none",
              idempotency: "forbidden",
            },
          ],
          schemas: {
            new_command: {
              input: {
                type: "object",
                required: ["id"],
                properties: { id: { type: "string" } },
                additionalProperties: false,
              },
              output: { type: "null" },
            },
          },
        },
      },
      { ok: true, result: null },
    ])
    const d = deps(host)
    expect(await run(["api", "call", "new_command", "--live", "--id", "a", "--json"], d)).toBe(0)
    expect(host.calls[1]).toMatchObject({ name: "new_command", body: { id: "a" } })
  })
  it("refuses a mismatched Host contract before dispatch", async () => {
    const host = transport("internal", [
      { ok: true, result: { contractVersion: 999, commands: [] } },
    ])
    const d = deps(host)
    expect(await run(["api", "call", "session_list", "--live", "--json"], d)).not.toBe(0)
    expect(host.calls).toHaveLength(1)
  })
})

describe("file, stream and script boundaries", () => {
  let directory: string
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-cli-api-"))
  })
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }))
  it("writes byte responses atomically and preserves an existing file on failure", async () => {
    const target = path.join(directory, "file.bin")
    const first = deps(transport("internal", [{ ok: true, result: Buffer.from([0, 255, 10]) }]))
    expect(
      await run(
        ["api", "request", "GET", "/download", "--response", "bytes", "--save", target],
        first
      )
    ).toBe(0)
    expect(fs.readFileSync(target)).toEqual(Buffer.from([0, 255, 10]))
    const second = deps(transport("internal", [{ ok: false, cause: "network", message: "lost" }]))
    expect(
      await run(
        ["api", "request", "GET", "/download", "--response", "bytes", "--save", target],
        second
      )
    ).not.toBe(0)
    expect(fs.readFileSync(target)).toEqual(Buffer.from([0, 255, 10]))
    expect(fs.readdirSync(directory)).toEqual(["file.bin"])
  })
  it("sends raw file bytes and encodes multipart uploads with a boundary", async () => {
    const file = path.join(directory, "source.bin")
    fs.writeFileSync(file, Buffer.from([0, 255, 10]))
    const host = transport("internal", [
      { ok: true, result: {} },
      { ok: true, result: {} },
    ])
    const d = deps(host)
    expect(
      await run(
        [
          "api",
          "request",
          "POST",
          "/upload",
          "--body-file",
          file,
          "--content-type",
          "application/octet-stream",
        ],
        d
      )
    ).toBe(0)
    expect(host.calls[0].options?.rawBody).toEqual(Buffer.from([0, 255, 10]))
    expect(
      await run(
        [
          "api",
          "request",
          "POST",
          "/upload",
          "--multipart",
          JSON.stringify({ file: `@${file}`, label: "sample" }),
        ],
        d
      )
    ).toBe(0)
    expect(host.calls[1].options?.headers?.["content-type"]).toContain(
      "multipart/form-data; boundary="
    )
    expect(
      Buffer.from(host.calls[1].options!.rawBody as Uint8Array).includes(Buffer.from([0, 255, 10]))
    ).toBe(true)
  })
  it("keeps raw HTTP Problem metadata in JSON failures", async () => {
    const d = deps(
      transport("internal", [
        {
          ok: false,
          cause: "refused",
          message: "later",
          requestId: "r1",
          retryable: true,
          retryAfter: "2",
          problem: { details: { replacement: "new" } },
        },
      ])
    )
    expect(await run(["api", "request", "GET", "/catalog", "--json"], d)).not.toBe(0)
    expect(JSON.parse(d.out.stderr[0])).toMatchObject({
      problem: { details: { replacement: "new" } },
      diagnostics: { requestId: "r1", retryAfter: "2", retryable: "true" },
    })
  })
  it("cancels live discovery under the total budget before any mutation", async () => {
    const host = transport("internal", [])
    host.request = jest.fn(
      async (_method, _route, _body, options) =>
        new Promise((resolve) =>
          options?.signal?.addEventListener(
            "abort",
            () => resolve({ ok: false, cause: "timeout", message: "stopped" }),
            { once: true }
          )
        )
    )
    const d = deps(host)
    expect(
      await run(
        [
          "api",
          "call",
          "session_list",
          "--live",
          "--timeout",
          "1s",
          "--total-timeout",
          "20ms",
          "--json",
        ],
        d
      )
    ).not.toBe(0)
    expect(host.calls).toHaveLength(0)
    expect(JSON.parse(d.out.stderr[0]).cause).toBe("timeout")
  })
  it("checkpoints event output and rejects a cursor from a different Host", async () => {
    const file = path.join(directory, "cursor.json")
    const host = transport("internal", [])
    const watch = jest.fn(async (options: import("../api/events").WatchOptions) => {
      options.onEvent({ type: "a", seq: 7, payload: "event" })
      return { ok: true as const, result: { count: 1 } }
    })
    const d = deps({ ...host, watch })
    expect(
      await run(["api", "events", "--channels", "a", "--max-events", "1", "--cursor-file", file], d)
    ).toBe(0)
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ seq: 7, host: host.label })
    const other = deps({ ...host, label: "other Host", watch })
    expect(await run(["api", "events", "--channels", "a", "--cursor-file", file], other)).toBe(2)
    expect(watch).toHaveBeenCalledTimes(1)
  })
})

it.each(["/export?access_token=CANARY_QUERY_SECRET", "export?access_token=CANARY_QUERY_SECRET"])(
  "does not print raw request query credentials in debug or failures: %s",
  async (routePath) => {
    const d = deps(transport("internal", [{ ok: false, cause: "failed", message: "refused" }]))
    await run(["api", "request", "GET", routePath, "--debug", "--json"], d)
    expect(d.out.stderr.join(" ")).not.toContain("CANARY_QUERY_SECRET")
  }
)
