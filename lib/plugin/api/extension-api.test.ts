/**
 * Tests for Extension Points Plugin API
 */

import React from "react"
import {
  createExtensionAPI,
  getExtensionsForPoint,
  getPluginExtensions,
  restorePluginExtensions,
  clearPluginExtensions,
  getPluginExtensionDiagnostics,
  clearAllExtensionDiagnostics,
} from "./extension-api"
import type { ExtensionPoint, ExtensionProps } from "@/types/plugin/plugin"
import {
  setContextKey,
  __resetContextKeysForTesting,
} from "@/lib/plugin/context-keys/context-key-store"

describe("Extension API", () => {
  const testPluginId = "test-plugin"

  beforeEach(() => {
    clearPluginExtensions(testPluginId)
    clearPluginExtensions("other-plugin")
    clearPluginExtensions("plugin-1")
    clearPluginExtensions("plugin-2")
    clearPluginExtensions("plugin-a")
    clearPluginExtensions("plugin-b")
    clearPluginExtensions("when-plugin")
    clearAllExtensionDiagnostics()
    __resetContextKeysForTesting()
  })

  describe("when-clause visibility", () => {
    const Cmp: React.ComponentType<ExtensionProps> = () => null

    it("hides an extension while its when-clause is unmet and shows it when met", () => {
      const api = createExtensionAPI("when-plugin")
      api.registerExtension("chat.header", Cmp, { when: "chat.active" })

      // Context key absent → clause false → hidden.
      expect(getExtensionsForPoint("chat.header")).toHaveLength(0)
      expect(api.hasExtensions("chat.header")).toBe(false)

      // Flip the key → clause true → visible.
      setContextKey("chat.active", true)
      expect(getExtensionsForPoint("chat.header")).toHaveLength(1)
      expect(api.hasExtensions("chat.header")).toBe(true)

      // Flip back → hidden again.
      setContextKey("chat.active", false)
      expect(getExtensionsForPoint("chat.header")).toHaveLength(0)
    })

    it("requires both condition() and when to pass", () => {
      const api = createExtensionAPI("when-plugin")
      setContextKey("chat.active", true)
      api.registerExtension("chat.header", Cmp, {
        when: "chat.active",
        condition: () => false,
      })
      expect(getExtensionsForPoint("chat.header")).toHaveLength(0)
    })

    it("treats an extension without a when-clause as always visible", () => {
      const api = createExtensionAPI("when-plugin")
      api.registerExtension("chat.header", Cmp)
      expect(getExtensionsForPoint("chat.header")).toHaveLength(1)
    })

    it("hides an extension whose when-clause is malformed (fail-closed)", () => {
      const api = createExtensionAPI("when-plugin")
      api.registerExtension("chat.header", Cmp, { when: "chat.active &&" })
      expect(getExtensionsForPoint("chat.header")).toHaveLength(0)
    })
  })

  describe("createExtensionAPI", () => {
    it("should create an API object with all expected methods", () => {
      const api = createExtensionAPI(testPluginId)

      expect(api).toBeDefined()
      expect(typeof api.registerExtension).toBe("function")
      expect(typeof api.getExtensions).toBe("function")
      expect(typeof api.hasExtensions).toBe("function")
    })
  })

  describe("registerExtension", () => {
    it("should register an extension at a canonical point", () => {
      const api = createExtensionAPI(testPluginId)
      const TestComponent: React.ComponentType<ExtensionProps> = () => null

      const unregister = api.registerExtension("sidebar.left.top", TestComponent)

      expect(typeof unregister).toBe("function")
      expect(api.hasExtensions("sidebar.left.top")).toBe(true)
    })

    it("should map legacy aliases to canonical points and emit diagnostics", () => {
      const api = createExtensionAPI(testPluginId)
      const TestComponent: React.ComponentType<ExtensionProps> = () => null

      api.registerExtension("sidebar:top" as ExtensionPoint, TestComponent)

      expect(api.hasExtensions("sidebar.left.top")).toBe(true)
      expect(getPluginExtensionDiagnostics(testPluginId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "plugin.point.alias",
            canonicalId: "sidebar.left.top",
          }),
        ])
      )
    })

    it("should reject unknown points", () => {
      const api = createExtensionAPI(testPluginId)
      const TestComponent: React.ComponentType<ExtensionProps> = () => null

      expect(() => api.registerExtension("unknown-point" as ExtensionPoint, TestComponent)).toThrow(
        /Extension registration blocked/
      )
      expect(getPluginExtensionDiagnostics(testPluginId)).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "plugin.point.unknown" })])
      )
    })

    it("should reject registration when permission is required in block mode", () => {
      const api = createExtensionAPI(testPluginId, {
        governanceMode: "block",
        hasPermission: () => false,
      })
      const TestComponent: React.ComponentType<ExtensionProps> = () => null

      expect(() => api.registerExtension("chat.header", TestComponent)).toThrow(
        /Extension registration blocked/
      )
      expect(getPluginExtensionDiagnostics(testPluginId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "plugin.point.permission_denied",
            severity: "error",
          }),
        ])
      )
    })

    it("should unregister extension when cleanup is called", () => {
      const api = createExtensionAPI(testPluginId)
      const TestComponent: React.ComponentType<ExtensionProps> = () => null

      const unregister = api.registerExtension("sidebar.left.top", TestComponent)
      expect(api.hasExtensions("sidebar.left.top")).toBe(true)

      unregister()
      expect(api.hasExtensions("sidebar.left.top")).toBe(false)
    })

    it("should register with priority option", () => {
      const api = createExtensionAPI(testPluginId)
      const HighPriority: React.ComponentType<ExtensionProps> = () => null
      const LowPriority: React.ComponentType<ExtensionProps> = () => null

      api.registerExtension("chat.input.actions", LowPriority, { priority: 1 })
      api.registerExtension("chat.input.actions", HighPriority, { priority: 10 })

      const extensions = api.getExtensions("chat.input.actions")
      expect(extensions.length).toBe(2)
      expect(extensions[0].options.priority).toBe(10)
    })

    it("should register with condition option", () => {
      const api = createExtensionAPI(testPluginId)
      const ConditionalComponent: React.ComponentType<ExtensionProps> = () => null
      let conditionResult = true

      api.registerExtension("toolbar.right", ConditionalComponent, {
        condition: () => conditionResult,
      })

      expect(api.hasExtensions("toolbar.right")).toBe(true)

      conditionResult = false
      expect(api.hasExtensions("toolbar.right")).toBe(false)
    })
  })

  describe("getExtensions", () => {
    it("should return empty array for point with no extensions", () => {
      const api = createExtensionAPI(testPluginId)
      expect(api.getExtensions("sidebar.left.bottom")).toEqual([])
    })

    it("should return all extensions for a point", () => {
      const api = createExtensionAPI(testPluginId)
      const Component1: React.ComponentType<ExtensionProps> = () => null
      const Component2: React.ComponentType<ExtensionProps> = () => null

      api.registerExtension("chat.message.actions", Component1)
      api.registerExtension("chat.message.actions", Component2)

      const extensions = api.getExtensions("chat.message.actions")
      expect(extensions.length).toBe(2)
    })

    it("should filter by condition", () => {
      const api = createExtensionAPI(testPluginId)
      const ShowComponent: React.ComponentType<ExtensionProps> = () => null
      const HideComponent: React.ComponentType<ExtensionProps> = () => null

      api.registerExtension("settings.plugins", ShowComponent, { condition: () => true })
      api.registerExtension("settings.plugins", HideComponent, { condition: () => false })

      const extensions = api.getExtensions("settings.plugins")
      expect(extensions.length).toBe(1)
    })

    it("should handle condition errors gracefully", () => {
      const api = createExtensionAPI(testPluginId)
      const ErrorComponent: React.ComponentType<ExtensionProps> = () => null

      api.registerExtension("chat.header", ErrorComponent, {
        condition: () => {
          throw new Error("Condition error")
        },
      })

      const extensions = api.getExtensions("chat.header")
      expect(extensions.length).toBe(0)
    })
  })

  describe("hasExtensions", () => {
    it("should return false for point with no extensions", () => {
      const api = createExtensionAPI(testPluginId)
      expect(api.hasExtensions("chat.message.footer")).toBe(false)
    })

    it("should return true for point with extensions", () => {
      const api = createExtensionAPI(testPluginId)
      const TestComponent: React.ComponentType<ExtensionProps> = () => null

      api.registerExtension("chat.message.footer", TestComponent)
      expect(api.hasExtensions("chat.message.footer")).toBe(true)
    })
  })

  describe("getExtensionsForPoint", () => {
    it("should return extensions from all plugins", () => {
      const api1 = createExtensionAPI("plugin-1")
      const api2 = createExtensionAPI("plugin-2")
      const Component1: React.ComponentType<ExtensionProps> = () => null
      const Component2: React.ComponentType<ExtensionProps> = () => null

      api1.registerExtension("chat.header", Component1)
      api2.registerExtension("chat.header", Component2)

      const extensions = getExtensionsForPoint("chat.header")
      expect(extensions.length).toBe(2)
    })
  })

  describe("clearPluginExtensions", () => {
    it("should clear all extensions for a specific plugin", () => {
      const api = createExtensionAPI(testPluginId)
      const TestComponent: React.ComponentType<ExtensionProps> = () => null

      api.registerExtension("toolbar.right", TestComponent)
      api.registerExtension("chat.header", TestComponent)

      expect(api.hasExtensions("toolbar.right")).toBe(true)
      expect(api.hasExtensions("chat.header")).toBe(true)

      clearPluginExtensions(testPluginId)

      expect(api.hasExtensions("toolbar.right")).toBe(false)
      expect(api.hasExtensions("chat.header")).toBe(false)
    })

    it("should not affect other plugins", () => {
      const api1 = createExtensionAPI("plugin-a")
      const api2 = createExtensionAPI("plugin-b")
      const TestComponent: React.ComponentType<ExtensionProps> = () => null

      api1.registerExtension("chat.header", TestComponent)
      api2.registerExtension("chat.header", TestComponent)

      clearPluginExtensions("plugin-a")

      const extensions = getExtensionsForPoint("chat.header")
      expect(extensions.length).toBe(1)
      expect(extensions[0].pluginId).toBe("plugin-b")
    })
  })

  describe("plugin extension snapshot helpers", () => {
    it("returns all extensions for a specific plugin", () => {
      const api = createExtensionAPI(testPluginId)
      const TestComponent: React.ComponentType<ExtensionProps> = () => null

      api.registerExtension("toolbar.right", TestComponent)
      api.registerExtension("chat.header", TestComponent)

      expect(getPluginExtensions(testPluginId)).toHaveLength(2)
    })

    it("restores extension registrations for rollback flows", () => {
      const api = createExtensionAPI(testPluginId)
      const TestComponent: React.ComponentType<ExtensionProps> = () => null

      api.registerExtension("chat.header", TestComponent)
      const snapshot = getPluginExtensions(testPluginId)

      clearPluginExtensions(testPluginId)
      expect(getExtensionsForPoint("chat.header")).toHaveLength(0)

      restorePluginExtensions(testPluginId, snapshot)
      expect(getExtensionsForPoint("chat.header")).toHaveLength(1)
      expect(getPluginExtensions(testPluginId)).toHaveLength(1)
    })
  })

  describe("width hints", () => {
    const Cmp: React.ComponentType<ExtensionProps> = () => null

    const optionsFor = (hints: { minWidth?: number; maxWidth?: number }) => {
      createExtensionAPI(testPluginId).registerExtension("chat.header", Cmp, hints)
      return getExtensionsForPoint("chat.header")[0].options
    }

    it("leaves both bounds unset when none are declared", () => {
      const options = optionsFor({})
      expect(options.minWidth).toBeUndefined()
      expect(options.maxWidth).toBeUndefined()
    })

    it("carries valid bounds onto the registration", () => {
      expect(optionsFor({ minWidth: 120, maxWidth: 320 })).toMatchObject({
        minWidth: 120,
        maxWidth: 320,
      })
    })

    it.each([
      ["zero", 0],
      ["negative", -40],
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
    ])("drops a %s bound rather than serialising it into a style", (_label, value) => {
      const options = optionsFor({ minWidth: value, maxWidth: value })
      expect(options.minWidth).toBeUndefined()
      expect(options.maxWidth).toBeUndefined()
    })

    it("drops a non-numeric bound coming from untyped plugin code", () => {
      const options = optionsFor({ minWidth: "200" as unknown as number })
      expect(options.minWidth).toBeUndefined()
    })

    it("collapses an inverted pair toward the ceiling so the smaller bound wins", () => {
      expect(optionsFor({ minWidth: 400, maxWidth: 100 })).toMatchObject({
        minWidth: 100,
        maxWidth: 100,
      })
    })

    it("keeps a floor whose paired ceiling was dropped as invalid", () => {
      const options = optionsFor({ minWidth: 200, maxWidth: -1 })
      expect(options.minWidth).toBe(200)
      expect(options.maxWidth).toBeUndefined()
    })
  })
})

it("R11 extension conditions refuse synchronously while their composite proof is cold", async () => {
  const { bindPluginCallbacks } = await import("@/lib/plugin/core/invocation-identity")
  const { configurePersonalDispatchFence } = await import("@/lib/execution/personal-operation")
  const restore = configurePersonalDispatchFence(() => undefined)
  const condition = jest.fn(() => true)
  try {
    createExtensionAPI("r11-extension").registerExtension("chat.header", () => null, { condition })
    const callback = bindPluginCallbacks("r11-extension", condition, () => ({
      executionRunId: "r11-cold",
    }))
    expect(callback()).toBe(false)
    expect(condition).not.toHaveBeenCalled()
  } finally {
    restore()
  }
})

it("R11 registered class renderer stays empty while cold and mounts after proof", async () => {
  const { bindPluginCallbacks } = await import("@/lib/plugin/core/invocation-identity")
  const { configurePersonalDispatchFence } = await import("@/lib/execution/personal-operation")
  const { renderToStaticMarkup } = await import("react-dom/server")
  let cold = true
  const restore = configurePersonalDispatchFence(() => (cold ? undefined : false))
  const constructed = jest.fn()
  const rendered = jest.fn()
  class Guest extends React.Component<ExtensionProps> {
    constructor(props: ExtensionProps) {
      super(props)
      constructed()
    }
    render() {
      rendered()
      return React.createElement("span", null, "R11 class content")
    }
  }
  const api = createExtensionAPI("r11-class")
  const component = bindPluginCallbacks("r11-class", Guest, () => ({ executionRunId: "r11-cold" }))
  const off = api.registerExtension("chat.header", component)
  try {
    const registered = api
      .getExtensions("chat.header")
      .find((row) => row.pluginId === "r11-class")!.component
    expect(renderToStaticMarkup(React.createElement(registered, {} as ExtensionProps))).toBe("")
    expect(constructed).not.toHaveBeenCalled()
    expect(rendered).not.toHaveBeenCalled()
    cold = false
    expect(renderToStaticMarkup(React.createElement(registered, {} as ExtensionProps))).toContain(
      "R11 class content"
    )
    expect(constructed).toHaveBeenCalledTimes(1)
    expect(rendered).toHaveBeenCalledTimes(1)
  } finally {
    off()
    restore()
  }
})

it("R11 function renderer preserves arrays containing class elements", async () => {
  const { bindPluginCallbacks } = await import("@/lib/plugin/core/invocation-identity")
  const { configurePersonalDispatchFence } = await import("@/lib/execution/personal-operation")
  const { renderToStaticMarkup } = await import("react-dom/server")
  const restore = configurePersonalDispatchFence(() => false)
  class Child extends React.Component {
    render() {
      return React.createElement("b", null, "array child")
    }
  }
  const component = bindPluginCallbacks("r11-array", () => [
    React.createElement(Child, { key: "child" }),
  ])
  const api = createExtensionAPI("r11-array")
  const off = api.registerExtension("chat.header", component)
  try {
    const registered = api
      .getExtensions("chat.header")
      .find((row) => row.pluginId === "r11-array")!.component
    expect(renderToStaticMarkup(React.createElement(registered, {} as ExtensionProps))).toContain(
      "array child"
    )
  } finally {
    off()
    restore()
  }
})
