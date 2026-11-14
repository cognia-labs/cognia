import { render, screen } from "@testing-library/react"

import { LocalEngineTargetNotice } from "./local-engine-target-notice"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, string>) =>
    values?.host ? `${key}:${values.host}` : key,
}))

describe("LocalEngineTargetNotice", () => {
  it("names the Host whose engines the panel manages", () => {
    render(
      <LocalEngineTargetNotice target={{ kind: "host", label: "Studio Mac", scopeKey: "studio" }} />
    )
    expect(screen.getByText("localEngineTarget.hostTitle:Studio Mac")).toBeInTheDocument()
    expect(screen.getByTestId("local-engine-target-notice")).toHaveTextContent(
      "localEngineTarget.hostBody"
    )
  })

  it("speaks of the paired Host when it has no name", () => {
    render(
      <LocalEngineTargetNotice target={{ kind: "host", label: undefined, scopeKey: "studio" }} />
    )
    expect(screen.getByText("localEngineTarget.unnamedHostTitle")).toBeInTheDocument()
  })

  it("renders nothing while this device manages its own engines", () => {
    const { container } = render(<LocalEngineTargetNotice target={{ kind: "this-device" }} />)
    expect(container).toBeEmptyDOMElement()
  })
})
