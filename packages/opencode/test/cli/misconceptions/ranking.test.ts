import { describe, expect, test } from "bun:test"
import { EOL } from "os"
import {
  DEPTH_WEIGHT,
  IMPORTANCE_WEIGHT,
  dedupe,
  locate,
  rank,
  table,
  type Category,
  type Finding,
  type Piece,
  type Row,
  type Topic,
} from "../../../src/cli/cmd/misconceptions"

type Depth = Finding["depth"]

const finding = (transcript: string, depth: Depth, extra: Partial<Finding> = {}) => ({
  description: `${transcript} ${depth}`,
  evidence: `${transcript}-${depth}`,
  depth,
  transcript,
  ...extra,
})

const piece: Piece = {
  context: [{ role: "user", text: "earlier question", index: 0 }],
  turns: [
    { role: "assistant", text: "assistant reply", index: 1 },
    { role: "user", text: "why does git pull change my files?", index: 2 },
    { role: "user", text: "(part 2 of 3) rest of a long message", index: 5 },
  ],
}

const item = { description: "thinks pull is read-only", evidence: "why does git pull", depth: "moderate" as const }

describe("weights", () => {
  test("DEPTH_WEIGHT and IMPORTANCE_WEIGHT have the specified values", () => {
    expect(DEPTH_WEIGHT).toEqual({ mild: 1, moderate: 2, severe: 3 })
    expect(IMPORTANCE_WEIGHT).toEqual({ core: 3, supporting: 2, peripheral: 1, uncovered: 1 })
  })
})

describe("locate", () => {
  test("turn matching a user turn label (index + 1) records that turn's index", () => {
    expect(locate({ ...item, turn: 3 }, piece)).toEqual({ ...item, messageIndex: 2 })
  })

  test("turn matching a split-message part records that part's index", () => {
    expect(locate({ ...item, turn: 6 }, piece)).toEqual({ ...item, messageIndex: 5 })
  })

  test("missing turn yields exactly description, evidence and depth", () => {
    const result = locate(item, piece)
    expect(result).toStrictEqual({ ...item })
    expect(Object.keys(result).sort()).toEqual(["depth", "description", "evidence"])
  })

  test("turn matching no turn yields no messageIndex and no turn key", () => {
    const result = locate({ ...item, turn: 99 }, piece)
    expect(Object.keys(result).sort()).toEqual(["depth", "description", "evidence"])
    expect(result).toStrictEqual({ ...item })
  })

  test("turn equal to a raw index (not index + 1) does not match", () => {
    expect(Object.keys(locate({ ...item, turn: 5 }, piece)).sort()).toEqual(["depth", "description", "evidence"])
  })

  test("turn matching an assistant turn yields no messageIndex", () => {
    expect(Object.keys(locate({ ...item, turn: 2 }, piece)).sort()).toEqual(["depth", "description", "evidence"])
  })

  test("turn matching only a context turn yields no messageIndex", () => {
    expect(Object.keys(locate({ ...item, turn: 1 }, piece)).sort()).toEqual(["depth", "description", "evidence"])
  })
})

describe("dedupe", () => {
  const f = (description: string, depth: Depth, messageIndex?: number, evidence = description): Finding =>
    messageIndex === undefined ? { description, evidence, depth } : { description, evidence, depth, messageIndex }

  test("findings with equal messageIndex repeat regardless of wording, keeping the deepest", () => {
    const deep = f("totally different", "severe", 4, "other quote")
    expect(dedupe([f("a", "mild", 4), deep])).toEqual([deep])
  })

  test("findings with different messageIndex never repeat even with identical wording", () => {
    const input = [f("same", "mild", 1), f("same", "mild", 2)]
    expect(dedupe(input)).toEqual(input)
  })

  test("findings without messageIndex repeat when descriptions normalize equal", () => {
    const keep = f("  Thinks PULL -- is read_only!! ", "moderate")
    expect(dedupe([f("thinks pull is read only", "mild"), keep])).toEqual([keep])
  })

  test("findings without messageIndex and different normalized descriptions are kept", () => {
    const input = [f("thinks pull is read only", "mild"), f("thinks push is read only", "mild")]
    expect(dedupe(input)).toEqual(input)
  })

  test("a finding with messageIndex and one without never repeat", () => {
    const input = [f("same", "mild", 0), f("same", "severe")]
    expect(dedupe(input)).toEqual(input)
  })

  test("on a depth tie the earlier finding is kept", () => {
    const first = f("x", "moderate", 3, "first")
    expect(dedupe([first, f("y", "moderate", 3, "second")])).toEqual([first])
  })

  test("kept finding takes the position of the group's first member", () => {
    const a = f("a", "mild", 1)
    const b = f("b", "mild", 2)
    const deep = f("a2", "severe", 1)
    const c = f("c", "mild")
    expect(dedupe([a, b, c, deep])).toEqual([deep, b, c])
  })

  test("severe beats moderate beats mild within a group", () => {
    const moderate = f("q", "moderate")
    const severe = f("Q!", "severe")
    expect(dedupe([f("q", "mild"), moderate, severe, f("q.", "mild")])).toEqual([severe])
  })

  test("kept finding is returned unchanged with its original fields", () => {
    const original = { description: "x", evidence: "quote", depth: "severe" as const, messageIndex: 7 }
    const result = dedupe([original, f("x", "mild", 7)])
    expect(result).toHaveLength(1)
    expect(result[0]).toStrictEqual({ description: "x", evidence: "quote", depth: "severe", messageIndex: 7 })
  })

  test("empty input returns empty output", () => {
    expect(dedupe([])).toEqual([])
  })
})

describe("rank", () => {
  test("no findings returns an empty list", () => {
    expect(rank({ findings: [], categories: [{ name: "A", topic: "t", findingIds: [0] }] })).toEqual([])
  })

  test("without topics, urgency sums depth weights of each transcript's deepest finding", () => {
    const findings = [
      finding("t1", "mild"),
      finding("t1", "severe"),
      finding("t2", "moderate"),
      finding("t3", "mild"),
    ]
    const rows = rank({ findings, categories: [{ name: "Merging", topic: "git", findingIds: [0, 1, 2, 3] }] })
    expect(rows).toHaveLength(1)
    expect(rows[0].category).toBe("Merging")
    expect(rows[0].transcripts).toBe(3)
    expect(rows[0].depth).toEqual({ mild: 1, moderate: 1, severe: 1 })
    expect(rows[0].urgency).toBe(3 + 2 + 1)
    expect(rows[0].topic).toBeUndefined()
    expect(rows[0].importance).toBeUndefined()
  })

  test("examples are at most 2 deepest-per-transcript findings, deepest first", () => {
    const findings = [
      finding("t1", "mild", { messageIndex: 0 }),
      finding("t2", "severe", { messageIndex: 4 }),
      finding("t3", "moderate"),
      finding("t2", "mild"),
    ]
    const rows = rank({ findings, categories: [{ name: "A", topic: "x", findingIds: [0, 1, 2, 3] }] })
    expect(rows[0].examples).toEqual([
      { transcript: "t2", evidence: "t2-severe", messageIndex: 4 },
      { transcript: "t3", evidence: "t3-moderate", messageIndex: undefined },
    ])
  })

  test("a finding belongs only to the first category that lists it", () => {
    const findings = [finding("t1", "severe"), finding("t2", "mild")]
    const rows = rank({
      findings,
      categories: [
        { name: "First", topic: "x", findingIds: [0] },
        { name: "Second", topic: "x", findingIds: [0, 1] },
      ],
    })
    expect(rows.map((r) => [r.category, r.transcripts, r.urgency])).toEqual([
      ["First", 1, 3],
      ["Second", 1, 1],
    ])
  })

  test("invalid ids (non-integer, negative, out of range) are ignored", () => {
    const findings = [finding("t1", "moderate")]
    const rows = rank({
      findings,
      categories: [
        { name: "Bad", topic: "x", findingIds: [0.5, -1, 1, 42] },
        { name: "Good", topic: "x", findingIds: [0] },
      ],
    })
    expect(rows.map((r) => r.category)).toEqual(["Good"])
    expect(rows[0].urgency).toBe(2)
  })

  test("repeated ids within a category count once", () => {
    const findings = [finding("t1", "severe")]
    const rows = rank({ findings, categories: [{ name: "A", topic: "x", findingIds: [0, 0, 0] }] })
    expect(rows).toHaveLength(1)
    expect(rows[0].transcripts).toBe(1)
    expect(rows[0].depth).toEqual({ mild: 0, moderate: 0, severe: 1 })
    expect(rows[0].urgency).toBe(3)
  })

  test("findings listed by no category form an Uncategorized row", () => {
    const findings = [finding("t1", "mild"), finding("t2", "severe"), finding("t3", "moderate")]
    const rows = rank({ findings, categories: [{ name: "A", topic: "x", findingIds: [0] }] })
    const uncategorized = rows.find((r) => r.category === "Uncategorized")
    expect(uncategorized?.transcripts).toBe(2)
    expect(uncategorized?.urgency).toBe(5)
    expect(rows.map((r) => r.category)).toEqual(["Uncategorized", "A"])
  })

  test("with no categories every finding is Uncategorized", () => {
    const rows = rank({ findings: [finding("t1", "mild")], categories: [] })
    expect(rows.map((r) => r.category)).toEqual(["Uncategorized"])
  })

  test("Uncategorized with topics is uncovered (topic none is not matched unless listed)", () => {
    const topics: Topic[] = [{ name: "Git", importance: "core", reason: "r" }]
    const rows = rank({ findings: [finding("t1", "severe")], categories: [], topics })
    expect(rows[0].category).toBe("Uncategorized")
    expect(rows[0].topic).toBeUndefined()
    expect(rows[0].importance).toBe("uncovered")
    expect(rows[0].urgency).toBe(3)
  })

  test("categories with no members produce no row", () => {
    const rows = rank({
      findings: [finding("t1", "mild")],
      categories: [
        { name: "Empty", topic: "x", findingIds: [] },
        { name: "OnlyInvalid", topic: "x", findingIds: [9] },
        { name: "A", topic: "x", findingIds: [0] },
      ],
    })
    expect(rows.map((r) => r.category)).toEqual(["A"])
  })

  test("matched topic multiplies by importance weight and reports the topic name as written", () => {
    const topics: Topic[] = [
      { name: "  Branching Basics ", importance: "core", reason: "r" },
      { name: "Rebasing", importance: "supporting", reason: "r" },
    ]
    const findings = [finding("t1", "moderate"), finding("t2", "mild"), finding("t3", "severe")]
    const rows = rank({
      findings,
      categories: [
        { name: "B", topic: "branching basics", findingIds: [0, 1] },
        { name: "R", topic: " REBASING  ", findingIds: [2] },
      ],
      topics,
    })
    const b = rows.find((r) => r.category === "B")
    const r = rows.find((r) => r.category === "R")
    expect(b?.urgency).toBe((2 + 1) * 3)
    expect(b?.topic).toBe("  Branching Basics ")
    expect(b?.importance).toBe("core")
    expect(r?.urgency).toBe(3 * 2)
    expect(r?.topic).toBe("Rebasing")
    expect(r?.importance).toBe("supporting")
  })

  test("peripheral topic uses weight 1", () => {
    const rows = rank({
      findings: [finding("t1", "severe")],
      categories: [{ name: "P", topic: "Tags", findingIds: [0] }],
      topics: [{ name: "tags", importance: "peripheral", reason: "r" }],
    })
    expect(rows[0].urgency).toBe(3)
    expect(rows[0].importance).toBe("peripheral")
    expect(rows[0].topic).toBe("tags")
  })

  test("unmatched topic uses weight 1, importance uncovered and topic undefined", () => {
    const rows = rank({
      findings: [finding("t1", "moderate")],
      categories: [{ name: "U", topic: "stash", findingIds: [0] }],
      topics: [{ name: "stashing", importance: "core", reason: "r" }],
    })
    expect(rows[0].urgency).toBe(2)
    expect(rows[0].importance).toBe("uncovered")
    expect(rows[0].topic).toBeUndefined()
  })

  test("empty topics array still sets importance to uncovered", () => {
    const rows = rank({
      findings: [finding("t1", "mild")],
      categories: [{ name: "U", topic: "x", findingIds: [0] }],
      topics: [],
    })
    expect(rows[0].importance).toBe("uncovered")
    expect(rows[0].topic).toBeUndefined()
  })

  test("rows are ordered by urgency descending", () => {
    const findings = [finding("t1", "mild"), finding("t2", "severe"), finding("t3", "moderate")]
    const categories: Category[] = [
      { name: "Low", topic: "x", findingIds: [0] },
      { name: "High", topic: "x", findingIds: [1] },
      { name: "Mid", topic: "x", findingIds: [2] },
    ]
    expect(rank({ findings, categories }).map((r) => r.category)).toEqual(["High", "Mid", "Low"])
  })

  test("urgency ties are broken by transcript count descending", () => {
    const findings = [finding("t1", "moderate"), finding("t2", "mild"), finding("t3", "mild")]
    const categories: Category[] = [
      { name: "A one", topic: "x", findingIds: [0] },
      { name: "Z two", topic: "x", findingIds: [1, 2] },
    ]
    const rows = rank({ findings, categories })
    expect(rows.map((r) => [r.category, r.urgency, r.transcripts])).toEqual([
      ["Z two", 2, 2],
      ["A one", 2, 1],
    ])
  })

  test("full ties are broken by category name ascending", () => {
    const findings = [finding("t1", "mild"), finding("t2", "mild"), finding("t3", "mild")]
    const categories: Category[] = [
      { name: "charlie", topic: "x", findingIds: [0] },
      { name: "alpha", topic: "x", findingIds: [1] },
      { name: "bravo", topic: "x", findingIds: [2] },
    ]
    expect(rank({ findings, categories }).map((r) => r.category)).toEqual(["alpha", "bravo", "charlie"])
  })

  test("topic weighting can reorder categories", () => {
    const findings = [finding("t1", "severe"), finding("t2", "moderate")]
    const rows = rank({
      findings,
      categories: [
        { name: "Severe peripheral", topic: "p", findingIds: [0] },
        { name: "Moderate core", topic: "c", findingIds: [1] },
      ],
      topics: [
        { name: "p", importance: "peripheral", reason: "r" },
        { name: "c", importance: "core", reason: "r" },
      ],
    })
    expect(rows.map((r) => [r.category, r.urgency])).toEqual([
      ["Moderate core", 6],
      ["Severe peripheral", 3],
    ])
  })
})

describe("table", () => {
  const row = (overrides: Partial<Row>): Row => ({
    category: "Merging",
    transcripts: 2,
    depth: { mild: 1, moderate: 0, severe: 1 },
    urgency: 4,
    topic: undefined,
    importance: undefined,
    examples: [],
    ...overrides,
  })

  test("empty rows prints the no-misconceptions message", () => {
    expect(table([], 3)).toBe("No misconceptions found in 3 transcript(s).")
  })

  test("rows without importance omit the topic line and format examples", () => {
    const out = table(
      [
        row({
          examples: [
            { transcript: "a.json", evidence: "pull overwrote it", messageIndex: 4 },
            { transcript: "b.json", evidence: "merge is magic", messageIndex: undefined },
          ],
        }),
      ],
      5,
    )
    expect(out).toBe(
      [
        "Misconceptions across 5 transcript(s), most urgent first:",
        "",
        "1. Merging  (urgency 4)",
        "   2 transcript(s): 1 severe, 0 moderate, 1 mild",
        "   > pull overwrote it  (a.json, message 4)",
        "   > merge is magic  (b.json)",
      ].join(EOL),
    )
  })

  test("topic line shows matched topic and importance", () => {
    const out = table([row({ topic: "Branching", importance: "core" })], 2)
    expect(out.split(EOL)).toContain("   topic: Branching (core)")
  })

  test("uncovered topic line says not covered by course material", () => {
    const out = table([row({ importance: "uncovered" })], 2)
    expect(out.split(EOL)).toContain("   topic: not covered by course material (uncovered)")
  })

  test("multiple rows are numbered from 1 with a blank line before each", () => {
    const out = table(
      [
        row({ category: "First", urgency: 9, transcripts: 3, depth: { mild: 0, moderate: 0, severe: 3 } }),
        row({
          category: "Second",
          urgency: 2,
          transcripts: 1,
          depth: { mild: 0, moderate: 1, severe: 0 },
          topic: "Git",
          importance: "supporting",
          examples: [{ transcript: "c.json", evidence: "q", messageIndex: 0 }],
        }),
      ],
      4,
    )
    expect(out).toBe(
      [
        "Misconceptions across 4 transcript(s), most urgent first:",
        "",
        "1. First  (urgency 9)",
        "   3 transcript(s): 3 severe, 0 moderate, 0 mild",
        "",
        "2. Second  (urgency 2)",
        "   1 transcript(s): 0 severe, 1 moderate, 0 mild",
        "   topic: Git (supporting)",
        "   > q  (c.json, message 0)",
      ].join(EOL),
    )
  })

  test("table renders rank output end to end", () => {
    const rows = rank({
      findings: [finding("s1.json", "severe", { messageIndex: 2 })],
      categories: [{ name: "Pulling", topic: "git", findingIds: [0] }],
    })
    expect(table(rows, 1)).toBe(
      [
        "Misconceptions across 1 transcript(s), most urgent first:",
        "",
        "1. Pulling  (urgency 3)",
        "   1 transcript(s): 1 severe, 0 moderate, 0 mild",
        "   > s1.json-severe  (s1.json, message 2)",
      ].join(EOL),
    )
  })
})
