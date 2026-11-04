import { standaloneDevicesRequiresHost } from "@/lib/runtime/surface-contract"

import {
  addsHostsToRegistry,
  COMPANION_ADD_HOST_HREF,
  DESKTOP_PAIR_HREF,
  devicePairHref,
} from "./pair-entry"

let tauri = false
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  isTauri: () => tauri,
}))

describe("devicePairHref", () => {
  it("opens the desktop's own pairing QR in Settings", () => {
    tauri = true
    expect(devicePairHref()).toBe(DESKTOP_PAIR_HREF)
  })

  it("is the surface contract's remedy everywhere else", () => {
    tauri = false
    expect(devicePairHref()).toBe(standaloneDevicesRequiresHost.remedy)
  })
})

describe("addsHostsToRegistry", () => {
  it("is the desktop alone, which drives other machines through the registry", () => {
    tauri = true
    expect(addsHostsToRegistry()).toBe(true)
  })

  it("routes every other shell to the companion pairing, which keeps the current Host", () => {
    tauri = false
    expect(addsHostsToRegistry()).toBe(false)
    expect(COMPANION_ADD_HOST_HREF).toBe("/pair?mode=add")
  })
})
