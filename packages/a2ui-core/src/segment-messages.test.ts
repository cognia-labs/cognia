import { segmentToMessages } from "./segment-messages"

describe("segmentToMessages", () => {
  it("converts the component map to an array and emits create→ready with merge:false", () => {
    const messages = segmentToMessages("canvas", {
      components: { root: { id: "root" }, c1: { id: "c1" } },
      dataModel: { a: 1 },
      rootId: "root",
      surfaceType: "panel",
      title: "T",
    })
    expect(messages).toHaveLength(4)
    expect(messages[0]).toMatchObject({
      type: "createSurface",
      surfaceId: "canvas",
      surfaceType: "panel",
    })
    expect(messages[1]).toEqual({
      type: "updateComponents",
      surfaceId: "canvas",
      components: [{ id: "root" }, { id: "c1" }],
    })
    expect(messages[2]).toEqual({
      type: "dataModelUpdate",
      surfaceId: "canvas",
      data: { a: 1 },
      merge: false,
    })
    expect(messages[3]).toEqual({ type: "surfaceReady", surfaceId: "canvas" })
    expect(messages[0]).not.toHaveProperty("computed")
  })

  it("carries a valid computed map onto createSurface and drops an invalid one", () => {
    const base = { components: { root: { id: "root" } }, dataModel: {}, rootId: "root" }
    const total = { op: "add", args: [{ path: "/a" }, 1] }
    expect(
      segmentToMessages("canvas", { ...base, computed: { "/total": total } })[0]
    ).toMatchObject({ computed: { "/total": total } })
    expect(
      segmentToMessages("canvas", { ...base, computed: { "/total": { op: "eval" } } })[0]
    ).not.toHaveProperty("computed")
  })
})
