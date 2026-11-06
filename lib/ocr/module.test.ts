import ocrModule from "./module"

describe("OCR module manifest", () => {
  it("declares a stable module whose real-world smoke is still owed", () => {
    expect(ocrModule).toMatchObject({ id: "ocr", kind: "module", stage: "stable" })
    expect(ocrModule.acceptance).toEqual({ realSmoke: "pending" })
  })

  it("provides the ocr port from its own implementation file", async () => {
    expect(ocrModule.provides?.map((provision) => provision.port)).toEqual(["ocr"])
    jest.doMock("./port", () => ({ port: { marker: true } }))
    const loaded = await ocrModule.provides![0].load()
    expect(loaded.port).toEqual({ marker: true })
  })

  it("installs its providers on every host under the name operators restart it by", () => {
    expect(ocrModule.runtimes).toEqual([
      {
        name: "ocr-runtime",
        criticality: "optional",
        boot: "knowledge-agents",
        adapters: {
          brain: { module: "./runtime-brain", hosts: ["brain"] },
          desktop: "./runtime-renderer",
          mobile: "./runtime-renderer",
        },
      },
    ])
  })

  it("owns the settings section and lists as public only what other modules open", () => {
    expect(ocrModule.owns).toEqual(["components/settings/ocr/"])
    expect(ocrModule.dependsOn).toEqual(["icons"])
    expect(ocrModule.api).toEqual([
      "components/settings/ocr/ocr-section-persisted.tsx",
      "hooks/use-ocr.ts",
    ])
  })

  it("claims its settings key for the OCR section", () => {
    expect(ocrModule.settings).toEqual({ keys: ["ocrSettings"] })
  })
})
