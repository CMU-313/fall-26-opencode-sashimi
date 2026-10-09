import { describe, expect, test } from "bun:test"
import { EOL } from "os"
import { DEPTH_WEIGHT, IMPORTANCE_WEIGHT, dedupe, locate, rank, table } from "../../../src/cli/cmd/misconceptions"
import type { Finding, Piece, Row } from "../../../src/cli/cmd/misconceptions"

type Depth = Finding["depth"]

const finding = (t: string, depth: Depth, messageIndex?: number) => ({
  description: depth,
  evidence: `${t}-${depth}`,
  depth,
  transcript: t,
  messageIndex,
})
const f = (description: string, depth: Depth, messageIndex?: number, evidence = description): Finding =>
  messageIndex === undefined ? { description, evidence, depth } : { description, evidence, depth, messageIndex }
const cat = (name: string, findingIds: number[], topic = "x") => ({ name, topic, findingIds })
const topic = (name: string, importance: "core" | "supporting" | "peripheral") => ({ name, importance, reason: "r" })
const brief = (rows: Row[]) => rows.map((r) => [r.category, r.transcripts, r.urgency, r.topic, r.importance])
const lines = (text: string) => text.replaceAll("\n", EOL)

test("DEPTH_WEIGHT and IMPORTANCE_WEIGHT have the specified values", () => {
  expect(DEPTH_WEIGHT).toEqual({ mild: 1, moderate: 2, severe: 3 })
  expect(IMPORTANCE_WEIGHT).toEqual({ core: 3, supporting: 2, peripheral: 1, uncovered: 1 })
})

describe("locate", () => {
  const piece: Piece = {
    context: [{ role: "user", text: "earlier question", index: 0 }],
    turns: [
      { role: "assistant", text: "assistant reply", index: 1 },
      { role: "user", text: "why does git pull change my files?", index: 2 },
      { role: "user", text: "(part 2 of 3) rest of a long message", index: 5 },
    ],
  }
  const item = { description: "thinks pull is read-only", evidence: "why does git pull", depth: "moderate" as const }

  test.each([
    ["a user turn label (index + 1)", 3, 2],
    ["a split-message part", 6, 5],
  ])("turn matching %s records that turn's index", (_, turn, messageIndex) => {
    expect(locate({ ...item, turn }, piece)).toStrictEqual({ ...item, messageIndex })
  })

  test.each([
    ["no turn", undefined],
    ["a turn matching nothing", 99],
    ["a raw index rather than index + 1", 5],
    ["an assistant turn", 2],
    ["only a context turn", 1],
  ])("%s yields exactly description, evidence and depth", (_, turn) => {
    expect(locate(turn === undefined ? item : { ...item, turn }, piece)).toStrictEqual({ ...item })
  })
})

describe("dedupe", () => {
  test.each([
    ["different messageIndex with identical wording", [f("same", "mild", 1), f("same", "mild", 2)]],
    ["no messageIndex and different normalized descriptions", [f("pull is read only", "mild"), f("push is", "mild")]],
    ["one with messageIndex and one without", [f("same", "mild", 0), f("same", "severe")]],
    ["empty input", []],
  ])("never repeats: %s", (_, input) => {
    expect(dedupe(input)).toEqual(input)
  })

  test("equal messageIndex repeats regardless of wording, keeping the deepest unchanged", () => {
    const deep = f("totally different", "severe", 4, "other quote")
    expect(dedupe([f("a", "mild", 4), deep])).toStrictEqual([deep])
  })

  test("without messageIndex, descriptions repeat when they normalize equal; severe > moderate > mild", () => {
    const severe = f("  Thinks PULL -- is read_only!! ", "severe")
    const repeats = [f("thinks pull is read only", "mild"), f("thinks pull is read only", "moderate"), severe]
    expect(dedupe(repeats)).toEqual([severe])
  })

  test("on a depth tie the earlier finding is kept, at the position of the group's first member", () => {
    const first = f("x", "moderate", 3, "first")
    expect(dedupe([first, f("y", "moderate", 3, "second")])).toEqual([first])
    const deep = f("a2", "severe", 1)
    const result = dedupe([f("a", "mild", 1), f("b", "mild", 2), f("c", "mild"), deep])
    expect(result).toEqual([deep, f("b", "mild", 2), f("c", "mild")])
  })
})

describe("rank", () => {
  test("without topics, urgency sums depth weights of each transcript's deepest finding; examples are the 2 deepest", () => {
    const findings = [
      finding("a", "mild", 0),
      finding("a", "severe", 4),
      finding("b", "moderate"),
      finding("c", "mild"),
    ]
    const rows = rank({ findings, categories: [cat("Merging", [0, 1, 2, 3])] })
    expect(brief(rows)).toEqual([["Merging", 3, 3 + 2 + 1, undefined, undefined]])
    expect(rows[0].depth).toEqual({ mild: 1, moderate: 1, severe: 1 })
    expect(rows[0].examples).toEqual([
      { transcript: "a", evidence: "a-severe", messageIndex: 4 },
      { transcript: "b", evidence: "b-moderate", messageIndex: undefined },
    ])
  })

  test("a finding belongs to the first category listing it; invalid and repeated ids are ignored", () => {
    expect(rank({ findings: [], categories: [cat("A", [0])] })).toEqual([])
    const findings = [finding("t1", "severe"), finding("t2", "mild")]
    const categories = [cat("Bad", [0.5, -1, 2, 42]), cat("First", [0, 0, 0]), cat("Second", [0, 1])]
    const rows = rank({ findings, categories })
    expect(brief(rows)).toEqual([
      ["First", 1, 3, undefined, undefined],
      ["Second", 1, 1, undefined, undefined],
    ])
    expect(rows[0].depth).toEqual({ mild: 0, moderate: 0, severe: 1 })
  })

  test("findings listed by no category form an Uncategorized row; empty categories produce no row", () => {
    const findings = [finding("t1", "mild"), finding("t2", "severe"), finding("t3", "moderate")]
    const rows = rank({ findings, categories: [cat("Empty", []), cat("OnlyInvalid", [9]), cat("A", [0])] })
    expect(brief(rows)).toEqual([
      ["Uncategorized", 2, 5, undefined, undefined],
      ["A", 1, 1, undefined, undefined],
    ])
    const uncovered = rank({ findings: [finding("t1", "severe")], categories: [], topics: [topic("Git", "core")] })
    expect(brief(uncovered)).toEqual([["Uncategorized", 1, 3, undefined, "uncovered"]])
  })

  test("topics match case-insensitively after trimming, weight by importance (reordering rows) and keep the name", () => {
    const topics = [topic("  Branching Basics ", "core"), topic("Rebasing", "supporting"), topic("tags", "peripheral")]
    const findings = [
      finding("t1", "moderate"),
      finding("t2", "mild"),
      finding("t3", "severe"),
      finding("t4", "severe"),
    ]
    const categories = [cat("B", [0, 1], "branching basics"), cat("R", [2], " REBASING  "), cat("P", [3], "Tags")]
    expect(brief(rank({ findings, categories, topics }))).toEqual([
      ["B", 2, (2 + 1) * 3, "  Branching Basics ", "core"],
      ["R", 1, 3 * 2, "Rebasing", "supporting"],
      ["P", 1, 3, "tags", "peripheral"],
    ])
  })

  test.each([
    ["unmatched topic", [topic("stashing", "core")]],
    ["empty topics array", []],
  ])("%s uses weight 1, importance uncovered and topic undefined", (_, topics) => {
    const rows = rank({ findings: [finding("t1", "moderate")], categories: [cat("U", [0], "stash")], topics })
    expect(brief(rows)).toEqual([["U", 1, 2, undefined, "uncovered"]])
  })

  test("orders by urgency desc, then transcripts desc, then name asc", () => {
    const findings = ["moderate", "mild", "mild", "severe", "mild", "mild"].map((d, i) => finding(`t${i}`, d as Depth))
    const categories = [cat("zeta", [4]), cat("A one", [0]), cat("beta", [5]), cat("Z two", [1, 2]), cat("High", [3])]
    const order = rank({ findings, categories }).map((r) => `${r.category}:${r.urgency}/${r.transcripts}`)
    expect(order).toEqual(["High:3/1", "Z two:2/2", "A one:2/1", "beta:1/1", "zeta:1/1"])
  })
})

describe("table", () => {
  test("empty rows prints the no-misconceptions message", () => {
    expect(table([], 3)).toBe("No misconceptions found in 3 transcript(s).")
  })

  test("numbers rows from 1 with a blank line before each, prints topic lines and formats examples", () => {
    const findings = [finding("a.json", "severe", 4), finding("b.json", "mild"), finding("c.json", "moderate")]
    const categories = [cat("Merging", [0, 1], "none"), cat("Second", [2], "git")]
    const rows = rank({ findings, categories, topics: [topic("Git", "supporting")] })
    expect(table(rows, 5)).toBe(
      lines(`Misconceptions across 5 transcript(s), most urgent first:

1. Merging  (urgency 4)
   2 transcript(s): 1 severe, 0 moderate, 1 mild
   topic: not covered by course material (uncovered)
   > a.json-severe  (a.json, message 4)
   > b.json-mild  (b.json)

2. Second  (urgency 4)
   1 transcript(s): 0 severe, 1 moderate, 0 mild
   topic: Git (supporting)
   > c.json-moderate  (c.json)`),
    )
  })

  test("omits the topic line when rows have no importance", () => {
    const rows = rank({ findings: [finding("s1.json", "severe", 2)], categories: [cat("Pulling", [0])] })
    expect(table(rows, 1)).toBe(
      lines(`Misconceptions across 1 transcript(s), most urgent first:

1. Pulling  (urgency 3)
   1 transcript(s): 1 severe, 0 moderate, 0 mild
   > s1.json-severe  (s1.json, message 2)`),
    )
  })
})
