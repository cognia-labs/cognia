import { assertSafeExternalContent, ContentSafetyBlockedError } from "@cognia/content-safety"
import { assertModelSafeToolOutput } from "./pii/tool-output.ts"

/** Final model-visible tool boundary, after review/transforms. Privacy is unconditional. */
export function prepareModelToolOutput(output: unknown, injectionProtection = true): unknown {
  const safe = assertModelSafeToolOutput(output)
  assertSafeExternalContent(safe, injectionProtection)
  if (injectionProtection && safe && typeof safe === "object") {
    // Only MCP content blocks carry opaque media. Arbitrary JSON and
    // structuredContent are serialized model text, even if a record claims
    // an image MIME type; assess that actual projection as well.
    const record = safe as Record<string, unknown>
    const json = Array.isArray(record.content) ? record.structuredContent : safe
    if (json !== undefined) {
      let text: string | undefined
      try {
        text = JSON.stringify(json)
      } catch {
        throw new ContentSafetyBlockedError(["inspection_incomplete"])
      }
      assertSafeExternalContent(text)
    }
  }
  return safe
}
