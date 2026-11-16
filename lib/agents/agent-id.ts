/**
 * Agent-name slugs shared by the subagent importers (their `sourceKey`) and
 * the chat mention targets (an agent's `@handle`). One pure function, so the
 * runtime mention path does not depend on the migration importers.
 */

/** "Code Reviewer" → "code-reviewer"; an empty or symbol-only name → "subagent". */
export function slugify(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "subagent"
  )
}
