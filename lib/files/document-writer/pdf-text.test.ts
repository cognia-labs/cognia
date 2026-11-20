import {
  assertPdfFontsDraw,
  breakProseLines,
  codeColumns,
  expandTabs,
  fitTableColumns,
  isWideCodePoint,
  needsUnicodePdfFont,
  normalizePdfText,
  PdfUnsupportedCharactersError,
  pdfGlyphs,
  proseMinimumWidth,
  proseNaturalWidth,
  unsupportedPdfCharacters,
  wrapCodeLine,
  type PdfGlyph,
  type PdfUnicodeCoverage,
} from "./pdf-text"

/** A unicode face covering the BMP except Hangul, like the bundled font. */
const NOTO_LIKE: PdfUnicodeCoverage = (codePoint) => !(codePoint >= 0xac00 && codePoint <= 0xd7a3)

const text = (glyphs: readonly PdfGlyph[]) => glyphs.map((glyph) => glyph.char).join("")
const lines = (rows: readonly PdfGlyph[][]) => rows.map(text)
const faces = (glyphs: readonly PdfGlyph[]) => glyphs.map((glyph) => glyph.face)

describe("which face draws a character", () => {
  it("rewrites typographic punctuation when no unicode face is embedded", () => {
    expect(text(pdfGlyphs("“quoted” — it’s… • €5", null))).toBe('"quoted" -- it\'s... · EUR5')
  })

  it("keeps the real punctuation once the unicode face is embedded", () => {
    const glyphs = pdfGlyphs("“中”", NOTO_LIKE)
    expect(text(glyphs)).toBe("“中”")
    expect(faces(glyphs)).toEqual(["unicode", "unicode", "unicode"])
  })

  it("draws Latin-1 with the standard face either way", () => {
    expect(faces(pdfGlyphs("café ½", NOTO_LIKE))).toEqual(Array(6).fill("standard"))
  })

  it("composes a decomposed accent into its Latin-1 letter", () => {
    expect(normalizePdfText("e\u0301")).toBe("\u00e9")
    expect(pdfGlyphs("e\u0301", null)).toEqual([{ char: "\u00e9", face: "standard" }])
  })

  it("drops invisible joiners and byte-order marks", () => {
    expect(text(pdfGlyphs("\ufeffa\u200bb\u2060c", null))).toBe("abc")
  })

  it("refuses a character no face draws instead of leaving it out", () => {
    expect(() => pdfGlyphs("ok 한", NOTO_LIKE)).toThrow(PdfUnsupportedCharactersError)
  })
})

describe("needsUnicodePdfFont", () => {
  it("is false for text the standard fonts draw, stand-ins included", () => {
    expect(needsUnicodePdfFont(["café", "“fine” – …", "á"])).toBe(false)
  })

  it("is true for Chinese, Cyrillic or Greek", () => {
    expect(needsUnicodePdfFont(["plain", "中文"])).toBe(true)
    expect(needsUnicodePdfFont(["Привет"])).toBe(true)
    expect(needsUnicodePdfFont(["λ"])).toBe(true)
  })

  it("is false for characters beyond the BMP, which no embedded face draws", () => {
    expect(needsUnicodePdfFont(["ok \u{1f600}"])).toBe(false)
  })
})

describe("unsupportedPdfCharacters", () => {
  it("names what is left outside Latin-1 without a unicode face, once each, in order", () => {
    expect(unsupportedPdfCharacters(["中文中 П"], null)).toEqual(["中", "文", "П"])
  })

  it("names only what the unicode face lacks once it is embedded (C09)", () => {
    expect(unsupportedPdfCharacters(["中文 한국 \u{1f600}"], NOTO_LIKE)).toEqual([
      "한",
      "국",
      "\u{1f600}",
    ])
  })

  it("never asks the unicode face about a character beyond the BMP", () => {
    const covers = jest.fn(() => true)
    expect(unsupportedPdfCharacters(["\u{20000}"], covers)).toEqual(["\u{20000}"])
    expect(covers).not.toHaveBeenCalled()
  })

  it("treats an emoji as one character, not two surrogates", () => {
    expect(unsupportedPdfCharacters(["ok \u{1f600}"], null)).toEqual(["\u{1f600}"])
  })

  it("caps how many it names", () => {
    const many = Array.from({ length: 20 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join("")
    expect(unsupportedPdfCharacters([many], null)).toHaveLength(8)
  })
})

describe("assertPdfFontsDraw", () => {
  it("throws a typed error carrying the characters", () => {
    let caught: unknown
    try {
      assertPdfFontsDraw(["Title", "正文"], null)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(PdfUnsupportedCharactersError)
    expect((caught as PdfUnsupportedCharactersError).characters).toEqual(["正", "文"])
  })

  it("passes text the embedded faces draw", () => {
    expect(() => assertPdfFontsDraw(["plain", "“quoted”"], null)).not.toThrow()
    expect(() => assertPdfFontsDraw(["标题", "Привет"], NOTO_LIKE)).not.toThrow()
  })
})

describe("isWideCodePoint", () => {
  it.each([
    ["中", true],
    ["。", true],
    ["あ", true],
    ["한", true],
    ["Ａ", true],
    ["a", false],
    ["П", false],
    ["“", false],
  ])("%s is wide: %s", (char, wide) => {
    expect(isWideCodePoint(char.codePointAt(0)!)).toBe(wide)
  })
})

describe("breakProseLines", () => {
  /** One unit per narrow glyph, two per wide one. */
  const widthOf = (glyph: PdfGlyph) => codeColumns(glyph)
  const wrap = (value: string, maxWidth: number) =>
    lines(breakProseLines(pdfGlyphs(value, NOTO_LIKE), maxWidth, widthOf))

  it("breaks Latin text at spaces and drops the space at the break", () => {
    expect(wrap("aa bb cc", 5)).toEqual(["aa bb", "cc"])
  })

  it("does not start a wrapped line with a space", () => {
    expect(wrap("aa   bb", 2)).toEqual(["aa", "bb"])
  })

  it("breaks between Chinese characters, which have no spaces between words", () => {
    expect(wrap("中文排版测试", 8)).toEqual(["中文排版", "测试"])
  })

  it("keeps closing punctuation off the start of a line", () => {
    expect(wrap("中文，排版", 4)).toEqual(["中", "文，", "排版"])
  })

  it("keeps opening punctuation off the end of a line", () => {
    expect(wrap("中文「引」", 6)).toEqual(["中文", "「引」"])
  })

  it("breaks between a Latin word and a Chinese character", () => {
    expect(wrap("Hello世界", 7)).toEqual(["Hello世", "界"])
  })

  it("cuts a word wider than the line between its characters", () => {
    expect(wrap("abcdefgh", 3)).toEqual(["abc", "def", "gh"])
  })

  it("starts a new line at a newline and keeps an empty paragraph as one empty line", () => {
    expect(wrap("a\n\nb", 10)).toEqual(["a", "", "b"])
    expect(wrap("", 10)).toEqual([""])
  })

  it("fits a word into a width that floating-point arithmetic left a hair short", () => {
    // A column sized to its widest word, less its padding: (w + 8) - 8 < w.
    const word = 0.13 + 0.13
    const width = word + 8 - 8
    expect(width).toBeLessThan(word)
    expect(lines(breakProseLines(pdfGlyphs("ab", null), width, () => 0.13))).toEqual(["ab"])
  })

  it("hands back the glyphs it was given, so styling rides along", () => {
    const styled = pdfGlyphs("aa bb", null).map((glyph, i) => ({ ...glyph, bold: i < 2 }))
    const [first, second] = breakProseLines(styled, 2, () => 1)
    expect(first.map((glyph) => glyph.bold)).toEqual([true, true])
    expect(second.map((glyph) => glyph.bold)).toEqual([false, false])
  })
})

describe("table column widths", () => {
  const widthOf = (glyph: PdfGlyph) => codeColumns(glyph)
  const glyphs = (value: string) => pdfGlyphs(value, NOTO_LIKE)

  it("measures prose unwrapped by its widest hard line", () => {
    expect(proseNaturalWidth(glyphs("ab cd\nabcdefg"), widthOf)).toBe(7)
    expect(proseNaturalWidth([], widthOf)).toBe(0)
  })

  it("measures the narrowest layout by the widest word, a wide character counting alone", () => {
    expect(proseMinimumWidth(glyphs("a bbbb cc"), widthOf)).toBe(4)
    expect(proseMinimumWidth(glyphs("中文排版"), widthOf)).toBe(2)
    expect(proseMinimumWidth(glyphs("中文，"), widthOf)).toBe(4)
    expect(proseMinimumWidth(glyphs("ab\nabc"), widthOf)).toBe(3)
  })

  it("keeps natural widths when the columns fit", () => {
    expect(fitTableColumns([10, 20], [5, 5], 40)).toEqual([10, 20])
  })

  it("gives each column its widest word, then shares the rest by what it would take", () => {
    // 30 + 90 > 60: floors 10 and 20, then 30 more split 20:70.
    const widths = fitTableColumns([30, 90], [10, 20], 60)
    expect(widths.reduce((sum, width) => sum + width, 0)).toBeCloseTo(60)
    expect(widths[0]).toBeCloseTo(10 + (30 * 20) / 90)
    expect(widths[1]).toBeCloseTo(20 + (30 * 70) / 90)
  })

  it("caps a long word at an even share, so it cannot crowd the other columns out", () => {
    // The URL column is cut between characters; the short column keeps all 40.
    const widths = fitTableColumns([500, 40], [500, 40], 100)
    expect(widths[0]).toBeCloseTo(60)
    expect(widths[1]).toBeCloseTo(40)
  })
})

describe("code layout", () => {
  const row = (value: string, columns: number) =>
    lines(wrapCodeLine(pdfGlyphs(value, NOTO_LIKE), columns))

  it("expands tabs to the next four-column stop, a wide character counting two", () => {
    expect(expandTabs("\tx")).toBe("    x")
    expect(expandTabs("ab\tc")).toBe("ab  c")
    expect(expandTabs("中\tx")).toBe("中  x")
  })

  it("keeps indentation and every space when it cuts a long line", () => {
    expect(row("    return a  +  b", 8)).toEqual(["    retu", "rn a  + ", " b"])
  })

  it("counts a wide character as two columns and never splits one", () => {
    expect(row("中文ab", 4)).toEqual(["中文", "ab"])
    expect(row("a中b", 2)).toEqual(["a", "中", "b"])
  })

  it("expands a tab to the stop of the whole line, not of the row", () => {
    expect(row("abcde\tf", 6)).toEqual(["abcde ", "  f"])
  })

  it("keeps a blank line as one empty row", () => {
    expect(wrapCodeLine([], 80)).toEqual([[]])
  })

  it("never cuts at less than two columns, so a wide character always fits", () => {
    expect(row("中", 0)).toEqual(["中"])
  })
})
