import {
  assertStandardPdfFontText,
  expandTabs,
  PdfUnsupportedCharactersError,
  toStandardPdfFontText,
  unsupportedStandardPdfFontCharacters,
  wrapMonospaceLine,
} from "./pdf-text"

describe("toStandardPdfFontText", () => {
  it("rewrites the typographic punctuation the built-in fonts drop", () => {
    expect(toStandardPdfFontText("“quoted” — it’s… • €5")).toBe('"quoted" -- it\'s... · EUR5')
  })

  it("leaves Latin-1 text alone", () => {
    expect(toStandardPdfFontText("café ü © ½ ß")).toBe("café ü © ½ ß")
  })

  it("drops invisible joiners and byte-order marks", () => {
    expect(toStandardPdfFontText("\ufeffa\u200bb\u2060c")).toBe("abc")
  })
})

describe("unsupportedStandardPdfFontCharacters", () => {
  it("names what is left outside Latin-1, once each, in order", () => {
    expect(unsupportedStandardPdfFontCharacters("中文中 П")).toEqual(["中", "文", "П"])
  })

  it("treats an emoji as one character, not two surrogates", () => {
    expect(unsupportedStandardPdfFontCharacters("ok \u{1f600}")).toEqual(["\u{1f600}"])
  })

  it("finds nothing in punctuation it can rewrite", () => {
    expect(unsupportedStandardPdfFontCharacters("“fine” – …")).toEqual([])
  })

  it("caps how many it names", () => {
    const many = Array.from({ length: 20 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join("")
    expect(unsupportedStandardPdfFontCharacters(many)).toHaveLength(8)
  })
})

describe("assertStandardPdfFontText", () => {
  it("throws a typed error carrying the characters", () => {
    let caught: unknown
    try {
      assertStandardPdfFontText(["Title", "正文"])
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(PdfUnsupportedCharactersError)
    expect((caught as PdfUnsupportedCharactersError).characters).toEqual(["正", "文"])
  })

  it("passes drawable text", () => {
    expect(() => assertStandardPdfFontText(["plain", "“quoted”"])).not.toThrow()
  })
})

describe("code layout", () => {
  it("expands tabs to the next four-column stop", () => {
    expect(expandTabs("\tx")).toBe("    x")
    expect(expandTabs("ab\tc")).toBe("ab  c")
  })

  it("keeps indentation and every space when it cuts a long line", () => {
    expect(wrapMonospaceLine("    return a  +  b", 8)).toEqual(["    retu", "rn a  + ", " b"])
  })

  it("keeps a blank line as one empty row", () => {
    expect(wrapMonospaceLine("", 80)).toEqual([""])
  })

  it("never cuts at less than one column", () => {
    expect(wrapMonospaceLine("ab", 0)).toEqual(["a", "b"])
  })
})
