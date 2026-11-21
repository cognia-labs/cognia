import {
  OH_MY_PI_SOURCE_ID,
  detectOhMyPiSession,
  ohMyPiSessionSource,
  parseOhMyPiSession,
  summarizeOhMyPiFile,
} from "./oh-my-pi"
import { piSessionSource } from "./pi"
import type { PickedSessionFile, SessionRef } from "../types"

const SAMPLE_OMP_JSONL = [
  JSON.stringify({ type: "title", title: "OMP refactor thread" }),
  JSON.stringify({
    type: "session",
    version: 3,
    id: "omp-sess-1",
    cwd: "/work/repo",
    timestamp: "2026-11-18T10:00:00.000Z",
    parentSession: "/Users/dev/.omp/agent/sessions/2026-11-18_parent-id.jsonl",
  }),
  JSON.stringify({
    type: "model_change",
    id: "e1",
    parentId: null,
    provider: "anthropic",
    modelId: "claude-sonnet-4",
    timestamp: "2026-11-18T10:00:01.000Z",
  }),
  JSON.stringify({
    type: "message",
    id: "e2",
    parentId: "e1",
    timestamp: "2026-11-18T10:00:02.000Z",
    message: { role: "user", content: "Check the build status" },
  }),
  JSON.stringify({
    type: "message",
    id: "e3",
    parentId: "e2",
    timestamp: "2026-11-18T10:00:03.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Inspecting build script" },
        { type: "toolCall", id: "call-1", name: "bash", arguments: { cmd: "pnpm test" } },
      ],
      usage: { input: 100, output: 20, cacheRead: 10, cost: { total: 0.01 } },
    },
  }),
  JSON.stringify({
    type: "message",
    id: "e4",
    parentId: "e3",
    timestamp: "2026-11-18T10:00:04.000Z",
    message: {
      role: "toolResult",
      toolCallId: "call-1",
      content: "All green",
      isError: false,
    },
  }),
  JSON.stringify({
    type: "message",
    id: "e5",
    parentId: "e4",
    timestamp: "2026-11-18T10:00:05.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Tests passed." }],
    },
  }),
  // Alternate branch from e2
  JSON.stringify({
    type: "message",
    id: "e-alt",
    parentId: "e2",
    timestamp: "2026-11-18T10:00:03.500Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Alternate branch answer." }],
    },
  }),
].join("\n")

describe("ohMyPiSessionSource", () => {
  it("resolves ompSessionDir or falls back to ~/.omp/agent/sessions", () => {
    expect(ohMyPiSessionSource.scanRoots("")).toEqual([])
    expect(ohMyPiSessionSource.scanRoots("/home/u")).toEqual(["/home/u/.omp/agent/sessions"])
    expect(
      ohMyPiSessionSource.scanRoots("/home/u", {
        claudeConfigDir: "",
        codexHome: "",
        opencodeConfigDir: "",
        opencodeDataDir: "",
        piAgentDir: "/home/u/.pi/agent",
        piSessionDir: "/home/u/.pi/agent/sessions",
        ompAgentDir: "/custom/omp",
        ompSessionDir: "/custom/omp/sessions",
        geminiDir: "",
        continueDir: "",
        cursorDir: "",
      })
    ).toEqual(["/custom/omp/sessions"])
  })

  it("distinguishes .omp/ sessions from .pi/ sessions without shadowing", () => {
    const ompFile: PickedSessionFile = {
      name: "s1.jsonl",
      path: "/home/u/.omp/agent/sessions/s1.jsonl",
      content: SAMPLE_OMP_JSONL,
    }
    const piFile: PickedSessionFile = {
      name: "s2.jsonl",
      path: "/home/u/.pi/agent/sessions/s2.jsonl",
      content: JSON.stringify({
        type: "session",
        version: 3,
        id: "pi-1",
        cwd: "/work",
        timestamp: "2026-11-18T10:00:00.000Z",
      }),
    }

    expect(detectOhMyPiSession([ompFile])).toBe("match")
    expect(piSessionSource.detect([ompFile])).toBe("no")
    expect(detectOhMyPiSession([piFile])).toBe("no")
    expect(piSessionSource.detect([piFile])).toBe("match")
  })

  it("summarizes and parses OMP DAG transcripts with fork metadata, tools, and alternate branches", () => {
    const summary = summarizeOhMyPiFile(SAMPLE_OMP_JSONL, "/home/u/.omp/agent/sessions/s1.jsonl")
    expect(summary).toMatchObject({
      sourceId: OH_MY_PI_SOURCE_ID,
      ref: {
        sourceId: OH_MY_PI_SOURCE_ID,
        originalSessionId: "omp-sess-1",
      },
      title: "OMP refactor thread",
      cwd: "/work/repo",
    })

    const ref: SessionRef = {
      sourceId: OH_MY_PI_SOURCE_ID,
      originalSessionId: "omp-sess-1",
      locator: "/home/u/.omp/agent/sessions/s1.jsonl",
    }
    const imported = parseOhMyPiSession(ref, SAMPLE_OMP_JSONL)
    expect(imported.session.title).toBe("OMP refactor thread")
    expect(imported.session.model).toBe("anthropic/claude-sonnet-4")
    expect(imported.session.workingDir).toBe("/work/repo")
    expect(imported.session.importRuntimeBinding).toMatchObject({
      presetId: "oh-my-pi",
      nativeSessionId: "omp-sess-1",
      cwd: "/work/repo",
      resumeMethod: "api",
    })
    expect(imported.session.importRelation).toEqual({
      kind: "fork",
      parentNativeSessionId: "parent-id",
    })
    expect(imported.messages.length).toBeGreaterThanOrEqual(3)
    expect(imported.nested).toHaveLength(1)
    expect(imported.nested?.[0]?.session.importRelation).toEqual({
      kind: "branch",
      parentNativeSessionId: "omp-sess-1",
    })
  })
})
