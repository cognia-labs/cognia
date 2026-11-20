import {
  THEMES,
  THEME_LIST,
  THEME_TOKEN_KEYS,
  exportThemeTokens,
  invalidThemeTokenKeys,
  isThemeColor,
} from "./syntax-themes"
import type { ThemeId, ThemeTokens } from "./syntax-themes"

describe("THEMES", () => {
  it("contains every documented theme id", () => {
    const expected: ThemeId[] = [
      "arknights",
      "cyberpunk",
      "terminal",
      "sakura",
      "catppuccin-mocha",
      "aurora",
      "genshin",
      "honkai",
      "light",
      "dark",
      "sepia",
      "github",
      "dracula",
      "nord",
      "solarized",
      "monokai",
    ]
    for (const id of expected) {
      expect(THEMES[id]).toBeDefined()
    }
  })

  it("each theme has every token slot", () => {
    const slots: (keyof ThemeTokens)[] = [
      "bg",
      "surface",
      "text",
      "muted",
      "border",
      "accent",
      "userBg",
      "assistantBg",
      "codeBg",
      "codeText",
      "detailBg",
    ]
    for (const id of Object.keys(THEMES) as ThemeId[]) {
      const tokens = THEMES[id]
      for (const slot of slots) {
        expect(typeof tokens[slot]).toBe("string")
        expect(tokens[slot]).toMatch(/^#?[0-9a-fA-F]{3,8}$/)
      }
    }
  })
})

describe("THEME_LIST", () => {
  it("matches the keys of THEMES", () => {
    const ids = THEME_LIST.map((t) => t.id)
    expect(new Set(ids)).toEqual(new Set(Object.keys(THEMES)))
  })

  it("each entry has a label", () => {
    for (const e of THEME_LIST) {
      expect(typeof e.label).toBe("string")
      expect(e.label.length).toBeGreaterThan(0)
    }
  })
})

const BREAKOUT = "red;}</style><script>window.__pwned=1</script><style>"

describe("isThemeColor", () => {
  it.each([
    "red",
    "transparent",
    "#fff",
    "#ffffff80",
    "rgb(1 2 3 / 50%)",
    "rgba(1,2,3,.5)",
    "hsl(200deg 50% 50%)",
    "oklch(0.5 0.1 200 / 0.4)",
    "color(display-p3 1 0 0)",
  ])("accepts %s", (value) => {
    expect(isThemeColor(value)).toBe(true)
  })

  it.each([
    BREAKOUT,
    "#fff;}",
    "#fff} body{background:url(https://example.com/x)",
    "var(--x)",
    "url(x)",
    "expression(alert(1))",
    "rgb(1,2,3)/**/",
    " #abc",
    "",
    "#" + "f".repeat(200),
  ])("refuses %j", (value) => {
    expect(isThemeColor(value)).toBe(false)
  })

  it("refuses anything that is not a string", () => {
    expect(isThemeColor(undefined)).toBe(false)
    expect(isThemeColor(0x123456)).toBe(false)
  })
})

describe("every built-in theme", () => {
  it.each(THEME_LIST.map((theme) => theme.id))("%s is made of CSS colors", (id) => {
    expect(invalidThemeTokenKeys(THEMES[id])).toEqual([])
  })
})

describe("exportThemeTokens", () => {
  it("is the built-in theme when there is no custom palette", () => {
    expect(exportThemeTokens("dracula")).toBe(THEMES.dracula)
  })

  it("keeps the custom colors and takes a refused token from the built-in theme (F15)", () => {
    const tokens = exportThemeTokens("light", {
      ...THEMES.dark,
      accent: BREAKOUT,
    } satisfies ThemeTokens)
    expect(tokens.bg).toBe(THEMES.dark.bg)
    expect(tokens.accent).toBe(THEMES.light.accent)
    expect(Object.keys(tokens).sort()).toEqual([...THEME_TOKEN_KEYS].sort())
  })

  it("fills tokens a persisted palette lacks", () => {
    const partial = { bg: "#010203" } as ThemeTokens
    expect(invalidThemeTokenKeys(partial)).toHaveLength(THEME_TOKEN_KEYS.length - 1)
    expect(exportThemeTokens("light", partial)).toEqual({ ...THEMES.light, bg: "#010203" })
  })
})
