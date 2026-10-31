/**
 * Extract JSON from a structured response: prefer the first fenced block,
 * otherwise parse the first balanced object or array in surrounding prose.
 * Malformed candidates throw; they are never silently skipped or repaired.
 */
export function extractJson<T>(text: string): T {
  const trimmed = text.trim()
  // Try fenced block first.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]+?)\s*```/i)
  if (fenced) {
    return JSON.parse(fenced[1]) as T
  }
  // Find the first balanced { … } or [ … ] span.
  const start = trimmed.search(/[{[]/)
  if (start === -1) {
    throw new Error(`extractJson: no JSON object or array found in response`)
  }
  // Walk forward respecting nested brackets so we don't trip on stray braces
  // inside string literals. Best-effort but plenty for distill output.
  const opener = trimmed[start]
  const closer = opener === "{" ? "}" : "]"
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (escape) {
      escape = false
      continue
    }
    if (ch === "\\") {
      escape = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === opener) depth += 1
    else if (ch === closer) {
      depth -= 1
      if (depth === 0) {
        return JSON.parse(trimmed.slice(start, i + 1)) as T
      }
    }
  }
  throw new Error("extractJson: unterminated JSON span in response")
}
