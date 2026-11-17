// A pointer from a shortened tool output to where its complete text still lives.
//
// A tool that cannot inline its whole output (bash spilling a long log to a
// temp file) states one reference on the output's first line, saying where the
// rest is. Every later shortening — the compaction cap on retained tool
// results, the clip on the summary model's transcript — keeps head and tail
// and drops the middle, and a cut that rewrites or wraps the head (a header,
// a JSON re-serialization) could still lose it; the model then lost its only
// way back to the full output.
//
// So the line has one fixed shape and one fixed place, and every cut that
// shortens a tool body re-adds it (`keepRecoverableRefs`). Only the first line
// counts: a reference-shaped line further down is the output's own data (a log
// the tool printed), untrusted, and is cut like the rest of it.

/** Opening and closing of every reference line. */
const REF_OPEN = "[full output: "
const REF_CLOSE = " — read this file with the read tool for the complete output]"

/** Longest reference honored: a real path and size fit well inside it. */
const MAX_REF_CHARS = 1_024

/** One reference line: the file holding the complete output, and how big it is. */
export function formatRecoverableRef(path: string, totalChars: number): string {
  return `${REF_OPEN}${path} (${totalChars} characters)${REF_CLOSE}`
}

/**
 * The reference `text` states on its first line (after any label the tool
 * kernel puts in front, such as `bash: ` on a failure), or null.
 */
export function leadingRecoverableRef(text: string): string | null {
  const lineEnd = text.indexOf("\n")
  const first = lineEnd < 0 ? text : text.slice(0, lineEnd)
  const at = first.indexOf(REF_OPEN)
  if (at < 0) return null
  const close = first.indexOf(REF_CLOSE, at)
  if (close < 0) return null
  const ref = first.slice(at, close + REF_CLOSE.length)
  return ref.length <= MAX_REF_CHARS ? ref : null
}

/**
 * `shortened` with the reference `original` states on its first line put back
 * in front when the cut lost it. Anything else returns `shortened` unchanged.
 */
export function keepRecoverableRefs(original: string, shortened: string): string {
  const ref = leadingRecoverableRef(original)
  return ref && !shortened.includes(ref) ? `${ref}\n${shortened}` : shortened
}
