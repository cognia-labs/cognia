/**
 * Names for files the app writes on the user's behalf.
 *
 * Export filenames used to come from ASCII-only slugs (`[^a-z0-9]+` → `-`),
 * so every conversation titled in Chinese, Japanese or Russian became
 * `conversation.md`, and on a phone, where the save path is fixed rather
 * than chosen in a dialog, the second export silently replaced the first.
 *
 * `exportFilenameStem` keeps the title in any script and removes only what a
 * filesystem or a reader cannot take; `uniqueFilename` picks the first free
 * `name (n).ext` among names already taken.
 */

/**
 * Characters no common filesystem accepts in a name (Windows is the strictest),
 * control characters, and bidirectional controls, which can make `txt.exe`
 * read as `exe.txt`.
 */
const UNSAFE_CHARACTERS = /[\\/:*?"<>|\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

/** Device names Windows reserves whatever the extension. */
const WINDOWS_RESERVED_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/**
 * Most filesystems cap a name at 255 bytes. The stem stays well under that so
 * an extension and a ` (12)` suffix still fit, whatever script it is in.
 */
const MAX_STEM_BYTES = 180

const encoder = new TextEncoder()

/** The longest prefix of `text` within `maxBytes` of UTF-8, never splitting a character. */
function truncateUtf8(text: string, maxBytes: number): string {
  if (encoder.encode(text).byteLength <= maxBytes) return text
  const segments =
    typeof Intl !== "undefined" && "Segmenter" in Intl
      ? Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), (s) =>
          String(s.segment)
        )
      : Array.from(text)
  let out = ""
  let bytes = 0
  for (const segment of segments) {
    const size = encoder.encode(segment).byteLength
    if (bytes + size > maxBytes) break
    out += segment
    bytes += size
  }
  return out
}

/**
 * A filename stem for `title`: letters and digits of every script kept,
 * whitespace runs and unsafe characters turned into `-`, no leading or
 * trailing `-` / `.`, at most {@link MAX_STEM_BYTES} bytes, never a Windows
 * device name. `fallback` when nothing is left.
 */
export function exportFilenameStem(title: string, fallback: string): string {
  const cleaned = title
    .normalize("NFC")
    .replace(UNSAFE_CHARACTERS, "-")
    .replace(/\s+/gu, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
  const stem = truncateUtf8(cleaned, MAX_STEM_BYTES).replace(/[-.]+$/, "")
  if (!stem) return fallback
  return WINDOWS_RESERVED_NAMES.test(stem) ? `${stem}-file` : stem
}

/** `name.ext` → `["name", ".ext"]`; a leading dot is not an extension. */
function splitExtension(filename: string): [string, string] {
  const dot = filename.lastIndexOf(".")
  return dot > 0 ? [filename.slice(0, dot), filename.slice(dot)] : [filename, ""]
}

/**
 * `filename` when no name in `taken` matches it, else the first free
 * `name (2).ext`, `name (3).ext`, …. Names compare case-insensitively after
 * NFC normalization, as the case-insensitive filesystems on phones and
 * desktops do.
 */
export function uniqueFilename(filename: string, taken: Iterable<string>): string {
  const key = (name: string) => name.normalize("NFC").toLowerCase()
  const used = new Set(Array.from(taken, key))
  if (!used.has(key(filename))) return filename
  const [base, extension] = splitExtension(filename)
  for (let n = 2; ; n += 1) {
    const candidate = `${base} (${n})${extension}`
    if (!used.has(key(candidate))) return candidate
  }
}
