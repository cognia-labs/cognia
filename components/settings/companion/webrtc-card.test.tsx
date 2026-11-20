import { selectOption } from "@/lib/testing/select-option"
/**
 * WebRtcCard — covers the input parser, default population, save round-trip,
 * the new per-device tier list, and the consecutive-poll-failure banner.
 *
 * The Dexie schema is exercised through the real `lib/db/settings.ts`; the
 * Jest jsdom env wires up `fake-indexeddb` in `jest.setup.ts` so reads/writes
 * complete synchronously enough that we can drive the UI with React Testing
 * Library without mocking the db.
 *
 * To exercise the polling effect we mock `@/lib/tauri` so `isTauri()` returns
 * `true` and `transport.call` resolves with whatever the test wants for the
 * two signaling commands.
 */

import "fake-indexeddb/auto"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import en from "@/i18n/messages/en.json"

import {
  WebRtcCard,
  deleteSecrets,
  parseServers,
  parseTtl,
  persistTurnProvider,
  persistTurnServers,
  redactServerLine,
  referencedSecrets,
  storedTurnCredentials,
  stringifyServers,
  unreferencedSecrets,
  TierDot,
  type DeviceTierEntry,
  type FormState,
  type MintedSecrets,
} from "./webrtc-card"
import { __setProviderSecretStore } from "@/lib/credentials/turn-provisioning"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import {
  KEYRING_CREDENTIAL_PREFIX,
  __setTurnCredentialBackend,
  isKeyringSentinel,
  keyIdOfSentinel,
} from "@/lib/credentials/turn-credentials"
import { saveSettings, getSettings } from "@/lib/db/settings"

// The real settings module, with `saveSettings` behind a jest.fn so a test can
// make one save fail after the card has written its keyring entries.
jest.mock("@/lib/db/settings", () => {
  const actual = jest.requireActual("@/lib/db/settings")
  return { ...actual, saveSettings: jest.fn(actual.saveSettings) }
})

jest.mock("sonner", () => ({
  toast: Object.assign(jest.fn(), {
    success: jest.fn(),
    error: jest.fn(),
    warning: jest.fn(),
  }),
}))

// Mock @/lib/tauri so isTauri() returns true and transport.call is a jest fn
// we can program per test. The Dexie path (saveSettings/getSettings) keeps
// using the real `lib/db/settings.ts`.
const mockTransportCall = jest.fn()
jest.mock("@/lib/tauri", () => ({
  isTauri: () => true,
  transport: {
    call: (name: string, params?: Record<string, unknown>) => {
      if (name.startsWith("companion_signaling_")) {
        throw new Error("Desktop signaling must use local IPC")
      }
      return mockTransportCall(name, params)
    },
    subscribe: jest.fn(),
  },
  localTransport: {
    call: (name: string, params?: Record<string, unknown>) => mockTransportCall(name, params),
    subscribe: jest.fn(),
  },
}))

function renderCard() {
  return render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <WebRtcCard />
    </NextIntlClientProvider>
  )
}

// In-memory TURN credential store so the production code's
// auto-selected `TauriKeyringStore` (which would invoke
// `secret_store_*` over Tauri IPC) is replaced with a deterministic
// test backend. Restored in afterAll so other test files aren't
// affected.
class TestTurnCredentialStore {
  readonly map = new Map<string, { username: string; credential: string }>()
  async save(keyId: string, value: { username: string; credential: string }): Promise<void> {
    this.map.set(keyId, { ...value })
  }
  async load(keyId: string): Promise<{ username: string; credential: string } | null> {
    return this.map.get(keyId) ? { ...this.map.get(keyId)! } : null
  }
  async delete(keyId: string): Promise<void> {
    this.map.delete(keyId)
  }
}
let turnStore: TestTurnCredentialStore
const saveSettingsMock = saveSettings as jest.MockedFunction<typeof saveSettings>
const realSaveSettings =
  jest.requireActual<typeof import("@/lib/db/settings")>("@/lib/db/settings").saveSettings
const noneMinted = (): MintedSecrets => ({ turn: [], provider: [] })

beforeEach(() => {
  jest.clearAllMocks()
  mockTransportCall.mockImplementation(() =>
    Promise.reject(new Error("not configured for this test"))
  )
  turnStore = new TestTurnCredentialStore()
  __setTurnCredentialBackend(turnStore)
  saveSettingsMock.mockImplementation(realSaveSettings)
})

afterAll(() => {
  __setTurnCredentialBackend(null)
})

describe("parseServers", () => {
  it("accepts a STUN URL in the STUN field", () => {
    expect(parseServers("stun:stun.l.google.com:19302", "ice")).toEqual({
      servers: [{ urls: "stun:stun.l.google.com:19302" }],
      invalid: [],
    })
  })

  it("accepts a TURN URL with credentials in the TURN field", () => {
    const text = "turn:turn.example.com:3478?transport=udp|alice|s3cr3t"
    expect(parseServers(text, "turn")).toEqual({
      servers: [
        {
          urls: "turn:turn.example.com:3478?transport=udp",
          username: "alice",
          credential: "s3cr3t",
        },
      ],
      invalid: [],
    })
  })

  // Regression (R5): the STUN list is stored as typed, so a TURN line accepted
  // here reached Dexie with its credential in plaintext, past the keyring.
  it("rejects TURN entries in the STUN field, redacting their credentials", () => {
    const text = [
      "turn:turn.example.com:3478|alice|s3cr3t",
      "turns:turn.example.com:5349?transport=tcp|bob|hunter2",
    ].join("\n")
    const out = parseServers(text, "ice")
    expect(out).toEqual({
      servers: [],
      invalid: [
        { value: "turn:turn.example.com:3478|•••", reason: "wrong-field" },
        { value: "turns:turn.example.com:5349?transport=tcp|•••", reason: "wrong-field" },
      ],
    })
    expect(JSON.stringify(out)).not.toMatch(/alice|s3cr3t|bob|hunter2/)
  })

  it("rejects a credential suffix on a STUN URL", () => {
    expect(parseServers("stun:a.example:3478|user|pass", "ice")).toEqual({
      servers: [],
      invalid: [{ value: "stun:a.example:3478|•••", reason: "malformed" }],
    })
  })

  it("rejects STUN entries in the TURN field", () => {
    expect(parseServers("stun:a.example:3478", "turn")).toEqual({
      servers: [],
      invalid: [{ value: "stun:a.example:3478", reason: "wrong-field" }],
    })
  })

  it("rejects TURN entries that are missing credentials", () => {
    expect(parseServers("turn:turn.example.com:3478", "turn")).toEqual({
      servers: [],
      invalid: [{ value: "turn:turn.example.com:3478", reason: "malformed" }],
    })
  })

  it("skips blank and commented lines", () => {
    const text = ["", "# a comment", "stun:a.example:3478", "  "].join("\n")
    expect(parseServers(text, "ice")).toEqual({
      servers: [{ urls: "stun:a.example:3478" }],
      invalid: [],
    })
  })

  it("flags non-stun/turn schemes in either field", () => {
    for (const field of ["ice", "turn"] as const) {
      expect(parseServers("http://nope", field)).toEqual({
        servers: [],
        invalid: [{ value: "http://nope", reason: "malformed" }],
      })
    }
  })

  it("rejects malformed ports, unsupported query parameters, and TURN-TLS over UDP", () => {
    const text = [
      "turn:turn.example.com:70000?transport=udp|u|p",
      "turn:turn.example.com:3478?foo=bar|u|p",
      "turns:turn.example.com:5349?transport=udp|u|p",
    ].join("\n")
    expect(parseServers(text, "turn")).toEqual({
      servers: [],
      invalid: [
        { value: "turn:turn.example.com:70000?transport=udp|•••", reason: "malformed" },
        { value: "turn:turn.example.com:3478?•••|•••", reason: "malformed" },
        { value: "turns:turn.example.com:5349?transport=udp|•••", reason: "malformed" },
      ],
    })
  })

  it("accepts bracketed IPv6 and TURN-TLS over TCP", () => {
    expect(parseServers("turns:[2001:db8::1]:5349?transport=tcp|alice|secret", "turn")).toEqual({
      servers: [
        {
          urls: "turns:[2001:db8::1]:5349?transport=tcp",
          username: "alice",
          credential: "secret",
        },
      ],
      invalid: [],
    })
  })
})

describe("redactServerLine", () => {
  it("keeps a URL without secrets as it is", () => {
    expect(redactServerLine("stun:a.example:3478")).toBe("stun:a.example:3478")
    expect(redactServerLine("turn:t.example:3478?transport=udp")).toBe(
      "turn:t.example:3478?transport=udp"
    )
  })

  it("masks the credential suffix, userinfo and any other query", () => {
    expect(redactServerLine("turn:t.example|alice|s3cr3t")).toBe("turn:t.example|•••")
    expect(redactServerLine("turn:alice:s3cr3t@t.example")).toBe("turn:•••@t.example")
    expect(redactServerLine("turn:t.example?password=s3cr3t")).toBe("turn:t.example?•••")
  })
})

describe("stringifyServers", () => {
  it("renders one URL per line", () => {
    expect(stringifyServers([{ urls: "stun:a.example" }, { urls: "stun:b.example" }])).toBe(
      "stun:a.example\nstun:b.example"
    )
  })

  it("appends credentials as |user|cred", () => {
    expect(
      stringifyServers([
        {
          urls: "turn:t.example",
          username: "u",
          credential: "p",
        },
      ])
    ).toBe("turn:t.example|u|p")
  })
})

describe("TierDot", () => {
  it("renders a circle for each tier", () => {
    const { rerender, container } = render(<TierDot tier="connected" />)
    expect(container.querySelector("svg")).toBeInTheDocument()
    rerender(<TierDot tier="failed" />)
    expect(container.querySelector("svg")).toBeInTheDocument()
  })

  it("includes a tier-specific color class", () => {
    const { container, rerender } = render(<TierDot tier="connected" />)
    // SVG `className` is an `SVGAnimatedString` in jsdom; read the class
    // attribute directly so the assertion works against a plain string.
    expect(container.querySelector("svg")?.getAttribute("class") ?? "").toContain("emerald")
    rerender(<TierDot tier="negotiating" />)
    expect(container.querySelector("svg")?.getAttribute("class") ?? "").toContain("amber")
  })
})

describe("WebRtcCard — form & i18n", () => {
  beforeEach(async () => {
    try {
      await getDb().delete()
    } catch {
      // db not yet created — fine
    }
    __resetDbForTesting()
  })

  it("renders the title and the toggle", async () => {
    renderCard()
    expect(await screen.findByText(/WebRTC remote access/i)).toBeInTheDocument()
    expect(screen.getByTestId("webrtc-enable-toggle")).toBeInTheDocument()
  })

  it("populates the default signaling URL on first paint", async () => {
    renderCard()
    const input = await screen.findByLabelText(/Signaling server/i)
    await waitFor(() => expect(input).toHaveValue("wss://signaling.cognia.cn/signaling"))
  })

  it("places the TURN textarea placeholder via the translation key, not a literal", async () => {
    renderCard()
    // The actual placeholder value lives in `en.json`. We assert the
    // attribute matches the i18n value to prove the hard-coded literal at
    // line 223 (pre-ADR-0021 follow-up) is gone.
    const turn = await screen.findByLabelText(/TURN servers/i)
    expect(turn).toHaveAttribute("placeholder", en.mobile.companion.webrtc.turnServersPlaceholder)
  })

  it("uses the dedicated save button label", async () => {
    renderCard()
    const btn = await screen.findByTestId("webrtc-save")
    expect(btn).toHaveTextContent(en.mobile.companion.webrtc.saveButton)
  })

  it("rejects an invalid signaling URL", async () => {
    const { toast } = await import("sonner")
    renderCard()
    const input = await screen.findByLabelText(/Signaling server/i)
    await waitFor(() => expect(input).toBeEnabled())
    await userEvent.clear(input)
    await userEvent.type(input, "http://no-wss.example")
    await userEvent.click(screen.getByTestId("webrtc-save"))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
  })
})

describe("WebRtcCard — status block", () => {
  beforeEach(async () => {
    try {
      await getDb().delete()
    } catch {
      // db not yet created — fine
    }
    __resetDbForTesting()
  })

  it("renders the disabled state when the hub is off", async () => {
    mockTransportCall.mockImplementation((name: string) => {
      if (name === "companion_signaling_status") {
        return Promise.resolve({
          enabled: false,
          signalingUrl: "wss://signaling.cognia.cn/signaling",
          registeredDevices: [],
        })
      }
      if (name === "companion_signaling_devices_status") {
        return Promise.resolve([])
      }
      return Promise.reject(new Error(`unexpected ${name}`))
    })
    renderCard()
    await screen.findByTestId("webrtc-status-disabled")
  })

  it("renders the empty-state hint when no devices are paired", async () => {
    mockTransportCall.mockImplementation((name: string) => {
      if (name === "companion_signaling_status") {
        return Promise.resolve({
          enabled: true,
          signalingUrl: "wss://signaling.cognia.cn/signaling",
          registeredDevices: [],
        })
      }
      if (name === "companion_signaling_devices_status") {
        return Promise.resolve([])
      }
      return Promise.reject(new Error(`unexpected ${name}`))
    })
    renderCard()
    const empty = await screen.findByTestId("webrtc-status-empty")
    expect(empty).toHaveTextContent(en.mobile.companion.webrtc.noDevices)
  })

  it("renders one row per registered device with its tier label", async () => {
    const devices: DeviceTierEntry[] = [
      {
        deviceId: "device-apple-123456",
        rendezvousId: "r1",
        tier: "connected",
        updatedAtMs: 1,
      },
      {
        deviceId: "device-banana-7890",
        rendezvousId: "r2",
        tier: "negotiating",
        updatedAtMs: 2,
      },
      {
        deviceId: "device-cherry-9999",
        rendezvousId: "r3",
        tier: "failed",
        lastError: "ICE state failed",
        updatedAtMs: 3,
      },
    ]
    mockTransportCall.mockImplementation((name: string) => {
      if (name === "companion_signaling_status") {
        return Promise.resolve({
          enabled: true,
          signalingUrl: "wss://signaling.cognia.cn/signaling",
          registeredDevices: devices.map((d) => d.rendezvousId),
        })
      }
      if (name === "companion_signaling_devices_status") {
        return Promise.resolve(devices)
      }
      return Promise.reject(new Error(`unexpected ${name}`))
    })
    renderCard()
    await screen.findByTestId("webrtc-device-tier-list")
    expect(screen.getByTestId("webrtc-device-row-device-apple-123456")).toHaveTextContent(
      en.mobile.companion.webrtc.deviceTier.connected
    )
    expect(screen.getByTestId("webrtc-device-row-device-apple-123456")).toHaveTextContent(
      en.mobile.companion.webrtc.protocolMode
    )
    expect(screen.getByTestId("webrtc-device-row-device-banana-7890")).toHaveTextContent(
      en.mobile.companion.webrtc.deviceTier.negotiating
    )
    const failedRow = screen.getByTestId("webrtc-device-row-device-cherry-9999")
    expect(failedRow).toHaveTextContent(en.mobile.companion.webrtc.deviceTier.failed)
    expect(failedRow).toHaveTextContent("ICE state failed")
  })
})

describe("WebRtcCard — poll-failure banner", () => {
  beforeEach(async () => {
    try {
      await getDb().delete()
    } catch {
      // db not yet created — fine
    }
    __resetDbForTesting()
    jest.useFakeTimers()
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it("shows the banner after three consecutive failures and clears it on recovery", async () => {
    let mode: "fail" | "succeed" = "fail"
    mockTransportCall.mockImplementation((name: string) => {
      if (mode === "fail") {
        return Promise.reject(new Error("hub unreachable"))
      }
      if (name === "companion_signaling_status") {
        return Promise.resolve({
          enabled: true,
          signalingUrl: "wss://signaling.cognia.cn/signaling",
          registeredDevices: [],
        })
      }
      if (name === "companion_signaling_devices_status") {
        return Promise.resolve([])
      }
      return Promise.reject(new Error(`unexpected ${name}`))
    })
    renderCard()

    // The polling effect triggers immediately on mount, then chains via
    // setTimeout(3000). Drive three failures.
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
        jest.advanceTimersByTime(3000)
      })
    }
    // One more flush so the third rejection lands.
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    await screen.findByTestId("webrtc-poll-error")

    // Flip to success and the banner should disappear once the next sample
    // lands.
    mode = "succeed"
    await act(async () => {
      jest.advanceTimersByTime(3000)
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitFor(() => expect(screen.queryByTestId("webrtc-poll-error")).not.toBeInTheDocument())
  })
})

// ---------------------------------------------------------------------------
// TURN credential keyring (S1)
// ---------------------------------------------------------------------------

describe("WebRtcCard — TURN credential keyring", () => {
  beforeEach(async () => {
    try {
      await getDb().delete()
    } catch {
      // db not yet created — fine
    }
    __resetDbForTesting()
  })

  it("prevents editing or saving defaults until stored credentials finish hydrating", async () => {
    const knownKeyId = "delayed-key"
    await saveSettings({
      signalingUrl: "wss://saved.example/signaling",
      turnServers: [
        { urls: "turn:saved.example", credential: `${KEYRING_CREDENTIAL_PREFIX}${knownKeyId}` },
      ],
    })
    let finishRead!: (value: { username: string; credential: string }) => void
    const read = jest.spyOn(turnStore, "load").mockImplementation(
      () =>
        new Promise((resolve) => {
          finishRead = resolve
        })
    )
    renderCard()
    await waitFor(() => expect(read).toHaveBeenCalledWith(knownKeyId))
    expect(screen.getByLabelText(/Signaling server/i)).toBeDisabled()
    expect(screen.getByLabelText(/TURN servers/i)).toBeDisabled()
    expect(screen.getByTestId("webrtc-enable-toggle")).toBeDisabled()
    expect(screen.getByTestId("webrtc-save")).toBeDisabled()
    await act(async () => {
      finishRead({ username: "saved", credential: "synthetic-secret" })
    })
    await waitFor(() => expect(screen.getByTestId("webrtc-save")).toBeEnabled())
    expect(screen.getByLabelText(/Signaling server/i)).toHaveValue("wss://saved.example/signaling")
    expect(screen.getByLabelText(/TURN servers/i)).toHaveValue(
      "turn:saved.example|saved|synthetic-secret"
    )
  })

  it("save() writes new TURN credentials to keyring, not Dexie", async () => {
    renderCard()
    const ta = await screen.findByLabelText(/TURN servers/i)
    await waitFor(() => expect(ta).toBeEnabled())
    await userEvent.clear(ta)
    await userEvent.type(ta, "turn:turn.example.com:3478|alice|s3cret")
    await userEvent.click(screen.getByTestId("webrtc-save"))
    // After save, the stored value must be a sentinel — never plaintext.
    await waitFor(async () => {
      const s = await getSettings()
      const persisted = s.turnServers?.[0]
      expect(persisted).toBeTruthy()
      expect(isKeyringSentinel(persisted!.credential as string)).toBe(true)
    })
    const persisted = (await getSettings()).turnServers![0]
    const keyId = keyIdOfSentinel(persisted.credential as string)!
    expect(turnStore.map.get(keyId)).toEqual({
      username: "alice",
      credential: "s3cret",
    })
    // Defensive: make sure the literal string "s3cret" never lands in
    // Dexie under any field.
    expect(JSON.stringify(persisted)).not.toContain("s3cret")
  })

  it("save() leaves an existing keyring sentinel alone", async () => {
    // Pre-seed: a TURN entry already in the keyring, with a known keyring
    // entry. Simulates the user opening Settings, not touching the
    // textarea, and clicking Save again.
    const knownKeyId = "preexisting-key-id"
    turnStore.map.set(knownKeyId, {
      username: "alice",
      credential: "s3cret",
    })
    await saveSettings({
      turnServers: [
        {
          urls: "turn:turn.example.com:3478",
          credential: `${KEYRING_CREDENTIAL_PREFIX}${knownKeyId}`,
        },
      ],
    })
    renderCard()
    // Wait until the textarea is hydrated.
    const ta = await screen.findByLabelText(/TURN servers/i)
    await waitFor(() => expect((ta as HTMLTextAreaElement).value).toContain("alice"))
    await userEvent.click(screen.getByTestId("webrtc-save"))
    // The textarea shows the resolved plaintext, so the save sees plaintext.
    // Regression (R4): it used to mint a fresh keyring entry for it on every
    // save and never delete the one it replaced. An unchanged line keeps its
    // key, and the keyring holds exactly that one entry.
    const { toast } = await import("sonner")
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    const persisted = (await getSettings()).turnServers![0]
    expect(persisted.credential).toBe(`${KEYRING_CREDENTIAL_PREFIX}${knownKeyId}`)
    expect([...turnStore.map.keys()]).toEqual([knownKeyId])
  })

  it("saving twice without edits writes the keyring once", async () => {
    const { toast } = await import("sonner")
    renderCard()
    const ta = await screen.findByLabelText(/TURN servers/i)
    await waitFor(() => expect(ta).toBeEnabled())
    await userEvent.clear(ta)
    await userEvent.type(ta, "turn:turn.example.com:3478|alice|s3cret")
    await userEvent.click(screen.getByTestId("webrtc-save"))
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1))
    const first = (await getSettings()).turnServers![0].credential

    await userEvent.click(screen.getByTestId("webrtc-save"))
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(2))
    expect((await getSettings()).turnServers![0].credential).toBe(first)
    expect(turnStore.map.size).toBe(1)
  })

  it("replaces an edited entry's keyring secret and deletes the old one after the save", async () => {
    const { toast } = await import("sonner")
    turnStore.map.set("old-key", { username: "alice", credential: "old-secret" })
    await saveSettings({
      turnServers: [{ urls: "turn:turn.example.com:3478", credential: "kr:old-key" }],
    })
    renderCard()
    const ta = await screen.findByLabelText(/TURN servers/i)
    await waitFor(() => expect((ta as HTMLTextAreaElement).value).toContain("old-secret"))
    await userEvent.clear(ta)
    await userEvent.type(ta, "turn:turn.example.com:3478|alice|new-secret")
    await userEvent.click(screen.getByTestId("webrtc-save"))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())

    const keyId = keyIdOfSentinel((await getSettings()).turnServers![0].credential as string)!
    expect(keyId).not.toBe("old-key")
    expect([...turnStore.map.entries()]).toEqual([
      [keyId, { username: "alice", credential: "new-secret" }],
    ])
  })

  it("a failed save deletes only what it minted and keeps the stored secret", async () => {
    const { toast } = await import("sonner")
    turnStore.map.set("old-key", { username: "alice", credential: "old-secret" })
    await saveSettings({
      turnServers: [{ urls: "turn:turn.example.com:3478", credential: "kr:old-key" }],
    })
    renderCard()
    const ta = await screen.findByLabelText(/TURN servers/i)
    await waitFor(() => expect((ta as HTMLTextAreaElement).value).toContain("old-secret"))
    await userEvent.clear(ta)
    await userEvent.type(ta, "turn:turn.example.com:3478|alice|new-secret")
    saveSettingsMock.mockRejectedValueOnce(new Error("disk full"))
    await userEvent.click(screen.getByTestId("webrtc-save"))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("disk full"))
    )

    // The stored config still points at the old entry, and it still resolves.
    expect((await getSettings()).turnServers![0].credential).toBe("kr:old-key")
    expect([...turnStore.map.entries()]).toEqual([
      ["old-key", { username: "alice", credential: "old-secret" }],
    ])
  })

  it("keeps a TURN line typed in the STUN field out of Dexie and out of the toast", async () => {
    const { toast } = await import("sonner")
    renderCard()
    const ice = await screen.findByLabelText(/STUN servers/i)
    await waitFor(() => expect(ice).toBeEnabled())
    await userEvent.clear(ice)
    await userEvent.type(ice, "stun:a.example:3478\nturn:turn.example.com:3478|alice|s3cret")
    await userEvent.click(screen.getByTestId("webrtc-save"))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())

    const stored = await getSettings()
    expect(stored.iceServers).toEqual([{ urls: "stun:a.example:3478" }])
    expect(JSON.stringify(stored)).not.toContain("s3cret")
    const warnings = (toast.warning as jest.Mock).mock.calls.map((c) => String(c[0]))
    expect(warnings).toEqual([
      "Skipping turn:turn.example.com:3478|•••: TURN entries go in the TURN servers field, which keeps their credentials in the OS keyring.",
    ])
  })

  // Regression (R6): the invalid-line toast echoed the raw line.
  it("never echoes a credential from an invalid line", async () => {
    const { toast } = await import("sonner")
    renderCard()
    const ta = await screen.findByLabelText(/TURN servers/i)
    await waitFor(() => expect(ta).toBeEnabled())
    await userEvent.clear(ta)
    await userEvent.type(ta, "turn:turn.example.com:70000|alice|s3cret")
    await userEvent.click(screen.getByTestId("webrtc-save"))
    await waitFor(() => expect(toast.warning).toHaveBeenCalled())
    const text = (toast.warning as jest.Mock).mock.calls.map((c) => String(c[0])).join("\n")
    expect(text).toContain("turn:turn.example.com:70000|•••")
    expect(text).not.toContain("alice")
    expect(text).not.toContain("s3cret")
  })
})

// ---------------------------------------------------------------------------
// Per-device reconnect button (W2)
// ---------------------------------------------------------------------------

describe("WebRtcCard — per-device reconnect button", () => {
  beforeEach(async () => {
    try {
      await getDb().delete()
    } catch {
      // db not yet created — fine
    }
    __resetDbForTesting()
  })

  function makeDevicesResponder(devices: DeviceTierEntry[]): void {
    mockTransportCall.mockImplementation((name: string, params?: Record<string, unknown>) => {
      if (name === "companion_signaling_status") {
        return Promise.resolve({
          enabled: true,
          signalingUrl: "wss://signaling.cognia.cn/signaling",
          registeredDevices: devices.map((d) => d.rendezvousId),
        })
      }
      if (name === "companion_signaling_devices_status") {
        return Promise.resolve(devices)
      }
      if (name === "companion_signaling_reconnect_device") {
        // Record the rendezvousId param so the test can assert it.
        ;(makeDevicesResponder as unknown as { lastReconnect?: unknown }).lastReconnect = params
        return Promise.resolve()
      }
      return Promise.reject(new Error(`unexpected ${name}`))
    })
  }

  it("renders one reconnect button per device row", async () => {
    makeDevicesResponder([
      {
        deviceId: "device-apple-123456",
        rendezvousId: "r1",
        tier: "connected",
        updatedAtMs: 1,
      },
      {
        deviceId: "device-banana-7890",
        rendezvousId: "r2",
        tier: "failed",
        lastError: "ICE failed",
        updatedAtMs: 2,
      },
    ])
    renderCard()
    await screen.findByTestId("webrtc-device-tier-list")
    expect(screen.getByTestId("webrtc-reconnect-device-apple-123456")).toBeInTheDocument()
    expect(screen.getByTestId("webrtc-reconnect-device-banana-7890")).toBeInTheDocument()
  })

  it("clicking the button calls companion_signaling_reconnect_device with the rendezvousId", async () => {
    makeDevicesResponder([
      {
        deviceId: "device-apple",
        rendezvousId: "r-apple",
        tier: "failed",
        lastError: "previous attempt failed",
        updatedAtMs: 1,
      },
    ])
    renderCard()
    const btn = await screen.findByTestId("webrtc-reconnect-device-apple")
    await userEvent.click(btn)
    await waitFor(() => {
      const captured = (
        makeDevicesResponder as unknown as { lastReconnect?: Record<string, unknown> }
      ).lastReconnect
      expect(captured).toEqual({ rendezvousId: "r-apple" })
    })
  })

  it("surfaces the error message on failure as a toast.error", async () => {
    const { toast } = await import("sonner")
    mockTransportCall.mockImplementation((name: string) => {
      if (name === "companion_signaling_status") {
        return Promise.resolve({
          enabled: true,
          signalingUrl: "wss://signaling.cognia.cn/signaling",
          registeredDevices: ["r1"],
        })
      }
      if (name === "companion_signaling_devices_status") {
        return Promise.resolve([
          {
            deviceId: "device-apple",
            rendezvousId: "r1",
            tier: "failed",
            updatedAtMs: 1,
          } as DeviceTierEntry,
        ])
      }
      if (name === "companion_signaling_reconnect_device") {
        return Promise.reject(new Error("rendezvous id r1 not found"))
      }
      return Promise.reject(new Error(`unexpected ${name}`))
    })
    renderCard()
    const btn = await screen.findByTestId("webrtc-reconnect-device-apple")
    await userEvent.click(btn)
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled()
    })
  })
})

// ---------------------------------------------------------------------------
// ADR-0021 — ephemeral-TURN provider section
// ---------------------------------------------------------------------------

class FakeProviderStore {
  readonly map = new Map<string, string>()
  async save(keyId: string, value: string): Promise<void> {
    this.map.set(keyId, value)
  }
  async load(keyId: string): Promise<string | null> {
    return this.map.has(keyId) ? this.map.get(keyId)! : null
  }
  async delete(keyId: string): Promise<void> {
    this.map.delete(keyId)
  }
}

const BASE_FORM: FormState = {
  enabled: true,
  signalingUrl: "wss://x/signaling",
  iceServersText: "",
  turnServersText: "",
  turnProviderKind: "none",
  turnProviderKeyId: "",
  turnProviderSid: "",
  turnProviderToken: "",
  turnProviderTtl: "",
  turnProviderSecretRef: "",
}

describe("parseTtl", () => {
  it("returns undefined for blank / invalid and clamps numeric TTLs", () => {
    expect(parseTtl("")).toBeUndefined()
    expect(parseTtl("  ")).toBeUndefined()
    expect(parseTtl("abc")).toBeUndefined()
    expect(parseTtl("-1")).toBeUndefined()
    expect(parseTtl("30")).toBe(600)
    expect(parseTtl("3600")).toBe(3600)
    expect(parseTtl("999999")).toBe(86_400)
  })
})

describe("persistTurnProvider", () => {
  let ps: FakeProviderStore
  beforeEach(() => {
    ps = new FakeProviderStore()
    __setProviderSecretStore(ps as never)
  })
  afterAll(() => __setProviderSecretStore(null))

  // Regression (R4): it deleted the stored secret before the save committed.
  it("kind 'none' returns an empty ref and leaves the stored secret for after the save", async () => {
    await ps.save("old", JSON.stringify({ apiToken: "x" }))
    const minted = noneMinted()
    const { turnProvider, nextSecretRef } = await persistTurnProvider(
      { ...BASE_FORM, turnProviderKind: "none", turnProviderSecretRef: "kr:old" },
      minted
    )
    expect(turnProvider).toEqual({ kind: "none" })
    expect(nextSecretRef).toBe("")
    expect(await ps.load("old")).not.toBeNull()
    expect(minted).toEqual(noneMinted())
  })

  it("Cloudflare with a token writes the apiToken to the keyring + a sentinel ref", async () => {
    const minted = noneMinted()
    const { turnProvider, nextSecretRef } = await persistTurnProvider(
      {
        ...BASE_FORM,
        turnProviderKind: "cloudflare-calls",
        turnProviderKeyId: "key-1",
        turnProviderToken: "tok",
        turnProviderTtl: "7200",
      },
      minted
    )
    expect(turnProvider.kind).toBe("cloudflare-calls")
    expect(turnProvider.cloudflareKeyId).toBe("key-1")
    expect(turnProvider.ttlSeconds).toBe(7200)
    expect(nextSecretRef).toMatch(/^kr:/)
    expect(turnProvider.secretRef).toBe(nextSecretRef)
    const kid = keyIdOfSentinel(nextSecretRef)!
    expect(JSON.parse((await ps.load(kid))!)).toEqual({ apiToken: "tok" })
    expect(minted.provider).toEqual([kid])
  })

  it("a replacement token leaves the previous secret in place", async () => {
    await ps.save("old", JSON.stringify({ apiToken: "x" }))
    const { nextSecretRef } = await persistTurnProvider(
      {
        ...BASE_FORM,
        turnProviderKind: "cloudflare-calls",
        turnProviderToken: "tok",
        turnProviderSecretRef: "kr:old",
      },
      noneMinted()
    )
    expect(nextSecretRef).not.toBe("kr:old")
    expect(await ps.load("old")).not.toBeNull()
  })

  it("Twilio with a token stores the authToken + the SID", async () => {
    const { turnProvider, nextSecretRef } = await persistTurnProvider(
      {
        ...BASE_FORM,
        turnProviderKind: "twilio",
        turnProviderSid: "ACxxxx",
        turnProviderToken: "auth",
      },
      noneMinted()
    )
    expect(turnProvider.twilioAccountSid).toBe("ACxxxx")
    const kid = keyIdOfSentinel(nextSecretRef)!
    expect(JSON.parse((await ps.load(kid))!)).toEqual({ authToken: "auth" })
  })

  it("keeps the existing secret ref when no new token is entered", async () => {
    const minted = noneMinted()
    const { turnProvider, nextSecretRef } = await persistTurnProvider(
      {
        ...BASE_FORM,
        turnProviderKind: "cloudflare-calls",
        turnProviderKeyId: "key-1",
        turnProviderSecretRef: "kr:keep",
      },
      minted
    )
    expect(nextSecretRef).toBe("kr:keep")
    expect(turnProvider.secretRef).toBe("kr:keep")
    // No new secret written.
    expect(ps.map.size).toBe(0)
    expect(minted).toEqual(noneMinted())
  })
})

describe("persistTurnServers", () => {
  const stored = [{ url: "turn:a.example", username: "alice", credential: "s1", keyId: "key-a" }]

  it("reuses the key of an unchanged entry and mints one for a changed entry", async () => {
    const minted = noneMinted()
    const out = await persistTurnServers(
      [
        { urls: "turn:a.example", username: "alice", credential: "s1" },
        { urls: "turn:b.example", username: "bob", credential: "s2" },
      ],
      stored,
      minted
    )
    expect(out.turnServers[0]).toEqual({ urls: "turn:a.example", credential: "kr:key-a" })
    const minedKey = keyIdOfSentinel(out.turnServers[1].credential as string)!
    expect(minted.turn).toEqual([minedKey])
    expect(turnStore.map.get(minedKey)).toEqual({ username: "bob", credential: "s2" })
    expect(turnStore.map.has("key-a")).toBe(false)
    expect(out.stored.map((s) => s.keyId)).toEqual(["key-a", minedKey])
  })

  it("mints for an entry whose credential changed", async () => {
    const minted = noneMinted()
    const out = await persistTurnServers(
      [{ urls: "turn:a.example", username: "alice", credential: "changed" }],
      stored,
      minted
    )
    expect(out.turnServers[0].credential).not.toBe("kr:key-a")
    expect(minted.turn).toHaveLength(1)
  })

  it("records a key before writing it, so a failed write is still rolled back", async () => {
    jest.spyOn(turnStore, "save").mockRejectedValueOnce(new Error("keyring locked"))
    const minted = noneMinted()
    await expect(
      persistTurnServers(
        [{ urls: "turn:b.example", username: "bob", credential: "s2" }],
        [],
        minted
      )
    ).rejects.toThrow("keyring locked")
    expect(minted.turn).toHaveLength(1)
  })
})

describe("keyring bookkeeping", () => {
  it("storedTurnCredentials pairs sentinels with their resolved values, one row per URL", () => {
    expect(
      storedTurnCredentials(
        [
          { urls: ["turn:a.example", "turns:a.example?transport=tcp"], credential: "kr:k1" },
          { urls: "turn:plain.example", username: "u", credential: "plaintext" },
          { urls: "turn:gone.example", credential: "kr:k2" },
        ],
        [
          {
            urls: ["turn:a.example", "turns:a.example?transport=tcp"],
            username: "alice",
            credential: "s1",
          },
          { urls: "turn:plain.example", username: "u", credential: "plaintext" },
          { urls: "turn:gone.example" },
        ]
      )
    ).toEqual([
      { url: "turn:a.example", username: "alice", credential: "s1", keyId: "k1" },
      {
        url: "turns:a.example?transport=tcp",
        username: "alice",
        credential: "s1",
        keyId: "k1",
      },
    ])
  })

  it("names the entries a new config no longer references", () => {
    const before = referencedSecrets({
      turnServers: [
        { urls: "turn:a", credential: "kr:k1" },
        { urls: "turn:b", credential: "kr:k2" },
      ],
      turnProvider: { kind: "cloudflare-calls", secretRef: "kr:p1" },
    })
    const after = referencedSecrets({
      turnServers: [{ urls: "turn:a", credential: "kr:k1" }],
      turnProvider: { kind: "none" },
    })
    expect(unreferencedSecrets(before, after)).toEqual({ turn: ["k2"], provider: ["p1"] })
  })

  it("deleteSecrets attempts every entry even when one fails", async () => {
    const ps = new FakeProviderStore()
    __setProviderSecretStore(ps as never)
    await ps.save("p1", "{}")
    turnStore.map.set("k1", { username: "u", credential: "c" })
    turnStore.map.set("k2", { username: "u", credential: "c" })
    jest.spyOn(turnStore, "delete").mockRejectedValueOnce(new Error("locked"))
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    await deleteSecrets({ turn: ["k1", "k2"], provider: ["p1"] })
    expect(turnStore.map.has("k1")).toBe(true)
    expect(turnStore.map.has("k2")).toBe(false)
    expect(ps.map.has("p1")).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
    __setProviderSecretStore(null)
  })
})

describe("WebRtcCard — TURN provider UI", () => {
  const MARKER_URL = "wss://hydrated.example/signaling"
  beforeEach(async () => {
    __setProviderSecretStore(new FakeProviderStore() as never)
    // Keep the status poll quiet.
    mockTransportCall.mockResolvedValue([])
    try {
      await getDb().delete()
    } catch {
      // db not yet created — fine
    }
    __resetDbForTesting()
    // Seed a distinct signaling URL so `waitForHydrate` proves the async
    // hydrate actually ran (the INITIAL state already carries the *default*
    // URL, so waiting on that would pass before hydrate completes and a late
    // hydrate would then clobber the provider selection mid-test).
    await saveSettings({ signalingUrl: MARKER_URL })
  })
  afterAll(() => __setProviderSecretStore(null))

  const waitForHydrate = async () => {
    const url = await screen.findByLabelText(/Signaling server/i)
    await waitFor(() => expect(url).toHaveValue(MARKER_URL))
  }

  it("reveals Cloudflare inputs when the Cloudflare provider is selected", async () => {
    renderCard()
    await waitForHydrate()
    const select = await screen.findByTestId("webrtc-turn-provider-kind")
    await selectOption(select, "cloudflare-calls")
    expect(screen.getByTestId("webrtc-turn-cf-keyid")).toBeInTheDocument()
    expect(screen.getByTestId("webrtc-turn-token")).toBeInTheDocument()
    expect(screen.getByTestId("webrtc-turn-test")).toBeInTheDocument()
    // The Twilio-only SID field stays hidden.
    expect(screen.queryByTestId("webrtc-turn-twilio-sid")).not.toBeInTheDocument()
  })

  it("Test button provisions and toasts success when the provider responds", async () => {
    const { toast } = await import("sonner")
    mockTransportCall.mockResolvedValue({
      iceServers: [{ urls: ["turn:a"] }],
      expiresAtMs: Date.now() + 60_000,
    })
    const user = userEvent.setup({ delay: null })
    renderCard()
    await waitForHydrate()
    const select = await screen.findByTestId("webrtc-turn-provider-kind")
    await selectOption(select, "cloudflare-calls")
    await user.type(screen.getByTestId("webrtc-turn-cf-keyid"), "key-1")
    await user.type(screen.getByTestId("webrtc-turn-token"), "tok")
    await user.click(screen.getByTestId("webrtc-turn-test"))
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalled()
    })
    expect(mockTransportCall).toHaveBeenCalledWith("turn_provision", {
      input: {
        kind: "cloudflare-calls",
        cloudflareKeyId: "key-1",
        twilioAccountSid: undefined,
        ttlSeconds: undefined,
        secretKeyId: undefined,
        inlineToken: "tok",
      },
    })
  }, 20000)
})

describe("WebRtcCard — TURN provider secret lifecycle", () => {
  let ps: FakeProviderStore
  const MARKER_URL = "wss://provider.example/signaling"

  beforeEach(async () => {
    ps = new FakeProviderStore()
    __setProviderSecretStore(ps as never)
    mockTransportCall.mockResolvedValue([])
    try {
      await getDb().delete()
    } catch {
      // db not yet created — fine
    }
    __resetDbForTesting()
    await ps.save("p-old", JSON.stringify({ apiToken: "old" }))
    await saveSettings({
      signalingUrl: MARKER_URL,
      turnProvider: { kind: "cloudflare-calls", cloudflareKeyId: "k", secretRef: "kr:p-old" },
    })
  })
  afterAll(() => __setProviderSecretStore(null))

  async function switchToNone() {
    renderCard()
    const url = await screen.findByLabelText(/Signaling server/i)
    await waitFor(() => expect(url).toHaveValue(MARKER_URL))
    await selectOption(await screen.findByTestId("webrtc-turn-provider-kind"), "none")
  }

  it("deletes the provider secret once a save to 'none' has committed", async () => {
    const { toast } = await import("sonner")
    await switchToNone()
    await userEvent.click(screen.getByTestId("webrtc-save"))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect((await getSettings()).turnProvider).toEqual({ kind: "none" })
    expect(ps.map.has("p-old")).toBe(false)
  })

  // Regression (R4): the secret went before the save, so a failed save left
  // the stored provider pointing at a deleted keyring entry.
  it("keeps the provider secret when the save fails", async () => {
    const { toast } = await import("sonner")
    await switchToNone()
    saveSettingsMock.mockRejectedValueOnce(new Error("disk full"))
    await userEvent.click(screen.getByTestId("webrtc-save"))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect((await getSettings()).turnProvider?.secretRef).toBe("kr:p-old")
    expect(ps.map.has("p-old")).toBe(true)
  })

  it("drops a newly entered token's secret when the save fails", async () => {
    const { toast } = await import("sonner")
    renderCard()
    const url = await screen.findByLabelText(/Signaling server/i)
    await waitFor(() => expect(url).toHaveValue(MARKER_URL))
    await userEvent.type(screen.getByTestId("webrtc-turn-token"), "new-token")
    saveSettingsMock.mockRejectedValueOnce(new Error("disk full"))
    await userEvent.click(screen.getByTestId("webrtc-save"))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect([...ps.map.keys()]).toEqual(["p-old"])
  })
})
