import { getProviderDisplayName, getProviderIconInfo } from "./icons"
import * as app from "./icons"
import * as core from "@cognia/provider-core/providers/provider-icons"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { getBuiltInProviderCatalog } from "@cognia/provider-types/built-in-provider-catalog"

describe("getProviderDisplayName", () => {
  it("names a provider from its icon entry", () => {
    expect(getProviderDisplayName("google")).toBe("Google AI")
    expect(getProviderDisplayName("OpenAI")).toBe("OpenAI")
  })

  // The video providers have no icon entry; a raw id in a picker reads as a bug.
  it("falls back to the built-in provider catalog's name", () => {
    expect(getProviderDisplayName("replicate")).toBe("Replicate")
    expect(getProviderDisplayName("fal")).toBe("Fal AI")
    expect(getProviderDisplayName("volcengine")).toBe("Volcengine Doubao")
    expect(getProviderIconInfo("qwen").hasLocalIcon).toBe(true)
  })

  it("keeps the id of a provider it does not know", () => {
    expect(getProviderDisplayName("my-gateway")).toBe("my-gateway")
  })
})

describe.each([
  ["app", app],
  ["provider-core", core],
] as const)("%s shared provider icon contract", (_name, api) => {
  it.each([
    ["openai", "/icons/lobe/openai.svg"],
    ["OpenAI", "/icons/lobe/openai.svg"],
    ["qwen", "/icons/lobe/qwen-color.svg"],
    ["opencode-go", "/icons/lobe/opencode.svg"],
    ["zhipu", "/icons/lobe/zhipu-color.svg"],
    ["lm-studio", "/icons/lobe/lmstudio.svg"],
  ])("uses a real shared local resource for %s", (id, src) => {
    expect(api.getProviderIconInfo(id)).toMatchObject({ localIcon: src, hasLocalIcon: true })
    expect(api.getProviderIconPath(id)).toBe(src)
    expect(existsSync(join(process.cwd(), "public", src))).toBe(true)
  })

  it.each([
    "llamacpp",
    "llamafile",
    "localai",
    "jan",
    "textgenwebui",
    "koboldcpp",
    "tabbyapi",
    "cliproxyapi",
  ])("does not claim a nonexistent local resource for %s", (id) => {
    expect(api.getProviderIconInfo(id)).toMatchObject({ localIcon: "", hasLocalIcon: false })
    expect(api.getProviderIconPath(id)).toBe(`https://models.dev/logos/${id}.svg`)
  })

  it.each(["AcmeAI", "constructor", "__proto__", "toString"])(
    "returns complete metadata for an unknown ID %s",
    (id) => {
      expect(api.getProviderIconInfo(id)).toEqual({
        name: id,
        localIcon: "",
        brandColor: "#6b7280",
        hasLocalIcon: false,
      })
      expect(api.getProviderIconPath(id)).toBe(`https://models.dev/logos/${id.toLowerCase()}.svg`)
    }
  )

  it.each(getBuiltInProviderCatalog())("preserves the app display name for $id", ({ id, name }) => {
    const shortNames: Record<string, string> = {
      xai: "xAI",
      fireworks: "Fireworks.ai",
      llamafile: "llamafile",
      textgenwebui: "Text Gen WebUI",
    }
    expect(api.getProviderIconInfo(id).name).toBe(shortNames[id] ?? name)
    const info = api.getProviderIconInfo(id)
    if (info.hasLocalIcon)
      expect(existsSync(join(process.cwd(), "public", info.localIcon))).toBe(true)
  })
})

describe("app compatibility helpers", () => {
  it("preserves the existing helper exports and model display behavior", () => {
    expect(app.getProviderBrandColor("OpenAI")).toBe("#10a37f")
    expect(app.getProviderInitial("google")).toBe("G")
    expect(app.hasLocalProviderIcon("qwen")).toBe(true)
    expect(app.getAllProviderIds()).toHaveLength(28)
    expect(app.getModelDisplayName("gpt-4o")).toBe("GPT-4o")
    expect(app.getModelDisplayName("private-model")).toBe("private-model")
    expect(app.resolveProviderFromModel("claude-example")).toBe("anthropic")
    expect(app.resolveProviderFromModel("private-model")).toBeNull()
  })
})
