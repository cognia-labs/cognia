/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"

import { useAutoLockOnIdle } from "./use-auto-lock-on-idle"

let mockPetRole: string | null = null
jest.mock("@/lib/pet/window-role", () => ({
  getPetWindowRole: () => mockPetRole,
  isSecondaryOverlayRole: (role: string | null) => role === "overlay" || role === "popup",
}))

let mockAutoLockMinutes: number | undefined = 5
let mockSettingsPresent = true
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({
      settings: mockSettingsPresent ? { accountAutoLockMinutes: mockAutoLockMinutes } : undefined,
    }),
}))

let mockSessions: Record<string, { status: string }> = {}
jest.mock("@/stores/chat/chat-store", () => ({
  useChatStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ sessions: mockSessions }),
    { getState: () => ({ sessions: mockSessions }) }
  ),
}))

const interruptSessionMock = jest.fn<Promise<void>, [string]>()
jest.mock("@/lib/claude/ipc", () => ({
  interruptSession: (sessionId: string) => interruptSessionMock(sessionId),
}))

const lockMock = jest.fn()
let mockDeviceManaged = false
let mockRemembered = false
let mockUnlockedAccountId: string | null = "acct_1"
let mockAccountRevision = 0
let mockLocked = false
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: Object.assign(
    (selector: (s: unknown) => unknown) =>
      selector({
        unlockedAccountId: mockUnlockedAccountId,
        accountRevision: mockAccountRevision,
        locked: mockLocked,
        accounts: mockDeviceManaged
          ? [{ id: mockUnlockedAccountId, protection: "device" }]
          : mockRemembered
            ? [{ id: mockUnlockedAccountId, rememberOnDevice: true }]
            : [],
      }),
    {
      getState: () => ({
        lock: lockMock,
        unlockedAccountId: mockUnlockedAccountId,
        accountRevision: mockAccountRevision,
        locked: mockLocked,
      }),
    }
  ),
}))

const FIVE_MINUTES = 5 * 60_000

const ORIGINAL_NODE_ENV = process.env.NODE_ENV
const ORIGINAL_ACCOUNT_GATE = process.env.NEXT_PUBLIC_ACCOUNT_GATE

// `ProcessEnv.NODE_ENV` is typed readonly in this repo, and jest.replaceProperty
// cannot create a missing key — assign through a mutable view instead.
function setEnv(key: string, value: string | undefined): void {
  const env = process.env as Record<string, string | undefined>
  if (value === undefined) delete env[key]
  else env[key] = value
}

beforeEach(() => {
  jest.useFakeTimers()
  jest.setSystemTime(new Date("2026-01-01T00:00:00Z"))
  jest.clearAllMocks()
  mockDeviceManaged = false
  mockRemembered = false
  mockPetRole = null
  mockAutoLockMinutes = 5
  mockSettingsPresent = true
  mockUnlockedAccountId = "acct_1"
  mockAccountRevision = 0
  mockLocked = false
  mockSessions = {}
  lockMock.mockResolvedValue(undefined)
  interruptSessionMock.mockResolvedValue()
})

afterEach(() => {
  jest.runOnlyPendingTimers()
  jest.useRealTimers()
  setEnv("NODE_ENV", ORIGINAL_NODE_ENV)
  setEnv("NEXT_PUBLIC_ACCOUNT_GATE", ORIGINAL_ACCOUNT_GATE)
})

describe("useAutoLockOnIdle", () => {
  it("locks after the configured idle timeout elapses", () => {
    renderHook(() => useAutoLockOnIdle())

    act(() => {
      jest.advanceTimersByTime(FIVE_MINUTES)
    })

    expect(lockMock).toHaveBeenCalledTimes(1)
  })

  it("does not lock before the timeout", () => {
    renderHook(() => useAutoLockOnIdle())

    act(() => {
      jest.advanceTimersByTime(FIVE_MINUTES - 1_000)
    })

    expect(lockMock).not.toHaveBeenCalled()
  })

  it("waits out the remainder when activity lands before the deadline", () => {
    renderHook(() => useAutoLockOnIdle())

    act(() => {
      jest.advanceTimersByTime(FIVE_MINUTES - 10_000)
      window.dispatchEvent(new Event("keydown"))
      jest.advanceTimersByTime(10_001)
    })
    expect(lockMock).not.toHaveBeenCalled()

    act(() => {
      jest.advanceTimersByTime(FIVE_MINUTES)
    })
    expect(lockMock).toHaveBeenCalledTimes(1)
  })

  it("locks on the next focus when a throttled tab never fired its timer", () => {
    renderHook(() => useAutoLockOnIdle())

    act(() => {
      // Wall-clock moves past the deadline without the timer being delivered,
      // which is exactly what a backgrounded tab does.
      jest.setSystemTime(Date.now() + FIVE_MINUTES + 1_000)
      window.dispatchEvent(new Event("focus"))
    })

    expect(lockMock).toHaveBeenCalledTimes(1)
  })

  it("interrupts a live turn before locking when a backgrounded window returns past the deadline", async () => {
    mockSessions = { s1: { status: "streaming" } }
    renderHook(() => useAutoLockOnIdle())

    await act(async () => {
      jest.setSystemTime(Date.now() + FIVE_MINUTES + 1_000)
      window.dispatchEvent(new Event("focus"))
      await Promise.resolve()
    })

    expect(interruptSessionMock).toHaveBeenCalledWith("s1")
    expect(lockMock).toHaveBeenCalledTimes(1)
  })

  it("never arms in a development build — debugging reads as pure idle", () => {
    setEnv("NODE_ENV", "development")
    renderHook(() => useAutoLockOnIdle())

    act(() => {
      jest.advanceTimersByTime(FIVE_MINUTES * 4)
    })

    expect(lockMock).not.toHaveBeenCalled()
  })

  it("still arms in a development build when the account gate is forced on", () => {
    setEnv("NODE_ENV", "development")
    setEnv("NEXT_PUBLIC_ACCOUNT_GATE", "1")
    renderHook(() => useAutoLockOnIdle())

    act(() => {
      jest.advanceTimersByTime(FIVE_MINUTES)
    })

    expect(lockMock).toHaveBeenCalledTimes(1)
  })

  it("is inert when auto-lock is off", () => {
    mockAutoLockMinutes = 0
    renderHook(() => useAutoLockOnIdle())

    act(() => {
      jest.advanceTimersByTime(FIVE_MINUTES * 4)
    })

    expect(lockMock).not.toHaveBeenCalled()
  })

  it("is inert before settings have hydrated", () => {
    mockSettingsPresent = false
    renderHook(() => useAutoLockOnIdle())

    act(() => {
      jest.advanceTimersByTime(FIVE_MINUTES * 4)
    })

    expect(lockMock).not.toHaveBeenCalled()
  })

  it("is inert when no account is unlocked", () => {
    mockUnlockedAccountId = null
    renderHook(() => useAutoLockOnIdle())

    act(() => {
      jest.advanceTimersByTime(FIVE_MINUTES * 4)
    })

    expect(lockMock).not.toHaveBeenCalled()
  })

  it("defers a streaming turn for at most one extra lock cycle, then interrupts and locks", async () => {
    mockSessions = { s1: { status: "streaming" } }
    renderHook(() => useAutoLockOnIdle())

    act(() => {
      jest.advanceTimersByTime(FIVE_MINUTES)
    })
    expect(lockMock).not.toHaveBeenCalled()

    act(() => {
      jest.advanceTimersByTime(FIVE_MINUTES)
    })
    await act(async () => Promise.resolve())

    expect(interruptSessionMock).toHaveBeenCalledWith("s1")
    expect(lockMock).toHaveBeenCalledTimes(1)
  })

  it("defers an approval for at most one extra lock cycle, then interrupts and locks", async () => {
    mockSessions = { s1: { status: "awaiting_approval" } }
    renderHook(() => useAutoLockOnIdle())

    act(() => {
      jest.advanceTimersByTime(FIVE_MINUTES * 2)
    })
    await act(async () => Promise.resolve())

    expect(interruptSessionMock).toHaveBeenCalledWith("s1")
    expect(lockMock).toHaveBeenCalledTimes(1)
  })

  it("does not run on an overlay window, which cannot see the main window's activity", () => {
    mockPetRole = "overlay"
    renderHook(() => useAutoLockOnIdle())

    act(() => {
      jest.advanceTimersByTime(FIVE_MINUTES * 4)
    })

    expect(lockMock).not.toHaveBeenCalled()
  })

  it("runs in an ordinary browser — a Browser Vault account is a real lock", () => {
    renderHook(() => useAutoLockOnIdle())

    act(() => {
      jest.advanceTimersByTime(FIVE_MINUTES)
    })

    expect(lockMock).toHaveBeenCalledTimes(1)
  })

  it("clears its timer and listeners on unmount", () => {
    const { unmount } = renderHook(() => useAutoLockOnIdle())
    unmount()

    act(() => {
      jest.advanceTimersByTime(FIVE_MINUTES * 4)
    })

    expect(lockMock).not.toHaveBeenCalled()
  })

  it("swallows a rejected lock rather than surfacing an unhandled rejection", async () => {
    lockMock.mockRejectedValueOnce(new Error("teardown failed"))
    renderHook(() => useAutoLockOnIdle())

    act(() => {
      jest.advanceTimersByTime(FIVE_MINUTES)
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(lockMock).toHaveBeenCalledTimes(1)
  })

  it("locks within one second when a turn's interrupt never settles", async () => {
    mockSessions = { s1: { status: "streaming" } }
    interruptSessionMock.mockReturnValue(new Promise(() => {}))
    renderHook(() => useAutoLockOnIdle())

    await act(async () => jest.advanceTimersByTime(FIVE_MINUTES * 2 + 999))
    expect(lockMock).not.toHaveBeenCalled()
    await act(async () => jest.advanceTimersByTime(1))
    expect(lockMock).toHaveBeenCalledTimes(1)
  })

  it("does not lock a different profile when the old interrupt finishes", async () => {
    mockSessions = { s1: { status: "streaming" } }
    let finishInterrupt!: () => void
    interruptSessionMock.mockReturnValue(new Promise((resolve) => (finishInterrupt = resolve)))
    renderHook(() => useAutoLockOnIdle())
    await act(async () => jest.advanceTimersByTime(FIVE_MINUTES * 2))

    // The imperative account fence also covers the gap before React commits.
    mockUnlockedAccountId = "acct_2"
    mockAccountRevision += 1
    await act(async () => finishInterrupt())
    await act(async () => jest.advanceTimersByTime(1_000))
    expect(lockMock).not.toHaveBeenCalled()
  })

  it("does not lock a new unlock of the same profile from an old interrupt", async () => {
    mockSessions = { s1: { status: "streaming" } }
    let finishInterrupt!: () => void
    interruptSessionMock.mockReturnValue(new Promise((resolve) => (finishInterrupt = resolve)))
    const { rerender } = renderHook(() => useAutoLockOnIdle())
    await act(async () => jest.advanceTimersByTime(FIVE_MINUTES * 2))

    mockAccountRevision += 1
    rerender()
    await act(async () => finishInterrupt())
    await act(async () => jest.advanceTimersByTime(1_000))
    expect(lockMock).not.toHaveBeenCalled()
  })

  it("cancels a pending idle lock on unmount", async () => {
    mockSessions = { s1: { status: "streaming" } }
    let finishInterrupt!: () => void
    interruptSessionMock.mockReturnValue(new Promise((resolve) => (finishInterrupt = resolve)))
    const { unmount } = renderHook(() => useAutoLockOnIdle())
    await act(async () => jest.advanceTimersByTime(FIVE_MINUTES * 2))
    unmount()

    await act(async () => finishInterrupt())
    await act(async () => jest.advanceTimersByTime(1_000))
    expect(lockMock).not.toHaveBeenCalled()
  })

  it("shares one pending interrupt between visibility and focus notifications", async () => {
    mockSessions = { s1: { status: "streaming" } }
    interruptSessionMock.mockReturnValue(new Promise(() => {}))
    renderHook(() => useAutoLockOnIdle())

    await act(async () => {
      jest.setSystemTime(Date.now() + FIVE_MINUTES + 1)
      document.dispatchEvent(new Event("visibilitychange"))
      window.dispatchEvent(new Event("focus"))
    })

    expect(interruptSessionMock).toHaveBeenCalledTimes(1)
    await act(async () => jest.advanceTimersByTime(1_000))
    expect(lockMock).toHaveBeenCalledTimes(1)
  })

  it("does not lock again when an interrupt finishes after the lock deadline", async () => {
    mockSessions = { s1: { status: "streaming" } }
    let finishInterrupt!: () => void
    interruptSessionMock.mockReturnValue(new Promise((resolve) => (finishInterrupt = resolve)))
    renderHook(() => useAutoLockOnIdle())

    await act(async () => jest.advanceTimersByTime(FIVE_MINUTES * 2 + 1_000))
    expect(lockMock).toHaveBeenCalledTimes(1)
    await act(async () => finishInterrupt())
    expect(lockMock).toHaveBeenCalledTimes(1)
  })

  it("enforces an elapsed interrupt deadline on focus when its grace timer was throttled", async () => {
    mockSessions = { s1: { status: "streaming" } }
    interruptSessionMock.mockReturnValue(new Promise(() => {}))
    renderHook(() => useAutoLockOnIdle())
    await act(async () => jest.advanceTimersByTime(FIVE_MINUTES * 2))

    act(() => {
      jest.setSystemTime(Date.now() + 1_001)
      window.dispatchEvent(new Event("focus"))
    })

    expect(interruptSessionMock).toHaveBeenCalledTimes(1)
    expect(lockMock).toHaveBeenCalledTimes(1)
  })

  it("locks without waiting out the grace period when interrupt dispatch is rejected", async () => {
    mockSessions = { s1: { status: "streaming" } }
    interruptSessionMock.mockRejectedValue(new Error("sidecar unavailable"))
    renderHook(() => useAutoLockOnIdle())

    await act(async () => jest.advanceTimersByTime(FIVE_MINUTES * 2))

    expect(lockMock).toHaveBeenCalledTimes(1)
    await act(async () => jest.advanceTimersByTime(1_000))
    expect(lockMock).toHaveBeenCalledTimes(1)
  })
})

function enterTauriShell(): void {
  ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
}

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
})

it("never arms idle locking before a device workspace has a user password", () => {
  mockDeviceManaged = true
  mockUnlockedAccountId = "acct_desktop_local_workspace"
  enterTauriShell()
  renderHook(() => useAutoLockOnIdle())
  act(() => jest.advanceTimersByTime(FIVE_MINUTES * 3))
  expect(lockMock).not.toHaveBeenCalled()
})

it("never arms idle locking for a profile that unlocks automatically on this device", () => {
  mockRemembered = true
  enterTauriShell()
  renderHook(() => useAutoLockOnIdle())
  act(() => jest.advanceTimersByTime(FIVE_MINUTES * 3))
  expect(lockMock).not.toHaveBeenCalled()
})

it("still arms idle locking for a remembered profile outside the desktop shell", () => {
  mockRemembered = true
  renderHook(() => useAutoLockOnIdle())
  act(() => jest.advanceTimersByTime(FIVE_MINUTES + 1))
  expect(lockMock).toHaveBeenCalledTimes(1)
})
