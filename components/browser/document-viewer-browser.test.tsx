/** @jest-environment jsdom */
import { render } from "@testing-library/react"
import { DocumentViewerBrowser } from "./document-viewer-browser"
it("honestly blocks without mounting a shared browser or iframe", () => {
  const onState = jest.fn()
  const { container } = render(
    <DocumentViewerBrowser
      sessionId="s"
      docTabId="d"
      providerId="lark"
      url="https://a.feishu.cn"
      onState={onState}
    />
  )
  expect(onState).toHaveBeenCalledWith("blocked", { reason: "isolation-unavailable" })
  expect(container).toBeEmptyDOMElement()
})
