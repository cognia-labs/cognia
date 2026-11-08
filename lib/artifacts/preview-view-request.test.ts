/** @jest-environment jsdom */
import {
  ARTIFACT_PREVIEW_REQUEST_EVENT,
  isArtifactPreviewRequested,
  onArtifactPreviewRequest,
  requestArtifactPreview,
} from "./preview-view-request"

it("delivers the targeted request and retains it for a panel mounting later", () => {
  const release = requestArtifactPreview("late")
  expect(isArtifactPreviewRequested("late")).toBe(true)
  expect(isArtifactPreviewRequested("other")).toBe(false)
  const handler = jest.fn()
  const unsubscribe = onArtifactPreviewRequest(handler)
  const releaseNext = requestArtifactPreview("next")
  expect(handler).toHaveBeenCalledWith("next")
  release()
  expect(isArtifactPreviewRequested("late")).toBe(false)
  unsubscribe()
  const releaseOther = requestArtifactPreview("other")
  expect(handler).toHaveBeenCalledTimes(1)
  releaseNext()
  releaseOther()
})

it("keeps overlapping requests alive until the last caller finishes", () => {
  const first = requestArtifactPreview("same")
  const second = requestArtifactPreview("same")
  first()
  expect(isArtifactPreviewRequested("same")).toBe(true)
  second()
  expect(isArtifactPreviewRequested("same")).toBe(false)
  const third = requestArtifactPreview("same")
  second()
  expect(isArtifactPreviewRequested("same")).toBe(true)
  third()
})

it("ignores malformed request events", () => {
  const handler = jest.fn()
  const unsubscribe = onArtifactPreviewRequest(handler)
  window.dispatchEvent(new Event(ARTIFACT_PREVIEW_REQUEST_EVENT))
  window.dispatchEvent(
    new CustomEvent(ARTIFACT_PREVIEW_REQUEST_EVENT, { detail: { artifactId: 42 } })
  )
  expect(handler).not.toHaveBeenCalled()
  unsubscribe()
})
