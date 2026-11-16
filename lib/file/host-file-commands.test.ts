/** @jest-environment jsdom */
import { transport } from "@/lib/tauri"
import { readTextFile, writeTextFile, ensureDir, defaultExportDir } from "./host-file-commands"

const TAURI_KEY = "__TAURI_INTERNALS__"

function setTauri(on: boolean) {
  if (on) (window as unknown as Record<string, unknown>)[TAURI_KEY] = {}
  else delete (window as unknown as Record<string, unknown>)[TAURI_KEY]
}

let callSpy: jest.SpiedFunction<typeof transport.call>

beforeEach(() => {
  setTauri(true)
  callSpy = jest.spyOn(transport, "call")
})

afterEach(() => {
  setTauri(false)
  jest.restoreAllMocks()
})

describe("filesystem commands", () => {
  it("readTextFile returns the string content", async () => {
    callSpy.mockResolvedValueOnce("file body")
    await expect(readTextFile("/p")).resolves.toBe("file body")
    expect(callSpy).toHaveBeenCalledWith("read_text_file", { path: "/p" })
  })

  it("writeTextFile forwards path + content", async () => {
    callSpy.mockResolvedValueOnce(undefined)
    await writeTextFile("/p", "data")
    expect(callSpy).toHaveBeenCalledWith("write_text_file", {
      path: "/p",
      content: "data",
    })
  })

  it("ensureDir forwards the path", async () => {
    callSpy.mockResolvedValueOnce(undefined)
    await ensureDir("/p")
    expect(callSpy).toHaveBeenCalledWith("ensure_dir", { path: "/p" })
  })

  it("defaultExportDir returns the resolved path", async () => {
    callSpy.mockResolvedValueOnce("/exports")
    await expect(defaultExportDir()).resolves.toBe("/exports")
    expect(callSpy).toHaveBeenCalledWith("default_export_dir")
  })
})
