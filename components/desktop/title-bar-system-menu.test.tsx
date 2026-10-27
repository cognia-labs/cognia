/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}))

import { TitleBarSystemMenu, type TitleBarSystemMenuProps } from "./title-bar-system-menu"

function setup(overrides: Partial<TitleBarSystemMenuProps> = {}) {
  const props: TitleBarSystemMenuProps = {
    at: { x: 40, y: 12 },
    onClose: jest.fn(),
    windowChrome: true,
    window: {
      maximized: false,
      minimize: jest.fn().mockResolvedValue(undefined),
      toggleMaximize: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    },
    onCustomize: jest.fn(),
    ...overrides,
  }
  return { props, ...render(<TitleBarSystemMenu {...props} />) }
}

test("renders nothing until a right-click sets the anchor", () => {
  setup({ at: null })
  expect(screen.queryByTestId("title-bar-system-menu-trigger")).toBeNull()
})

test("anchors its invisible trigger at the click point", () => {
  setup()
  const trigger = screen.getByTestId("title-bar-system-menu-trigger")
  expect(trigger).toHaveStyle({ position: "fixed", left: "40px", top: "12px" })
})

test("on Windows / Linux it carries the window commands above Customize", async () => {
  const { props } = setup()
  const user = userEvent.setup()
  expect(
    screen.getByText("desktop.menu.window.restore").closest("[role='menuitem']")
  ).toHaveAttribute("aria-disabled", "true")
  await user.click(screen.getByText("desktop.menu.window.maximize"))
  expect(props.window.toggleMaximize).toHaveBeenCalled()
  expect(props.onClose).toHaveBeenCalled()
})

test("Restore is the enabled one while maximized", async () => {
  const win = {
    maximized: true,
    minimize: jest.fn(),
    toggleMaximize: jest.fn().mockResolvedValue(undefined),
    close: jest.fn(),
  }
  setup({ window: win })
  const user = userEvent.setup()
  expect(
    screen.getByText("desktop.menu.window.maximize").closest("[role='menuitem']")
  ).toHaveAttribute("aria-disabled", "true")
  await user.click(screen.getByText("desktop.menu.window.restore"))
  expect(win.toggleMaximize).toHaveBeenCalledTimes(1)
})

test("Minimize minimizes the window", async () => {
  const { props } = setup()
  const user = userEvent.setup()
  await user.click(screen.getByText("desktop.menu.window.minimize"))
  expect(props.window.minimize).toHaveBeenCalled()
})

test("Close closes the window", async () => {
  const { props } = setup()
  const user = userEvent.setup()
  await user.click(screen.getByText("desktop.menu.window.close"))
  expect(props.window.close).toHaveBeenCalled()
})

test("on macOS it carries Customize alone", async () => {
  const { props } = setup({ windowChrome: false })
  expect(screen.queryByText("desktop.menu.window.close")).toBeNull()
  const user = userEvent.setup()
  await user.click(screen.getByTestId("title-bar-customize"))
  expect(props.onCustomize).toHaveBeenCalled()
  expect(props.onClose).toHaveBeenCalled()
})
