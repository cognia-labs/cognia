import { LOCAL_PERSON_RUN } from "@/lib/execution/acting-authority"
import { createGitHubPullRequestProvider } from "@/lib/review/github-runtime"
jest.mock("@/lib/review/github-runtime", () => ({ createGitHubPullRequestProvider: jest.fn() }))
import type { PullRequestProvider } from "@/types/review"
import { resolvePullRequestWorkspaceBase } from "./pull-request-base"

function provider(): PullRequestProvider {
  return {
    id: "github",
    getAuthenticationState: jest.fn(),
    findForBranch: jest.fn(),
    resolveCheckout: jest.fn().mockResolvedValue({
      provider: "github",
      repository: "acme/app",
      number: 42,
      fetchRef: "refs/pull/42/head",
      headSha: "0123456789abcdef0123456789abcdef01234567",
    }),
    push: jest.fn(),
    create: jest.fn(),
    publishFeedback: jest.fn(),
  }
}

it("refreshes a pull-request base before provisioning", async () => {
  const adapter = provider()
  await expect(
    resolvePullRequestWorkspaceBase(
      "/repo",
      { kind: "pullRequest", provider: "github", repo: "acme/app", number: 42 },
      adapter
    )
  ).resolves.toEqual({
    kind: "pullRequest",
    provider: "github",
    repo: "acme/app",
    number: 42,
    fetchRef: "refs/pull/42/head",
    headSha: "0123456789abcdef0123456789abcdef01234567",
  })
  expect(adapter.resolveCheckout).toHaveBeenCalledWith("/repo", {
    repository: "acme/app",
    number: 42,
  })
})

it("fails closed on a mismatched provider resolution", async () => {
  const adapter = provider()
  jest.mocked(adapter.resolveCheckout).mockResolvedValueOnce({
    provider: "github",
    repository: "other/repo",
    number: 42,
    fetchRef: "refs/pull/42/head",
    headSha: "0123456789abcdef0123456789abcdef01234567",
  })
  await expect(
    resolvePullRequestWorkspaceBase(
      "/repo",
      { kind: "pullRequest", provider: "github", repo: "acme/app", number: 42 },
      adapter
    )
  ).rejects.toThrow("mismatched checkout resolution")
})

it("does not contact a provider for non-PR bases", async () => {
  const adapter = provider()
  await expect(
    resolvePullRequestWorkspaceBase("/repo", { kind: "remoteDefault" }, adapter)
  ).resolves.toEqual({ kind: "remoteDefault" })
  expect(adapter.resolveCheckout).not.toHaveBeenCalled()
})

it("forwards Host admission to the default provider without granting unnamed callers", async () => {
  jest.mocked(createGitHubPullRequestProvider).mockReturnValue(provider() as never)
  const base = { kind: "pullRequest", provider: "github", repo: "acme/app", number: 42 } as const
  await resolvePullRequestWorkspaceBase("/repo", base, undefined, {
    localAuthorization: LOCAL_PERSON_RUN,
  })
  expect(createGitHubPullRequestProvider).toHaveBeenLastCalledWith(undefined, {
    localAuthorization: LOCAL_PERSON_RUN,
  })
  await resolvePullRequestWorkspaceBase("/repo", base)
  expect(createGitHubPullRequestProvider).toHaveBeenLastCalledWith(undefined, undefined)
})
