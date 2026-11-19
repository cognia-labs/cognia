import oneLight from "shiki/themes/one-light.mjs"
import oneDark from "shiki/themes/one-dark-pro.mjs"
import githubLight from "shiki/themes/github-light-default.mjs"
import githubDark from "shiki/themes/github-dark-default.mjs"
import type { ThemeRegistration } from "shiki"
import { defaultThemeColors } from "@/lib/appearance/theme-token-catalog"
import { isColorParsable, wcagContrast } from "@/lib/appearance/contrast"
import { CHAT_CODE_THEME } from "@/lib/chat/code-theme"
import { chatCodeThemeInputs } from "./chat-code-themes"

describe("chatCodeThemeInputs", () => {
  describe.each([
    { family: "one", pair: CHAT_CODE_THEME },
    { family: "github", pair: { light: "github-light-default", dark: "github-dark-default" } },
  ])("$family", ({ pair }) => {
    it.each(["light", "dark"] as const)(
      "keeps every %s foreground readable on built-in code surfaces",
      (variant) => {
        const input = chatCodeThemeInputs(pair)[variant === "light" ? 0 : 1] as ThemeRegistration
        const palette = defaultThemeColors(variant)
        const backgrounds = [
          palette.background,
          palette.card,
          palette.muted,
          input.colors!["editor.background"]!,
        ]
        for (const rule of input.tokenColors ?? []) {
          const fg = rule.settings.foreground
          if (!fg || !isColorParsable(fg)) continue
          const surfaces = rule.settings.background ? [rule.settings.background] : backgrounds
          for (const bg of surfaces) {
            expect(wcagContrast(fg, bg)).toBeGreaterThanOrEqual(4.5)
          }
        }
        for (const bg of backgrounds)
          expect(wcagContrast(input.colors!["editor.foreground"]!, bg)).toBeGreaterThanOrEqual(4.5)
      }
    )
  })

  it("uses unique stable registration names without changing logical setting IDs", () => {
    const first = chatCodeThemeInputs(CHAT_CODE_THEME) as [ThemeRegistration, ThemeRegistration]
    const second = chatCodeThemeInputs(CHAT_CODE_THEME)
    expect(first[0].name).not.toBe(oneLight.name)
    expect(first[1].name).not.toBe(oneDark.name)
    expect(second[0]).toBe(first[0])
    expect(second[1]).toBe(first[1])
    expect(CHAT_CODE_THEME).toEqual({ light: "one-light", dark: "one-dark-pro" })
  })

  it("preserves rule scopes, font styles, token backgrounds, inheritance and original registrations", () => {
    const before = JSON.stringify([oneLight, oneDark, githubLight, githubDark])
    const corrected = [
      ...chatCodeThemeInputs(CHAT_CODE_THEME),
      ...chatCodeThemeInputs({ light: "github-light-default", dark: "github-dark-default" }),
    ] as ThemeRegistration[]
    for (const [index, original] of [oneLight, oneDark, githubLight, githubDark].entries()) {
      expect(corrected[index]).not.toBe(original)
      expect(corrected[index]!.name).not.toBe(original.name)
      expect(corrected[index]!.tokenColors).toHaveLength(original.tokenColors!.length)
      for (const [ruleIndex, rule] of original.tokenColors!.entries()) {
        const fixed = corrected[index]!.tokenColors![ruleIndex]!
        expect(fixed.scope).toEqual(rule.scope)
        expect(fixed.settings.fontStyle).toBe(rule.settings.fontStyle)
        expect(fixed.settings.background).toBe(rule.settings.background)
        if (rule.settings.foreground === "inherit")
          expect(fixed.settings.foreground).toBe("inherit")
      }
    }
    expect(JSON.stringify([oneLight, oneDark, githubLight, githubDark])).toBe(before)
  })

  it("passes other selected themes through without recolouring them", () => {
    expect(chatCodeThemeInputs({ light: "light-plus", dark: "dark-plus" })).toEqual([
      "light-plus",
      "dark-plus",
    ])
  })
})
