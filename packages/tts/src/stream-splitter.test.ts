import { SentenceStreamSplitter } from "./stream-splitter"

describe("SentenceStreamSplitter", () => {
  it("cuts the first fragment on a wide separator once past the minimum length", () => {
    const s = new SentenceStreamSplitter()
    // "Sure thing," — comma is a first-fragment separator, and we're past 10 chars.
    expect(s.push("Sure thing, let me check")).toEqual(["Sure thing,"])
  })

  it("does not cut before the minimum first-fragment length", () => {
    const s = new SentenceStreamSplitter()
    // "Hi, " has a comma but is under 10 chars — hold.
    expect(s.push("Hi, ")).toEqual([])
    // The full stop is the last character: the next token decides whether it
    // ends the sentence, so the fragment waits for it (or for flush).
    expect(s.push("everyone here.")).toEqual([])
    expect(s.push(" More")).toEqual(["Hi, everyone here."])
  })

  it("switches to sentence enders (narrow set) after the first fragment", () => {
    const s = new SentenceStreamSplitter()
    // First fragment cuts on the comma…
    expect(s.push("First part, ")).toEqual(["First part,"])
    // …after which a comma no longer splits — only sentence enders do.
    expect(s.push("still going, and now done. Next")).toEqual(["still going, and now done."])
  })

  it("force-emits the first fragment after enough words without a separator", () => {
    const s = new SentenceStreamSplitter({ forceFirstFragmentAfterWords: 5 })
    // Five words, no separator → forced out so first audio isn't held up. The
    // last word may still be growing ("fiv" + "e"), so the cut backs up to
    // the last whitespace and keeps it buffered.
    expect(s.push("one two three four five")).toEqual(["one two three four"])
    expect(s.flush()).toBe("five")
  })

  it("force-emits the first fragment by characters for CJK (no spaces)", () => {
    const s = new SentenceStreamSplitter({ forceFirstFragmentAfterChars: 12 })
    // No spaces → word-count force can't fire; the char cap does.
    expect(s.push("这是一段没有标点的中文流式文本内容")).toHaveLength(1)
  })

  it("cuts on a Chinese full stop past the minimum length", () => {
    const s = new SentenceStreamSplitter()
    // 10 chars then 。 at index 9 → first fragment cut there; 再见 stays buffered.
    expect(s.push("你好呀今天天气不错。再见")).toEqual(["你好呀今天天气不错。"])
  })

  it("emits multiple fragments from a single push", () => {
    const s = new SentenceStreamSplitter({ minFirstFragmentLength: 1, minSentenceLength: 1 })
    expect(s.push("One. Two. Three.")).toEqual(["One.", "Two."])
    expect(s.flush()).toBe("Three.")
  })

  it("never cuts inside a token on ASCII punctuation", () => {
    const s = new SentenceStreamSplitter()
    // An address, a decimal and an abbreviation all carry a full stop with no
    // whitespace after it. Cutting there would read "3." / "14" aloud and let
    // half an address pass the per-fragment PII gate on its own.
    expect(s.push("Write to alice@example.com about pi 3.14 e.g.today")).toEqual([])
    expect(s.push(". Then")).toEqual(["Write to alice@example.com about pi 3.14 e.g.today."])
  })

  it("cuts after closing quotes that follow the punctuation", () => {
    const s = new SentenceStreamSplitter({ minFirstFragmentLength: 1 })
    expect(s.push('He said "stop." Then left')).toEqual(['He said "stop."'])
  })

  it("does not force-cut the first fragment through a trailing ASCII run", () => {
    const s = new SentenceStreamSplitter({ forceFirstFragmentAfterChars: 12 })
    // Unspaced CJK followed by an address still arriving: cut before the run.
    expect(s.push("请把文件发给我的邮箱alice@exa")).toEqual(["请把文件发给我的邮箱"])
    expect(s.push("mple.com")).toEqual([])
    expect(s.flush()).toBe("alice@example.com")
  })

  it("does not force-cut a buffer that is one unbroken ASCII run", () => {
    const s = new SentenceStreamSplitter({ forceFirstFragmentAfterChars: 12 })
    expect(s.push("https://example.com/a/very/long/path")).toEqual([])
  })

  it("flush returns the buffered tail once, then nothing", () => {
    const s = new SentenceStreamSplitter()
    s.push("An incomplete tail with no ender")
    expect(s.flush()).toBe("An incomplete tail with no ender")
    expect(s.flush()).toBeNull()
  })

  it("flush returns null when nothing is buffered", () => {
    const s = new SentenceStreamSplitter()
    expect(s.flush()).toBeNull()
  })

  describe("confirmed forced cuts", () => {
    const opts = { forceFirstFragmentAfterWords: 5, forcedCutLookahead: 10 }

    it("waits for the lookahead, then takes the cut where it first fell", () => {
      const confirm = jest.fn(() => true)
      const s = new SentenceStreamSplitter({ ...opts, confirmForcedCut: confirm })
      // The forced cut falls before "five"; the lookahead is still short.
      expect(s.push("one two three four five")).toEqual([])
      expect(confirm).not.toHaveBeenCalled()
      expect(s.push(" six seven")).toEqual(["one two three four"])
      expect(confirm).toHaveBeenCalledTimes(1)
      expect(confirm).toHaveBeenCalledWith("one two three four ", "five six s")
      expect(s.flush()).toBe("five six seven")
    })

    it("holds a refused cut until a separator, however long the text grows", () => {
      // A spaced card number straddles the cut: cutting would send half of it.
      const confirm = jest.fn(
        (head: string, lookahead: string) => !`${head}${lookahead}`.includes("4111 1111 1111 1111")
      )
      const s = new SentenceStreamSplitter({
        ...opts,
        forcedCutLookahead: 20,
        confirmForcedCut: confirm,
      })
      expect(s.push("my card is 4111 1111")).toEqual([])
      expect(s.push(" 1111 1111 and then many more words follow")).toEqual([])
      expect(confirm).toHaveBeenCalledTimes(1)
      expect(s.push(" without stopping")).toEqual([])
      expect(confirm).toHaveBeenCalledTimes(1)
      expect(s.push(", done")).toEqual([
        "my card is 4111 1111 1111 1111 and then many more words follow without stopping,",
      ])
      expect(s.flush()).toBe("done")
    })

    it("hands a refused fragment over whole at flush", () => {
      const s = new SentenceStreamSplitter({ ...opts, confirmForcedCut: () => false })
      expect(s.push("call me on 415 555 0100 any time you like")).toEqual([])
      expect(s.flush()).toBe("call me on 415 555 0100 any time you like")
    })

    it("lets a separator inside the lookahead cut first, without asking", () => {
      const confirm = jest.fn(() => false)
      const s = new SentenceStreamSplitter({ ...opts, confirmForcedCut: confirm })
      expect(s.push("one two three four five")).toEqual([])
      expect(s.push(" six. Seven")).toEqual(["one two three four five six."])
      expect(confirm).not.toHaveBeenCalled()
    })
  })
})
