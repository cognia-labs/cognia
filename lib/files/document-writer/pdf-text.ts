// What the PDF writer can draw with jsPDF's built-in fonts, and how code lines
// are laid out on a page. Pure, so it runs in the light node test project.
//
// jsPDF's standard fonts (Helvetica, Courier) are declared WinAnsi, but jsPDF 4
// only maps U+0000–U+00FF onto them. Anything above is dropped ("“ ” — … € •"
// all vanish) or written as raw bytes (Chinese, Cyrillic, Greek and emoji come
// out as garbage), and jsPDF reports nothing. A PDF that silently loses its
// text is worse than no PDF, so the writer:
//
// - rewrites typographic punctuation that has a plain equivalent, which keeps
//   ordinary English prose (curly quotes, dashes, ellipses, bullets) readable;
// - refuses with `PdfUnsupportedCharactersError` when anything else outside
//   Latin-1 is left, naming the characters, instead of producing garbage.

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

/** How many distinct offending characters an error names. */
const MAX_REPORTED_CHARACTERS = 8

/** Code is laid out with tabs at this width; the standard fonts draw no tab. */
export const CODE_TAB_WIDTH = 4

/** Text with typographic punctuation rewritten to what the standard fonts draw. */
export function toStandardPdfFontText(text: string): string {
  let out = ""
  for (const char of text) out += STANDARD_FONT_REPLACEMENTS[char] ?? char
  return out
}

/**
 * The distinct characters (in order of appearance, at most a handful) that the
 * standard fonts cannot draw, after `toStandardPdfFontText`.
 */
export function unsupportedStandardPdfFontCharacters(text: string): string[] {
  const found: string[] = []
  for (const char of toStandardPdfFontText(text)) {
    if ((char.codePointAt(0) ?? 0) <= STANDARD_FONT_MAX_CODE_POINT) continue
    if (found.includes(char)) continue
    found.push(char)
    if (found.length === MAX_REPORTED_CHARACTERS) break
  }
  return found
}

/** The text uses characters the PDF writer's built-in fonts cannot draw. */
export class PdfUnsupportedCharactersError extends Error {
  readonly characters: readonly string[]

  constructor(characters: readonly string[]) {
    super(`the PDF's built-in fonts cannot draw: ${characters.join(" ")}`)
    this.name = "PdfUnsupportedCharactersError"
    this.characters = characters
  }
}

/** Throw `PdfUnsupportedCharactersError` when any of `texts` cannot be drawn. */
export function assertStandardPdfFontText(texts: Iterable<string>): void {
  const found: string[] = []
  for (const text of texts) {
    for (const char of unsupportedStandardPdfFontCharacters(text)) {
      if (!found.includes(char)) found.push(char)
    }
    if (found.length >= MAX_REPORTED_CHARACTERS) break
  }
  if (found.length > 0)
    throw new PdfUnsupportedCharactersError(found.slice(0, MAX_REPORTED_CHARACTERS))
}

/** Expand tabs to `CODE_TAB_WIDTH` columns, as an editor showing the code would. */
export function expandTabs(line: string): string {
  if (!line.includes("\t")) return line
  let out = ""
  for (const char of line) {
    if (char === "\t") out += " ".repeat(CODE_TAB_WIDTH - (out.length % CODE_TAB_WIDTH))
    else out += char
  }
  return out
}

/**
 * Lay one line of code out at a fixed character width, keeping every space.
 *
 * Prose wrapping (`splitTextToSize`) breaks at spaces and drops them, which is
 * right for a paragraph and wrong for code: indentation is meaning in Python,
 * YAML and Makefiles. A monospace line is cut at exactly `charsPerLine`
 * columns instead; an empty line stays one empty row.
 */
export function wrapMonospaceLine(line: string, charsPerLine: number): string[] {
  const width = Math.max(1, Math.floor(charsPerLine))
  const expanded = Array.from(expandTabs(line))
  if (expanded.length === 0) return [""]
  const rows: string[] = []
  for (let start = 0; start < expanded.length; start += width) {
    rows.push(expanded.slice(start, start + width).join(""))
  }
  return rows
}
