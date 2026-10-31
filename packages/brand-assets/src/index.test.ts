import { existsSync } from "node:fs"
import { join } from "node:path"
import { brandIconAsset, hasBrandIcon } from "./index"

describe("brand assets", () => {
  it.each<[string, string, boolean]>([
    ["openai", "/icons/lobe/openai.svg", true],
    [" Claude_Code ", "/icons/lobe/claudecode-color.svg", false],
    ["together-ai", "/icons/lobe/together-color.svg", false],
    ["lm-studio", "/icons/lobe/lmstudio.svg", true],
    ["opencode-go", "/icons/lobe/opencode.svg", true],
    ["qwen", "/icons/lobe/qwen-color.svg", false],
    ["feishu-web", "/icons/brands/feishu-color.svg", false],
    ["lark", "/icons/brands/feishu-color.svg", false],
    ["google-vision", "/icons/lobe/googlecloud-color.svg", false],
    ["searchapi", "/icons/lobe/searchapi.svg", true],
    ["pi-rpc", "/icons/lobe/pi.svg", true],
    ["minimax-code", "/icons/lobe/minimax-color.svg", false],
  ])("resolves the supported cross-domain brand %s", (id, src, mono) => {
    expect(brandIconAsset(id)).toEqual({ src, mono })
    expect(hasBrandIcon(id)).toBe(true)
    expect(existsSync(join(process.cwd(), "public", src))).toBe(true)
  })

  it.each(["private-gateway", "constructor", "__proto__", "toString", "", "---"])(
    "returns an explicit miss for %j",
    (id) => {
      expect(brandIconAsset(id)).toBeNull()
      expect(hasBrandIcon(id)).toBe(false)
    }
  )

  it("does not expose mutable registry entries", () => {
    const result = brandIconAsset("openai")!
    result.src = "changed"
    expect(brandIconAsset("openai")?.src).toBe("/icons/lobe/openai.svg")
  })
})
