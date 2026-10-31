import { getProviderIconInfo, getProviderIconPath } from "./provider-icons"

describe("provider icon resolution", () => {
  it("prefers bundled local icons for known providers", () => {
    expect(getProviderIconPath("openai")).toBe("/icons/lobe/openai.svg")
    expect(getProviderIconPath("Ollama")).toBe("/icons/lobe/ollama.svg")
  })

  it("uses the shared local brand even when the legacy registry had no icon", () => {
    expect(getProviderIconPath("opencode")).toBe("/icons/lobe/opencode.svg")
  })

  it("generates a stable fallback for unknown providers", () => {
    expect(getProviderIconInfo("AcmeAI")).toEqual({
      name: "AcmeAI",
      localIcon: "",
      brandColor: "#6b7280",
      hasLocalIcon: false,
    })
    expect(getProviderIconPath("AcmeAI")).toBe("https://models.dev/logos/acmeai.svg")
  })
})
