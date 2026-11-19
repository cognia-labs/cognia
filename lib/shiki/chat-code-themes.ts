import type { BundledTheme, ThemeRegistration } from "shiki"
import oneLight from "shiki/themes/one-light.mjs"
import oneDark from "shiki/themes/one-dark-pro.mjs"
import githubLight from "shiki/themes/github-light-default.mjs"
import githubDark from "shiki/themes/github-dark-default.mjs"
import type { ChatCodeThemePair } from "@/lib/chat/code-theme"
import { defaultThemeColors } from "@/lib/appearance/theme-token-catalog"
import {
  adjustForegroundLightnessToTarget,
  isColorParsable,
  toHexApprox,
  wcagContrast,
} from "@/lib/appearance/contrast"

export type ChatCodeThemeInput = BundledTheme | ThemeRegistration

const MIN_CONTRAST = 4.5

function readableForeground(foreground: string | undefined, backgrounds: readonly string[]) {
  // TextMate's `inherit` must stay inheritance; an absent foreground lets a
  // more general scope supply its ink. Neither is a colour to correct.
  if (!foreground || !isColorParsable(foreground)) return foreground
  let ink = foreground
  for (const background of backgrounds) {
    if (wcagContrast(ink, background) >= MIN_CONTRAST) continue
    // Leave room for conversion into Shiki's clipped, 8-bit sRGB palette.
    const corrected = adjustForegroundLightnessToTarget(ink, background, MIN_CONTRAST + 0.25)
    // Shiki's TextMate theme compiler needs hex, not an oklch CSS expression.
    ink = (corrected && toHexApprox(corrected)) || ink
  }
  return ink
}

function readableTheme(original: ThemeRegistration, variant: "light" | "dark"): ThemeRegistration {
  const palette = defaultThemeColors(variant)
  const background = original.colors!["editor.background"]!
  // Neutral built-in code surfaces are washes of these tokens. AI Elements
  // also paints the Shiki background itself. Arbitrary custom host palettes
  // are outside this default-palette guarantee.
  const surfaces = [palette.background, palette.card, palette.muted, background]
  return {
    ...original,
    // Both engines cache by theme name. Reusing the bundled name can keep
    // previously-loaded raw colours, even after a corrected object is supplied.
    name: `cognia-${original.name}-aa-v1`,
    colors: {
      ...original.colors,
      "editor.foreground": readableForeground(original.colors!["editor.foreground"], surfaces)!,
    },
    tokenColors: original.tokenColors!.map((rule) => ({
      ...rule,
      scope: Array.isArray(rule.scope) ? [...rule.scope] : rule.scope,
      settings: {
        ...rule.settings,
        ...(rule.settings.foreground
          ? {
              foreground: readableForeground(
                rule.settings.foreground,
                rule.settings.background ? [rule.settings.background] : surfaces
              ),
            }
          : {}),
      },
    })),
  }
}

const readableThemes = new Map<string, ThemeRegistration>([
  ["one-light", readableTheme(oneLight, "light")],
  ["one-dark-pro", readableTheme(oneDark, "dark")],
  ["github-light-default", readableTheme(githubLight, "light")],
  ["github-dark-default", readableTheme(githubDark, "dark")],
])

/** Resolve logical IDs once, sharing the same registrations in every engine. */
export function chatCodeThemeInputs(
  theme: ChatCodeThemePair
): [ChatCodeThemeInput, ChatCodeThemeInput] {
  const resolve = (id: string): ChatCodeThemeInput => readableThemes.get(id) ?? (id as BundledTheme)
  return [resolve(theme.light), resolve(theme.dark)]
}
