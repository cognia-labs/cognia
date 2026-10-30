import { recordPluginApiAudit } from "./interface-catalog"
import { PluginApiPolicyError, withGovernedPluginContext } from "./governed-context"
import { detectPlatform, isCliHost } from "@/lib/platform/detect"

jest.mock("@/lib/platform/detect", () => ({
  detectPlatform: jest.fn(() => "web"),
  isCliHost: jest.fn(() => false),
}))

jest.mock("./interface-catalog", () => {
  const actual = jest.requireActual("./interface-catalog")
  return { ...actual, recordPluginApiAudit: jest.fn() }
})

const audit = jest.mocked(recordPluginApiAudit)

describe("withGovernedPluginContext", () => {
  beforeEach(() => {
    audit.mockClear()
    jest.mocked(detectPlatform).mockReturnValue("web")
    jest.mocked(isCliHost).mockReturnValue(false)
  })

  it.each(["web", "mobile", "headless"] as const)(
    "rejects desktop-only methods on the detected %s host before invocation",
    (platform) => {
      jest.mocked(detectPlatform).mockReturnValue(platform)
      const getAvailability = jest.fn()
      const context = withGovernedPluginContext(
        { recorder: { getAvailability } },
        { pluginId: "demo", hasPermission: () => true }
      )

      expect(() => context.recorder.getAvailability()).toThrow(
        'cannot call "recorder.getAvailability": platform'
      )
      expect(getAvailability).not.toHaveBeenCalled()
    }
  )

  it("classifies the standalone CLI as a headless host", () => {
    jest.mocked(isCliHost).mockReturnValue(true)
    const context = withGovernedPluginContext(
      { recorder: { getAvailability: jest.fn() } },
      { pluginId: "demo", hasPermission: () => true }
    )

    expect(() => context.recorder.getAvailability()).toThrow(
      'cannot call "recorder.getAvailability": platform'
    )
  })

  it("maps Tauri to the desktop contract platform", () => {
    jest.mocked(detectPlatform).mockReturnValue("tauri")
    const context = withGovernedPluginContext(
      { recorder: { getAvailability: () => "ready" } },
      { pluginId: "demo", hasPermission: () => true }
    )

    expect(context.recorder.getAvailability()).toBe("ready")
  })

  it.each([
    ["files", "save"],
    ["skills", "invokeBuiltIn"],
    ["plans", "listAll"],
    ["hooks", "listOwn"],
  ])("allows the implemented %s.%s API through the catalog", (namespace, method) => {
    const implementation = jest.fn(() => "called")
    const context = withGovernedPluginContext(
      { [namespace]: { [method]: implementation } },
      { pluginId: "demo", hasPermission: () => true }
    )

    expect(context[namespace][method]()).toBe("called")
    expect(implementation).toHaveBeenCalledTimes(1)
  })

  it("preserves results and audits metadata for nested catalog methods", async () => {
    const context = withGovernedPluginContext(
      { session: { listSessions: async () => ["session"] } },
      { pluginId: "demo", hasPermission: () => true }
    )

    await expect(context.session.listSessions()).resolves.toEqual(["session"])
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "demo",
        methodId: "session.listSessions",
        outcome: "allowed",
      })
    )
    expect(audit.mock.calls[0][0]).not.toHaveProperty("args")
  })

  it("keeps shadow permission decisions behavior-compatible", () => {
    const fn = jest.fn(() => "ok")
    const context = withGovernedPluginContext(
      { auth: { registerProvider: fn } },
      { pluginId: "demo", hasPermission: () => false }
    )

    expect(context.auth.registerProvider()).toBe("ok")
    expect(fn).toHaveBeenCalled()
  })

  it("fails closed for methods missing from the catalog", () => {
    const context = withGovernedPluginContext(
      { session: { futureMethod: () => "unsafe" } },
      { pluginId: "demo", hasPermission: () => true }
    )

    expect(() => context.session.futureMethod()).toThrow(PluginApiPolicyError)
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ methodId: "session.futureMethod", outcome: "denied" })
    )
  })

  it("preserves class instances instead of proxying their methods", () => {
    class HostHandle {
      close() {}
    }
    const handle = new HostHandle()
    const context = withGovernedPluginContext(
      { capabilities: { handle } },
      { pluginId: "demo", hasPermission: () => true }
    )

    expect(context.capabilities.handle).toBe(handle)
  })
})

describe("new namespace policy refusals", () => {
  it.each(["files.save", "skills.invokeBuiltIn", "plans.create"])(
    "denies %s without its permission before invoking host code",
    (id) => {
      const [namespace, method] = id.split(".")
      const implementation = jest.fn()
      const context = withGovernedPluginContext(
        { [namespace]: { [method]: implementation } },
        {
          pluginId: "unprivileged",
          platform: "web",
          hasPermission: () => false,
        }
      )
      expect(() => context[namespace][method]()).toThrow("permission")
      expect(implementation).not.toHaveBeenCalled()
    }
  )
  it.each(["files.save", "skills.invokeBuiltIn", "plans.create"])(
    "denies the frontend-only %s on Python",
    (id) => {
      const [namespace, method] = id.split(".")
      const implementation = jest.fn()
      const context = withGovernedPluginContext(
        { [namespace]: { [method]: implementation } },
        {
          pluginId: "python",
          runtime: "python",
          platform: "desktop",
          hasPermission: () => true,
        }
      )
      expect(() => context[namespace][method]()).toThrow("runtime")
      expect(implementation).not.toHaveBeenCalled()
    }
  )
  it("denies file dialogs on headless hosts", () => {
    const implementation = jest.fn()
    const context = withGovernedPluginContext(
      { files: { save: implementation } },
      {
        pluginId: "headless",
        platform: "headless",
        hasPermission: () => true,
      }
    )
    expect(() => context.files.save()).toThrow("platform")
    expect(implementation).not.toHaveBeenCalled()
  })
})
