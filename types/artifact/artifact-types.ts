import type { ArtifactType } from "@/types"

/**
 * Every artifact type, in display order: the one list the artifact module and
 * the workflow editor's artifact forms both offer. It lives with the types so
 * a module that only needs the vocabulary does not import the artifact module.
 */
export const ARTIFACT_TYPES: ArtifactType[] = [
  "code",
  "document",
  "svg",
  "html",
  "react",
  "mermaid",
  "chart",
  "math",
  "jupyter",
]
