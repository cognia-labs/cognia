import "fake-indexeddb/auto"

import type { ExecutionRun } from "@cognia/plugin-contract/types/execution/run"
import { __enableDbRuntimeForTesting, __resetDbForTesting, getDb } from "@/lib/db/schema"
import { createExecutionRun } from "@/lib/db/execution-runs"
import {
  MAX_RUN_TREE_DEPTH,
  buildRunTree,
  buildTree,
  childrenOf,
  flattenTree,
  readRunAncestors,
  readRunSubtree,
  type RunTreeReader,
  type TreeNode,
} from "./run-tree"

function run(id: string, parentRunId?: string, startedAt = 1): ExecutionRun {
  return {
    id,
    ...(parentRunId ? { parentRunId } : {}),
    kind: "job",
    sourceId: id,
    title: id,
    status: "running",
    currentRevision: 0,
    startedAt,
    updatedAt: startedAt,
  }
}

function shape<T extends { id: string }>(nodes: TreeNode<T>[]): unknown[] {
  return nodes.map((node) => [node.item.id, node.depth, shape(node.children)])
}

function memoryReader(rows: ExecutionRun[]): RunTreeReader {
  const byId = new Map(rows.map((row) => [row.id, row]))
  return {
    getRun: async (id) => byId.get(id),
    listChildren: async (parentId) => rows.filter((row) => row.parentRunId === parentId),
  }
}

describe("buildTree", () => {
  const keys = {
    id: (item: { id: string; parent?: string }) => item.id,
    parent: (item: { id: string; parent?: string }) => item.parent,
  }

  it("nests by parent id and keeps insertion order without a comparator", () => {
    const tree = buildTree(
      [{ id: "a" }, { id: "b", parent: "a" }, { id: "c", parent: "a" }, { id: "d", parent: "b" }],
      keys
    )
    expect(shape(tree)).toEqual([
      [
        "a",
        0,
        [
          ["b", 1, [["d", 2, []]]],
          ["c", 1, []],
        ],
      ],
    ])
  })

  it("makes a root of an item whose parent is missing or itself", () => {
    const tree = buildTree(
      [
        { id: "a", parent: "gone" },
        { id: "b", parent: "b" },
      ],
      keys
    )
    expect(shape(tree)).toEqual([
      ["a", 0, []],
      ["b", 0, []],
    ])
  })

  it("surfaces a pure cycle once, at the root", () => {
    const tree = buildTree(
      [
        { id: "a", parent: "b" },
        { id: "b", parent: "a" },
      ],
      keys
    )
    expect(flattenTree(tree).map((node) => node.item.id)).toEqual(["a", "b"])
    expect(shape(tree)).toEqual([["a", 0, [["b", 1, []]]]])
  })

  it("orders siblings and roots by their comparators", () => {
    const tree = buildTree(
      [
        { id: "r2", n: 1 },
        { id: "r1", n: 2 },
        { id: "c2", parent: "r1", n: 2 },
        { id: "c1", parent: "r1", n: 1 },
      ],
      {
        ...keys,
        compare: (left: { n: number }, right: { n: number }) => left.n - right.n,
        compareRoots: (left: { n: number }, right: { n: number }) => right.n - left.n,
      }
    )
    expect(shape(tree)).toEqual([
      [
        "r1",
        0,
        [
          ["c1", 1, []],
          ["c2", 1, []],
        ],
      ],
      ["r2", 0, []],
    ])
  })
})

describe("run rows", () => {
  it("childrenOf answers the direct children, oldest first", () => {
    const rows = [run("p"), run("b", "p", 3), run("a", "p", 2), run("g", "a"), run("x")]
    expect(childrenOf(rows, "p").map((row) => row.id)).toEqual(["a", "b"])
  })

  it("buildRunTree nests by parentRunId alone", () => {
    const rows = [run("child", "root", 2), run("root", undefined, 1), run("other", undefined, 0)]
    expect(shape(buildRunTree(rows))).toEqual([
      ["other", 0, []],
      ["root", 0, [["child", 1, []]]],
    ])
  })
})

describe("readRunAncestors", () => {
  it("walks the parents nearest first and stops at a missing one", async () => {
    const reader = memoryReader([run("a", "b"), run("b", "c"), run("c", "gone")])
    expect((await readRunAncestors("a", reader)).map((row) => row.id)).toEqual(["b", "c"])
  })

  it("answers nothing for a root or an unknown run", async () => {
    const reader = memoryReader([run("root")])
    await expect(readRunAncestors("root", reader)).resolves.toEqual([])
    await expect(readRunAncestors("unknown", reader)).resolves.toEqual([])
  })

  it("stops at a cycle", async () => {
    const reader = memoryReader([run("a", "b"), run("b", "c"), run("c", "a")])
    expect((await readRunAncestors("a", reader)).map((row) => row.id)).toEqual(["b", "c"])
  })

  it("stops at the depth cap", async () => {
    const rows = Array.from({ length: MAX_RUN_TREE_DEPTH + 5 }, (_, index) =>
      run(`r${index}`, `r${index + 1}`)
    )
    expect(await readRunAncestors("r0", memoryReader(rows))).toHaveLength(MAX_RUN_TREE_DEPTH)
  })
})

describe("readRunSubtree", () => {
  it("reads the tree below a run, level by level", async () => {
    const reader = memoryReader([
      run("root"),
      run("a", "root", 1),
      run("b", "root", 2),
      run("a1", "a"),
      run("unrelated"),
    ])
    expect(shape([(await readRunSubtree("root", reader))!])).toEqual([
      [
        "root",
        0,
        [
          ["a", 1, [["a1", 2, []]]],
          ["b", 1, []],
        ],
      ],
    ])
  })

  it("answers undefined for a run that does not exist", async () => {
    await expect(readRunSubtree("gone", memoryReader([]))).resolves.toBeUndefined()
  })

  it("places a run once when a corrupt cycle loops back to the root", async () => {
    const reader = memoryReader([run("root", "child"), run("child", "root")])
    const tree = await readRunSubtree("root", reader)
    expect(flattenTree([tree!]).map((node) => node.item.id)).toEqual(["root", "child"])
  })
})

describe("against executionRuns", () => {
  let disableDbRuntime: (() => void) | undefined

  beforeEach(async () => {
    disableDbRuntime = __enableDbRuntimeForTesting()
    await getDb().delete()
    __resetDbForTesting()
  })

  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    disableDbRuntime?.()
  })

  it("reads ancestors and the subtree through the parentRunId index", async () => {
    await createExecutionRun(run("team", undefined, 1))
    await createExecutionRun(run("child", "team", 2))
    await createExecutionRun(run("grandchild", "child", 3))

    expect((await readRunAncestors("grandchild")).map((row) => row.id)).toEqual(["child", "team"])
    expect(shape([(await readRunSubtree("team"))!])).toEqual([
      ["team", 0, [["child", 1, [["grandchild", 2, []]]]]],
    ])
  })
})
