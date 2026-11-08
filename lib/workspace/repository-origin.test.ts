import { originKey, parseOrigin, sameRepository } from "./repository-origin"

const key = (remote: string) => {
  const origin = parseOrigin(remote)
  return origin ? originKey(origin) : null
}

describe("parseOrigin", () => {
  it.each([
    ["https://github.com/org/sdk", "github.com/org/sdk"],
    ["https://github.com/Org/SDK.git", "github.com/org/sdk"],
    ["https://user:token@github.com/org/sdk.git/", "github.com/org/sdk"],
    ["http://github.com/org/sdk", "github.com/org/sdk"],
    ["git@github.com:org/sdk.git", "github.com/org/sdk"],
    ["github.com:org/sdk", "github.com/org/sdk"],
    ["ssh://git@github.com/org/sdk.git", "github.com/org/sdk"],
    ["ssh://git@github.com:22/org/sdk", "github.com/org/sdk"],
    ["git+ssh://git@github.com/org/sdk.git", "github.com/org/sdk"],
    ["git://github.com/org/sdk.git", "github.com/org/sdk"],
    ["github.com/org/sdk", "github.com/org/sdk"],
    ["GitHub.com/Org/Sdk/", "github.com/org/sdk"],
    // GitHub Enterprise and GitLab subgroups are identities of their own.
    ["https://ghe.corp.example/platform/sdk.git", "ghe.corp.example/platform/sdk"],
    ["git@ghe.corp.example:platform/sdk.git", "ghe.corp.example/platform/sdk"],
    ["https://gitlab.com/group/sub/repo.git", "gitlab.com/group/sub/repo"],
    ["git@gitlab.com:group/sub/repo.git", "gitlab.com/group/sub/repo"],
    ["https://git.example.com:8443/team/app", "git.example.com/team/app"],
    ["localhost/team/app", "localhost/team/app"],
  ])("reads %s as %s", (remote, expected) => {
    expect(key(remote)).toBe(expected)
  })

  it.each([
    "",
    "   ",
    "/home/me/repos/sdk",
    "../sdk",
    "C:\\repos\\sdk",
    "C:/repos/sdk",
    "file:///home/me/repos/sdk",
    "org/sdk",
    "github.com/org",
    "https://github.com/org",
    "https://github.com/",
    "github.com/org/../sdk",
    "not a url at all",
  ])("finds no repository identity in %p", (remote) => {
    expect(parseOrigin(remote)).toBeNull()
  })

  it("tells repositories apart that share a name", () => {
    expect(sameRepository("git@github.com:org/sdk.git", "https://github.com/ORG/sdk")).toBe(true)
    // A fork is another repository.
    expect(sameRepository("github.com/org/sdk", "github.com/fork/sdk")).toBe(false)
    // So is the same path on another host.
    expect(sameRepository("github.com/org/sdk", "ghe.corp.example/org/sdk")).toBe(false)
    expect(sameRepository("github.com/org/sdk", "/local/sdk")).toBe(false)
    expect(sameRepository(null, undefined)).toBe(false)
  })
})
