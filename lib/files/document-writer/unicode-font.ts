// The bundled font the PDF writer embeds for text jsPDF's built-in fonts
// cannot draw (see `./pdf-text`). It is Noto Sans SC Regular, trimmed to the
// upstream font's BMP character map (`public/fonts/noto-sans-sc/README.md`
// says how it was made): simplified and traditional Chinese, kana, the Russian
// alphabet, unaccented Greek letters and typographic punctuation.
//
// The file lives under `public/`, so the static export ships it to the
// browser, the Tauri shell and the Capacitor app alike, and is read as a
// same-origin asset. It is about 10 MB, so it is fetched only when an export
// needs it, and not kept in memory between exports: the HTTP cache (the asset
// protocol on desktop and mobile) makes the next read cheap. jsPDF embeds a
// subset of it holding only the glyphs a PDF uses.

/** Where the font is and the names jsPDF registers it under. */
export const PDF_UNICODE_FONT = {
  /** Root-relative path of the asset in the static export. */
  path: "/fonts/noto-sans-sc/NotoSansSC-Regular.ttf",
  /** File name in jsPDF's virtual file system. */
  vfsName: "NotoSansSC-Regular.ttf",
  /** Font family name `setFont` selects it by. */
  family: "NotoSansSC",
} as const

/** The bundled PDF font could not be read, so text it would draw cannot be laid out. */
export class PdfFontUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`the bundled PDF font could not be loaded from ${PDF_UNICODE_FONT.path}`, { cause })
    this.name = "PdfFontUnavailableError"
  }
}

/** The first four bytes of a TrueType-outline font, the only kind jsPDF reads. */
const TRUETYPE_SIGNATURE = "\x00\x01\x00\x00"

/** `String.fromCharCode` takes its arguments on the stack; stay well below its limit. */
const BINARY_CHUNK = 0x8000

/**
 * Bytes as a binary string (one char per byte), the form jsPDF's virtual
 * file system takes a TrueType font in.
 */
export function toBinaryString(bytes: Uint8Array): string {
  let out = ""
  for (let start = 0; start < bytes.length; start += BINARY_CHUNK) {
    out += String.fromCharCode(...bytes.subarray(start, start + BINARY_CHUNK))
  }
  return out
}

/**
 * Read the bundled font as a binary string for `jsPDF.addFileToVFS`. Rejects
 * with `PdfFontUnavailableError` when the asset is missing, unreadable or not
 * a TrueType font.
 */
export async function loadPdfUnicodeFont(): Promise<string> {
  let bytes: Uint8Array
  try {
    const url = new URL(PDF_UNICODE_FONT.path, window.location.href).toString()
    const response = await fetch(url, { cache: "force-cache" })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    bytes = new Uint8Array(await response.arrayBuffer())
  } catch (error) {
    throw new PdfFontUnavailableError(error)
  }
  const binary = toBinaryString(bytes)
  if (!binary.startsWith(TRUETYPE_SIGNATURE)) {
    throw new PdfFontUnavailableError(new Error("the asset is not a TrueType font"))
  }
  return binary
}
