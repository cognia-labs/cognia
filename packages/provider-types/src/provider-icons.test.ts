import { existsSync } from "node:fs"
import { join } from "node:path"
import { brandIconAsset } from "@cognia/brand-assets"
import { getBuiltInProviderCatalog } from "./built-in-provider-catalog"
import {
  getAllProviderIds,
  getProviderBrandColor,
  getProviderDisplayName,
  getProviderIconInfo,
  getProviderIconPath,
  getProviderInitial,
  hasLocalProviderIcon,
} from "./provider-icons"

describe("Provider visual metadata", () => {
  it.each(getBuiltInProviderCatalog())("shares brand resources for $id", ({ id }) => {
    const asset = brandIconAsset(id)
    const info = getProviderIconInfo(id)
    expect(info.hasLocalIcon).toBe(asset !== null)
    expect(hasLocalProviderIcon(id)).toBe(asset !== null)
    expect(info.localIcon).toBe(asset?.src ?? "")
    if (asset) {
      expect(getProviderIconPath(id)).toBe(asset.src)
      expect(existsSync(join(process.cwd(), "public", asset.src))).toBe(true)
    }
  })

  it.each([
    ["xai", "xAI"],
    ["fireworks", "Fireworks.ai"],
    ["llamafile", "llamafile"],
    ["textgenwebui", "Text Gen WebUI"],
    ["zhipu", "Zhipu AI (智谱清言)"],
    ["replicate", "Replicate"],
  ])("preserves the existing app display name for %s", (id, name) => {
    expect(getProviderDisplayName(id)).toBe(name)
    expect(getProviderIconInfo(id).name).toBe(name)
    expect(getProviderInitial(id)).toBe(name.charAt(0).toUpperCase())
  })

  it("retains the registered metadata set and existing brand colors", () => {
    expect(getAllProviderIds()).toEqual([
      "openai",
      "anthropic",
      "google",
      "deepseek",
      "groq",
      "mistral",
      "xai",
      "togetherai",
      "openrouter",
      "opencode",
      "opencode-go",
      "cohere",
      "fireworks",
      "cerebras",
      "sambanova",
      "zhipu",
      "minimax",
      "ollama",
      "lmstudio",
      "vllm",
      "llamacpp",
      "llamafile",
      "localai",
      "jan",
      "textgenwebui",
      "koboldcpp",
      "tabbyapi",
      "cliproxyapi",
    ])
    expect(getProviderBrandColor("OpenAI")).toBe("#10a37f")
    expect(getProviderBrandColor("llamacpp")).toBe("#ff8236")
    expect(getProviderBrandColor("private-gateway")).toBe("#6b7280")
  })

  it("does not expose mutable provider metadata", () => {
    const info = getProviderIconInfo("openai")
    info.name = "changed"
    expect(getProviderDisplayName("openai")).toBe("OpenAI")
  })
})
