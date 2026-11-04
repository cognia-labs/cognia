export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const
export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

/**
 * Pick the closest supported thinking level.
 *
 * Pi accepts an unsupported level, answers `success: true`, and silently
 * clamps to `off` — verified against 0.84.1. Sending an unvalidated level
 * therefore turns "think hard" into "don't think" with no error anywhere, so
 * the clamp has to happen here.
 */
export function clampThinkingLevel(
  requested: string,
  available: readonly string[]
): string | undefined {
  if (available.length === 0) return undefined
  if (available.includes(requested)) return requested

  const wanted = THINKING_LEVELS.indexOf(requested as ThinkingLevel)
  if (wanted < 0) return undefined

  // Step down to the nearest supported level rather than up: silently
  // spending more reasoning budget than asked for is worse than less.
  const ordered = THINKING_LEVELS.filter((level) => available.includes(level))
  if (ordered.length === 0) return undefined
  let best = ordered[0]
  for (const level of ordered) {
    if (THINKING_LEVELS.indexOf(level) <= wanted) best = level
  }
  return best
}
