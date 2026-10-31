import {
  isCredentialKey,
  isHostCredentialSnapshot,
  isPluginCredentialRef,
  type PluginNetworkEgressOutput,
} from "./plugin-pii-gate"

/**
 * Resolve only after the caller's PII and destination checks. Kept separate
 * from the pure gate so the same final boundary serves every network transport.
 */
export async function resolveNetworkCredentials(
  input: PluginNetworkEgressOutput,
  readSecret: (key: string) => Promise<string | null>
) {
  const secrets = new Set<string>()
  const resolveValue = async (value: unknown, key?: string): Promise<unknown> => {
    if (isPluginCredentialRef(value)) {
      if (!isHostCredentialSnapshot(value)) {
        throw new Error("Network credential reference must be a host-created snapshot")
      }
      if (!key || !isCredentialKey(key)) {
        throw new Error("Network credential reference is only valid in a credential field")
      }
      const { $secretRef, prefix = "" } = value
      let secret: string | null
      try {
        secret = await readSecret($secretRef)
      } catch {
        // Store/gateway errors may include private material; never forward them.
        throw new Error(
          "Network credential reference could not be read from this plugin's secret store"
        )
      }
      if (typeof secret !== "string" || !secret.length) {
        throw new Error(
          "Network credential reference secret not found in this plugin's secret store"
        )
      }
      // Short matches corrupt ordinary text and arbitrary binary payloads.
      if (secret.length >= 8) {
        secrets.add(secret)
        secrets.add(prefix + secret)
      }
      return prefix + secret
    }
    if (Array.isArray(value)) return Promise.all(value.map((entry) => resolveValue(entry)))
    if (value && typeof value === "object") {
      return Object.fromEntries(
        await Promise.all(
          Object.entries(value).map(async ([name, entry]) => [
            name,
            await resolveValue(entry, name),
          ])
        )
      )
    }
    return value
  }
  const resolveFields = async (fields: PluginNetworkEgressOutput["headers"]) =>
    fields
      ? (Object.fromEntries(
          await Promise.all(
            Object.entries(fields).map(async ([key, value]) => [
              key,
              (await resolveValue(value, key)) as string,
            ])
          )
        ) as Record<string, string>)
      : undefined

  const headers = await resolveFields(input.headers)
  const query = await resolveFields(input.query)
  let url = input.url
  if (query && Object.keys(query).length) {
    const parsed = new URL(url)
    for (const [key, value] of Object.entries(query)) parsed.searchParams.append(key, value)
    url = parsed.toString()
  }
  let body = input.body
  // JSON cannot carry the brand. String bodies have already been inspected
  // by the gate and must never be interpreted as credential references.
  if (body !== undefined && typeof body !== "string") {
    body = await resolveValue(body)
  }

  // A server may echo a credential in response headers, data or an error URL.
  // Match the transport encodings too; the native gateway returns JSON as text.
  const hidden = [
    ...new Set(
      [...secrets].flatMap((secret) => {
        const json = JSON.stringify(secret).slice(1, -1)
        const base64 = btoa(
          Array.from(new TextEncoder().encode(secret), (byte) => String.fromCharCode(byte)).join("")
        )
        return [
          secret,
          json,
          json.replaceAll("/", "\\/"),
          secret
            .split("")
            .map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)
            .join(""),
          encodeURIComponent(secret),
          encodeURI(secret),
          new URLSearchParams({ v: secret }).toString().slice(2),
          base64,
          base64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""),
        ]
      })
    ),
  ].sort((a, b) => b.length - a.length)
  const createPattern = (values: string[]) =>
    new RegExp(
      values
        .map((secret) =>
          secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(
            /%([0-9a-f]{2})/gi,
            (_match, hex: string) =>
              `%${hex
                .split("")
                .map((char) =>
                  /[a-f]/i.test(char) ? `[${char.toUpperCase()}${char.toLowerCase()}]` : char
                )
                .join("")}`
          )
        )
        .join("|"),
      "g"
    )
  const pattern = createPattern(hidden)
  const binaryNeedles = hidden.map((secret) => new TextEncoder().encode(secret))
  const hideJson = (value: unknown): unknown => {
    if (typeof value === "string") return hideText(value)
    if (Array.isArray(value)) return value.map(hideJson)
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [hideText(key), hideJson(entry)])
      )
    }
    return value
  }
  const hideText = (text: string): string => {
    let parsed: unknown
    if (/^\s*[{[\"]/.test(text)) {
      try {
        parsed = JSON.parse(text)
      } catch {
        /* Non-JSON response text. */
      }
    }
    if (typeof parsed === "string" || (parsed !== null && typeof parsed === "object")) {
      const cleaned = JSON.stringify(hideJson(parsed))
      if (cleaned !== JSON.stringify(parsed)) return cleaned
    }
    return text.replace(pattern, "[REDACTED]")
  }
  const hideBytes = (bytes: Uint8Array): Uint8Array => {
    const first = bytes.find((byte) => ![9, 10, 11, 12, 13, 32].includes(byte))
    if (first === 123 || first === 91 || first === 34) {
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
        const cleaned = hideText(text)
        if (cleaned !== text) return new TextEncoder().encode(cleaned)
      } catch {
        // Invalid UTF-8 is scanned as bytes below, without converting the body
        // to a per-byte string or corrupting unrelated binary content.
      }
    }
    const matches: Array<{ start: number; end: number }> = []
    for (const needle of binaryNeedles) {
      for (
        let start = bytes.indexOf(needle[0]);
        start !== -1;
        start = bytes.indexOf(needle[0], start + 1)
      ) {
        if (start + needle.length > bytes.length) break
        let matched = true
        for (let offset = 1; offset < needle.length; offset++) {
          const actual = bytes[start + offset]
          const expected = needle[offset]
          // Percent-encoded hex digits are case insensitive, just as in text.
          const hex = needle[offset - 1] === 37 || (offset > 1 && needle[offset - 2] === 37)
          if (
            actual !== expected &&
            !(
              hex &&
              (actual | 32) === (expected | 32) &&
              (expected | 32) >= 97 &&
              (expected | 32) <= 102
            )
          ) {
            matched = false
            break
          }
        }
        if (matched) matches.push({ start, end: start + needle.length })
      }
    }
    if (!matches.length) return bytes
    matches.sort((a, b) => a.start - b.start || b.end - a.end)
    const replacement = new TextEncoder().encode("[REDACTED]")
    const chunks: Uint8Array[] = []
    let cursor = 0
    for (const match of matches) {
      if (match.start < cursor) continue
      chunks.push(bytes.subarray(cursor, match.start), replacement)
      cursor = match.end
    }
    chunks.push(bytes.subarray(cursor))
    const result = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0))
    let offset = 0
    for (const chunk of chunks) {
      result.set(chunk, offset)
      offset += chunk.length
    }
    return result
  }
  const hideResponse = async (value: unknown): Promise<unknown> => {
    if (typeof value === "string") return hideText(value)
    if (value instanceof ArrayBuffer) return hideBytes(new Uint8Array(value)).buffer
    if (typeof Blob !== "undefined" && value instanceof Blob) {
      return new Blob(
        [hideBytes(new Uint8Array(await value.arrayBuffer())) as Uint8Array<ArrayBuffer>],
        { type: hideText(value.type) }
      )
    }
    if (Array.isArray(value)) return Promise.all(value.map(hideResponse))
    if (value && typeof value === "object") {
      return Object.fromEntries(
        await Promise.all(
          Object.entries(value).map(async ([key, entry]) => [
            hideText(key),
            await hideResponse(entry),
          ])
        )
      )
    }
    return value
  }
  const hideError = (error: unknown, seen = new WeakMap<object, unknown>()): unknown => {
    if (typeof error === "string") return hideText(error)
    if (!error || typeof error !== "object") return error
    if (seen.has(error)) return seen.get(error)
    // Retain prototypes and transport metadata (name/code/requestId), including
    // DOMException's native accessors, while replacing only private text.
    if (
      error instanceof Error ||
      (typeof DOMException !== "undefined" && error instanceof DOMException)
    ) {
      const clean = Object.create(Object.getPrototypeOf(error))
      seen.set(error, clean)
      // Build the scrubbed descriptors before defining any property: source
      // errors may be frozen and carry non-configurable message/cause fields.
      const descriptors: Record<string, PropertyDescriptor> = {
        ...Object.getOwnPropertyDescriptors(error),
      }
      descriptors.name = { value: error.name, configurable: true }
      if ("code" in error) descriptors.code = { value: error.code, configurable: true }
      descriptors.message = { value: hideText(error.message), configurable: true }
      if (error.stack) descriptors.stack = { value: hideText(error.stack), configurable: true }
      if ("cause" in error)
        descriptors.cause = { value: hideError(error.cause, seen), configurable: true }
      if ("details" in error)
        descriptors.details = {
          value: hideError(error.details, seen),
          configurable: true,
          enumerable: true,
        }
      Object.defineProperties(clean, descriptors)
      return clean
    }
    const clean = Array.isArray(error) ? [] : Object.create(Object.getPrototypeOf(error))
    seen.set(error, clean)
    for (const [key, entry] of Object.entries(error)) clean[hideText(key)] = hideError(entry, seen)
    return clean
  }
  return {
    url,
    headers,
    body,
    async dispatch<T>(send: () => Promise<T>): Promise<T> {
      if (!hidden.length) return send()
      try {
        return (await hideResponse(await send())) as T
      } catch (error) {
        throw hideError(error)
      }
    },
  }
}
