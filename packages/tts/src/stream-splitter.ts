/**
 * Incremental sentence splitter for streaming TTS (plan W7 / D3).
 *
 * The old pipeline synthesized only after the whole reply was generated, so
 * first-audio latency = "LLM fully done + whole text synthesized". This splitter
 * turns a growing text stream into speakable fragments *as tokens arrive*, so
 * synthesis of fragment 1 can start while the model is still writing fragment 2.
 *
 * Two-tier boundary policy (inspired by stream2sentence):
 *  - The FIRST fragment uses a WIDE separator set and a small minimum length so
 *    audio starts as soon as possible; if no separator shows up it is force-cut
 *    after enough words/characters rather than waiting.
 *  - Every fragment after that uses a NARROW separator set (sentence enders) and
 *    a minimum length, trading a little latency for natural prosody.
 *
 * A cut never lands inside a token. ASCII punctuation ends a fragment only
 * when whitespace follows it (closing quotes/brackets in between allowed), so
 * `example.com`, `3.14` and `e.g.` stay whole, and a forced first cut backs up
 * to the last whitespace. That matters twice: a fragment is spoken (and
 * prosody suffers from `3.` / `14`), and each fragment is PII-screened on its
 * own before it leaves the device, so an e-mail address cut in half would pass
 * the gate as two harmless-looking pieces. CJK enders and newlines cut at once
 * because CJK has no spaces to wait for.
 *
 * Consumer-agnostic: `push()`/`flush()` suit a push source (per-delta callback);
 * `splitStream()` wraps them for a pull source (async iterable of tokens).
 */

export interface StreamSplitterOptions {
  /** Wide set used only for the first fragment (grab first audio fast). */
  firstFragmentSeparators?: string
  /** Minimum characters before the first fragment may be cut. */
  minFirstFragmentLength?: number
  /** Force-emit the first fragment after this many words even without a separator. */
  forceFirstFragmentAfterWords?: number
  /** Force-emit the first fragment after this many characters (covers CJK, which has no spaces). */
  forceFirstFragmentAfterChars?: number
  /** Narrow set (sentence enders) used for every fragment after the first. */
  sentenceSeparators?: string
  /** Minimum characters before a subsequent fragment may be cut. */
  minSentenceLength?: number
}

const DEFAULTS: Required<StreamSplitterOptions> = {
  // Note: the plan lists a bare "-" in the first set; it is intentionally
  // omitted here because it splits hyphenated words mid-token for no real gain.
  firstFragmentSeparators: ".?!;:,\n…)]}。！？；：，",
  minFirstFragmentLength: 10,
  forceFirstFragmentAfterWords: 30,
  forceFirstFragmentAfterChars: 60,
  sentenceSeparators: ".?!\n…。！？",
  minSentenceLength: 10,
}

export class SentenceStreamSplitter {
  private buffer = ""
  private isFirst = true
  private readonly opts: Required<StreamSplitterOptions>

  constructor(options: StreamSplitterOptions = {}) {
    this.opts = { ...DEFAULTS, ...options }
  }

  /** Feed more text; return any fragments that completed (possibly none). */
  push(text: string): string[] {
    this.buffer += text
    const out: string[] = []
    for (;;) {
      const cut = this.findCut()
      if (cut < 0) break
      const fragment = this.buffer.slice(0, cut).trim()
      this.buffer = this.buffer.slice(cut)
      if (fragment) {
        out.push(fragment)
        this.isFirst = false
      }
    }
    return out
  }

  /** Emit whatever remains buffered as a final fragment (or null if empty). */
  flush(): string | null {
    const tail = this.buffer.trim()
    this.buffer = ""
    if (!tail) return null
    this.isFirst = false
    return tail
  }

  private findCut(): number {
    const seps = this.isFirst ? this.opts.firstFragmentSeparators : this.opts.sentenceSeparators
    const minLen = this.isFirst ? this.opts.minFirstFragmentLength : this.opts.minSentenceLength
    const b = this.buffer
    for (let i = Math.max(0, minLen - 1); i < b.length; i++) {
      if (!seps.includes(b[i])) continue
      if (IMMEDIATE_SEPARATORS.includes(b[i])) return i + 1
      // ASCII punctuation: look past closing quotes/brackets for whitespace.
      let j = i + 1
      while (j < b.length && CLOSERS.includes(b[j])) j++
      // The next token decides; wait for it rather than guess.
      if (j >= b.length) return -1
      if (WHITESPACE.test(b[j])) return j
    }
    if (this.isFirst) {
      const words = b.trim().split(/\s+/).filter(Boolean).length
      if (
        words >= this.opts.forceFirstFragmentAfterWords ||
        b.length >= this.opts.forceFirstFragmentAfterChars
      ) {
        return forcedCut(b)
      }
    }
    return -1
  }
}

/** Separators that end a fragment without waiting for whitespace. */
const IMMEDIATE_SEPARATORS = "\n…。！？；：，"
/** Characters that may sit between ASCII punctuation and the whitespace after it. */
const CLOSERS = "\"'”’)]}"
const WHITESPACE = /\s/

/**
 * Where a forced first cut may land without splitting a token: after the
 * last whitespace, else (unspaced CJK) before a trailing run of ASCII
 * non-space characters. A buffer that is one unbroken ASCII run (a URL, a
 * key) is not force-cut at all.
 */
function forcedCut(buffer: string): number {
  if (WHITESPACE.test(buffer[buffer.length - 1] ?? "")) return buffer.length
  for (let i = buffer.length - 1; i > 0; i--) {
    if (WHITESPACE.test(buffer[i])) return i + 1
  }
  const trailingRun = /[\x21-\x7e]+$/.exec(buffer)
  if (!trailingRun) return buffer.length
  return trailingRun.index > 0 ? trailingRun.index : -1
}

/**
 * Pull-style wrapper: drive the splitter from an async iterable of text tokens,
 * yielding speakable fragments in order (including the flushed tail).
 */
export async function* splitStream(
  tokens: AsyncIterable<string>,
  options: StreamSplitterOptions = {}
): AsyncGenerator<string> {
  const splitter = new SentenceStreamSplitter(options)
  for await (const token of tokens) {
    for (const fragment of splitter.push(token)) yield fragment
  }
  const tail = splitter.flush()
  if (tail) yield tail
}
