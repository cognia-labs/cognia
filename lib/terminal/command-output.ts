/**
 * Command output extraction for the integrated terminal.
 *
 * OSC 633 (`osc633.rs`) carries no command output frame — it only marks the
 * command boundaries (A/B/C/D). To surface a finished command's *output* (for
 * the command-menu "Copy output" action and the quick-fix evaluator), we read
 * the xterm buffer rows between the command's start marker and its end marker,
 * mirroring VS Code's `CommandDetectionCapability.getOutput`.
 *
 * The pure bits live here — buffer-row reads happen through a
 * {@link BufferLineReader} so the logic is unit-testable without an xterm
 * instance. The same indirection the `fileLinkProvider` uses in
 * `terminal-instance.tsx` (`buffer.active.getLine(n).translateToString(true)`).
 */

/**
 * Reads the trimmed text of an absolute buffer line, or `null` when the line
 * is out of range / not yet rendered. In the renderer this wraps
 * `term.buffer.active.getLine(line)?.translateToString(true)`.
 */
export type BufferLineReader = (line: number) => string | null

/**
 * Collect buffer-line text in `[startLine, endLineExclusive)`. Out-of-range or
 * unreadable lines (reader returns `null`) are skipped, not pushed as blanks,
 * so a trimmed scrollback never injects phantom empty rows. Returns `[]` for a
 * non-finite or inverted range.
 */
export function readBufferRange(
  read: BufferLineReader,
  startLine: number,
  endLineExclusive: number
): string[] {
  if (!Number.isFinite(startLine) || !Number.isFinite(endLineExclusive)) return []
  const from = Math.max(0, Math.floor(startLine))
  const to = Math.floor(endLineExclusive)
  const out: string[] = []
  for (let line = from; line < to; line++) {
    const text = read(line)
    if (text == null) continue
    out.push(text)
  }
  return out
}

/**
 * Join captured output rows into a single string, trimming trailing blank
 * rows (xterm pads the viewport with empty cells, and the prompt that follows
 * a command shouldn't bleed into its captured output). Leading/interior blank
 * lines are preserved — they're real output.
 */
export function joinOutput(lines: readonly string[]): string {
  let end = lines.length
  while (end > 0 && lines[end - 1].trim().length === 0) end--
  return lines.slice(0, end).join("\n")
}

/**
 * Resolve the exclusive output end line for a command, given its own start
 * line and the start lines of all commands. Output runs until the next
 * command's start marker; when this is the most recent command, it runs to
 * `fallbackEnd` (the live cursor's absolute row). Pure so the bounding rule is
 * tested independently of marker disposal races.
 */
export function outputEndLine(
  startLine: number,
  allStartLines: readonly number[],
  fallbackEnd: number
): number {
  let next: number | null = null
  for (const line of allStartLines) {
    if (line > startLine && (next === null || line < next)) next = line
  }
  return next ?? fallbackEnd
}

// ── Stream-side extraction ────────────────────────────────────────────────
//
// The buffer reader above serves the UI, which has an xterm. A caller driving a
// tab programmatically (`runInDockTab`, the Dock `wait_for_exit` tool, the
// interactive workflow nodes) has only the byte stream, so it reads the same
// window from the other side: the bytes between the command's OSC 633 `C`
// (pre-exec) and `D` (command finished) sequences. The PTY forwards those
// sequences unchanged (`osc633.rs` parses a copy), so they are still in the
// stream to slice on. This mirrors the headless runner's capture
// (`crates/cognia-terminal/src/headless.rs:finalize_output`) so an interactive
// and an unattended run of one command report the same text.

const ESC = "\u001b"
const BEL = "\u0007"
const OSC_633_COMMAND_START = `${ESC}]633;C`
const OSC_633_COMMAND_END = `${ESC}]633;D`

/**
 * Drop terminal control sequences and normalise line endings.
 *
 * OSC (`ESC ] … BEL` / `ESC ] … ESC \`), CSI (`ESC [ … <final>`) and other
 * two-byte escapes are removed; CRLF and bare CR become LF. Same rules as the
 * Rust `strip_escapes`, so a progress bar's carriage returns read as lines.
 */
export function stripTerminalEscapes(text: string): string {
  let out = ""
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch !== ESC) {
      out += ch
      i += 1
      continue
    }
    const next = text[i + 1]
    if (next === undefined) break
    if (next === "]") {
      i += 2
      while (i < text.length) {
        if (text[i] === BEL) {
          i += 1
          break
        }
        if (text[i] === ESC && text[i + 1] === "\\") {
          i += 2
          break
        }
        i += 1
      }
    } else if (next === "[") {
      i += 2
      while (i < text.length) {
        const code = text.charCodeAt(i)
        i += 1
        if (code >= 0x40 && code <= 0x7e) break
      }
    } else {
      i += 2
    }
  }
  return out.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}

/** Index just past the OSC sequence that starts at `at` (its BEL / ST terminator). */
function endOfOsc(text: string, at: number): number {
  for (let i = at + 2; i < text.length; i++) {
    if (text[i] === BEL) return i + 1
    if (text[i] === ESC && text[i + 1] === "\\") return i + 2
  }
  return text.length
}

/**
 * The output of the first command that finished in `raw`.
 *
 * `raw` is decoded terminal text captured from (at least) the moment the
 * command was written. The window is the bytes after the last `C` that precedes
 * the first `D`, up to that `D` — so the echoed command line and the prompt that
 * follows are both outside it. Trailing newlines are trimmed.
 *
 * Degraded streams fall back the way the Rust runner does:
 *  - no `C` (a shell without the pre-exec hook, or a capture whose head was
 *    dropped): the window starts at the beginning of `raw`;
 *  - no `D` yet (finalised by a fallback timer): the window runs to the end,
 *    and whatever follows the last newline is dropped as prompt noise.
 *
 * The markers are located textually, so a program that prints a literal OSC
 * 633 `D` ends its own window early. That can only shorten what is reported,
 * never attribute another command's output to this one: the exit code still
 * comes from the nonce-validated integration event.
 */
export function extractMarkedCommandOutput(raw: string): string {
  const end = raw.indexOf(OSC_633_COMMAND_END)
  const searchLimit = end === -1 ? raw.length : end
  const startMarker = raw.lastIndexOf(OSC_633_COMMAND_START, searchLimit)
  const start = startMarker !== -1 && startMarker < searchLimit ? endOfOsc(raw, startMarker) : 0
  if (end === -1) {
    const text = stripTerminalEscapes(raw.slice(start))
    const lastNewline = text.lastIndexOf("\n")
    return lastNewline === -1 ? "" : text.slice(0, lastNewline).replace(/\n+$/, "")
  }
  return stripTerminalEscapes(raw.slice(start, end)).replace(/\n+$/, "")
}

/** True once `raw` holds a command-finished sequence to slice on. */
export function hasCommandEndMarker(raw: string): boolean {
  return raw.includes(OSC_633_COMMAND_END)
}
