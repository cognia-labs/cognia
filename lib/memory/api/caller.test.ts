import {
  companionCaller,
  localUserCaller,
  mcpCaller,
  pluginCaller,
  workflowCaller,
  resolveMemoryCaller,
} from "./caller"

describe("memory caller constructors", () => {
  it("bind the account-owner principals for in-process transports", () => {
    expect(localUserCaller()).toEqual({ principalId: "local-user", transport: "local-ui" })
    expect(mcpCaller()).toEqual({ principalId: "mcp:bridge", transport: "mcp" })
  })

  it("namespaces a plugin principal by the manager-injected id", () => {
    expect(pluginCaller("my-plugin")).toEqual({
      principalId: "plugin:my-plugin",
      transport: "plugin",
    })
  })

  it("binds a companion principal to the injected device id and paired reader", () => {
    expect(companionCaller("dev-1")).toEqual({
      principalId: "companion:dev-1",
      transport: "companion",
    })
    expect(companionCaller("dev-1", "member")).toEqual({
      principalId: "companion:dev-1",
      transport: "companion",
      pairedReader: "member",
    })
    expect(companionCaller("dev-1", "owner")).toEqual({
      principalId: "companion:dev-1",
      transport: "companion",
      pairedReader: "owner",
    })
  })

  it("degrades to the transport principal when the route injects no device id", () => {
    expect(companionCaller()).toEqual({
      principalId: "companion:device",
      transport: "companion",
    })
    expect(companionCaller(undefined)).toEqual(companionCaller())
  })

  it("namespaces a workflow principal by run id when bound to one", () => {
    expect(workflowCaller("run-7")).toEqual({
      principalId: "workflow:run-7",
      transport: "workflow",
    })
    expect(workflowCaller()).toEqual({ principalId: "workflow", transport: "workflow" })
  })

  it("constructs identities without caching mutable grants", () => {
    for (const caller of [
      localUserCaller(),
      mcpCaller(),
      pluginCaller("p"),
      companionCaller("d", "member"),
      workflowCaller("r"),
    ]) {
      expect(caller.namespaces).toBeUndefined()
    }
  })

  it("intersects host, transport, and principal restrictions without mutating the caller", () => {
    const caller = { ...pluginCaller("p"), namespaces: { projects: ["a", "b"] } }
    expect(
      resolveMemoryCaller(caller, {
        principalGrants: {
          "transport:plugin": { scopes: ["workspace"], projects: ["a", "c"] },
          "plugin:p": { projects: ["a", "b", "c"] },
        },
      }).namespaces
    ).toEqual({ scopes: ["workspace"], projects: ["a"] })
    expect(caller.namespaces.projects).toEqual(["a", "b"])
    expect(
      resolveMemoryCaller(caller, { principalGrants: { "plugin:p": { scopes: [] } } }).namespaces
        ?.scopes
    ).toEqual([])
  })

  it("fails closed on malformed restrictions and ignores prototype keys", () => {
    expect(
      resolveMemoryCaller(pluginCaller("p"), { principalGrants: { "plugin:p": null } as never })
        .namespaces
    ).toEqual({ scopes: [] })
    expect(
      resolveMemoryCaller(pluginCaller("p"), {
        principalGrants: { "plugin:p": { projects: 3 } } as never,
      }).namespaces
    ).toEqual({ projects: [] })
    const caller = pluginCaller("p")
    expect(
      resolveMemoryCaller(caller, {
        principalGrants: Object.create({ "plugin:p": { scopes: [] } }),
      })
    ).toEqual({ ...caller, namespaces: undefined })
  })
})
