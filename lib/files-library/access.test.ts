import { normalizeFileSpacePath } from "@/lib/filespace/paths"
import type { FileSpacePath } from "@/types/filespace"
import type { LiveGrantView } from "@/types/filespace/live"

import { resolveFilesEntryAccess } from "./access"
import type { FilesEntry } from "./types"

const p = (raw: string) => normalizeFileSpacePath(raw) as FileSpacePath

function makeEntry(overrides: Partial<FilesEntry> = {}): FilesEntry {
  return {
    key: "artifact:a1",
    kind: "artifact",
    sourceId: "a1",
    title: "Spec.md",
    sourceTitle: "Spec.md",
    originSessionId: "s1",
    projectIds: [],
    sessionIds: ["s1"],
    sharedWithMe: false,
    creator: "user",
    originAlive: true,
    createdAt: 100,
    updatedAt: 200,
    ownedByFiles: false,
    hidden: false,
    searchText: "spec.md",
    ...overrides,
  }
}

function makeGrantView(
  id: string,
  paths: LiveGrantView["grant"]["paths"],
  overrides: Partial<LiveGrantView["grant"]> = {}
): LiveGrantView {
  return {
    grant: {
      id,
      sessionId: "s1",
      label: "Team SFTP",
      createdBy: "user",
      creatorPrincipal: "owner",
      audience: { kind: "credentials" },
      protocols: ["sftp", "webdav"],
      provider: "builtin",
      permissions: ["read", "download"],
      status: "active",
      statusReason: null,
      expiresAt: 10_000,
      policyRevision: 1,
      createdAt: 500,
      updatedAt: 500,
      revokedAt: null,
      paths,
      ...overrides,
    },
    credentials: [],
  }
}

describe("resolveFilesEntryAccess", () => {
  it("matches live snapshot shares by recorded code or contentHash, stripping secret URL fragments", async () => {
    const result = await resolveFilesEntryAccess(
      makeEntry({
        key: "session-upload:hash-1",
        kind: "session-upload",
        sourceId: "hash-1",
        contentHash: "hash-1",
      }),
      {
        now: () => 1_000,
        hasLiveGrants: () => false,
        getLibraryItem: async () => ({
          key: "session-upload:hash-1",
          kind: "session-upload",
          sourceId: "hash-1",
          sharedLinkCodes: ["code-recorded", "code-expired"],
          createdAt: 1,
          updatedAt: 1,
        }),
        listSharedLinks: async () => [
          {
            id: "sl_1",
            code: "code-recorded",
            kind: "file-bundle",
            title: "Bundle A",
            url: "https://share.example/share/view?c=code-recorded#k=secret-key-1",
            createdAt: 900,
            expiresAt: 5_000,
            burnAfterRead: false,
            hasPassphrase: false,
            revoked: false,
          },
          {
            id: "sl_2",
            code: "code-by-hash",
            kind: "chat-html",
            title: "Chat Share",
            url: "https://share.example/share/view?c=code-by-hash#k=secret-key-2",
            createdAt: 950,
            expiresAt: 6_000,
            burnAfterRead: false,
            hasPassphrase: false,
            revoked: false,
            files: [
              {
                path: "/uploads/doc.pdf",
                size: 8,
                sha256: "hash-1",
              },
            ],
          },
          {
            id: "sl_expired",
            code: "code-expired",
            kind: "file-bundle",
            title: "Old",
            url: "https://share.example/share/view?c=code-expired#k=secret",
            createdAt: 100,
            expiresAt: 999,
            burnAfterRead: false,
            hasPassphrase: false,
            revoked: false,
          },
        ],
      }
    )

    expect(result.sharedLinks).toEqual([
      {
        code: "code-by-hash",
        title: "Chat Share",
        kind: "chat-html",
        createdAt: 950,
        expiresAt: 6_000,
        url: "https://share.example/share/view?c=code-by-hash",
      },
      {
        code: "code-recorded",
        title: "Bundle A",
        kind: "file-bundle",
        createdAt: 900,
        expiresAt: 5_000,
        url: "https://share.example/share/view?c=code-recorded",
      },
    ])
    expect(result.liveGrants).toEqual([])
  })

  it("matches live FileSpace grants across workspace-file and Dexie mounts and ignores locked/revoked grants", async () => {
    const wsAccess = await resolveFilesEntryAccess(
      makeEntry({
        key: "workspace-file:wf1",
        kind: "workspace-file",
        sourceId: "wf1",
        workspace: {
          sessionId: "s1",
          workspaceRoot: "/repo",
          executionRoot: "/repo",
          relPath: "src/lib/index.ts",
        },
      }),
      {
        now: () => 1_000,
        hasLiveGrants: () => true,
        getLibraryItem: async () => undefined,
        listSharedLinks: async () => [],
        loadFileSpace: async () => ({
          sessionId: "s1",
          status: "available",
          hostId: "local",
          mounts: [
            {
              id: "workspace",
              virtualPath: "/workspace",
              backing: "disk",
              label: "repo",
              hostPath: "/repo",
              managed: false,
              writable: true,
              status: "available",
            },
          ],
        }),
        listDexieEntries: async () => ({ uploads: [], artifacts: [] }),
        listLiveGrants: async () => [
          makeGrantView("g-match", [
            {
              mountId: "workspace",
              relPath: "src",
              isDir: true,
              mountFingerprint: "fp",
              virtualPath: "/workspace/src",
            },
          ]),
          makeGrantView("g-miss", [
            {
              mountId: "workspace",
              relPath: "docs",
              isDir: true,
              mountFingerprint: "fp",
              virtualPath: "/workspace/docs",
            },
          ]),
          makeGrantView(
            "g-revoked",
            [
              {
                mountId: "workspace",
                relPath: "",
                isDir: true,
                mountFingerprint: "fp",
                virtualPath: "/workspace",
              },
            ],
            { status: "revoked" }
          ),
        ],
      }
    )

    expect(wsAccess.liveGrants).toEqual([
      {
        id: "g-match",
        sessionId: "s1",
        label: "Team SFTP",
        audienceKind: "credentials",
        protocols: ["sftp", "webdav"],
        permissions: ["read", "download"],
        status: "active",
        expiresAt: 10_000,
        matchedPaths: ["/workspace/src"],
      },
    ])

    const artifactAccess = await resolveFilesEntryAccess(makeEntry(), {
      now: () => 1_000,
      hasLiveGrants: () => true,
      getLibraryItem: async () => undefined,
      listSharedLinks: async () => [],
      loadFileSpace: async () => ({
        sessionId: "s1",
        status: "available",
        hostId: "local",
        mounts: [],
      }),
      listDexieEntries: async () => ({
        uploads: [],
        artifacts: [
          {
            mountId: "artifacts",
            path: p("/artifacts/Spec.md"),
            name: "Spec.md",
            size: 12,
            mediaType: "text/markdown",
            createdAt: 1,
            updatedAt: 2,
            sourceId: "a1",
            sourceAvailable: true,
          },
        ],
      }),
      listLiveGrants: async () => [
        makeGrantView("g-art", [
          {
            mountId: "artifacts",
            relPath: "Spec.md",
            isDir: false,
            mountFingerprint: "fp",
            virtualPath: "/artifacts/Spec.md",
          },
        ]),
      ],
    })
    expect(artifactAccess.liveGrants.map((g) => g.id)).toEqual(["g-art"])
  })
})
