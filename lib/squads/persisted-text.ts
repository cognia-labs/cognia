/**
 * The one gate Squad text passes before it is written to disk: a steering
 * message, a parked delegation's prompt, a teammate's shared note. Personal
 * data is replaced with placeholders (`@cognia/redact`), and text that still
 * leaks after that is not kept at all.
 */

import { hasNoLeakingPii, redactText } from "@cognia/redact"

/** Redacted text, or `undefined` when it still leaks after redaction. */
export function redactTeamTextForPersistence(text: string): string | undefined {
  const redacted = redactText(text).redacted
  return hasNoLeakingPii(redacted) ? redacted : undefined
}
