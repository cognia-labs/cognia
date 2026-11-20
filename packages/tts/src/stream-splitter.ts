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
 * Backing up to whitespace still lets a forced cut fall between the parts of
 * an item written with spaces in it (`4111 1111 1111 1111`), and the first
 * half would leave the device before the second half is even generated. So a
 * forced cut waits for `forcedCutLookahead` more characters and asks
 * `confirmForcedCut` about the text either side of it; a refusal holds the
 * fragment until a real separator (or `flush()`) instead. Forced cuts are the
 * rare no-punctuation case, so the lookahead costs little; only text the
 * caller's gate flags waits for the sentence to end.
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
  /** Characters that must arrive past a forced cut before `confirmForcedCut` is asked. */
  forcedCutLookahead?: number
  /**
   * Whether a forced first cut may land between `head` (the fragment it would
   * emit, as buffered) and `lookahead` (the `forcedCutLookahead` characters
   * after it). `false` holds the fragment until a separator or `flush()`.
   * Absent means every forced cut is taken at once.
   */
  confirmForcedCut?: (head: string, lookahead: string) => boolean
}

type SplitterTuning = Required<Omit<StreamSplitterOptions, "confirmForcedCut">>

const DEFAULTS: SplitterTuning = {
  // Note: the plan lists a bare "-" in the first set; it is intentionally
  // omitted here because it splits hyphenated words mid-token for no real gain.
  firstFragmentSeparators: ".?!;:,\n…)]}。！？；：，",
  minFirstFragmentLength: 10,
  forceFirstFragmentAfterWords: 30,
  forceFirstFragmentAfterChars: 60,
  sentenceSeparators: ".?!\n…。！？",
  minSentenceLength: 10,
  // Covers a spaced card number, IBAN or phone number straddling the cut.
  forcedCutLookahead: 40,
}

export class SentenceStreamSplitter {
  private buffer = ""
  private isFirst = true
  /** Where the first forced cut would land, fixed while its lookahead arrives. */
  private pendingForcedCut: number | null = null
  /** `confirmForcedCut` refused: only a separator or `flush()` ends this fragment. */
  private forcedCutHeld = false
  private readonly opts: SplitterTuning
  private readonly confirmForcedCut?: (head: string, lookahead: string) => boolean

  constructor(options: StreamSplitterOptions = {}) {
    const { confirmForcedCut, ...tuning } = options
    this.opts = { ...DEFAULTS, ...tuning }
    this.confirmForcedCut = confirmForcedCut
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
      this.pendingForcedCut = null
      this.forcedCutHeld = false
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
    this.pendingForcedCut = null
    this.forcedCutHeld = false
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
    if (this.isFirst && !this.forcedCutHeld) return this.forcedFirstCut(b)
    return -1
  }

  private forcedFirstCut(b: string): number {
    if (this.pendingForcedCut === null) {
      const words = b.trim().split(/\s+/).filter(Boolean).length
      if (
        words < this.opts.forceFirstFragmentAfterWords &&
        b.length < this.opts.forceFirstFragmentAfterChars
      ) {
        return -1
      }
      const cut = forcedCut(b)
      if (cut < 0 || !this.confirmForcedCut) return cut
      this.pendingForcedCut = cut
    }
    const cut = this.pendingForcedCut
    if (b.length - cut < this.opts.forcedCutLookahead) return -1
    const head = b.slice(0, cut)
    const lookahead = b.slice(cut, cut + this.opts.forcedCutLookahead)
    if (this.confirmForcedCut?.(head, lookahead) !== false) return cut
    this.pendingForcedCut = null
    this.forcedCutHeld = true
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
