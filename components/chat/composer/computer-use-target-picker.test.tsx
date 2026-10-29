jest.mock("next-intl", () => {
  const React = jest.requireActual<typeof import("react")>("react")
  const Context = React.createContext<Record<string, unknown>>({})
  return {
    NextIntlClientProvider: ({
      messages,
      children,
    }: {
      messages: Record<string, unknown>
      children: React.ReactNode
    }) => React.createElement(Context.Provider, { value: messages }, children),
    useTranslations: (namespace: string) => {
      const messages = React.useContext(Context)
      return (key: string, values?: Record<string, unknown>) => {
        const result = `${namespace}.${key}`
          .split(".")
          .reduce<unknown>(
            (value, part) =>
              value && typeof value === "object"
                ? (value as Record<string, unknown>)[part]
                : undefined,
            messages
          )
        if (typeof result !== "string") throw new Error(`Missing translation ${namespace}.${key}`)
        return result.replace(/\{(\w+)\}/g, (_, name: string) => String(values?.[name]))
      }
    },
  }
})
jest.mock("@/components/ui/native-select", () => ({
  NativeSelect: (props: React.ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: React.ComponentProps<"option">) => <option {...props} />,
  NativeSelectOptGroup: (props: React.ComponentProps<"optgroup">) => <optgroup {...props} />,
}))
jest.mock("@/hooks/sandbox/use-computer-use-targets", () => ({ useComputerUseTargets: jest.fn() }))
jest.mock("@/lib/sandbox/managed-desktop-binding", () => ({
  ...jest.requireActual("@/lib/sandbox/managed-desktop-binding"),
  bindManagedDesktop: jest.fn(),
  unbindManagedDesktop: jest.fn(),
}))
jest.mock("@/lib/db/sessions", () => ({ updateSession: jest.fn() }))

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import en from "@/i18n/messages/en/computerUseTarget.json"
import zh from "@/i18n/messages/zh-CN/computerUseTarget.json"
import { useComputerUseTargets } from "@/hooks/sandbox/use-computer-use-targets"
import { bindManagedDesktop, unbindManagedDesktop } from "@/lib/sandbox/managed-desktop-binding"
import { updateSession } from "@/lib/db/sessions"
import {
  ComputerUseTargetPicker,
  SessionComputerUseTargetPicker,
} from "./computer-use-target-picker"

const options = {
  connections: [{ id: "docker", name: "Docker GUI" }],
  managed: [
    { desktop: { id: "cloud", generation: 2 }, enabled: true },
    { desktop: { id: "off", generation: 1 }, enabled: false },
  ],
  failed: false,
}
const grantee = { kind: "character", characterId: "agent" } as const
beforeEach(() => {
  jest.clearAllMocks()
  jest
    .mocked(useComputerUseTargets)
    .mockReturnValue(options as ReturnType<typeof useComputerUseTargets>)
  jest.mocked(bindManagedDesktop).mockResolvedValue("managed:cloud:2")
  jest.mocked(unbindManagedDesktop).mockResolvedValue(undefined)
})
function ui(element: React.ReactNode, messages = en) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ computerUseTarget: messages }}>
      {element}
    </NextIntlClientProvider>
  )
}

it.each([en, zh])(
  "labels disabled Host switches and unsaved characters using split translations",
  (messages) => {
    const { rerender } = ui(
      <ComputerUseTargetPicker value="local" grantee={grantee} onChange={jest.fn()} />,
      messages
    )
    expect(
      screen.getByRole("option", {
        name: messages.disabledDesktop
          .replace("{desktop}", "off")
          .replace("{reason}", messages.agentControlDisabled),
      })
    ).toBeDisabled()
    expect(screen.getByRole("option", { name: "Docker GUI" })).toBeEnabled()
    rerender(
      <NextIntlClientProvider locale="en" messages={{ computerUseTarget: messages }}>
        <ComputerUseTargetPicker value="local" onChange={jest.fn()} />
      </NextIntlClientProvider>
    )
    const disabledLabel = messages.disabledDesktop
      .replace("{desktop}", "cloud")
      .replace("{reason}", messages.unsavedCharacter)
    expect(screen.getByRole("option", { name: disabledLabel })).toBeDisabled()
  }
)

it("waits for the binding module to persist the row before changing the character setting", async () => {
  let resolve!: (id: string) => void
  jest.mocked(bindManagedDesktop).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  const onChange = jest.fn()
  ui(<ComputerUseTargetPicker value="local" grantee={grantee} onChange={onChange} />)
  fireEvent.change(screen.getByRole("combobox", { name: en.label }), {
    target: { value: "managed:cloud:2" },
  })
  expect(bindManagedDesktop).toHaveBeenCalledWith({ desktopId: "cloud", generation: 2, grantee })
  expect(onChange).not.toHaveBeenCalled()
  expect(screen.getByRole("combobox")).toBeDisabled()
  await act(async () => resolve("managed:cloud:2"))
  expect(onChange).toHaveBeenCalledWith({ connectionId: "managed:cloud:2" })
})

it("does not persist a target if the Host refuses delegation", async () => {
  jest.mocked(bindManagedDesktop).mockRejectedValue(new Error("refused"))
  const onChange = jest.fn()
  ui(<ComputerUseTargetPicker value="local" grantee={grantee} onChange={onChange} />)
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "managed:cloud:2" } })
  expect(await screen.findByRole("alert")).toHaveTextContent(en.changeFailed)
  expect(onChange).not.toHaveBeenCalled()
})

it("revokes before choosing local and retains the target on a failed revoke", async () => {
  const onChange = jest.fn()
  ui(
    <ComputerUseTargetPicker
      value={{ connectionId: "managed:cloud:2" }}
      grantee={grantee}
      onChange={onChange}
    />
  )
  jest.mocked(unbindManagedDesktop).mockRejectedValueOnce(new Error("offline"))
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "local" } })
  await screen.findByRole("alert")
  expect(onChange).not.toHaveBeenCalled()
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "local" } })
  await waitFor(() => expect(onChange).toHaveBeenCalledWith("local"))
  expect(unbindManagedDesktop).toHaveBeenCalledWith("managed:cloud:2", grantee)
})

it("writes a session target using its own grantee, and revokes it when following the character again", async () => {
  const session = { id: "session", title: "chat", createdAt: 0, updatedAt: 0 }
  const { unmount } = ui(<SessionComputerUseTargetPicker session={session} />)
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "managed:cloud:2" } })
  await waitFor(() =>
    expect(updateSession).toHaveBeenCalledWith("session", {
      computerUseTarget: { connectionId: "managed:cloud:2" },
    })
  )
  expect(bindManagedDesktop).toHaveBeenCalledWith({
    desktopId: "cloud",
    generation: 2,
    grantee: { kind: "session", sessionKey: "session" },
  })
  unmount()
  ui(
    <SessionComputerUseTargetPicker
      session={{ ...session, computerUseTarget: { connectionId: "managed:cloud:2" } }}
    />
  )
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "inherit" } })
  await waitFor(() =>
    expect(updateSession).toHaveBeenCalledWith("session", { computerUseTarget: undefined })
  )
  expect(unbindManagedDesktop).toHaveBeenCalledWith("managed:cloud:2", {
    kind: "session",
    sessionKey: "session",
  })
})

it("cleans up a newly created delegation if setting persistence fails", async () => {
  ui(
    <ComputerUseTargetPicker
      value="local"
      grantee={grantee}
      onChange={async () => {
        throw new Error("database")
      }}
    />
  )
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "managed:cloud:2" } })
  await screen.findByRole("alert")
  expect(unbindManagedDesktop).toHaveBeenCalledWith("managed:cloud:2", grantee)
})

it("shows an unavailable stored target without silently selecting local", () => {
  ui(
    <ComputerUseTargetPicker
      value={{ connectionId: "managed:gone:1" }}
      grantee={grantee}
      onChange={jest.fn()}
    />
  )
  expect(screen.getByRole("combobox")).toHaveValue("managed:gone:1")
  expect(screen.getByRole("option", { name: en.unavailable })).toBeDisabled()
})

it("revokes a late delegation after the picker unmounts instead of saving it", async () => {
  let finish!: (id: string) => void
  jest.mocked(bindManagedDesktop).mockImplementationOnce(
    () =>
      new Promise((done) => {
        finish = done
      })
  )
  const onChange = jest.fn()
  const { unmount } = ui(
    <ComputerUseTargetPicker value="local" grantee={grantee} onChange={onChange} />
  )
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "managed:cloud:2" } })
  unmount()
  await act(async () => finish("managed:cloud:2"))
  expect(onChange).not.toHaveBeenCalled()
  expect(unbindManagedDesktop).toHaveBeenCalledWith("managed:cloud:2", grantee)
})
