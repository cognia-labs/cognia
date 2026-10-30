/** @jest-environment jsdom */
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TooltipProvider } from "@/components/ui/tooltip"
import { PluginExtensionSlot, usePluginSlotHasExtensions } from "./plugin-extension-slot"
import { PluginExtensionSlotWithOverflow } from "./plugin-extension-slot-with-overflow"
import { getExtensionsForPoint } from "@/lib/plugin/api/extension-api"
import {
  registerInterceptor,
  __resetInterceptorRegistryForTesting,
} from "@/lib/plugin/interceptors/registry"
import { createInterceptorRegistration } from "@/lib/plugin/interceptors/normalize"
import type { SurfaceProjection } from "@/lib/plugin/interceptors/consumers"
import { usePluginStore } from "@/stores/plugin-runtime"

jest.mock("@/lib/plugin/api/extension-api", () => ({
  getExtensionsForPoint: jest.fn(),
  getExtensionRevision: () => 0,
  subscribeExtensionChanges: () => () => {},
}))
jest.mock("./plugin-surface", () => ({
  PluginSurface: ({ children, title }: { children: React.ReactNode; title?: string }) => (
    <div title={title}>{children}</div>
  ),
}))
beforeEach(() => {
  __resetInterceptorRegistryForTesting()
  usePluginStore.setState({ plugins: {} })
  jest.mocked(getExtensionsForPoint).mockReturnValue([
    {
      id: "ext",
      pluginId: "owner",
      component: () => <span>Extension content</span>,
      options: {},
    },
  ] as never)
})
afterEach(() => __resetInterceptorRegistryForTesting())
function contribute(
  handler: (input: SurfaceProjection) => SurfaceProjection | Promise<SurfaceProjection>,
  strict = false
) {
  return registerInterceptor(
    createInterceptorRegistration({
      pluginId: "decorator",
      pointId: "ui.surface.project",
      semantic: "transform",
      source: "interceptors",
      handler: handler as never,
      ...(strict ? { failurePolicy: "fail-closed" as const } : {}),
    })
  )
}
it.each(["inline", "overflow"])(
  "consumes asynchronous projection in the %s renderer",
  async (kind) => {
    const dispose = contribute((input) => ({
      ...input,
      presentation: { hidden: false, title: "Visible projection" },
    }))
    render(
      kind === "inline" ? (
        <PluginExtensionSlot point="chat.input.above" fallback={<span>Fallback</span>} />
      ) : (
        <PluginExtensionSlotWithOverflow
          point="chat.input.above"
          limit={1}
          overflowLabel="More"
          fallback={<span>Fallback</span>}
        />
      )
    )
    await waitFor(() => expect(screen.getByTitle("Visible projection")).toBeVisible())
    let finish!: () => void
    let started!: () => void
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    act(() => {
      dispose()
      contribute(async (input) => {
        started()
        await new Promise<void>((resolve) => {
          finish = resolve
        })
        return { ...input, presentation: { hidden: true } }
      })
    })
    await ready
    await act(async () => finish())
    expect(screen.getByText("Fallback")).toBeVisible()
    expect(screen.queryByText("Extension content")).not.toBeInTheDocument()
  }
)
it("applies titles and rejects late output after host context changes", async () => {
  let finish!: (input: SurfaceProjection) => void
  let first: SurfaceProjection | undefined
  contribute(async (input) => {
    if (input.context?.sessionId === "old")
      return new Promise((resolve) => {
        first = input
        finish = resolve
      })
    return { ...input, presentation: { hidden: false, title: "Current title" } }
  })
  const view = render(
    <PluginExtensionSlot point="chat.input.above" context={{ sessionId: "old" }} />
  )
  await waitFor(() => expect(first).toBeDefined())
  view.rerender(<PluginExtensionSlot point="chat.input.above" context={{ sessionId: "new" }} />)
  await waitFor(() => expect(screen.getByTitle("Current title")).toBeVisible())
  await act(async () => finish({ ...first!, presentation: { hidden: true } }))
  expect(screen.getByTitle("Current title")).toBeVisible()
})
it("uses projected visibility in the host presence probe", async () => {
  const dispose = contribute((input) => input)
  function Probe() {
    return <span>{String(usePluginSlotHasExtensions("chat.input.above"))}</span>
  }
  render(<Probe />)
  await waitFor(() => expect(screen.getByText("true")).toBeVisible())
  await act(async () => {
    dispose()
    contribute((input) => ({ ...input, presentation: { hidden: true } }))
  })
  await waitFor(() => expect(screen.getByText("false")).toBeVisible())
})

it("filters before computing inline and overflow contributions", async () => {
  jest.mocked(getExtensionsForPoint).mockReturnValue(
    ["first", "hidden", "last"].map((id) => ({
      id,
      pluginId: "owner",
      component: () => <span>{id}</span>,
      options: {},
    })) as never
  )
  contribute((input) => ({
    ...input,
    presentation: { hidden: input.extensionId === "hidden", title: `${input.extensionId} title` },
  }))
  render(
    <TooltipProvider>
      <PluginExtensionSlotWithOverflow point="chat.input.above" limit={1} overflowLabel="More" />
    </TooltipProvider>
  )
  await waitFor(() => expect(screen.getByTitle("first title")).toBeVisible())
  await userEvent.setup().click(screen.getByRole("button", { name: "More" }))
  expect(await screen.findByText("last")).toBeVisible()
  expect(screen.queryByText("hidden")).not.toBeInTheDocument()
})

it("reprojects when one decorator is disabled while another remains live", async () => {
  usePluginStore.setState({
    plugins: { decorator: { status: "enabled" }, second: { status: "enabled" } },
  } as never)
  contribute((input) => ({ ...input, presentation: { hidden: false, title: "From decorator" } }))
  registerInterceptor(
    createInterceptorRegistration({
      pluginId: "second",
      pointId: "ui.surface.project",
      semantic: "transform",
      source: "interceptors",
      handler: ((input: SurfaceProjection) => input) as never,
    })
  )
  render(<PluginExtensionSlot point="chat.input.above" />)
  await waitFor(() => expect(screen.getByTitle("From decorator")).toBeVisible())
  await act(async () =>
    usePluginStore.setState({
      plugins: { decorator: { status: "disabled" }, second: { status: "enabled" } },
    } as never)
  )
  await waitFor(() => expect(screen.queryByTitle("From decorator")).not.toBeInTheDocument())
  expect(await screen.findByText("Extension content")).toBeVisible()
})

it.each([false, true])("honors the projection failure policy (strict=%s)", async (strict) => {
  const handler = jest.fn(() => {
    throw new Error("projection failed")
  })
  contribute(handler, strict)
  render(<PluginExtensionSlot point="chat.input.above" fallback={<span>Fallback</span>} />)
  await act(async () => {
    await Promise.resolve()
  })
  expect(handler).toHaveBeenCalled()
  expect(screen.getByText(strict ? "Fallback" : "Extension content")).toBeVisible()
})
