// Which font draws each character of a PDF, and how text is laid out in lines.
// Pure, so it runs in the light node test project.
//
// Two faces draw a PDF's text:
//
// - **standard**: jsPDF's built-in Helvetica / Courier. They are declared
//   WinAnsi, but jsPDF 4 only maps U+0000–U+00FF onto them. Anything above is
//   dropped ("“ ” — … € •" all vanish) or written as raw bytes (Chinese,
//   Cyrillic and Greek come out as garbage), and jsPDF reports nothing.
// - **unicode**: the bundled Noto Sans SC (`./unicode-font`), embedded only
//   when the text needs it. It draws simplified and traditional Chinese, kana,
//   the Russian alphabet, unaccented Greek letters and typographic
//   punctuation. jsPDF reads only its BMP character map, so nothing beyond
//   U+FFFF (emoji, CJK Extension B), and the font has no Hangul, no accented
//   Greek and no Ukrainian letters.
//
// A character goes to the standard face when it is Latin-1. Otherwise it goes
// to the unicode face when that face is embedded and covers it. Otherwise it
// is rewritten to a plain stand-in (curly quotes to straight ones), which keeps
// English prose from pulling in a 10 MB font. Whatever is left is refused with
// `PdfUnsupportedCharactersError`, naming the characters: a PDF that silently
// loses its text is worse than no PDF.

/** Typographic characters with a plain-text stand-in inside Latin-1. */
const STANDARD_FONT_REPLACEMENTS: Readonly<Record<string, string>> = {
  "\u2018": "'", // left single quote
  "\u2019": "'", // right single quote
  "\u201a": "'",
  "\u201b": "'",
  "\u2032": "'", // prime
  "\u201c": '"', // left double quote
  "\u201d": '"', // right double quote
  "\u201e": '"',
  "\u201f": '"',
  "\u2033": '"', // double prime
  "\u2010": "-", // hyphen
  "\u2011": "-", // non-breaking hyphen
  "\u2012": "-", // figure dash
  "\u2013": "-", // en dash
  "\u2212": "-", // minus sign
  "\u2014": "--", // em dash
  "\u2015": "--", // horizontal bar
  "\u2026": "...", // ellipsis
  "\u2022": "\u00b7", // bullet, drawn as the Latin-1 middle dot
  "\u2023": "\u00b7",
  "\u2043": "\u00b7",
  "\u25cf": "\u00b7",
  "\u25e6": "\u00b7",
  "\u2002": " ", // en space
  "\u2003": " ", // em space
  "\u2007": " ",
  "\u2009": " ", // thin space
  "\u200a": " ",
  "\u202f": " ", // narrow no-break space
  "\u200b": "", // zero-width space
  "\u200c": "",
  "\u200d": "",
  "\u2060": "", // word joiner
  "\ufeff": "", // byte-order mark
  "\u20ac": "EUR", // euro sign
  "\u2122": "(TM)",
  "\u2190": "<-",
  "\u2192": "->",
  "\u2194": "<->",
  "\u21d2": "=>",
  "\u2264": "<=",
  "\u2265": ">=",
  "\u2260": "!=",
}

/** The highest code point jsPDF draws with its standard fonts. */
const STANDARD_FONT_MAX_CODE_POINT = 0xff

/** jsPDF reads only a font's BMP character map. */
const BMP_MAX_CODE_POINT = 0xffff

/** How many distinct offending characters an error names. */
const MAX_REPORTED_CHARACTERS = 8

/** Code is laid out with tabs at this width; neither face draws a tab. */
export const CODE_TAB_WIDTH = 4

/** The face a glyph is drawn with. */
export type PdfFace = "standard" | "unicode"

/** One character as it is drawn: the character and the face drawing it. */
export interface PdfGlyph {
  char: string
  face: PdfFace
}

/** Consecutive glyphs of one face, drawn by one `text()` call. */
export interface PdfTextRun {
  face: PdfFace
  text: string
}

/**
 * Whether the embedded unicode face has a glyph for a code point, or `null`
 * when no unicode face is embedded.
 */
export type PdfUnicodeCoverage = ((codePoint: number) => boolean) | null

/** The text the PDF draws: composed (NFC), so "e" + U+0301 is the Latin-1 "é". */
export function normalizePdfText(text: string): string {
  return text.normalize("NFC")
}

const codePointOf = (char: string) => char.codePointAt(0) ?? 0

/**
 * The glyphs that draw `char`, or `null` when no face can: one glyph normally,
 * several for a stand-in ("…" as "..."), none for an invisible joiner.
 */
function glyphsFor(char: string, covers: PdfUnicodeCoverage): PdfGlyph[] | null {
  const codePoint = codePointOf(char)
  if (codePoint <= STANDARD_FONT_MAX_CODE_POINT) return [{ char, face: "standard" }]
  if (covers && codePoint <= BMP_MAX_CODE_POINT && covers(codePoint)) {
    return [{ char, face: "unicode" }]
  }
  const replacement = STANDARD_FONT_REPLACEMENTS[char]
  if (replacement === undefined) return null
  return Array.from(replacement, (part) => ({ char: part, face: "standard" as const }))
}

/**
 * Whether any of `texts` needs the unicode face: a BMP character outside
 * Latin-1 without a plain stand-in. Characters beyond the BMP do not count,
 * because no embedded face can draw them anyway.
 */
export function needsUnicodePdfFont(texts: Iterable<string>): boolean {
  for (const text of texts) {
    for (const char of normalizePdfText(text)) {
      const codePoint = codePointOf(char)
      if (codePoint <= STANDARD_FONT_MAX_CODE_POINT || codePoint > BMP_MAX_CODE_POINT) continue
      if (STANDARD_FONT_REPLACEMENTS[char] === undefined) return true
    }
  }
  return false
}

/**
 * The distinct characters of `texts` (in order of appearance, at most a
 * handful) that no face can draw.
 */
export function unsupportedPdfCharacters(
  texts: Iterable<string>,
  covers: PdfUnicodeCoverage
): string[] {
  const found: string[] = []
  for (const text of texts) {
    for (const char of normalizePdfText(text)) {
      if (found.includes(char) || glyphsFor(char, covers)) continue
      found.push(char)
      if (found.length === MAX_REPORTED_CHARACTERS) return found
    }
  }
  return found
}

/** The text uses characters none of the PDF writer's fonts can draw. */
export class PdfUnsupportedCharactersError extends Error {
  readonly characters: readonly string[]

  constructor(characters: readonly string[]) {
    super(`the PDF's fonts cannot draw: ${characters.join(" ")}`)
    this.name = "PdfUnsupportedCharactersError"
    this.characters = characters
  }
}

/** Throw `PdfUnsupportedCharactersError` when any of `texts` cannot be drawn. */
export function assertPdfFontsDraw(texts: Iterable<string>, covers: PdfUnicodeCoverage): void {
  const found = unsupportedPdfCharacters(texts, covers)
  if (found.length > 0) throw new PdfUnsupportedCharactersError(found)
}

/**
 * `text` as glyphs. Throws `PdfUnsupportedCharactersError` for a character no
 * face draws, rather than leaving it out; `assertPdfFontsDraw` runs first so
 * that never happens to a whole document halfway through.
 */
export function pdfGlyphs(text: string, covers: PdfUnicodeCoverage): PdfGlyph[] {
  const glyphs: PdfGlyph[] = []
  for (const char of normalizePdfText(text)) {
    const drawn = glyphsFor(char, covers)
    if (!drawn) throw new PdfUnsupportedCharactersError([char])
    glyphs.push(...drawn)
  }
  return glyphs
}

/** Glyphs grouped into runs of one face, in order. */
export function pdfTextRuns(glyphs: readonly PdfGlyph[]): PdfTextRun[] {
  const runs: PdfTextRun[] = []
  for (const glyph of glyphs) {
    const last = runs.at(-1)
    if (last && last.face === glyph.face) last.text += glyph.char
    else runs.push({ face: glyph.face, text: glyph.char })
  }
  return runs
}

/**
 * Whether a code point is drawn two columns wide in a monospace editor: CJK
 * ideographs and punctuation, kana, Hangul, fullwidth forms. The BMP part of
 * the table `cli/src/tui/markdown/width.ts` uses for terminal tables (that
 * project cannot be imported from here); nothing beyond the BMP reaches a PDF.
 */
export function isWideCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6)
  )
}

/**
 * Characters a line may not start with (closing punctuation, small kana, the
 * iteration and prolonged-sound marks) and may not end with (opening
 * punctuation): the basic line-breaking rules (kinsoku) of Chinese and
 * Japanese, plus their ASCII counterparts.
 */
const NO_LINE_START = new Set(
  Array.from(
    "、。，．：；？！）］｝〕〉》」』】〙〗〟’”｠»…‥・ー々〻ゝゞヽヾ" +
      "ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶ％" +
      ",.;:?!)]}%"
  )
)
const NO_LINE_END = new Set(Array.from("（［｛〔〈《「『【〘〖〝‘“｟«([{"))

const isSpace = (glyph: PdfGlyph) => glyph.char === " "

/**
 * Break prose into lines no wider than `maxWidth`.
 *
 * Lines break at spaces (a space at a break is dropped) and between wide
 * characters, since Chinese and Japanese put no spaces between words, but not
 * before closing punctuation or after opening punctuation. A word wider than a
 * whole line is cut between characters. `"\n"` starts a new line.
 */
export function breakProseLines(
  glyphs: readonly PdfGlyph[],
  maxWidth: number,
  widthOf: (glyph: PdfGlyph) => number
): PdfGlyph[][] {
  const lines: PdfGlyph[][] = []
  let paragraph: PdfGlyph[] = []
  for (const glyph of glyphs) {
    if (glyph.char === "\n") {
      lines.push(...breakParagraph(paragraph, maxWidth, widthOf))
      paragraph = []
    } else {
      paragraph.push(glyph)
    }
  }
  lines.push(...breakParagraph(paragraph, maxWidth, widthOf))
  return lines
}

/** Units that never break inside: a word, one wide character, or a space. */
function breakUnits(glyphs: readonly PdfGlyph[]): PdfGlyph[][] {
  const units: PdfGlyph[][] = []
  for (const glyph of glyphs) {
    const last = units.at(-1)
    const lastGlyph = last?.at(-1)
    const wide = isWideCodePoint(codePointOf(glyph.char))
    const joins =
      last !== undefined &&
      lastGlyph !== undefined &&
      !isSpace(glyph) &&
      !isSpace(lastGlyph) &&
      (NO_LINE_START.has(glyph.char) ||
        NO_LINE_END.has(lastGlyph.char) ||
        (!wide && !isWideCodePoint(codePointOf(lastGlyph.char))))
    if (joins) last.push(glyph)
    else units.push([glyph])
  }
  return units
}

function breakParagraph(
  glyphs: readonly PdfGlyph[],
  maxWidth: number,
  widthOf: (glyph: PdfGlyph) => number
): PdfGlyph[][] {
  const lines: PdfGlyph[][] = []
  let line: PdfGlyph[] = []
  let width = 0
  const flush = () => {
    while (line.length > 0 && isSpace(line[line.length - 1])) line.pop()
    lines.push(line)
    line = []
    width = 0
  }
  for (const unit of breakUnits(glyphs)) {
    const unitWidth = unit.reduce((sum, glyph) => sum + widthOf(glyph), 0)
    if (isSpace(unit[0])) {
      // A space never starts a wrapped line, and may overhang the margin
      // because it is dropped where the line breaks.
      if (line.length === 0 && lines.length > 0) continue
      line.push(...unit)
      width += unitWidth
      continue
    }
    if (width + unitWidth <= maxWidth) {
      line.push(...unit)
      width += unitWidth
      continue
    }
    if (line.some((glyph) => !isSpace(glyph))) flush()
    else {
      line = []
      width = 0
    }
    if (unitWidth <= maxWidth) {
      line.push(...unit)
      width = unitWidth
      continue
    }
    // Wider than a line on its own: cut between characters.
    for (const glyph of unit) {
      const glyphWidth = widthOf(glyph)
      if (line.length > 0 && width + glyphWidth > maxWidth) flush()
      line.push(glyph)
      width += glyphWidth
    }
  }
  if (line.length > 0 || lines.length === 0) flush()
  return lines
}

/** Expand tabs to `CODE_TAB_WIDTH` columns, as an editor showing the code would. */
export function expandTabs(line: string): string {
  if (!line.includes("\t")) return line
  let out = ""
  let column = 0
  for (const char of line) {
    if (char === "\t") {
      const spaces = CODE_TAB_WIDTH - (column % CODE_TAB_WIDTH)
      out += " ".repeat(spaces)
      column += spaces
    } else {
      out += char
      column += isWideCodePoint(codePointOf(char)) ? 2 : 1
    }
  }
  return out
}

/** How many monospace columns a glyph takes: two for a wide character. */
export function codeColumns(glyph: PdfGlyph): 1 | 2 {
  return isWideCodePoint(codePointOf(glyph.char)) ? 2 : 1
}

/**
 * Lay one line of code out at a fixed column width, keeping every space.
 *
 * Prose wrapping breaks at spaces and drops them, which is right for a
 * paragraph and wrong for code: indentation is meaning in Python, YAML and
 * Makefiles. A code line is cut at exactly `columns` columns instead, a wide
 * character counting two as it does in an editor. Tabs become spaces up to the
 * next `CODE_TAB_WIDTH` stop of the whole line, since neither face draws a
 * tab. An empty line stays one empty row.
 */
export function wrapCodeLine(glyphs: readonly PdfGlyph[], columns: number): PdfGlyph[][] {
  const width = Math.max(2, Math.floor(columns))
  const expanded: PdfGlyph[] = []
  let lineColumn = 0
  for (const glyph of glyphs) {
    if (glyph.char === "\t") {
      const spaces = CODE_TAB_WIDTH - (lineColumn % CODE_TAB_WIDTH)
      for (let i = 0; i < spaces; i += 1) expanded.push({ char: " ", face: "standard" })
      lineColumn += spaces
    } else {
      expanded.push(glyph)
      lineColumn += codeColumns(glyph)
    }
  }
  if (expanded.length === 0) return [[]]
  const rows: PdfGlyph[][] = []
  let row: PdfGlyph[] = []
  let used = 0
  for (const glyph of expanded) {
    const span = codeColumns(glyph)
    if (row.length > 0 && used + span > width) {
      rows.push(row)
      row = []
      used = 0
    }
    row.push(glyph)
    used += span
  }
  rows.push(row)
  return rows
}
