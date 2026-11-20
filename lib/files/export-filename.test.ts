import { exportFilenameStem, uniqueFilename } from "./export-filename"

describe("exportFilenameStem", () => {
  it.each([
    ["季度 报告", "季度-报告"],
    ["Отчёт за май", "Отчёт-за-май"],
    ["会議メモ", "会議メモ"],
    ["Weekly Report", "Weekly-Report"],
    ["v1.2 notes", "v1.2-notes"],
  ])("keeps %j readable as %j (N2)", (title, stem) => {
    expect(exportFilenameStem(title, "conversation")).toBe(stem)
  })

  it("gives two titles in another script two names, not one fallback", () => {
    expect(exportFilenameStem("项目计划", "conversation")).not.toBe(
      exportFilenameStem("周会纪要", "conversation")
    )
  })

  it("removes what a filesystem cannot take", () => {
    expect(exportFilenameStem('  a/b:c*d?"e"<f>|g\\h  ', "x")).toBe("a-b-c-d-e-f-g-h")
    expect(exportFilenameStem("tab\there\u0000nul", "x")).toBe("tab-here-nul")
    expect(exportFilenameStem("...hidden.", "x")).toBe("hidden")
  })

  it("drops bidirectional controls that can disguise an extension", () => {
    expect(exportFilenameStem("invoice\u202Etxt.exe", "x")).toBe("invoice-txt.exe")
  })

  it("composes a decomposed title before naming the file", () => {
    expect(exportFilenameStem("Cafe\u0301", "x")).toBe("Café")
  })

  it("falls back when nothing usable is left", () => {
    expect(exportFilenameStem("", "conversation")).toBe("conversation")
    expect(exportFilenameStem(" / : * ", "conversation")).toBe("conversation")
  })

  it("never yields a Windows device name", () => {
    expect(exportFilenameStem("CON", "x")).toBe("CON-file")
    expect(exportFilenameStem("lpt1", "x")).toBe("lpt1-file")
    expect(exportFilenameStem("console", "x")).toBe("console")
  })

  it("bounds the stem in bytes without splitting a character", () => {
    const stem = exportFilenameStem("长".repeat(200), "x")
    expect(new TextEncoder().encode(stem).byteLength).toBeLessThanOrEqual(180)
    expect(stem).toBe("长".repeat(60))

    const emoji = exportFilenameStem("👨‍👩‍👧".repeat(30), "x")
    expect(new TextEncoder().encode(emoji).byteLength).toBeLessThanOrEqual(180)
    expect(emoji.length % "👨‍👩‍👧".length).toBe(0)
  })
})

describe("uniqueFilename", () => {
  it("keeps a name nothing else has", () => {
    expect(uniqueFilename("a.md", ["b.md"])).toBe("a.md")
  })

  it("numbers a taken name from 2, skipping numbers already used", () => {
    expect(uniqueFilename("a.md", ["a.md"])).toBe("a (2).md")
    expect(uniqueFilename("a.md", ["a.md", "a (2).md", "a (3).md"])).toBe("a (4).md")
  })

  it("compares names as case-insensitive filesystems do", () => {
    expect(uniqueFilename("Report.md", ["report.MD"])).toBe("Report (2).md")
    expect(uniqueFilename("Café.md", ["Cafe\u0301.md"])).toBe("Café (2).md")
  })

  it("numbers before the last extension, and after a name without one", () => {
    expect(uniqueFilename("chat.animated.html", ["chat.animated.html"])).toBe(
      "chat.animated (2).html"
    )
    expect(uniqueFilename("README", ["README"])).toBe("README (2)")
    expect(uniqueFilename(".env", [".env"])).toBe(".env (2)")
  })
})
