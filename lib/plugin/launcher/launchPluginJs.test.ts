import {
  buildLaunchArgv,
  deriveScopeFromManifest,
  launchPluginJs,
  nodePermissionArgs,
  nodePermissionSupport,
  type NodePermissionScope,
  type PluginJsHostInvoker,
  encodeNodePluginValue,
  reviveNodePluginValue,
} from "./launchPluginJs"

describe("nodePermissionSupport", () => {
  it("reports scoped filesystem grants as supported", () => {
    expect(nodePermissionSupport("filesystem:read")).toEqual({
      available: true,
    })
    expect(nodePermissionSupport("filesystem:write")).toEqual({
      available: true,
    })
  })

  it("keeps in-process network and subprocess grants visible but unavailable", () => {
    expect(nodePermissionSupport("network:fetch")).toMatchObject({
      available: false,
      reason: "network-broker-missing",
    })
    expect(nodePermissionSupport("process:spawn")).toMatchObject({
      available: false,
      reason: "subprocess-broker-missing",
    })
  })
})

const EMPTY_SCOPE: NodePermissionScope = {
  permissions: [],
  readPaths: [],
  writePaths: [],
  netHosts: [],
  allowedSubprocesses: [],
}

describe("nodePermissionArgs", () => {
  it("always emits --permission as the first arg", () => {
    expect(nodePermissionArgs(EMPTY_SCOPE)[0]).toBe("--permission")
  })

  it("omits read/write/net/child flags when their lists are empty", () => {
    expect(nodePermissionArgs(EMPTY_SCOPE)).toEqual(["--permission"])
  })

  it("emits one --allow-fs-read flag per path", () => {
    const args = nodePermissionArgs({
      ...EMPTY_SCOPE,
      readPaths: ["/etc", "/var/log"],
    })
    expect(args).toEqual(["--permission", "--allow-fs-read=/etc", "--allow-fs-read=/var/log"])
  })

  it("emits scoped filesystem read and write flags when fully populated", () => {
    const args = nodePermissionArgs({
      permissions: [],
      readPaths: ["/r"],
      writePaths: ["/w"],
      netHosts: [],
      allowedSubprocesses: [],
    })
    expect(args).toEqual(["--permission", "--allow-fs-read=/r", "--allow-fs-write=/w"])
  })

  it("does not emit wildcards — empty list ≠ allow all", () => {
    const args = nodePermissionArgs(EMPTY_SCOPE)
    expect(args.join(" ")).not.toContain("*")
  })

  it("drops wildcard grant values instead of emitting Node allow-all flags", () => {
    const args = nodePermissionArgs({
      permissions: [],
      readPaths: ["*"],
      writePaths: ["/tmp", "*"],
      netHosts: ["*"],
      allowedSubprocesses: ["*"],
    })
    expect(args).toEqual(["--permission", "--allow-fs-write=/tmp"])
    expect(args.join(" ")).not.toContain("*")
  })

  it("rejects network host grants because Node has no host-scoped network flag", () => {
    expect(() =>
      nodePermissionArgs({
        permissions: [],
        readPaths: [],
        writePaths: [],
        netHosts: ["api.example.com"],
        allowedSubprocesses: [],
      })
    ).toThrow(/network grants require a scoped host broker/)
  })

  it("rejects subprocess allowlists instead of emitting broad child-process access", () => {
    expect(() =>
      nodePermissionArgs({
        permissions: [],
        readPaths: [],
        writePaths: [],
        netHosts: [],
        allowedSubprocesses: ["git"],
      })
    ).toThrow(/subprocess grants require a scoped host broker/)
  })
})

describe("deriveScopeFromManifest", () => {
  it("treats missing concrete inputs as empty lists, not wildcards", () => {
    const scope = deriveScopeFromManifest(["filesystem:read"], {})
    expect(scope.readPaths).toEqual([])
    expect(scope.writePaths).toEqual([])
    expect(scope.netHosts).toEqual([])
    expect(scope.allowedSubprocesses).toEqual([])
  })

  it("passes concrete lists through verbatim", () => {
    const scope = deriveScopeFromManifest(["filesystem:write"], {
      writePaths: ["/tmp", "/cache"],
    })
    expect(scope.writePaths).toEqual(["/tmp", "/cache"])
  })
})

describe("buildLaunchArgv", () => {
  it("places node-permission flags before the entry path", () => {
    const argv = buildLaunchArgv("./entry.mjs", {
      ...EMPTY_SCOPE,
      readPaths: ["/r"],
    })
    expect(argv).toEqual(["--permission", "--allow-fs-read=/r", "./entry.mjs"])
  })

  it("appends extra args after the entry path", () => {
    const argv = buildLaunchArgv("./entry.mjs", EMPTY_SCOPE, ["--flag", "value"])
    expect(argv).toEqual(["--permission", "./entry.mjs", "--flag", "value"])
  })
})

type Frame = Record<string, unknown> & { type: string; id?: string }

function residentHost(onFrame: (frame: Frame, emit: (frame: Frame) => void) => void) {
  const inbox: Frame[] = []
  const invoker = jest.fn(async (command: string, args: Record<string, unknown>) => {
    if (command === "plugin_launch_js")
      return {
        command: "node",
        argv: ["--permission"],
        generation: "generation",
      }
    if (command === "plugin_js_status") return true
    if (command === "plugin_stop_js") return undefined
    if (command === "plugin_deactivate_js") {
      onFrame({ type: "deactivate", id: "deactivate" }, (frame) => inbox.push(frame))
      return undefined
    }
    expect(command).toBe("plugin_invoke_js_callback")
    expect(args.callbackId).toBe("$exchange")
    expect(args.generation).toBe("generation")
    for (const frame of (args.args as { frames: Frame[] }).frames)
      onFrame(frame, (reply) => inbox.push(reply))
    if (!inbox.length) await new Promise((resolve) => setTimeout(resolve, 1))
    return { frames: inbox.splice(0) }
  })
  return invoker
}

const launchOptions = {
  pluginId: "demo",
  entryPath: "index.mjs",
  cwd: "/plugins/demo",
  scope: EMPTY_SCOPE,
}

describe("launchPluginJs", () => {
  it("launches a generation-bound resident process and stops it", async () => {
    const invoker = residentHost((frame, emit) => {
      if (frame.type === "activate")
        emit({ type: "activated", id: frame.id, hooks: {}, exports: {} })
      else if (frame.type === "invoke") emit({ type: "result", id: frame.id, value: frame.args })
      else if (frame.type === "deactivate") emit({ type: "result", id: frame.id })
    })
    const result = await launchPluginJs({
      ...launchOptions,
      hostInvoker: invoker as PluginJsHostInvoker,
    })
    expect(invoker).toHaveBeenNthCalledWith(1, "plugin_launch_js", {
      pluginId: "demo",
      pluginPath: "/plugins/demo",
      entry: "index.mjs",
      extraArgs: [],
    })
    await expect(result.process.isRunning()).resolves.toBe(true)
    await expect(result.invokeCallback("callback", ["value"])).resolves.toEqual(["value"])
    await result.deactivate()
    expect(invoker).toHaveBeenCalledWith(
      "plugin_deactivate_js",
      expect.objectContaining({ generation: "generation" })
    )
    expect(invoker).toHaveBeenCalledWith("plugin_stop_js", {
      pluginId: "demo",
      generation: "generation",
    })
    expect(result.process.killed).toBe(true)
    await expect(result.invokeCallback("callback", [])).rejects.toThrow("stopped")
  })

  it("B09 waits for pending activation host calls even after an early activated frame", async () => {
    let settle!: () => void
    const pending = new Promise<void>((resolve) => {
      settle = resolve
    })
    const set = jest.fn(() => pending)
    const invoker = residentHost((frame, emit) => {
      if (frame.type === "activate") {
        emit({
          type: "call",
          id: "write",
          requestId: frame.id,
          path: "storage.set",
          args: ["key", "value"],
        })
        emit({ type: "activated", id: frame.id, hooks: {}, exports: {} })
      }
    })
    let done = false
    const activation = launchPluginJs({
      ...launchOptions,
      context: { storage: { set } },
      hostInvoker: invoker as PluginJsHostInvoker,
    }).then((result) => {
      done = true
      return result
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(set).toHaveBeenCalledWith("key", "value")
    expect(done).toBe(false)
    settle()
    const result = await activation
    await result.process.kill()
  })

  it("B09 rejects activation and kills the child when a host call rejects", async () => {
    const invoker = residentHost((frame, emit) => {
      if (frame.type === "activate")
        emit({
          type: "call",
          id: "write",
          requestId: frame.id,
          path: "storage.set",
          args: ["key", "value"],
        })
    })
    await expect(
      launchPluginJs({
        ...launchOptions,
        hostInvoker: invoker as PluginJsHostInvoker,
        context: {
          storage: {
            set: async () => {
              throw new Error("write denied")
            },
          },
        },
      })
    ).rejects.toThrow("write denied")
    expect(invoker).toHaveBeenCalledWith(
      "plugin_stop_js",
      expect.objectContaining({ generation: "generation" })
    )
  })

  it("returns host call errors to a callback so it can recover", async () => {
    let invocationId: string | undefined
    const invoker = residentHost((frame, emit) => {
      if (frame.type === "activate")
        emit({ type: "activated", id: frame.id, hooks: {}, exports: {} })
      if (frame.type === "invoke") {
        invocationId = frame.id
        emit({
          type: "call",
          id: "read",
          requestId: frame.id,
          path: "storage.get",
          args: ["missing"],
        })
      }
      if (frame.type === "reply") {
        expect(frame.error).toBe("read denied")
        emit({ type: "result", id: invocationId, value: "fallback" })
      }
    })
    const result = await launchPluginJs({
      ...launchOptions,
      context: {
        storage: {
          get: async () => {
            throw new Error("read denied")
          },
        },
      },
      hostInvoker: invoker as PluginJsHostInvoker,
    })
    await expect(result.invokeCallback("read", [])).resolves.toBe("fallback")
    await result.process.kill()
  })

  it("B08 sends the real config and snapshots synchronous configuration reads", async () => {
    const config = { answer: 42 }
    const invoker = residentHost((frame, emit) => {
      if (frame.type === "activate") {
        expect(frame.snapshot).toMatchObject({ pluginId: "demo", config })
        emit({ type: "activated", id: frame.id, hooks: {}, exports: {} })
      }
    })
    const result = await launchPluginJs({
      ...launchOptions,
      context: { config },
      hostInvoker: invoker as PluginJsHostInvoker,
    })
    await result.process.kill()
  })

  it("B07 serves nested callback reads and writes and disposes registered host handles", async () => {
    const dispose = jest.fn()
    const storage = {
      get: jest.fn(async () => "host-value"),
      set: jest.fn(async () => {}),
    }
    const invoker = residentHost((frame, emit) => {
      if (frame.type === "activate")
        emit({
          type: "call",
          id: "registration",
          requestId: frame.id,
          path: "events.on",
          args: ["event", { $callback: "listener" }],
        })
      if (frame.type === "reply" && frame.id === "registration")
        emit({
          type: "activated",
          id: "request:1",
          hooks: { onCommand: { $callback: "listener" } },
          exports: {},
        })
      if (frame.type === "invoke")
        emit({
          type: "call",
          id: "read",
          requestId: frame.id,
          path: "storage.get",
          args: ["key"],
        })
      if (frame.type === "reply" && frame.id === "read")
        emit({ type: "result", id: "request:2", value: frame.value })
      if (frame.type === "deactivate")
        emit({
          type: "call",
          id: "write",
          requestId: frame.id,
          path: "storage.set",
          args: ["closed", true],
        })
      if (frame.type === "reply" && frame.id === "write") emit({ type: "result", id: "deactivate" })
    })
    const on = jest.fn((_event: string, _callback: (...args: unknown[]) => unknown) => dispose)
    const result = await launchPluginJs({
      ...launchOptions,
      context: { storage, events: { on } },
      hostInvoker: invoker as PluginJsHostInvoker,
    })
    expect(on.mock.calls[0][1]).toEqual(expect.any(Function))
    const hooks = result.activation.hooks as {
      onCommand: () => Promise<unknown>
    }
    await expect(hooks.onCommand()).resolves.toBe("host-value")
    await result.deactivate()
    expect(storage.set).toHaveBeenCalledWith("closed", true)
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it("disposes handles after activation rollback and refuses unsafe context paths", async () => {
    const dispose = jest.fn()
    const invoker = residentHost((frame, emit) => {
      if (frame.type === "activate")
        emit({
          type: "call",
          id: "register",
          requestId: frame.id,
          path: "events.on",
          args: [],
        })
      if (frame.type === "reply" && frame.id === "register")
        emit({
          type: "call",
          id: "unsafe",
          requestId: "request:1",
          path: "__proto__.pollute",
          args: [],
        })
    })
    await expect(
      launchPluginJs({
        ...launchOptions,
        context: { events: { on: () => ({ dispose }) } },
        hostInvoker: invoker as PluginJsHostInvoker,
      })
    ).rejects.toThrow("unsafe")
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it("keeps class handles in the generation table and snapshots their data", async () => {
    class Handle {
      label = "host-handle"
      disposed = false
      dispose() {
        this.disposed = true
      }
    }
    const handle = new Handle()
    const invoker = residentHost((frame, emit) => {
      if (frame.type === "activate") {
        emit({ type: "call", id: "handle", requestId: frame.id, path: "events.on", args: [] })
      }
      if (frame.type === "reply") {
        expect(frame.value).toMatchObject({
          $hostHandle: { id: "handle", path: [], properties: { label: "host-handle" } },
        })
        emit({ type: "activated", id: "request:1", hooks: {}, exports: {} })
      }
    })
    const result = await launchPluginJs({
      ...launchOptions,
      context: { events: { on: () => handle } },
      hostInvoker: invoker as PluginJsHostInvoker,
    })
    await result.process.kill()
    expect(handle.disposed).toBe(true)
  })

  it("restores host handles passed back to context after their registration settles", async () => {
    const dispose = jest.fn()
    const register = jest.fn()
    const invoker = residentHost((frame, emit) => {
      if (frame.type === "activate") {
        emit({ type: "call", id: "handle", requestId: frame.id, path: "events.on", args: [] })
        emit({
          type: "call",
          id: "register",
          requestId: frame.id,
          path: "lifecycle.register",
          args: [{ $hostHandle: { id: "handle", path: [] } }],
        })
        emit({ type: "activated", id: frame.id, hooks: {}, exports: {} })
      }
    })
    const result = await launchPluginJs({
      ...launchOptions,
      context: { events: { on: async () => dispose }, lifecycle: { register } },
      hostInvoker: invoker as PluginJsHostInvoker,
    })
    expect(register).toHaveBeenCalledWith(dispose)
    await result.process.kill()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it("retains failed disposers and allows a failed native stop to be retried", async () => {
    const dispose = jest
      .fn()
      .mockRejectedValueOnce(new Error("handle busy"))
      .mockResolvedValue(undefined)
    const invoker = residentHost((frame, emit) => {
      if (frame.type === "activate")
        emit({ type: "call", id: "handle", requestId: frame.id, path: "events.on", args: [] })
      if (frame.type === "reply")
        emit({ type: "activated", id: "request:1", hooks: {}, exports: {} })
    })
    const implementation = invoker.getMockImplementation()!
    let stops = 0
    invoker.mockImplementation(async (command, args) => {
      if (command === "plugin_stop_js" && ++stops === 1) throw new Error("stop busy")
      return implementation(command, args)
    })
    const result = await launchPluginJs({
      ...launchOptions,
      context: { events: { on: () => dispose } },
      hostInvoker: invoker as PluginJsHostInvoker,
    })
    const error = await result.process.kill().catch((failure) => failure)
    expect(error).toBeInstanceOf(AggregateError)
    expect(error.errors.map((failure: Error) => failure.message)).toEqual([
      "handle busy",
      "stop busy",
    ])
    expect(result.process.killed).toBe(false)
    await result.process.kill()
    expect(dispose).toHaveBeenCalledTimes(2)
    expect(stops).toBe(2)
    expect(result.process.killed).toBe(true)
  })

  it("times out one request without wedging later requests and bounds deactivate", async () => {
    const invoker = residentHost((frame, emit) => {
      if (frame.type === "activate")
        emit({ type: "activated", id: frame.id, hooks: {}, exports: {} })
      if (frame.type === "invoke" && frame.callbackId === "works")
        emit({ type: "result", id: frame.id, value: 42 })
    })
    const result = await launchPluginJs({
      ...launchOptions,
      hostInvoker: invoker as PluginJsHostInvoker,
      requestTimeoutMs: 20,
    })
    await expect(result.invokeCallback("hangs", [])).rejects.toThrow("timed out")
    await expect(result.invokeCallback("works", [])).resolves.toBe(42)
    await expect(result.deactivate()).rejects.toThrow("timed out")
    expect(result.process.killed).toBe(true)
  })

  it("preserves wire markers and cycles in both host directions", () => {
    const ref = Object.defineProperty(
      { $secretRef: "token" },
      Symbol.for("cognia.plugin.secretRef"),
      { value: true }
    )
    const value = {
      ref,
      plain: { $cogniaSecretRef: { $secretRef: "ordinary" } },
      spoof: { $callback: "fake" },
    }
    const revived = reviveNodePluginValue(
      encodeNodePluginValue(value, () => {
        throw new Error("unexpected function")
      }),
      jest.fn()
    ) as typeof value
    expect(
      Object.getOwnPropertyDescriptor(revived.ref, Symbol.for("cognia.plugin.secretRef"))?.value
    ).toBe(true)
    expect(revived.plain).toEqual(value.plain)
    expect(revived.spoof).toEqual(value.spoof)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => encodeNodePluginValue(cyclic, jest.fn())).toThrow("cycle")
  })

  it("rejects missing plugin ids and entry paths before spawning", async () => {
    const hostInvoker = jest.fn()

    await expect(
      launchPluginJs({
        pluginId: " ",
        entryPath: "index.mjs",
        cwd: "/plugins/demo",
        scope: EMPTY_SCOPE,
        hostInvoker,
      })
    ).rejects.toThrow(/pluginId is required/)

    await expect(
      launchPluginJs({
        pluginId: "demo.node",
        entryPath: " ",
        cwd: "/plugins/demo",
        scope: EMPTY_SCOPE,
        hostInvoker,
      })
    ).rejects.toThrow(/entryPath is required/)

    expect(hostInvoker).not.toHaveBeenCalled()
  })

  it("rejects a missing installed plugin root before spawning", async () => {
    const hostInvoker = jest.fn()

    await expect(
      launchPluginJs({
        pluginId: "demo.node",
        entryPath: "index.mjs",
        scope: EMPTY_SCOPE,
        hostInvoker,
      })
    ).rejects.toThrow(/cwd is required/)

    expect(hostInvoker).not.toHaveBeenCalled()
  })

  it("rejects wildcard argv values after building the full launch command", async () => {
    await expect(
      launchPluginJs({
        pluginId: "demo.node",
        entryPath: "index.mjs",
        cwd: "/plugins/demo",
        scope: EMPTY_SCOPE,
        extraArgs: ["*"],
        hostInvoker: jest.fn(),
      })
    ).rejects.toThrow(/wildcard grants are forbidden/)
  })
})
