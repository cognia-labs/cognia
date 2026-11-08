import {
  AsciicastFileError,
  asciicastFileContent,
  recordingFileName,
  recordingFromAsciicast,
} from "./asciicast-file"
import type { TerminalRecording } from "./types"

const now = () => 1_700_000_000_000

function recording(overrides: Partial<TerminalRecording> = {}): TerminalRecording {
  return {
    id: "rec-1",
    sessionId: "s-1",
    title: "zsh",
    header: {
      version: 2,
      width: 100,
      height: 30,
      timestamp: 1_700_000_000,
      duration: 2.5,
      title: "zsh",
    },
    frames: [
      [0.1, "o", "$ echo hi\r\n"],
      [0.5, "r", "120x40"],
      [2.5, "o", "hi\r\n"],
    ],
    duration: 2.5,
    createdAt: 1_700_000_002_500,
    sizeBytes: 40,
    ...overrides,
  }
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (error) {
    return error instanceof AsciicastFileError ? error.code : "other"
  }
  return undefined
}

describe("recordingFromAsciicast", () => {
  it("round-trips what the dock saves", () => {
    const saved = recording()
    const loaded = recordingFromAsciicast(asciicastFileContent(saved), { now })
    expect(loaded.header).toMatchObject({ version: 2, width: 100, height: 30, duration: 2.5 })
    expect(loaded.frames).toEqual(saved.frames)
    expect(loaded.duration).toBe(2.5)
    expect(loaded.title).toBe("zsh")
  })

  it("takes the duration from the last frame when the header has none", () => {
    const text = [
      JSON.stringify({ version: 2, width: 80, height: 24 }),
      JSON.stringify([1.5, "o", "x"]),
      JSON.stringify([0.5, "o", "y"]),
    ].join("\n")
    const loaded = recordingFromAsciicast(text, { fileName: "build-log.cast", now })
    expect(loaded.duration).toBe(1.5)
    // Sorted by time, whatever the file's order.
    expect(loaded.frames.map((f) => f[0])).toEqual([0.5, 1.5])
    expect(loaded.title).toBe("build-log")
  })

  it("skips marker events it has nothing to draw for", () => {
    const text = [
      JSON.stringify({ version: 2, width: 80, height: 24 }),
      JSON.stringify([0.2, "m", "chapter"]),
      JSON.stringify([0.4, "o", "x"]),
    ].join("\n")
    expect(recordingFromAsciicast(text, { now }).frames).toEqual([[0.4, "o", "x"]])
  })

  it("names what is wrong with a file that is not a recording", () => {
    expect(codeOf(() => recordingFromAsciicast("   \n"))).toBe("empty")
    expect(codeOf(() => recordingFromAsciicast("plain log text"))).toBe("not-json")
    expect(
      codeOf(() => recordingFromAsciicast(JSON.stringify({ version: 1, width: 80, height: 24 })))
    ).toBe("unsupported-version")
    expect(
      codeOf(() => recordingFromAsciicast(JSON.stringify({ version: 2, width: 0, height: 24 })))
    ).toBe("bad-header")
    expect(codeOf(() => recordingFromAsciicast("[1,2,3]"))).toBe("bad-header")
    const badFrame = [
      JSON.stringify({ version: 2, width: 80, height: 24 }),
      JSON.stringify([-1, "o", "x"]),
    ].join("\n")
    expect(codeOf(() => recordingFromAsciicast(badFrame))).toBe("bad-frame")
    const brokenLine = [JSON.stringify({ version: 2, width: 80, height: 24 }), '[0.1, "o"'].join(
      "\n"
    )
    try {
      recordingFromAsciicast(brokenLine)
      throw new Error("expected a throw")
    } catch (error) {
      expect(error).toBeInstanceOf(AsciicastFileError)
      expect((error as AsciicastFileError).line).toBe(2)
    }
  })
})

describe("recordingFileName", () => {
  it("builds a filesystem-safe name from the title and the local start time", () => {
    const name = recordingFileName(recording({ title: 'ssh deploy@prod: "logs"/tail' }))
    expect(name).toMatch(/^ssh-deploy@prod-logs-tail-\d{4}-\d{2}-\d{2}-\d{4}\.cast$/)
  })

  it("falls back to a generic name for an empty title", () => {
    expect(recordingFileName(recording({ title: "  " }))).toMatch(/^terminal-.*\.cast$/)
  })
})
