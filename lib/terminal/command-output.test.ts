import {
  extractMarkedCommandOutput,
  hasCommandEndMarker,
  joinOutput,
  outputEndLine,
  readBufferRange,
  stripTerminalEscapes,
} from "./command-output"
import type { BufferLineReader } from "./command-output"

/** Build a reader over a fixed array; lines outside range return null. */
function readerOf(lines: Array<string | null>): BufferLineReader {
  return (line) => (line >= 0 && line < lines.length ? lines[line] : null)
}

describe("readBufferRange", () => {
  it("collects lines in [start, end)", () => {
    const read = readerOf(["a", "b", "c", "d"])
    expect(readBufferRange(read, 1, 3)).toEqual(["b", "c"])
  })

  it("skips unreadable (null) lines rather than pushing blanks", () => {
    const read = readerOf(["a", null, "c"])
    expect(readBufferRange(read, 0, 3)).toEqual(["a", "c"])
  })

  it("clamps a negative start to 0", () => {
    const read = readerOf(["a", "b"])
    expect(readBufferRange(read, -5, 2)).toEqual(["a", "b"])
  })

  it("returns [] for inverted or non-finite ranges", () => {
    const read = readerOf(["a", "b"])
    expect(readBufferRange(read, 2, 1)).toEqual([])
    expect(readBufferRange(read, Number.NaN, 2)).toEqual([])
    expect(readBufferRange(read, 0, Number.POSITIVE_INFINITY)).toEqual([])
  })
})

describe("joinOutput", () => {
  it("joins with newlines and trims trailing blank rows", () => {
    expect(joinOutput(["one", "two", "", "  "])).toBe("one\ntwo")
  })

  it("preserves interior blank lines", () => {
    expect(joinOutput(["a", "", "b"])).toBe("a\n\nb")
  })

  it("returns empty string for all-blank input", () => {
    expect(joinOutput(["", "   ", ""])).toBe("")
    expect(joinOutput([])).toBe("")
  })
})

describe("outputEndLine", () => {
  it("returns the next command's start line", () => {
    expect(outputEndLine(10, [2, 10, 25, 40], 100)).toBe(25)
  })

  it("falls back to the cursor row for the most recent command", () => {
    expect(outputEndLine(40, [2, 10, 25, 40], 87)).toBe(87)
  })

  it("ignores start lines at or before this command", () => {
    expect(outputEndLine(25, [2, 10, 25], 60)).toBe(60)
  })
})

const C = (nonce = "n") => `\u001b]633;C;${nonce}\u0007`
const D = (code = 0, nonce = "n") => `\u001b]633;D;${nonce};${code}\u0007`

describe("stripTerminalEscapes", () => {
  // Same fixture as the Rust `strip_escapes_removes_osc_and_csi` test, so the
  // interactive and headless captures agree on what counts as text.
  it("removes OSC and CSI sequences and normalises line endings", () => {
    const text = `${C("nonce")}hello \u001b[32mgreen\u001b[0m\r\nworld\r\n${D(0, "nonce")}prompt>`
    expect(stripTerminalEscapes(text)).toBe("hello green\nworld\nprompt>")
  })

  it("accepts the ST terminator and drops two-byte escapes", () => {
    expect(stripTerminalEscapes("a\u001b]0;title\u001b\\b\u001b=c")).toBe("abc")
  })

  it("turns a bare carriage return into a line break", () => {
    expect(stripTerminalEscapes("10%\r50%\r100%")).toBe("10%\n50%\n100%")
  })
})

describe("extractMarkedCommandOutput", () => {
  it("returns only what the command printed between its C and D markers", () => {
    const raw = `$ ls\r\n${C()}a.txt\r\nb.txt\r\n${D()}$ `
    expect(extractMarkedCommandOutput(raw)).toBe("a.txt\nb.txt")
  })

  it("keeps output that has no trailing newline", () => {
    expect(extractMarkedCommandOutput(`${C()}no-newline${D()}$ `)).toBe("no-newline")
  })

  it("reports an empty string for a command that printed nothing", () => {
    expect(extractMarkedCommandOutput(`${C()}${D(1)}$ `)).toBe("")
  })

  it("uses the first command that finished, from its own pre-exec marker", () => {
    const raw = `${C()}stale\r\n${C()}fresh\r\n${D()}$ ${C()}next\r\n${D()}`
    expect(extractMarkedCommandOutput(raw)).toBe("fresh")
  })

  it("starts at the beginning when the shell sent no pre-exec marker", () => {
    expect(extractMarkedCommandOutput(`out\r\n${D()}PS> `)).toBe("out")
  })

  it("drops the trailing prompt line when no end marker arrived", () => {
    expect(extractMarkedCommandOutput(`${C()}hello\r\nworld\r\nPS D:\\repo>`)).toBe("hello\nworld")
    expect(extractMarkedCommandOutput(`${C()}prompt-only>`)).toBe("")
  })
})

describe("hasCommandEndMarker", () => {
  it("detects the end sequence", () => {
    expect(hasCommandEndMarker(`x${D()}`)).toBe(true)
    expect(hasCommandEndMarker(`x${C()}`)).toBe(false)
  })
})
