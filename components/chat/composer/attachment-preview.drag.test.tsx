/**
 * Drag wiring for the attachment chips.
 *
 * Kept in its own file because it stubs `@dnd-kit/core`'s `DndContext` to hand
 * the drag callbacks back to the test. jsdom reports every element as 0×0, so
 * the real sensors can never resolve a drop target there — stubbing the context
 * exercises OUR handler rather than the library's hit-testing. The decision the
 * handler delegates to is unit-tested as `resolveDragEnd`.
 */

import { fireEvent, render, screen } from "@testing-library/react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { SPRING_DRAG } from "@/lib/ui/motion"
import { AttachmentPreview } from "./attachment-preview"
import type { StagedAttachmentState, StagedAttachmentsValue } from "./staged-attachment-store"

const mockReorder = jest.fn()

/**
 * Drag callbacks captured from the stubbed DndContext. The `mock` name prefix
 * is what lets the hoisted `jest.mock` factory below reference it without
 * tripping the TDZ guard.
 */
const mockDnd: {
  onDragStart?: (e: { active: { id: string } }) => void
  onDragEnd?: (e: { active: { id: string }; over: { id: string } | null }) => void
  onDragCancel?: () => void
} = {}

jest.mock("@dnd-kit/core", () => ({
  ...jest.requireActual("@dnd-kit/core"),
  DndContext: ({
    children,
    onDragStart,
    onDragEnd,
    onDragCancel,
  }: {
    children: React.ReactNode
    onDragStart?: (e: unknown) => void
    onDragEnd?: (e: unknown) => void
    onDragCancel?: () => void
  }) => {
    mockDnd.onDragStart = onDragStart as typeof mockDnd.onDragStart
    mockDnd.onDragEnd = onDragEnd as typeof mockDnd.onDragEnd
    mockDnd.onDragCancel = onDragCancel
    return <>{children}</>
  },
}))

/** Props each chip's `motion.div` received, so the settle transition is observable. */
const mockMotionDivProps: Array<{ layout?: unknown; transition?: Record<string, unknown> }> = []

jest.mock("motion/react", () => {
  const actual = jest.requireActual("motion/react")
  const React = jest.requireActual("react")
  const Div = React.forwardRef(function MotionDivStub(
    {
      layout,
      transition,
      initial: _initial,
      animate: _animate,
      exit: _exit,
      ...rest
    }: Record<string, unknown>,
    ref: unknown
  ) {
    mockMotionDivProps.push({ layout, transition: transition as Record<string, unknown> })
    return React.createElement("div", { ref, ...rest })
  })
  return {
    ...actual,
    motion: new Proxy(actual.motion, {
      get: (target, key) => (key === "div" ? Div : target[key as keyof typeof target]),
    }),
  }
})

const mockState: {
  files: Array<{ id: string; type?: "file"; filename?: string }>
  byId: Map<string, StagedAttachmentState>
  order: string[]
} = { files: [], byId: new Map(), order: [] }

jest.mock("@/components/ai-elements/prompt-input", () => ({
  usePromptInputAttachments: () => ({ files: mockState.files, remove: jest.fn() }),
}))

jest.mock("./staged-attachment-store", () => ({
  useStagedAttachments: (): StagedAttachmentsValue => ({
    byId: mockState.byId,
    order: mockState.order,
    isExtracting: false,
    totalBytes: 0,
    totalTokens: 0,
    precomputed: new Map(),
    whenSettled: async () => {},
    reorder: mockReorder,
    setOcrText: jest.fn(),
    toggleIncludeOcr: jest.fn(),
    applyVideoSettings: jest.fn(),
    seedIncoming: jest.fn(),
    processMedia: jest.fn(),
    cancelProcessing: jest.fn(),
    retry: jest.fn(),
  }),
}))

function stage(files: Array<{ id: string; filename?: string }>) {
  mockState.files = files.map((f) => ({ type: "file" as const, ...f }))
  mockState.order = files.map((f) => f.id)
  mockState.byId = new Map(
    files.map((f) => [
      f.id,
      {
        status: "ready" as const,
        sizeBytes: 1,
        extracted: {
          kind: "document" as const,
          block: { type: "text" as const, text: "x" },
          tokens: 0,
        },
      },
    ])
  )
}

function mount() {
  return render(
    <TooltipProvider>
      <AttachmentPreview videoRoute={{ available: false, reason: "runtime" }} />
    </TooltipProvider>
  )
}

beforeEach(() => {
  mockReorder.mockClear()
  stage([
    { id: "a", filename: "one.txt" },
    { id: "b", filename: "two.txt" },
  ])
})

describe("AttachmentPreview — drag settle", () => {
  it("settles a reordered chip on the over-damped drag spring", () => {
    mockMotionDivProps.length = 0
    mount()
    const chip = mockMotionDivProps.find((p) => p.layout !== undefined)
    expect(chip?.transition?.layout).toEqual(SPRING_DRAG)
  })
})

describe("AttachmentPreview — drag handlers", () => {
  it("commits a drop onto a different chip", () => {
    mount()
    mockDnd.onDragStart?.({ active: { id: "a" } })
    mockDnd.onDragEnd?.({ active: { id: "a" }, over: { id: "b" } })
    expect(mockReorder).toHaveBeenCalledWith("a", "b")
  })

  it("ignores a drop back onto the dragged chip", () => {
    mount()
    mockDnd.onDragEnd?.({ active: { id: "a" }, over: { id: "a" } })
    expect(mockReorder).not.toHaveBeenCalled()
  })

  it("ignores a drop that resolved no target", () => {
    mount()
    mockDnd.onDragEnd?.({ active: { id: "a" }, over: null })
    expect(mockReorder).not.toHaveBeenCalled()
  })

  // While a drag is live the framer `layout` prop is switched off so the two
  // libraries don't both animate `transform`; cancelling must restore it.
  it("clears the active drag on cancel so layout animation resumes", () => {
    mount()
    mockDnd.onDragStart?.({ active: { id: "a" } })
    mockDnd.onDragCancel?.()
    // Rendering survives the full start → cancel cycle.
    expect(screen.getAllByTestId("composer-attachment-chip")).toHaveLength(2)
  })

  it("leaves the chips interactive after a completed drag", () => {
    mount()
    mockDnd.onDragStart?.({ active: { id: "a" } })
    mockDnd.onDragEnd?.({ active: { id: "a" }, over: { id: "b" } })
    fireEvent.click(screen.getByRole("button", { name: /Preview one\.txt/i }))
    expect(screen.getByRole("dialog")).toBeInTheDocument()
  })
})
