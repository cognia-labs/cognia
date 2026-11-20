import type { CogniaDB } from "@/lib/db/schema"
import type { OutboundQueueScope } from "@/lib/db/mobile-outbound-queue"

import {
  hostSettingsPatch,
  isMirroredSettingsClient,
  prepareSettingsMirror,
} from "./mirror-to-host"

jest.mock("@/lib/platform/detect", () => ({ isCapacitor: jest.fn(() => false) }))
jest.mock("@/lib/platform/web-companion", () => ({ hasWebCompanionTarget: jest.fn(() => false) }))
jest.mock("@/lib/db/mobile-outbound-queue", () => ({
  captureOutboundQueueScope: jest.fn(),
  enqueueInScope: jest.fn(),
}))

import { isCapacitor } from "@/lib/platform/detect"
import { hasWebCompanionTarget } from "@/lib/platform/web-companion"

const mockIsCapacitor = isCapacitor as jest.MockedFunction<typeof isCapacitor>
const mockHasWebCompanion = hasWebCompanionTarget as jest.MockedFunction<
  typeof hasWebCompanionTarget
>

describe("isMirroredSettingsClient", () => {
  beforeEach(() => {
    mockIsCapacitor.mockReturnValue(false)
    mockHasWebCompanion.mockReturnValue(false)
  })

  it("is false on the desktop, which owns its own settings row", () => {
    expect(isMirroredSettingsClient()).toBe(false)
  })

  it("is true on a Capacitor phone", () => {
    mockIsCapacitor.mockReturnValue(true)
    expect(isMirroredSettingsClient()).toBe(true)
  })

  it("is true in a browser pointed at a cloud server", () => {
    mockHasWebCompanion.mockReturnValue(true)
    expect(isMirroredSettingsClient()).toBe(true)
  })
})

describe("hostSettingsPatch", () => {
  it("keeps the writable keys", () => {
    expect(hostSettingsPatch({ theme: "dark", fontScale: "lg" })).toEqual({
      theme: "dark",
      fontScale: "lg",
    })
  })

  it("carries the appearance keys the embedded desktop section writes", () => {
    // The regression this module exists for: `/me/appearance` embeds the
    // desktop `<AppearanceSection />`, which writes these through the store.
    // They were allowlisted server-side but nothing ever sent them.
    const patch = {
      colorTheme: "nord",
      accentColor: "#ff0000",
      customCss: ".x{}",
      customCssEnabled: true,
    }
    expect(hostSettingsPatch(patch as never)).toEqual(patch)
  })

  it("sends a cleared key as null, which survives JSON where undefined does not", () => {
    // An appearance reset clears the optional colour preset with `undefined`.
    // JSON drops `undefined`, so the Host never heard of the clear and kept
    // the old preset.
    const writable = hostSettingsPatch({ colorTheme: undefined, theme: "system" })
    expect(writable).toEqual({ colorTheme: null, theme: "system" })
    expect(JSON.parse(JSON.stringify(writable))).toEqual({ colorTheme: null, theme: "system" })
  })

  it("drops non-writable keys instead of letting them fail the whole patch", () => {
    // The host rejects a patch outright if any key is disallowed, so sending a
    // mixed patch would lose the writable half too.
    const writable = hostSettingsPatch({
      theme: "dark",
      apiKey: "sk-secret",
      defaultWorkingDir: "/tmp",
    } as never)
    expect(writable).toEqual({ theme: "dark" })
    expect(JSON.stringify(writable)).not.toContain("sk-secret")
  })

  it("is null when nothing in the patch is writable", () => {
    expect(hostSettingsPatch({ apiKey: "sk-secret" } as never)).toBeNull()
  })

  it("does not carry the device-local keys that only mean something here", () => {
    // Pushing one device's biometric policy, microphone id or editor
    // performance tier onto another is wrong rather than merely useless.
    expect(
      hostSettingsPatch({
        biometricRequiredFor: { unlock: true },
        selectedMicId: "mic-1",
        workflowEditorPerformanceTier: "high",
        webrtcEnabled: false,
      } as never)
    ).toBeNull()
  })

  it("keeps the wallpaper library on the handset that holds its bytes", () => {
    // Off Tauri `saveImage()` can only write an `indexeddb` blobKey, which
    // addresses this webview's blob store and nothing else. Mirroring the array
    // put rows in the desktop's gallery that it could not open.
    expect(
      hostSettingsPatch({
        wallpapers: [
          {
            id: "w1",
            name: "Sunset",
            kind: "image",
            builtin: false,
            createdAt: 1,
            source: { kind: "image", storage: "indexeddb", blobKey: "w1", mime: "image/png" },
          },
        ],
      } as never)
    ).toBeNull()
  })

  it("does not carry transport config, which flows the other way", () => {
    expect(
      hostSettingsPatch({
        signalingUrl: "wss://example/signaling",
        iceServers: [],
        turnServers: [],
        turnProvider: { kind: "none" },
      } as never)
    ).toBeNull()
  })
})

describe("prepareSettingsMirror", () => {
  const db = { name: "active" } as unknown as CogniaDB
  const scopeFor = (target: CogniaDB) =>
    ({
      db: target,
      accountId: "acct_a",
      targetId: "host-1",
      assertActive() {},
    }) as never as OutboundQueueScope
  let enqueueJob: jest.Mock

  beforeEach(() => {
    enqueueJob = jest.fn().mockResolvedValue(undefined)
  })

  it("is null when this runtime owns its settings", () => {
    expect(
      prepareSettingsMirror(db, { isMirrored: () => false, captureScope: () => scopeFor(db) })
    ).toBeNull()
  })

  it("is null without a Host route, so an unpaired phone still saves locally", () => {
    expect(
      prepareSettingsMirror(db, { isMirrored: () => true, captureScope: () => null })
    ).toBeNull()
  })

  it("is null for a database that is not the active route's", () => {
    const other = { name: "other" } as unknown as CogniaDB
    expect(
      prepareSettingsMirror(other, { isMirrored: () => true, captureScope: () => scopeFor(db) })
    ).toBeNull()
  })

  it("queues one app_settings_update in the route's scope, carrying the writable keys", async () => {
    const scope = scopeFor(db)
    const mirror = prepareSettingsMirror(db, {
      isMirrored: () => true,
      captureScope: () => scope,
      enqueueJob,
    })
    expect(await mirror!.enqueue({ theme: "dark", apiKey: "sk-secret" } as never)).toEqual([
      "theme",
    ])
    expect(enqueueJob).toHaveBeenCalledTimes(1)
    expect(enqueueJob).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({
        command: "app_settings_update",
        payload: { patch: { theme: "dark" } },
        label: "theme",
      })
    )
  })

  it("queues nothing for a patch with no writable key", async () => {
    const mirror = prepareSettingsMirror(db, {
      isMirrored: () => true,
      captureScope: () => scopeFor(db),
      enqueueJob,
    })
    expect(await mirror!.enqueue({ selectedMicId: "mic" })).toEqual([])
    expect(enqueueJob).not.toHaveBeenCalled()
  })

  it("lets a queue failure reach the save", async () => {
    enqueueJob.mockRejectedValueOnce(new Error("quota exceeded"))
    const mirror = prepareSettingsMirror(db, {
      isMirrored: () => true,
      captureScope: () => scopeFor(db),
      enqueueJob,
    })
    await expect(mirror!.enqueue({ theme: "dark" })).rejects.toThrow("quota exceeded")
  })
})
