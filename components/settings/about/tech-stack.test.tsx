/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import pkg from "@/package.json" with { type: "json" }

const openExternalMock = jest.fn(async (_u: string) => {})
jest.mock("@/lib/tauri/opener", () => ({ openExternal: (u: string) => openExternalMock(u) }))

import { TechStack } from "./tech-stack"

describe("<TechStack />", () => {
  it("uses shared package metadata with a collapsed dependency list alongside the brand tiles", () => {
    const { container } = render(<TechStack />)
    const info = container.querySelector('[data-slot="ai-package-info"]')
    expect(info).not.toBeNull()
    expect(info).toHaveTextContent("Cognia")
    expect(info).toHaveTextContent(pkg.version)
    expect(info).toHaveTextContent("not resolved installed versions")
    const toggle = screen.getByRole("button", {
      name: `Runtime dependencies (${Object.keys(pkg.dependencies).length})`,
    })
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByRole("list", { name: "Runtime dependencies" })).not.toBeInTheDocument()
    expect(screen.getAllByRole("listitem")).toHaveLength(9)
  })

  it("shows the declared direct runtime dependencies and keeps keyboard collapse usable", async () => {
    const user = userEvent.setup()
    render(<TechStack />)
    const toggle = screen.getByRole("button", { name: /Runtime dependencies \(/ })
    await user.click(toggle)
    const list = screen.getByRole("list", { name: "Runtime dependencies" })
    expect(within(list).getAllByRole("listitem")).toHaveLength(Object.keys(pkg.dependencies).length)
    for (const name of ["react", "next", "@cognia/agent", "zod", "xlsx"]) {
      const row = within(list).getByText(name, { exact: true }).closest('[role="listitem"]')
      expect(row).toHaveTextContent(pkg.dependencies[name as keyof typeof pkg.dependencies])
    }
    expect(within(list).queryByText("eslint", { exact: true })).not.toBeInTheDocument()
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    await user.keyboard(" ")
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByRole("list", { name: "Runtime dependencies" })).not.toBeInTheDocument()
    expect(toggle).toHaveFocus()
    await user.keyboard("{Enter}")
    expect(screen.getByRole("list", { name: "Runtime dependencies" })).toBeVisible()
    await user.click(screen.getByTestId("stack-React"))
    expect(openExternalMock).toHaveBeenCalledWith("https://react.dev")
  })

  it("renders every credited project", () => {
    render(<TechStack />)
    const grid = screen.getByTestId("acknowledgements")
    for (const name of [
      "Next.js",
      "React",
      "Tauri",
      "Capacitor",
      "Tailwind CSS",
      "shadcn/ui",
      "Radix UI",
      "Zustand",
      "next-intl",
    ]) {
      expect(grid).toHaveTextContent(name)
    }
  })

  it("renders a brand mark for each tile", () => {
    render(<TechStack />)
    const tiles = screen.getAllByRole("listitem")
    expect(tiles).toHaveLength(9)
    for (const tile of tiles) {
      expect(tile.querySelector("svg")).not.toBeNull()
    }
  })

  it("opens the project site on click", () => {
    render(<TechStack />)
    fireEvent.click(screen.getByTestId("stack-React"))
    expect(openExternalMock).toHaveBeenCalledWith("https://react.dev")
    fireEvent.click(screen.getByTestId("stack-Tauri"))
    expect(openExternalMock).toHaveBeenCalledWith("https://tauri.app")
    fireEvent.click(screen.getByTestId("stack-next-intl"))
    expect(openExternalMock).toHaveBeenCalledWith("https://next-intl.dev")
  })
})
