/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const skillsRef: { current: unknown } = { current: undefined }
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => skillsRef.current,
}))

jest.mock("@/lib/db/skills", () => ({
  ...jest.requireActual("@/lib/db/skills"),
  listSkills: jest.fn(async () => []),
}))

import { fireEvent, render, screen } from "@testing-library/react"
import type { Skill } from "@cognia/agent-config-types"
import { useSkillsStore } from "@/stores/skills"
import { EDITOR_EMPTY_RECENT_LIMIT, SkillEditorEmpty, editableSkills } from "./skill-editor-empty"

function skill(id: string, over: Partial<Skill> = {}): Skill {
  return {
    id,
    name: `Skill ${id}`,
    description: `About ${id}`,
    content: `# ${id}`,
    source: "custom",
    status: "enabled",
    createdAt: 0,
    updatedAt: 0,
    ...over,
  } as Skill
}

beforeEach(() => {
  skillsRef.current = undefined
  useSkillsStore.setState({
    activeTab: "editor",
    editorTarget: null,
    editorWorkspace: {
      activeSkillId: null,
      openFiles: [],
      activeFileId: null,
      rightPaneOpen: true,
    },
  } as never)
})

describe("editableSkills", () => {
  it("leaves out built-ins, which are duplicated rather than edited", () => {
    const ids = editableSkills([skill("a"), skill("b", { isBuiltIn: true })]).map((s) => s.id)
    expect(ids).toEqual(["a"])
  })

  it("puts the most recently changed first and stops at the limit", () => {
    const many = Array.from({ length: EDITOR_EMPTY_RECENT_LIMIT + 2 }, (_, i) =>
      skill(`s${i}`, { updatedAt: i })
    )
    const picked = editableSkills(many)
    expect(picked).toHaveLength(EDITOR_EMPTY_RECENT_LIMIT)
    expect(picked[0].id).toBe(`s${EDITOR_EMPTY_RECENT_LIMIT + 1}`)
  })
})

describe("<SkillEditorEmpty />", () => {
  it("opens a recent skill straight into the editor", () => {
    skillsRef.current = [skill("old", { updatedAt: 1 }), skill("new", { updatedAt: 2 })]
    render(<SkillEditorEmpty />)
    const rows = screen.getAllByTestId(/^skill-editor-empty-open-/)
    expect(rows.map((row) => row.dataset.testid)).toEqual([
      "skill-editor-empty-open-new",
      "skill-editor-empty-open-old",
    ])
    fireEvent.click(rows[0])
    const ws = useSkillsStore.getState().editorWorkspace
    expect(ws.activeSkillId).toBe("new")
    expect(ws.openFiles[0]?.draftContent).toBe("# new")
  })

  it("says how to get a skill of one's own when there is none", () => {
    skillsRef.current = [skill("b", { isBuiltIn: true })]
    render(<SkillEditorEmpty />)
    expect(screen.queryByTestId("skill-editor-empty-recent")).not.toBeInTheDocument()
    expect(screen.getByText("emptyNone")).toBeInTheDocument()
  })

  it("keeps the hint, not the none message, while the list is loading", () => {
    render(<SkillEditorEmpty />)
    expect(screen.getByText("emptyHint")).toBeInTheDocument()
    expect(screen.queryByText("emptyNone")).not.toBeInTheDocument()
  })

  it("goes back to the list, or starts a new skill", () => {
    skillsRef.current = []
    render(<SkillEditorEmpty />)
    fireEvent.click(screen.getByTestId("skill-editor-empty-list"))
    expect(useSkillsStore.getState().activeTab).toBe("my-skills")
    fireEvent.click(screen.getByTestId("skill-editor-empty-create"))
    expect(useSkillsStore.getState().editorTarget).toEqual({ mode: "create" })
  })
})
