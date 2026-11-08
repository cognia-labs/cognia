const store = {
  createSurface: jest.fn(),
  deleteSurface: jest.fn(),
  processMessage: jest.fn(),
  getSurface: jest.fn((id: string) => ({ id })),
}

jest.mock("@/stores/a2ui", () => ({ useA2UIStore: { getState: () => store } }))

import type { A2UITemplateDef, PluginA2UIComponent } from "@/types/plugin"
import { createA2UIAPI } from "./a2ui-api"
import type { PluginA2UIBridge } from "./plugin-bridge"

const bridge = { registerComponent: jest.fn(), registerTemplate: jest.fn() }
const getBridge = jest.fn(() => bridge as unknown as PluginA2UIBridge)

beforeEach(() => jest.clearAllMocks())

describe("ctx.a2ui", () => {
  it("drives surfaces through the A2UI store", () => {
    const api = createA2UIAPI("p1", getBridge)
    api.createSurface("s1", "panel", { title: "T" })
    api.updateComponents("s1", [{ id: "root", component: "Text" } as never])
    api.updateDataModel("s1", { a: 1 })
    api.updateDataModel("s1", { b: 2 }, false)
    api.setReady("s1")
    api.deleteSurface("s1")
    expect(store.createSurface).toHaveBeenCalledWith("s1", "panel", { title: "T" })
    expect(store.processMessage.mock.calls.map(([message]) => message)).toEqual([
      {
        type: "updateComponents",
        surfaceId: "s1",
        components: [{ id: "root", component: "Text" }],
      },
      { type: "dataModelUpdate", surfaceId: "s1", data: { a: 1 }, merge: true },
      { type: "dataModelUpdate", surfaceId: "s1", data: { b: 2 }, merge: false },
      { type: "surfaceReady", surfaceId: "s1" },
    ])
    expect(store.deleteSurface).toHaveBeenCalledWith("s1")
    expect(api.getSurface("s1")).toEqual({ id: "s1" })
  })

  it("registers components and templates under the plugin, reaching the bridge only then", () => {
    const api = createA2UIAPI("p1", getBridge)
    expect(getBridge).not.toHaveBeenCalled()
    const component = { type: "chart" } as unknown as PluginA2UIComponent
    const template = { id: "t1" } as unknown as A2UITemplateDef
    api.registerComponent(component)
    api.registerTemplate(template)
    expect(bridge.registerComponent).toHaveBeenCalledWith("p1", component)
    expect(bridge.registerTemplate).toHaveBeenCalledWith("p1", template)
  })
})
