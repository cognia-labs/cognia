/**
 * Subsystem keys for repo paths (ADR-0250 §14).
 *
 * A subsystem is one feature split across layers: `lib/chat`, `components/chat`,
 * `hooks/chat`, `stores/chat` and `app/chat` all map to `chat`. The module
 * gate (`check-modules.mjs`) owns files by these keys, and the dependency
 * analysis (`convergence/subsystem-deps.mjs`) groups its counts by them, so the
 * two must agree on every path. Both build their classifier here.
 */

import { basename, extname } from "node:path"

/** The layered application roots; every other root is a package, plugin or project. */
export const LAYERED_ROOTS = ["app", "components", "hooks", "lib", "stores", "types"]
const LAYERED = new Set(LAYERED_ROOTS)

/**
 * Plural/singular directory pairs that are one subsystem split across layers
 * (`lib/plugin` + `components/plugins`).
 */
export const ALIASES = new Map([
  ["plugins", "plugin"],
  ["workflows", "workflow"],
  ["agents", "agent"],
  ["accounts", "account"],
  ["goals", "goal"],
  ["bots", "bot"],
  ["artifacts", "artifact"],
  ["agent-teams", "agent-team"],
  ["projects", "project"],
  ["themes", "theme"],
  ["files", "file"],
  ["devices", "device"],
])

function alias(key, layer) {
  // components/providers holds the React initializers, so it gets its own name
  // instead of merging with lib/provider.
  if (layer === "components" && key === "providers") return "initializers"
  // components/settings is the settings UI hub; the store under it is shared state.
  if (key === "settings" && layer !== "components" && layer !== "app") return "settings-store"
  return ALIASES.get(key) ?? key
}

function segmentOf(top, segment) {
  // Route groups such as `app/(mobile-onboard)` name the subsystem inside the parens.
  return top === "app" ? segment.replace(/^\((.*)\)$/, "$1") : segment
}

/**
 * Build a classifier over the given repo-relative file list. The list decides
 * which subsystem names exist, so a file directly under a layer root
 * (`lib/pet-window.ts`) can attach to a subsystem that has a directory
 * somewhere (`lib/pet/`).
 *
 * `classify(path)` returns `{ key, layer }`, or `null` for a path outside the
 * classified roots. Packages are `pkg:<dir>`, plugins `plugin:<dir>`, the CLI
 * `cli`, and a root-level file with no matching subsystem `<layer>-root`.
 */
export function createSubsystemClassifier(files) {
  const knownKeys = new Set()
  for (const file of files) {
    const parts = file.split("/")
    if (LAYERED.has(parts[0]) && parts.length > 2) knownKeys.add(segmentOf(parts[0], parts[1]))
  }

  function classify(path) {
    const parts = path.split("/")
    const top = parts[0]
    if (top === "packages" && parts[1]) return { key: `pkg:${parts[1]}`, layer: "packages" }
    if (top === "plugins" && parts[1]) return { key: `plugin:${parts[1]}`, layer: "plugins" }
    if (top === "cli") return { key: "cli", layer: "cli" }
    if (!LAYERED.has(top)) return null
    if (parts.length < 2 || !parts[1]) return { key: `${top}-root`, layer: top }
    if (parts.length === 2) {
      const stem = basename(parts[1], extname(parts[1]))
        .replace(/^use-/, "")
        .replace(/-store$/, "")
      if (knownKeys.has(stem)) return { key: alias(stem, top), layer: top }
      return { key: `${top}-root`, layer: top }
    }
    return { key: alias(segmentOf(top, parts[1]), top), layer: top }
  }

  return { classify, knownKeys }
}
