/** Shared by portable plugin builds and the Host artifact-runtime builder. */
import { createHash } from "node:crypto"

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

export function hashSources(paths, readSource) {
  return Object.fromEntries(
    [...paths].sort().map((relative) => {
      const bytes = readSource(relative)
      return [relative, bytes ? sha256(bytes) : null]
    })
  )
}
