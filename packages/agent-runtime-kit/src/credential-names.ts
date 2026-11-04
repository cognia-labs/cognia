/** Substrings that mark an env var / header / query param as a credential. */
const SECRET_MARKERS = [
  "key",
  "token",
  "secret",
  "password",
  "passwd",
  "credential",
  "auth",
  "session",
  "cookie",
  "signature",
  "private",
  "dsn",
  "webhook",
]

/** True when the name suggests the value is a credential. */
export function looksSecret(name: string): boolean {
  const lower = name.toLowerCase()
  return SECRET_MARKERS.some((marker) => lower.includes(marker))
}
