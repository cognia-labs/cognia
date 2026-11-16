jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(), transport: { call: jest.fn() } }))

import { isTauri, transport } from "@/lib/tauri"
import { confinedOps, ensureDirConfined, writeTextFileConfined } from "./confined-ops"

const mockedIsTauri = isTauri as unknown as jest.Mock
const mockedCall = transport.call as unknown as jest.Mock

beforeEach(() => {
  mockedIsTauri.mockReset()
  mockedCall.mockReset().mockResolvedValue(undefined)
})

describe("confined commands", () => {
  it("writeTextFileConfined forwards path, content, and allowed roots", async () => {
    await writeTextFileConfined("/w/a.txt", "data", ["/w"])
    expect(mockedCall).toHaveBeenCalledWith("write_text_file_confined", {
      path: "/w/a.txt",
      content: "data",
      allowedRoots: ["/w"],
    })
  })

  it("ensureDirConfined forwards path and allowed roots", async () => {
    await ensureDirConfined("/w/sub", ["/w"])
    expect(mockedCall).toHaveBeenCalledWith("ensure_dir_confined", {
      path: "/w/sub",
      allowedRoots: ["/w"],
    })
  })
})

describe("confinedOps (desktop)", () => {
  beforeEach(() => mockedIsTauri.mockReturnValue(true))

  it("writeText forwards path/content/roots to the confined command", async () => {
    await confinedOps.writeText("/w/a.txt", "data", ["/w"])
    expect(mockedCall).toHaveBeenCalledWith("write_text_file_confined", {
      path: "/w/a.txt",
      content: "data",
      allowedRoots: ["/w"],
    })
  })

  it("mkdir forwards path/roots to the confined command", async () => {
    await confinedOps.mkdir("/w/sub", ["/w"])
    expect(mockedCall).toHaveBeenCalledWith("ensure_dir_confined", {
      path: "/w/sub",
      allowedRoots: ["/w"],
    })
  })
})

describe("confinedOps (web mode rejects)", () => {
  beforeEach(() => mockedIsTauri.mockReturnValue(false))

  it("writeText throws and never calls the command", async () => {
    await expect(confinedOps.writeText("/w/a", "x", ["/w"])).rejects.toThrow(/desktop app/i)
    expect(mockedCall).not.toHaveBeenCalled()
  })

  it("mkdir throws and never calls the command", async () => {
    await expect(confinedOps.mkdir("/w/a", ["/w"])).rejects.toThrow(/desktop app/i)
    expect(mockedCall).not.toHaveBeenCalled()
  })
})
