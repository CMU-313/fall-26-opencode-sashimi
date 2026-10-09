import { describe, expect, test } from "bun:test"
import { confirm, severity, type Finding, type Turn } from "../../../src/cli/cmd/misconceptions"

type Depth = Finding["depth"]
const depths: Depth[] = ["mild", "moderate", "severe"]
const turn = (role: Turn["role"], index: number): Turn => ({ role, text: `${role} ${index}`, index })

// Student turns at export positions 0, 2 and 4; assistant replies at 1 and 3.
const turns = [turn("user", 0), turn("assistant", 1), turn("user", 2), turn("assistant", 3), turn("user", 4)]
const pull: Finding = { description: "pull is read only", evidence: "why git pull", depth: "severe", messageIndex: 0 }
const merge: Finding = { description: "merge loses work", evidence: "merge is magic", depth: "mild" }
const rebase: Finding = { description: "rebase is merge", evidence: "rebase?", depth: "moderate", messageIndex: 4 }
const candidates = [pull, merge, rebase]
const keep = (id: number, cited: number[] = [], acted = false) => ({ id, cited, acted })
const ids = (kept: ReturnType<typeof keep>[]) =>
  confirm(candidates, kept, turns).map((f) => candidates.findIndex((c) => c.description === f.description))

describe("confirm", () => {
  test("keeps named candidates in kept order, drops the rest and ignores invalid ids", () => {
    expect(confirm([], [keep(0), keep(1)], turns)).toEqual([])
    expect(ids([])).toEqual([])
    expect(ids([keep(1, [3])])).toEqual([1])
    expect(ids([keep(2, [5]), keep(0, [1]), keep(1, [3])])).toEqual([2, 0, 1])
    expect(ids([keep(3), keep(-1), keep(0.5), keep(42), keep(Number.NaN)])).toEqual([])
    expect(ids([keep(3, [1]), keep(1, [3]), keep(-1, [1]), keep(1.5, [1])])).toEqual([1])
  })

  test("a repeated id counts once and the first mention wins", () => {
    const result = confirm(candidates, [keep(1, [3], false), keep(1, [5], true), keep(1, [1], true)], turns)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ description: "merge loses work", cited: [2], acted: false })
  })

  test.each([
    ["bracket numbers become positions (n - 1)", merge, [3], [2], 2],
    ["own messageIndex is unioned with citations", pull, [3], [0, 2], 0],
    ["positions are deduplicated and sorted ascending", rebase, [5, 1, 5, 3, 1], [0, 2, 4], 0],
    ["messageIndex becomes the first position even when it was later", rebase, [1], [0, 4], 0],
    ["assistant, unknown and zero brackets are filtered out", merge, [2, 4, 99, 0, 3], [2], 2],
    ["own messageIndex on a non-student turn is not kept", { ...merge, messageIndex: 1 }, [3], [2], 2],
    ["no valid citation leaves cited empty and messageIndex absent", merge, [2, 99], [], undefined],
    ["no citation leaves messageIndex as it was", { ...merge, messageIndex: 1 }, [], [], 1],
  ])("%s", (_, candidate, brackets, cited, messageIndex) => {
    const result = confirm([candidate], [keep(0, brackets)], turns)
    expect(result[0].cited).toEqual(cited)
    expect(result[0].messageIndex).toBe(messageIndex)
  })

  test("acted is copied but does not change depth; depth comes from severity", () => {
    expect(confirm([merge], [keep(0, [3], true)], turns)[0]).toMatchObject({ depth: "mild", acted: true })
    expect(confirm([rebase], [keep(0, [], true)], turns)[0]).toMatchObject({ depth: "moderate", acted: true })
    expect(confirm([merge], [keep(0, [3], false)], turns)[0]).toMatchObject({ depth: "mild", acted: false })
    expect(confirm([merge], [keep(0, [1, 3])], turns)[0].depth).toBe("severe")
    expect(confirm([pull], [keep(0, [3])], turns)[0].depth).toBe("severe")
    expect(confirm([pull], [keep(0, [1])], turns)[0].depth).toBe("severe")
  })

  test("description and evidence are unchanged, the full shape is as specified and inputs are not mutated", () => {
    const before = structuredClone(candidates)
    const kept = [keep(0, [3, 1], false), keep(1, [3])]
    const keptBefore = structuredClone(kept)
    const expected = { ...pull, cited: [0, 2], acted: false }
    expect(confirm(candidates, kept, turns)[0]).toStrictEqual(expected)
    expect(candidates).toEqual(before)
    expect(kept).toEqual(keptBefore)
  })

  test("works with empty turns: every citation is filtered out", () => {
    const result = confirm([pull, merge], [keep(0, [1]), keep(1, [3])], [])
    expect(result.map((f) => `${f.cited}/${f.messageIndex}`)).toEqual(["/0", "/undefined"])
  })
})

describe("severity", () => {
  const later = [turn("user", 0), turn("user", 1), turn("assistant", 5), turn("user", 6)]
  const edges = [turn("assistant", 0), turn("user", 1), turn("user", 2), turn("assistant", 3)]
  const students = edges.filter((t) => t.role === "user")

  test.each([
    ["two citations with an assistant reply directly between them", [0, 2], turns],
    ["an assistant reply anywhere strictly between first and last citation", [0, 1, 6], later],
  ])("%s is severe whatever the depth", (_, cited, turns) => {
    depths.forEach((depth) => expect(severity({ cited, acted: false, depth, turns })).toBe("severe"))
  })

  test.each([
    ["assistant turns only at or outside the cited bounds", [1, 2], edges],
    ["only student turns between citations", [1, 2], students],
    ["no turn at all between citations", [0, 2], []],
    ["no citation", [], turns],
    ["a single citation with assistant turns around it", [2], turns],
  ])("%s passes the depth through", (_, cited, turns) => {
    depths.forEach((depth) => expect(severity({ cited, acted: false, depth, turns })).toBe(depth))
  })

  test("acted never changes the result", () => {
    depths.forEach((depth) => {
      expect(severity({ cited: [0], acted: true, depth, turns })).toBe(depth)
      expect(severity({ cited: [0, 2], acted: true, depth, turns: [] })).toBe(depth)
      expect(severity({ cited: [0, 2], acted: true, depth, turns })).toBe("severe")
    })
  })
})
