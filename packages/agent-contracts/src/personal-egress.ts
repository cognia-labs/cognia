/** ADR-0243: opaque tools cannot be unlocked by approval or disclosure. */
export const PERSONAL_EGRESS_DENIAL =
  "This run holds a person's private content. Network-capable tools are off for the rest of the run; approval or disclosure cannot unlock them."

export type PersonalEgressToolOwner =
  | { kind: "native"; registeredTools: readonly string[] }
  | { kind: "host" }
  | { kind: "plugin"; pluginId: string; toolId: string }
  | { kind: "unknown" }

export function personalEgressToolDenied(
  name: string,
  fenced: boolean,
  hostReadTools: readonly string[] = [],
  owner: PersonalEgressToolOwner = { kind: "unknown" }
): boolean {
  if (!fenced) return false
  if (owner.kind === "plugin") return true
  if (
    owner.kind === "native" &&
    owner.registeredTools.includes(name) &&
    /^(?:WebSearch|Read|Glob|Grep|LS|TodoRead|TodoWrite)$/.test(name)
  )
    return false
  if (
    owner.kind === "host" &&
    (name === "web_search" || name === "mcp__cognia-plugin-tools__web_search")
  )
    return false
  // This list is supplied by Host declarations, never MCP/plugin annotations.
  return !hostReadTools.includes(name)
}
