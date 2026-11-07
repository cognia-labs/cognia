import type { ToolSurfaceContext } from "@/lib/modules/manifest-types"

const mockRequest = jest.fn(async (_request: unknown) => true)
jest.mock("@/lib/plugin/security/consent-broker", () => ({
  getPluginConsentBroker: () => ({ request: (request: unknown) => mockRequest(request) }),
}))
const mockDetectPlatform = jest.fn(() => "web")
jest.mock("@/lib/platform/detect", () => ({ detectPlatform: () => mockDetectPlatform() }))

import {
  TEMPLATE_TOOL_CONSENT_SUBJECT,
  currentTemplatePlatform,
  denied,
  invalidArguments,
  notFound,
  requestTemplateToolConsent,
  stringArg,
  templateToolsOffered,
  toolFailed,
} from "./agent-tool-kit"

function surfaceCtx(fields: Partial<ToolSurfaceContext> = {}): ToolSurfaceContext {
  return {
    session: { id: "s1" } as ToolSurfaceContext["session"],
    agent: null,
    settings: { selfInvokeTools: { templates: true } } as ToolSurfaceContext["settings"],
    activeGoal: null,
    prompts: { snapshot: null, context: {} },
    host: "web",
    activeProject: null,
    ...fields,
  }
}

describe("templateToolsOffered", () => {
  it("offers the tools once opted in, on every host but the CLI", () => {
    for (const host of ["desktop", "web", "mobile", "brain"] as const) {
      expect(templateToolsOffered(surfaceCtx({ host }))).toBe(true)
    }
    expect(templateToolsOffered(surfaceCtx({ host: "cli" }))).toBe(false)
  })

  it("withholds them until opted in and from an IM-bound session", () => {
    expect(templateToolsOffered(surfaceCtx({ settings: null }))).toBe(false)
    expect(
      templateToolsOffered(
        surfaceCtx({ session: { id: "s1", platformBinding: { adapterId: "lark" } } as never })
      )
    ).toBe(false)
  })
})

it("asks the consent broker under the subject grants were given to before the move", async () => {
  expect(TEMPLATE_TOOL_CONSENT_SUBJECT).toBe("cognia-template-builtin")
  mockRequest.mockResolvedValueOnce(false)
  expect(await requestTemplateToolConsent("templates:library:write", "library-write:X")).toBe(false)
  expect(mockRequest).toHaveBeenCalledWith({
    pluginId: "cognia-template-builtin",
    permission: "templates:library:write",
    reason: "library-write:X",
  })
})

it("names the platform a template is instantiated for", async () => {
  mockDetectPlatform.mockReturnValueOnce("tauri")
  expect(await currentTemplatePlatform()).toBe("desktop")
  mockDetectPlatform.mockReturnValueOnce("mobile")
  expect(await currentTemplatePlatform()).toBe("mobile")
  expect(await currentTemplatePlatform()).toBe("web")
})

it("builds the structured failures and reads non-blank string arguments", () => {
  expect(invalidArguments("bad")).toEqual({ ok: false, code: "invalid_arguments", error: "bad" })
  expect(notFound("squad", "t1")).toEqual({
    ok: false,
    code: "not_found",
    error: "no squad with id t1",
  })
  expect(denied("do it")).toMatchObject({ code: "consent_denied" })
  expect(toolFailed(new Error("boom"))).toEqual({ ok: false, code: "tool_failed", error: "boom" })
  expect(toolFailed("plain")).toMatchObject({ error: "plain" })
  expect(stringArg({ a: " x ", b: "  ", c: 3 }, "a")).toBe(" x ")
  expect(stringArg({ b: "  " }, "b")).toBeNull()
  expect(stringArg({ c: 3 }, "c")).toBeNull()
})
