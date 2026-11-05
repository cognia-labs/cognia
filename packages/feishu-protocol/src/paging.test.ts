import { readAllLarkPages, withLarkPageParams, type LarkPage, type LarkPageReader } from "./paging"

function reader(pages: Array<LarkPage<number>>) {
  const paths: string[] = []
  const api: LarkPageReader = {
    async get<T>(path: string) {
      paths.push(path)
      return (pages.shift() ?? {}) as T
    },
  }
  return { api, paths }
}

describe("withLarkPageParams", () => {
  it("adds page_size, and an encoded page_token when continuing", () => {
    expect(withLarkPageParams("/l", 50)).toBe("/l?page_size=50")
    expect(withLarkPageParams("/l?x=1", 50, "a/b")).toBe("/l?x=1&page_size=50&page_token=a%2Fb")
  })
})

describe("readAllLarkPages", () => {
  it("follows page tokens until has_more is false", async () => {
    const { api, paths } = reader([
      { items: [1, 2], has_more: true, page_token: "t2" },
      { items: [3], has_more: false },
    ])
    await expect(readAllLarkPages(api, "/l", { cap: 10, pageSize: 2 })).resolves.toEqual({
      items: [1, 2, 3],
      truncated: false,
    })
    expect(paths).toEqual(["/l?page_size=2", "/l?page_size=2&page_token=t2"])
  })

  it("stops at the cap and says it truncated", async () => {
    const { api } = reader([{ items: [1, 2, 3], has_more: true, page_token: "t2" }])
    await expect(readAllLarkPages(api, "/l", { cap: 2, pageSize: 3 })).resolves.toEqual({
      items: [1, 2],
      truncated: true,
    })
  })

  it("treats has_more without a token as the end", async () => {
    const { api } = reader([{ items: [1], has_more: true }])
    await expect(readAllLarkPages(api, "/l", { cap: 5, pageSize: 1 })).resolves.toEqual({
      items: [1],
      truncated: false,
    })
  })

  it("stops after maxPages requests", async () => {
    const { api, paths } = reader([
      { items: [1], has_more: true, page_token: "a" },
      { items: [2], has_more: true, page_token: "b" },
    ])
    await expect(
      readAllLarkPages(api, "/l", { cap: 10, pageSize: 1, maxPages: 2 })
    ).resolves.toEqual({ items: [1, 2], truncated: true })
    expect(paths).toHaveLength(2)
  })
})
