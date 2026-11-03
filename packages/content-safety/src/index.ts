import { hasNoLeakingPii, normalizeForRedaction } from "@cognia/redact"

export const CONTENT_SAFETY_VERSION = "2"
export type ContentSource = "user" | "external" | "trusted"
export type ContentStage = "admission" | "model-input" | "tool-result" | "retrieval"
export interface ContentFinding {
  category: "privacy" | "prompt-injection"
  code: string
  severity: "medium" | "high"
  /** Findings never contain matched text, secrets, or a reversible redaction map. */
  view: "original" | "normalized" | "decoded"
}
export interface ContentAssessment {
  version: string
  source: ContentSource
  stage: ContentStage
  status: "complete" | "incomplete"
  findings: ContentFinding[]
}

// Bounds are checked BEFORE normalization/decoding. Layered decoding has one
// shared budget; no compression formats or unbounded recursive expansion.
const MAX_CHARS = 1_048_576
const MAX_ENCODED_CHARS = 16_384
const MAX_DECODED_VIEWS = 16
const MAX_DECODE_DEPTH = 3
const OVERRIDE =
  /(?:\b(?:ignore|disregard|forget|override)\b.{0,40}\b(?:previous|prior|above|system|all|safety)\b.{0,30}\b(?:instructions?|prompts?|rules?|restrictions?)\b|(?:忽略|无视|抛弃|覆盖).{0,16}(?:之前|此前|上文|所有|系统|安全).{0,12}(?:指令|提示|规则|限制))/i
const EXTRACT =
  /(?:\b(?:reveal|dump|print|output|show|expose)\b.{0,40}\b(?:system|developer|hidden)\s+(?:prompt|instructions?)|(?:泄露|输出|展示|打印).{0,16}(?:系统提示|系统指令|内部指令))/i
const EXFILTRATE =
  /(?:(?:send|upload|forward|post).{0,60}(?:credentials?|api[ _-]?keys?|access[ _-]?tokens?|secrets?).{0,60}(?:https?:|external|attacker)|(?:将|把).{0,40}(?:访问凭据|访问令牌|API密钥|私钥|密码).{0,30}(?:发送|上传|转发).{0,20}(?:外部|https?:|邮箱))/i
const ROLE =
  /<\|im_start\|>\s*(?:system|developer)|\[INST\].*?<<SYS>>|(?:^|\n)\s*(?:SYSTEM|DEVELOPER)\s+OVERRIDE\s*:/i
const DISABLE =
  /(?:disable|bypass|turn off).{0,24}(?:safety|security|guardrails?|filters?)|(?:关闭|绕过|禁用).{0,12}(?:安全检查|防护机制|安全规则)/i

function authoredInstructions(text: string): string {
  // A bounded analysis-only grammar prevents a friendly prefix from hiding a
  // second request to execute the quoted attack. Source content is unchanged.
  const view = text
    .replace(/(```[^]*?```|`[^`\n]+`|“[^”\n]*”|「[^」\n]*」|"[^"\n]*")/g, " quoted_text ")
    .trim()
    .replace(/\s+/g, " ")
  if (
    /^(?:please\s+)?(?:explain|analy[sz]e|review|translate|describe)\s+(?:(?:why|this|the|following|code|text|phrase|example|request)\s+|:\s*)*quoted_text(?:\s+is\s+(?:a\s+)?(?:prompt[ -]injection|unsafe|dangerous))?\s*[.!?]?$/i.test(
      view
    )
  )
    return view
  if (
    /^(?:请)?(?:分析|解释)(?:这句话|以下文本|下面这句话)(?:为什么|为何)(?:危险|是提示词注入)[，,](?:不要|切勿)执行(?:它)?[：:]\s*quoted_text\s*[。！？]?$/.test(
      view
    )
  )
    return view
  return text
}

function normalizeInspectionText(text: string): string {
  return normalizeForRedaction(text)
    .normalize("NFKC")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g, "")
    .replace(
      /\\(?:u([\da-f]{4})|x([\da-f]{2})|u\{([\da-f]{1,6})\})/gi,
      (match, u: string, x: string, point: string) => {
        const code = Number.parseInt(u ?? x ?? point, 16)
        return code <= 0x10ffff ? String.fromCodePoint(code) : match
      }
    )
    .replace(
      /&#(x[\da-f]{1,6}|\d{1,7});|&(amp|lt|gt|quot|apos);/gi,
      (match, numeric: string, named: string) => {
        if (numeric) {
          const code = Number.parseInt(numeric.replace(/^x/i, ""), /^x/i.test(numeric) ? 16 : 10)
          return code <= 0x10ffff ? String.fromCodePoint(code) : match
        }
        return (
          ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[
            named.toLowerCase()
          ] ?? match
        )
      }
    )
    .replace(/\s+/g, " ")
}

function decodedViews(text: string): { views: string[]; complete: boolean } {
  const views: string[] = []
  const queue = [{ text, depth: 0 }]
  const seen = new Set([text])
  let candidates = 0
  let complete = true
  const add = (value: string, depth: number) => {
    if (seen.has(value)) return
    if (
      depth > MAX_DECODE_DEPTH ||
      value.length > MAX_ENCODED_CHARS ||
      views.length >= MAX_DECODED_VIEWS
    ) {
      complete = false
      return
    }
    seen.add(value)
    views.push(value)
    queue.push({ text: value, depth })
  }
  for (let index = 0; index < queue.length && complete; index++) {
    const current = queue[index]!
    add(normalizeInspectionText(current.text), current.depth + 1)
    for (const match of current.text.matchAll(/(?:%[0-9a-f]{2}|[^\s%]){12,}/gi)) {
      if (!match[0].includes("%")) continue
      if (++candidates > MAX_DECODED_VIEWS || match[0].length > MAX_ENCODED_CHARS) {
        complete = false
        break
      }
      try {
        add(decodeURIComponent(match[0]), current.depth + 1)
      } catch {
        /* Malformed URI is still scanned verbatim. */
      }
    }
    if (!complete) break
    // Decode all text candidates so forged roles and safety bypasses receive
    // the same inspection as overrides, including another encoded layer.
    for (const match of current.text.matchAll(/\b[A-Za-z0-9+/_-]{24,}={0,2}/g)) {
      if (match[0].length > MAX_ENCODED_CHARS) {
        complete = false
        break
      }
      try {
        const token = match[0].replace(/-/g, "+").replace(/_/g, "/")
        const binary = atob(token.padEnd(Math.ceil(token.length / 4) * 4, "="))
        const value = new TextDecoder("utf-8", { fatal: true }).decode(
          Uint8Array.from(binary, (c) => c.charCodeAt(0))
        )
        if (!/[\u0000-\u0008\u000e-\u001f]/.test(value)) {
          // Long code identifiers also match the alphabet. Only successfully
          // decoded text consumes the shared view budget; attempts remain
          // bounded by input size and the decoded-view/depth limits.
          if (++candidates > MAX_DECODED_VIEWS) {
            complete = false
            break
          }
          add(value, current.depth + 1)
        }
      } catch {
        /* Binary base64 is not an instruction-bearing text view. */
      }
    }
  }
  return { views, complete }
}

/** Assess without modifying content. Policy and side effects belong to the Host. */
export function assessContentSafety(input: {
  text: string
  source: ContentSource
  stage: ContentStage
  inspectPrivacy?: boolean
  inspectInjection?: boolean
}): ContentAssessment {
  const result: ContentAssessment = {
    version: CONTENT_SAFETY_VERSION,
    source: input.source,
    stage: input.stage,
    status: input.text.length > MAX_CHARS ? "incomplete" : "complete",
    findings: [],
  }
  if (result.status === "incomplete") return result
  if (input.inspectPrivacy !== false && !hasNoLeakingPii(input.text)) {
    result.findings.push({
      category: "privacy",
      code: "recognized_sensitive_data",
      severity: "high",
      view: "original",
    })
  }
  if (input.source === "trusted" || input.inspectInjection === false) return result
  const text = input.source === "user" ? authoredInstructions(input.text) : input.text
  const normalized = normalizeInspectionText(text)
  const views: Array<[string, ContentFinding["view"]]> = [[text, "original"]]
  if (normalized !== text) views.push([normalized, "normalized"])
  const decoded = decodedViews(normalized)
  if (!decoded.complete) result.status = "incomplete"
  for (const text of decoded.views) views.push([text, "decoded"])
  const seen = new Set<string>()
  for (const [view, name] of views) {
    for (const [code, pattern] of [
      ["instruction_override", OVERRIDE],
      ["system_prompt_extraction", EXTRACT],
      ["credential_exfiltration", EXFILTRATE],
      ["forged_role_boundary", ROLE],
      ["safety_bypass", DISABLE],
    ] as const) {
      if (!seen.has(code) && pattern.test(view)) {
        seen.add(code)
        result.findings.push({ category: "prompt-injection", code, severity: "high", view: name })
      }
    }
  }
  return result
}

/** Privacy and injection policy are independent; disabling one never disables the other. */
export function decideContentSafety(
  assessment: ContentAssessment,
  policy: {
    injectionProtection: boolean
    enforcePrivacy?: boolean
  }
): { action: "allow" | "block" | "quarantine"; reasonCodes: string[] } {
  const findings = assessment.findings.filter((f) =>
    f.category === "privacy" ? policy.enforcePrivacy : policy.injectionProtection
  )
  const reasonCodes = findings.map((f) => f.code)
  if (assessment.status !== "complete" && (policy.injectionProtection || policy.enforcePrivacy))
    reasonCodes.push("inspection_incomplete")
  const action =
    reasonCodes.length === 0 ? "allow" : assessment.source === "external" ? "quarantine" : "block"
  return { action, reasonCodes }
}

/** Preserve readable external evidence while neutralizing forged fence tags. */
export function frameExternalContent(text: string): string {
  const body = text.replace(/<\s*(\/?)\s*untrusted[\s_-]*content\b[^>]*>/gi, (_, slash: string) =>
    slash ? "‹/untrusted_content›" : "‹untrusted_content›"
  )
  return `<untrusted_content>\n${body}\n</untrusted_content>`
}

export class ContentSafetyBlockedError extends Error {
  readonly code = "content_safety_blocked"
  readonly reasonCodes: string[]
  constructor(reasonCodes: string[]) {
    super(`Content withheld by content safety: ${reasonCodes.join(", ")}`)
    this.name = "ContentSafetyBlockedError"
    this.reasonCodes = reasonCodes
  }
}

function textualMime(mime: string): boolean {
  return /^(?:text\/|application\/(?:json|xml|javascript|yaml|x-yaml|x-www-form-urlencoded))|\+(?:json|xml)$|^image\/svg\+xml$/.test(
    mime
  )
}

/** Assess every model-visible text field/key with one shared traversal budget. */
export function assessStructuredContentSafety(input: {
  value: unknown
  source: ContentSource
  stage: ContentStage
  inspectPrivacy?: boolean
  inspectInjection?: boolean
}): ContentAssessment {
  const result: ContentAssessment = {
    version: CONTENT_SAFETY_VERSION,
    source: input.source,
    stage: input.stage,
    status: "complete",
    findings: [],
  }
  const seen = new Set<string>()
  let nodes = 0
  let chars = 0
  const ancestors = new WeakSet<object>()
  const incomplete = (code?: string) => {
    result.status = "incomplete"
    if (code && !seen.has(code)) {
      seen.add(code)
      result.findings.push({
        category: "prompt-injection",
        code,
        severity: "high",
        view: "decoded",
      })
    }
  }
  const scanText = (text: string, source: ContentSource) => {
    const assessment = assessContentSafety({
      text,
      source,
      stage: input.stage,
      inspectPrivacy: input.inspectPrivacy,
      inspectInjection: input.inspectInjection,
    })
    if (assessment.status !== "complete") incomplete()
    for (const finding of assessment.findings) {
      const key = `${finding.category}:${finding.code}`
      if (!seen.has(key)) {
        seen.add(key)
        result.findings.push(finding)
      }
    }
  }
  const inspect = (
    value: unknown,
    depth: number,
    source = input.source,
    mediaUri = false,
    authoredTextScanned = false
  ): void => {
    if (result.status !== "complete") return
    if (++nodes > 10_000 || depth > 32) return incomplete()
    if (typeof value === "string") {
      const dataUri = /^data:([^,]{0,256}),/i.exec(value)
      if (
        dataUri &&
        (textualMime(dataUri[1]!.split(";", 1)[0]!.toLowerCase() || "text/plain") || mediaUri)
      ) {
        const mime = dataUri[1]!.split(";", 1)[0]!.toLowerCase() || "text/plain"
        if (!textualMime(mime)) return
        if (value.length > MAX_CHARS) return incomplete()
        try {
          const payload = value.slice(dataUri[0].length)
          const decoded = /;base64(?:;|$)/i.test(dataUri[1]!)
            ? new TextDecoder("utf-8", { fatal: true }).decode(
                Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))
              )
            : decodeURIComponent(payload)
          inspect(decoded, depth + 1, "external")
        } catch {
          incomplete("text_decode_failed")
        }
        return
      }
      chars += value.length
      if (chars > MAX_CHARS) return incomplete()
      scanText(value, source)
      return
    }
    if (value === null || typeof value !== "object") return
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return
    if (ancestors.has(value)) return incomplete()
    ancestors.add(value)
    try {
      if (Array.isArray(value)) {
        if (value.length > 10_000) return incomplete()
        if (source === "user") {
          const textParts: string[] = []
          let length = 0
          for (const part of value) {
            if (
              part &&
              typeof part === "object" &&
              part.type === "text" &&
              typeof part.text === "string"
            ) {
              length += part.text.length
              if (length > MAX_CHARS) return incomplete()
              textParts.push(part.text)
            }
          }
          if (textParts.length > 0) scanText(textParts.join("\n"), source)
        }
        for (const item of value) {
          inspect(item, depth + 1, source, false, source === "user" && item?.type === "text")
          if (result.status !== "complete") break
        }
        return
      }
      const record = value as Record<string, unknown>
      const nestedSource =
        record.type === "document" ||
        record.type === "file" ||
        record.type === "resource" ||
        (typeof record.type === "string" &&
          (record.type.startsWith("tool-") || record.type === "dynamic-tool"))
          ? "external"
          : source
      const binary =
        record.type === "image" ||
        record.type === "audio" ||
        record.type === "image_url" ||
        record.type === "base64" ||
        record.type === "document" ||
        record.type === "file" ||
        mediaUri
      const mime = String(record.mimeType ?? record.mediaType ?? record.media_type ?? "")
        .toLowerCase()
        .split(";", 1)[0]!
        .trim()
      // A generic result can have a field named blob/content. Only a media
      // declaration makes its payload opaque; otherwise inspect it as text.
      const mediaPayload = binary || /^[\w.+-]+\/[\w.+-]+$/.test(mime)

      if (
        mediaPayload &&
        (typeof record.blob === "string" ||
          (record.encoding === "base64" && typeof record.content === "string") ||
          record.data !== undefined ||
          typeof record.dataBase64 === "string")
      ) {
        let encoded =
          record.blob ??
          (record.encoding === "base64" ? record.content : (record.data ?? record.dataBase64))
        let taggedHandled = false
        if (encoded && typeof encoded === "object" && "type" in encoded) {
          const tagged = encoded as Record<string, unknown>
          if (tagged.type === "data") encoded = tagged.data
          else if (tagged.type === "text" || tagged.type === "url" || tagged.type === "reference") {
            const text = tagged.text ?? tagged.url ?? tagged.reference
            if (typeof text !== "string") return incomplete("text_decode_failed")
            inspect(text, depth + 1, "external", tagged.type === "url")
            taggedHandled = true
          }
        }
        if (!taggedHandled && textualMime(mime)) {
          try {
            const bytes =
              encoded instanceof ArrayBuffer
                ? new Uint8Array(encoded)
                : ArrayBuffer.isView(encoded)
                  ? new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength)
                  : undefined
            if ((bytes?.byteLength ?? String(encoded).length) > MAX_CHARS) return incomplete()
            const binary = bytes ? undefined : atob(String(encoded))
            inspect(
              new TextDecoder("utf-8", { fatal: true }).decode(
                bytes ?? Uint8Array.from(binary!, (c) => c.charCodeAt(0))
              ),
              depth + 1,
              "external"
            )
          } catch {
            incomplete("text_decode_failed")
          }
        }
      }
      if (value instanceof Map) {
        for (const [key, nested] of value) {
          inspect(key, depth + 1, source)
          inspect(nested, depth + 1, source)
          if (result.status !== "complete") break
        }
        return
      }
      if (value instanceof Set) {
        for (const nested of value) {
          inspect(nested, depth + 1, source)
          if (result.status !== "complete") break
        }
        return
      }
      for (const key in record) {
        if (!Object.prototype.hasOwnProperty.call(record, key)) continue
        inspect(key, depth + 1, nestedSource)
        if (result.status !== "complete") break
        if (key === "structuredContent") {
          try {
            inspect(JSON.stringify(record[key]), depth + 1, "external")
          } catch {
            incomplete()
          }
          continue
        }
        if (
          (key === "blob" && mediaPayload) ||
          (key === "content" && record.encoding === "base64" && mediaPayload) ||
          (mediaPayload && (key === "data" || key === "dataBase64"))
        )
          continue
        if (authoredTextScanned && key === "text" && typeof record[key] === "string") {
          chars += record[key].length
          if (chars > MAX_CHARS) return incomplete()
          continue
        }
        inspect(
          record[key],
          depth + 1,
          key === "output" || key === "result" ? "external" : nestedSource,
          mediaPayload && (key === "url" || key === "image_url" || key === "image")
        )
        if (result.status !== "complete") break
      }
    } finally {
      ancestors.delete(value)
    }
  }
  inspect(input.value, 0)
  return result
}

function assertStructured(value: unknown, source: ContentSource, stage: ContentStage): void {
  const decision = decideContentSafety(
    assessStructuredContentSafety({ value, source, stage, inspectPrivacy: false }),
    { injectionProtection: true }
  )
  if (decision.action !== "allow") throw new ContentSafetyBlockedError(decision.reasonCodes)
}

/** Inspect model-visible tool evidence without scanning binary transport bytes. */
export function assertSafeExternalContent(value: unknown, injectionProtection = true): void {
  if (injectionProtection) assertStructured(value, "external", "tool-result")
}

/** Authored text can quote examples; attachments remain external evidence. */
export function assertSafeModelInput(value: unknown, injectionProtection = true): void {
  if (!injectionProtection) return
  assertStructured(value, "user", "model-input")
}

/** Actual provider history only: Host system/developer instructions retain authority. */
export function assertSafeModelHistory(
  messages: readonly unknown[],
  injectionProtection = true
): void {
  if (!injectionProtection) return
  if (messages.length > 10_000) throw new ContentSafetyBlockedError(["inspection_incomplete"])
  const authored: unknown[] = [],
    external: unknown[] = []
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      external.push(message)
      continue
    }
    const record = message as Record<string, unknown>
    if (record.role === "system" || record.role === "developer") continue
    const parts = record.parts ?? record.content ?? record
    if (record.role === "user") authored.push(parts)
    else external.push(parts)
  }
  assertStructured(authored, "user", "model-input")
  assertStructured(external, "external", "model-input")
}
