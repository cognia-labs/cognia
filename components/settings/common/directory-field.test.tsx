import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import { DirectoryField } from "./directory-field"

function setup(over: Partial<Parameters<typeof DirectoryField>[0]> = {}) {
  const onChange = jest.fn()
  const onCommit = jest.fn()
  render(
    <DirectoryField
      value=""
      onChange={onChange}
      onCommit={onCommit}
      ariaLabel="Projects folder"
      browseLabel="Browse"
      hasPicker={() => true}
      pick={async () => "/Users/x/Projects"}
      {...over}
    />
  )
  return { onChange, onCommit }
}

describe("DirectoryField", () => {
  it("commits a picked directory immediately", async () => {
    const { onChange, onCommit } = setup()
    fireEvent.click(screen.getByRole("button", { name: "Browse" }))
    await waitFor(() => expect(onCommit).toHaveBeenCalledWith("/Users/x/Projects"))
    expect(onChange).toHaveBeenCalledWith("/Users/x/Projects")
  })

  it("leaves the value alone when the pick is cancelled", async () => {
    const { onChange, onCommit } = setup({ pick: async () => null, value: "/kept" })
    fireEvent.click(screen.getByRole("button", { name: "Browse" }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Browse" })).toBeEnabled())
    expect(onChange).not.toHaveBeenCalled()
    expect(onCommit).not.toHaveBeenCalled()
  })

  it("hides Browse where no picker exists instead of rendering an inert button", () => {
    // `pickDirectory` returns null off Tauri, so a Browse button on web would
    // do nothing at all when clicked. The text input stays — it is the real
    // control on every shell.
    setup({ hasPicker: () => false })
    expect(screen.queryByRole("button", { name: "Browse" })).not.toBeInTheDocument()
    expect(screen.getByLabelText("Projects folder")).toBeInTheDocument()
  })

  it("persists a typed path on blur", () => {
    const { onCommit } = setup({ value: "/typed" })
    fireEvent.blur(screen.getByLabelText("Projects folder"))
    expect(onCommit).toHaveBeenCalledWith("/typed")
  })

  it("carries an id for a label drawn outside the field", () => {
    render(
      <>
        <label htmlFor="seed-dir">Seed storage</label>
        <DirectoryField
          id="seed-dir"
          value=""
          onChange={jest.fn()}
          ariaLabel="Seed storage"
          browseLabel="Browse"
          hasPicker={() => false}
        />
      </>
    )
    expect(screen.getByLabelText("Seed storage")).toHaveAttribute("id", "seed-dir")
  })

  // A form that persists on submit passes only onChange; a pick still fills
  // the field.
  it("fills the field from a pick without an onCommit", async () => {
    const onChange = jest.fn()
    render(
      <DirectoryField
        value=""
        onChange={onChange}
        ariaLabel="Executable"
        browseLabel="Browse"
        hasPicker={() => true}
        pick={async () => "/opt/homebrew/bin/lume"}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Browse" }))
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("/opt/homebrew/bin/lume"))
    fireEvent.blur(screen.getByLabelText("Executable"))
  })
})
