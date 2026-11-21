const loadInstructionsMock = jest.fn()
jest.mock("@/lib/agents/instructions/load", () => ({
  loadProjectInstructions: (...a: unknown[]) => loadInstructionsMock(...a),
}))

import {
  allMarkdownMentionCandidates,
  discoverMarkdownAgentTargets,
  markdownAgentTargets,
  mergeChatMentionTargets,
} from "./markdown-agent-targets"
import { resolveTargetAgentId } from "./agent-targets"
import type { MarkdownAgentFile } from "@/lib/agents/markdown-agents"

beforeEach(() => loadInstructionsMock.mockReset())

const file = (id: string, body: string): MarkdownAgentFile => ({ id, content: body })

describe("markdownAgentTargets", () => {
  it("projects parsed markdown agents into mention targets (handle === id)", () => {
    const targets = markdownAgentTargets([
      file("code-reviewer", "---\ndescription: Reviews code\nmodel: opus\n---\nYou review code."),
    ])
    expect(targets).toEqual([
      {
        id: "code-reviewer",
        name: "Code Reviewer",
        description: "Reviews code",
        model: "opus",
        handle: "code-reviewer",
      },
    ])
  })

  it("falls back to the raw id when it humanizes to empty", () => {
    const targets = markdownAgentTargets([file("_", "---\ndescription: Edge\n---\nbody")])
    expect(targets[0]).toMatchObject({ id: "_", name: "_", handle: "_" })
  })

  it("skips malformed files (missing description / empty body)", () => {
    const targets = markdownAgentTargets([
      file("bad", "---\n---\n"),
      file("good", "---\ndescription: Ok\n---\nbody"),
    ])
    expect(targets.map((t) => t.id)).toEqual(["good"])
  })

  it("round-trips: a picked markdown handle resolves back to its agent id", () => {
    const targets = markdownAgentTargets([
      file("doc-writer", "---\ndescription: Writes docs\n---\nWrite docs."),
    ])
    expect(resolveTargetAgentId("please @doc-writer help", targets)).toBe("doc-writer")
  })

  it("omits hidden, disabled, and runtime-pinned files from picker targets while retaining send-time candidates (F07/T06)", () => {
    const files = [
      file("visible", "---\ndescription: Visible\n---\nBody."),
      file("secret", "---\ndescription: Hidden\nhidden: true\n---\nBody."),
      file("off", "---\ndescription: Disabled\ndisabled: true\n---\nBody."),
      file("pinned", "---\ndescription: Pinned\nprovider: openai\n---\nBody."),
    ]
    expect(markdownAgentTargets(files).map((t) => t.id)).toEqual(["visible"])
    expect(allMarkdownMentionCandidates(files).map((t) => t.id)).toEqual([
      "visible",
      "secret",
      "off",
      "pinned",
    ])
  })

  it("mergeChatMentionTargets lets markdown agents override colliding base targets (F07/T06)", () => {
    const merged = mergeChatMentionTargets(
      [
        {
          id: "reviewer",
          name: "Template Reviewer",
          description: "from template",
          model: "haiku",
          handle: "reviewer",
        },
        {
          id: "planner",
          name: "Planner",
          description: "plans",
          handle: "planner",
        },
      ],
      [
        {
          id: "reviewer",
          name: "Reviewer",
          description: "from project markdown",
          model: "opus",
          handle: "reviewer",
        },
        {
          id: "doc-writer",
          name: "Doc Writer",
          description: "writes docs",
          handle: "doc-writer",
        },
      ]
    )
    expect(merged).toEqual([
      {
        id: "reviewer",
        name: "Reviewer",
        description: "from project markdown",
        model: "opus",
        handle: "reviewer",
      },
      {
        id: "planner",
        name: "Planner",
        description: "plans",
        handle: "planner",
      },
      {
        id: "doc-writer",
        name: "Doc Writer",
        description: "writes docs",
        handle: "doc-writer",
      },
    ])
  })
})

describe("discoverMarkdownAgentTargets", () => {
  it("discovers + projects markdown agent files for the given roots", async () => {
    loadInstructionsMock.mockResolvedValue({
      markdownAgentFiles: [file("triage", "---\ndescription: Triages issues\n---\nTriage.")],
    })
    const targets = await discoverMarkdownAgentTargets({ cwd: "/repo", roots: ["/repo"] })
    expect(targets.map((t) => t.id)).toEqual(["triage"])
    expect(loadInstructionsMock).toHaveBeenCalledWith({ cwd: "/repo", roots: ["/repo"] })
  })

  it("returns [] when discovery throws (best-effort, never blocks)", async () => {
    loadInstructionsMock.mockRejectedValue(new Error("no fs"))
    expect(await discoverMarkdownAgentTargets({ roots: [] })).toEqual([])
  })
})
