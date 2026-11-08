import * as core from "./index"

describe("@cognia/a2ui-core entry", () => {
  it("exposes each file's surface", () => {
    for (const name of [
      "getValueByPath",
      "applyA2UIComputedFields",
      "getComponentChildReferences",
      "parseA2UIInput",
      "extractA2UIBlocks",
      "isA2UIPreviewSurfaceId",
      "namespacedA2UIToolNames",
      "sanitizeOutboundSegments",
      "sanitizeScheduledOutboundPayload",
    ])
      expect(typeof (core as Record<string, unknown>)[name]).toBe("function")
  })
})
