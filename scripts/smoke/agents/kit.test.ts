/** @jest-environment node */
import fs from "node:fs"

jest.mock("@/cli/src/runtime/external/host-branch", () => ({
  installCliExternalAgentHost: jest.fn(() => jest.fn()),
  selectCliAgentWorkspace: jest.fn(),
}))
jest.mock("@/cli/src/runtime/external/sandbox-launcher", () => ({
  findSandboxLauncher: jest.fn(() => "/bin/launcher"),
}))
jest.mock("@/lib/ai/agent/external/config/presets", () => ({
  createAgentFromPreset: jest.fn((presetId: string, overrides: object) =>
    presetId === "missing" ? undefined : { presetId, ...overrides }
  ),
}))

import {
  installCliExternalAgentHost,
  selectCliAgentWorkspace,
} from "@/cli/src/runtime/external/host-branch"
import { findSandboxLauncher } from "@/cli/src/runtime/external/sandbox-launcher"
import {
  firstChoices,
  isAuthenticationRefusal,
  overrideEnv,
  presetConfig,
  requireSandboxLauncher,
  runTurn,
  withSmokeContext,
  type AcpAdapter,
  type PresetId,
  type SmokeContext,
} from "./kit"
import type { AcpElicitationRequest } from "@/types/agent/external-agent"

const installMock = installCliExternalAgentHost as jest.Mock
const selectMock = selectCliAgentWorkspace as jest.Mock
const findLauncherMock = findSandboxLauncher as jest.Mock
const options = { live: false, keep: false }

describe("withSmokeContext", () => {
  it("installs the host, selects a fresh scratch and undoes everything in reverse", async () => {
    const uninstall = jest.fn()
    installMock.mockReturnValueOnce(uninstall)
    const order: string[] = []
    let scratch = ""
    const result = await withSmokeContext("unit", options, async (context) => {
      scratch = context.scratch
      expect(fs.existsSync(scratch)).toBe(true)
      expect(selectMock).toHaveBeenLastCalledWith(scratch)
      context.defer(() => order.push("first"))
      context.defer(() => order.push("second"))
      expect(context.marker("X")).toMatch(/^X_[0-9a-f]{32}$/)
      return 42
    })
    expect(result).toBe(42)
    expect(order).toEqual(["second", "first"])
    expect(selectMock).toHaveBeenLastCalledWith(process.cwd())
    expect(uninstall).toHaveBeenCalled()
    expect(fs.existsSync(scratch)).toBe(false)
  })

  it("still cleans up and keeps going past a failed cleanup when the body throws", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => undefined)
    const later = jest.fn()
    let scratch = ""
    await expect(
      withSmokeContext("unit", options, async (context) => {
        scratch = context.scratch
        context.defer(later)
        context.defer(() => {
          throw new Error("cleanup broke")
        })
        throw new Error("body broke")
      })
    ).rejects.toThrow("body broke")
    expect(later).toHaveBeenCalled()
    expect(fs.existsSync(scratch)).toBe(false)
    expect(error).toHaveBeenCalledWith(expect.stringContaining("cleanup broke"))
    error.mockRestore()
  })

  it("keeps the scratch directory on request", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => undefined)
    const scratch = await withSmokeContext(
      "unit",
      { live: false, keep: true },
      async (c) => c.scratch
    )
    expect(fs.existsSync(scratch)).toBe(true)
    fs.rmSync(scratch, { recursive: true, force: true })
    error.mockRestore()
  })

  it("refuses to start without a sandbox launcher", async () => {
    findLauncherMock.mockReturnValueOnce(undefined)
    await expect(withSmokeContext("unit", options, async () => 1)).rejects.toThrow(
      /pnpm cli:external-host:build/
    )
    expect(requireSandboxLauncher(() => "/x")).toBe("/x")
  })
})

describe("helpers", () => {
  const context = { scratch: "/tmp/s", defer: jest.fn() } as unknown as SmokeContext

  it("overrides environment variables and restores them on cleanup", () => {
    process.env.KIT_TEST_SET = "before"
    delete process.env.KIT_TEST_UNSET
    const defers: Array<() => void> = []
    overrideEnv({ defer: (fn: () => void) => defers.push(fn) } as unknown as SmokeContext, {
      KIT_TEST_SET: "after",
      KIT_TEST_UNSET: "new",
    })
    expect(process.env.KIT_TEST_SET).toBe("after")
    defers[0]()
    expect(process.env.KIT_TEST_SET).toBe("before")
    expect(process.env.KIT_TEST_UNSET).toBeUndefined()
    delete process.env.KIT_TEST_SET
  })

  it("builds a preset config in scratch with retries off", () => {
    expect(
      presetConfig("kimi" as PresetId, context, { env: { A: "1" }, args: ["acp"] })
    ).toMatchObject({
      presetId: "kimi",
      process: { cwd: "/tmp/s", env: { A: "1" }, args: ["acp"] },
      retryConfig: { maxRetries: 0 },
      timeout: 30_000,
    })
    expect(() => presetConfig("missing" as PresetId, context)).toThrow(
      /Missing external-agent preset/
    )
  })

  it("recognises authentication refusals and nothing else", () => {
    expect(isAuthenticationRefusal(new Error("Authentication required"))).toBe(true)
    expect(isAuthenticationRefusal("please run login first")).toBe(true)
    expect(isAuthenticationRefusal(new Error("Missing API key"))).toBe(true)
    expect(isAuthenticationRefusal(new Error("-32603: Internal error"))).toBe(false)
  })

  it("answers form questions with the first choice of each field", () => {
    const request = {
      id: "q",
      mode: "form",
      message: "?",
      raw: {},
      requestedSchema: {
        type: "object",
        properties: {
          single: { type: "string", oneOf: [{ const: "Tests" }, { const: "Docs" }] },
          multi: { type: "array", items: { enum: ["Alpha", "Beta"] } },
        },
      },
    } as unknown as AcpElicitationRequest
    expect(firstChoices(request)).toEqual({ single: "Tests", multi: ["Alpha"] })
    expect(() => firstChoices({ ...request, mode: "url" })).toThrow(/URL elicitation/)
    expect(() =>
      firstChoices({
        ...request,
        requestedSchema: { type: "object", properties: { free: { type: "string" } } },
      } as unknown as AcpElicitationRequest)
    ).toThrow(/offers no explicit choice/)
  })
})

describe("runTurn", () => {
  function adapterWith(events: unknown[]) {
    return {
      prompt: jest.fn(async function* () {
        yield* events
      }),
      respondToPermission: jest.fn(async () => undefined),
      respondToElicitation: jest.fn(async () => undefined),
    }
  }

  it("collects the reply, stop reason and event counts, answering requests", async () => {
    const adapter = adapterWith([
      { type: "message_delta", delta: { type: "text", text: "he" } },
      { type: "permission_request", request: { id: "p1" } },
      {
        type: "elicitation_request",
        request: {
          id: "e1",
          mode: "form",
          requestedSchema: { properties: { pick: { type: "string", enum: ["A"] } } },
        },
      },
      { type: "message_delta", delta: { type: "text", text: "llo" } },
      { type: "done", stopReason: "end_turn" },
    ])
    const result = await runTurn(adapter as unknown as AcpAdapter, "s1", "hi", {
      allowPermissions: true,
    })
    expect(result).toEqual({
      reply: "hello",
      stopReason: "end_turn",
      events: { message_delta: 2, permission_request: 1, elicitation_request: 1, done: 1 },
    })
    expect(adapter.respondToPermission).toHaveBeenCalledWith("s1", {
      requestId: "p1",
      granted: true,
      scope: "once",
    })
    expect(adapter.respondToElicitation).toHaveBeenCalledWith({
      requestId: "e1",
      action: "accept",
      content: { pick: "A" },
    })
  })

  it("denies permissions by default and fails on an error event", async () => {
    const adapter = adapterWith([
      { type: "permission_request", request: { id: "p1", requestId: 7 } },
      { type: "error", error: "boom" },
    ])
    await expect(runTurn(adapter as unknown as AcpAdapter, "s1", "hi")).rejects.toThrow(
      /Agent turn error/
    )
    expect(adapter.respondToPermission).toHaveBeenCalledWith("s1", {
      requestId: 7,
      granted: false,
      scope: "once",
    })
  })
})
