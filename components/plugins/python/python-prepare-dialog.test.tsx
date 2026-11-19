/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { PythonPrepareDialog } from "./python-prepare-dialog"

function renderDialog(overrides: Partial<Parameters<typeof PythonPrepareDialog>[0]> = {}) {
  const onConfirm = jest.fn()
  const onLater = jest.fn()
  render(
    <PythonPrepareDialog
      open
      pluginName="Repo Wiki"
      dependencies={["requests>=2", "numpy<2"]}
      installer="uv"
      onConfirm={onConfirm}
      onLater={onLater}
      {...overrides}
    />
  )
  return { onConfirm, onLater }
}

describe("PythonPrepareDialog", () => {
  it("names the packages, the installer and what preparing costs", () => {
    renderDialog()
    expect(screen.getByText('title:{"name":"Repo Wiki"}')).toBeInTheDocument()
    expect(
      screen.getByText('body:{"name":"Repo Wiki","count":2,"installer":"uv"}')
    ).toBeInTheDocument()
    const packages = screen.getByTestId("python-prepare-dependencies")
    expect(packages).toHaveTextContent("requests>=2")
    expect(packages).toHaveTextContent("numpy<2")
    expect(screen.getByText("impact")).toBeInTheDocument()
  })

  it("says the configured installer when the Host has not named one", () => {
    renderDialog({ installer: null })
    expect(
      screen.getByText('body:{"name":"Repo Wiki","count":2,"installer":"unknown"}')
    ).toBeInTheDocument()
  })

  it("prepares on confirm, and that close is not a later", async () => {
    const user = userEvent.setup()
    const { onConfirm, onLater } = renderDialog()
    await user.click(screen.getByRole("button", { name: "confirm" }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onLater).not.toHaveBeenCalled()
  })

  it("puts it off on later or Escape, without preparing", async () => {
    const user = userEvent.setup()
    const { onConfirm, onLater } = renderDialog()
    await user.click(screen.getByRole("button", { name: "later" }))
    expect(onLater).toHaveBeenCalledTimes(1)
    await user.keyboard("{Escape}")
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it("says a locked plugin installs exactly what its lock pins, online or offline", () => {
    renderDialog({ dependencies: ["six==1.16.0"], lock: { offline: false } })
    expect(
      screen.getByText('bodyLocked:{"name":"Repo Wiki","count":1,"offline":"false"}')
    ).toBeInTheDocument()
    expect(screen.getByText("packagesLocked")).toBeInTheDocument()
    expect(screen.getByTestId("python-prepare-dependencies")).toHaveTextContent("six==1.16.0")
    expect(screen.getByText("impact")).toBeInTheDocument()
  })

  it("says an offline plugin uses its bundled wheels and no network", () => {
    renderDialog({ dependencies: ["six==1.16.0"], lock: { offline: true } })
    expect(
      screen.getByText('bodyLocked:{"name":"Repo Wiki","count":1,"offline":"true"}')
    ).toBeInTheDocument()
    expect(screen.getByText("impactOffline")).toBeInTheDocument()
  })

  it("says uv is installed first when it is missing", async () => {
    const user = userEvent.setup()
    const { onConfirm } = renderDialog({ lock: { offline: false }, needsUv: true })
    expect(screen.getByTestId("python-prepare-needs-uv")).toHaveTextContent("needsUv")
    await user.click(screen.getByRole("button", { name: "confirmWithUv" }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it("renders nothing while closed", () => {
    renderDialog({ open: false })
    expect(screen.queryByTestId("python-prepare-dialog")).not.toBeInTheDocument()
  })
})
