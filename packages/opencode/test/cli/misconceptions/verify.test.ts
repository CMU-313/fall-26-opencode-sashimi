// Unit tests for the verify pass: `confirm` applies a model's `kept` reply to candidate findings and
// `severity` re-derives depth from citations, repetition and whether the student acted on it.
import { describe, expect, test } from "bun:test"
import { confirm, severity, type Finding, type Piece } from "../../../src/cli/cmd/misconceptions"

type Depth = Finding["depth"]
type Turn = Piece["turns"][number]
type Kept = { id: number; cited: readonly number[]; acted: boolean }

// Student turns at export positions 0, 2 and 4; assistant replies at 1 and 3.
const turns: Turn[] = [
  { role: "user", text: "why does git pull change my files?", index: 0 },
  { role: "assistant", text: "pull fetches and merges", index: 1 },
  { role: "user", text: "but pull should be read only", index: 2 },
  { role: "assistant", text: "it is not", index: 3 },
  { role: "user", text: "ok, and rebase?", index: 4 },
]

const pull: Finding = { description: "pull is read only", evidence: "why does git pull", depth: "severe", messageIndex: 0 }
const merge: Finding = { description: "merge loses work", evidence: "merge is magic", depth: "mild" }
const rebase: Finding = { description: "rebase is a merge", evidence: "and rebase?", depth: "moderate", messageIndex: 4 }
const candidates = [pull, merge, rebase]

const keep = (id: number, cited: number[] = [], acted = false): Kept => ({ id, cited, acted })

describe("confirm", () => {
  test("no candidates yields nothing even when ids are named", () => {
    expect(confirm([], [keep(0), keep(1)], turns)).toEqual([])
  })

  test("no kept entries drops every candidate", () => {
    expect(confirm(candidates, [], turns)).toEqual([])
  })

  test("candidates not named in kept are dropped", () => {
    const result = confirm(candidates, [keep(1, [3])], turns)
    expect(result.map((f) => f.description)).toEqual(["merge loses work"])
  })

  test("kept candidates come back in kept order, not candidate order", () => {
    const result = confirm(candidates, [keep(2, [5]), keep(0, [1]), keep(1, [3])], turns)
    expect(result.map((f) => f.description)).toEqual(["rebase is a merge", "pull is read only", "merge loses work"])
  })

  test("ids outside [0, candidates.length) and non-integers are ignored", () => {
    expect(confirm(candidates, [keep(3), keep(-1), keep(0.5), keep(42), keep(Number.NaN)], turns)).toEqual([])
    const result = confirm(candidates, [keep(3, [1]), keep(1, [3]), keep(-1, [1]), keep(1.5, [1])], turns)
    expect(result.map((f) => f.description)).toEqual(["merge loses work"])
  })

  test("a repeated id counts once and the first mention wins", () => {
    const result = confirm(candidates, [keep(1, [3], false), keep(1, [5], true), keep(1, [1], true)], turns)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ description: "merge loses work", cited: [2], acted: false })
  })

  test("bracket numbers are converted to export positions (n - 1)", () => {
    const result = confirm([merge], [keep(0, [3])], turns)
    expect(result[0].cited).toEqual([2])
    expect(result[0].messageIndex).toBe(2)
  })

  test("the candidate's own messageIndex is unioned with the cited positions", () => {
    const result = confirm([pull], [keep(0, [3])], turns)
    expect(result[0].cited).toEqual([0, 2])
    expect(result[0].messageIndex).toBe(0)
  })

  test("cited positions are deduplicated and sorted ascending", () => {
    const result = confirm([rebase], [keep(0, [5, 1, 5, 3, 1])], turns)
    expect(result[0].cited).toEqual([0, 2, 4])
    expect(result[0].messageIndex).toBe(0)
  })

  test("messageIndex becomes the first cited position even when it was later", () => {
    const result = confirm([rebase], [keep(0, [1])], turns)
    expect(result[0].cited).toEqual([0, 4])
    expect(result[0].messageIndex).toBe(0)
  })

  test("positions that are not student turns are filtered out", () => {
    // [2] and [4] are assistant replies, [99] is nobody, [0] would be position -1.
    const result = confirm([merge], [keep(0, [2, 4, 99, 0, 3])], turns)
    expect(result[0].cited).toEqual([2])
    expect(result[0].messageIndex).toBe(2)
  })

  test("a candidate's own messageIndex on a non-student turn is not kept in cited", () => {
    const onAssistant: Finding = { ...merge, messageIndex: 1 }
    const result = confirm([onAssistant], [keep(0, [3])], turns)
    expect(result[0].cited).toEqual([2])
    expect(result[0].messageIndex).toBe(2)
  })

  test("with no valid citations cited is empty and messageIndex is left as it was", () => {
    const none = confirm([merge], [keep(0, [2, 99])], turns)
    expect(none[0].cited).toEqual([])
    expect(none[0].messageIndex).toBeUndefined()
    const onAssistant: Finding = { ...merge, messageIndex: 1 }
    const stays = confirm([onAssistant], [keep(0, [])], turns)
    expect(stays[0].cited).toEqual([])
    expect(stays[0].messageIndex).toBe(1)
  })

  test("acted is copied from the kept entry", () => {
    expect(confirm([merge], [keep(0, [3], true)], turns)[0].acted).toBe(true)
    expect(confirm([merge], [keep(0, [3], false)], turns)[0].acted).toBe(false)
  })

  test("depth is replaced by severity: acted makes it severe", () => {
    expect(confirm([merge], [keep(0, [3], true)], turns)[0].depth).toBe("severe")
  })

  test("depth is replaced by severity: repetition across an assistant reply is severe", () => {
    expect(confirm([merge], [keep(0, [1, 3])], turns)[0].depth).toBe("severe")
    expect(confirm([pull], [keep(0, [3])], turns)[0].depth).toBe("severe")
  })

  test("depth is replaced by severity: a single mild citation stays mild", () => {
    expect(confirm([merge], [keep(0, [3])], turns)[0].depth).toBe("mild")
    expect(confirm([merge], [keep(0, [])], turns)[0].depth).toBe("mild")
  })

  test("depth is replaced by severity: a single severe citation becomes moderate", () => {
    expect(confirm([pull], [keep(0, [1])], turns)[0].depth).toBe("moderate")
    expect(confirm([rebase], [keep(0, [])], turns)[0].depth).toBe("moderate")
  })

  test("description and evidence are unchanged and the full shape is as specified", () => {
    const result = confirm([pull], [keep(0, [3], false)], turns)
    expect(result).toHaveLength(1)
    expect(result[0]).toStrictEqual({
      description: "pull is read only",
      evidence: "why does git pull",
      depth: "severe",
      messageIndex: 0,
      cited: [0, 2],
      acted: false,
    })
  })

  test("inputs are not mutated", () => {
    const before = structuredClone(candidates)
    const kept = [keep(0, [3, 1]), keep(1, [3])]
    const keptBefore = structuredClone(kept)
    confirm(candidates, kept, turns)
    expect(candidates).toEqual(before)
    expect(kept).toEqual(keptBefore)
  })

  test("works with empty turns: every citation is filtered out", () => {
    const result = confirm([pull, merge], [keep(0, [1]), keep(1, [3])], [])
    expect(result.map((f) => f.cited)).toEqual([[], []])
    expect(result[0].messageIndex).toBe(0)
    expect(result[1].messageIndex).toBeUndefined()
  })
})

describe("severity", () => {
  const depths: Depth[] = ["mild", "moderate", "severe"]

  test("acted is severe regardless of depth and citations", () => {
    depths.forEach((depth) => {
      expect(severity({ cited: [], acted: true, depth, turns })).toBe("severe")
      expect(severity({ cited: [0], acted: true, depth, turns })).toBe("severe")
      expect(severity({ cited: [0, 2], acted: true, depth, turns: [] })).toBe("severe")
    })
  })

  test("two citations with an assistant reply strictly between them are severe", () => {
    depths.forEach((depth) => {
      expect(severity({ cited: [0, 2], acted: false, depth, turns })).toBe("severe")
    })
  })

  test("the assistant reply may be anywhere strictly between the first and last citation", () => {
    const later: Turn[] = [
      { role: "user", text: "a", index: 0 },
      { role: "user", text: "b", index: 1 },
      { role: "assistant", text: "c", index: 5 },
      { role: "user", text: "d", index: 6 },
    ]
    expect(severity({ cited: [0, 1, 6], acted: false, depth: "mild", turns: later })).toBe("severe")
  })

  test("an assistant turn only at or outside the cited bounds does not count as repetition", () => {
    const edges: Turn[] = [
      { role: "assistant", text: "before", index: 0 },
      { role: "user", text: "a", index: 1 },
      { role: "user", text: "b", index: 2 },
      { role: "assistant", text: "after", index: 3 },
    ]
    expect(severity({ cited: [1, 2], acted: false, depth: "mild", turns: edges })).toBe("moderate")
    expect(severity({ cited: [1, 2], acted: false, depth: "severe", turns: edges })).toBe("moderate")
  })

  test("two citations with only student turns between them are moderate", () => {
    const students: Turn[] = [
      { role: "user", text: "a", index: 0 },
      { role: "user", text: "b", index: 1 },
      { role: "user", text: "c", index: 2 },
    ]
    depths.forEach((depth) => {
      expect(severity({ cited: [0, 2], acted: false, depth, turns: students })).toBe("moderate")
    })
  })

  test("two citations with no turn at all between them are moderate", () => {
    depths.forEach((depth) => {
      expect(severity({ cited: [0, 2], acted: false, depth, turns: [] })).toBe("moderate")
    })
  })

  test("at most one citation with mild depth is mild", () => {
    expect(severity({ cited: [], acted: false, depth: "mild", turns })).toBe("mild")
    expect(severity({ cited: [0], acted: false, depth: "mild", turns })).toBe("mild")
  })

  test("at most one citation with moderate or severe depth is moderate", () => {
    expect(severity({ cited: [], acted: false, depth: "moderate", turns })).toBe("moderate")
    expect(severity({ cited: [0], acted: false, depth: "moderate", turns })).toBe("moderate")
    expect(severity({ cited: [], acted: false, depth: "severe", turns })).toBe("moderate")
    expect(severity({ cited: [0], acted: false, depth: "severe", turns })).toBe("moderate")
  })

  test("a single citation is never severe without acted, even with assistant turns around it", () => {
    expect(severity({ cited: [2], acted: false, depth: "severe", turns })).toBe("moderate")
  })
})
