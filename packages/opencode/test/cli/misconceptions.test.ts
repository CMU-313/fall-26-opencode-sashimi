import { describe, expect, test } from "bun:test"
import { Token } from "@opencode-ai/core/util/token"
import {
  dedupe,
  rank,
  shrink,
  split,
  table,
  type Finding,
  type Turn,
} from "../../src/cli/cmd/misconceptions"

// Shaped like `opencode export` output, including fields the analysis ignores.
function exported(messages: { role: "user" | "assistant"; parts: Record<string, unknown>[] }[]) {
  return JSON.stringify({
    info: { id: "ses_1", title: "Git help", directory: "/home/student/project" },
    messages: messages.map((message, i) => ({
      info: { id: `msg_${i}`, sessionID: "ses_1", role: message.role, time: { created: i } },
      parts: message.parts.map((part, j) => ({ id: `prt_${i}_${j}`, messageID: `msg_${i}`, ...part })),
    })),
  })
}

function turns(count: number, tokens: number): Turn[] {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    text: `${i}`.padEnd(tokens * 4, "x"),
  }))
}

function finding(description: string, depth: Finding["depth"], transcript = "a.json") {
  return { description, evidence: `quote: ${description} (${depth})`, depth, transcript }
}

describe("shrink", () => {
  test("keeps student text and assistant text in order", () => {
    const result = shrink(
      exported([
        { role: "user", parts: [{ type: "text", text: "why does git pull change my files?" }] },
        { role: "assistant", parts: [{ type: "text", text: "Pull runs fetch and then merge." }] },
      ]),
    )
    expect(result).toEqual([
      { role: "user", text: "why does git pull change my files?" },
      { role: "assistant", text: "Pull runs fetch and then merge." },
    ])
  })

  test("drops tool output, reasoning, files, and synthetic or ignored text", () => {
    const result = shrink(
      exported([
        {
          role: "user",
          parts: [
            { type: "text", text: "fix my test" },
            { type: "text", text: "<contents of src/app.ts>", synthetic: true },
            { type: "text", text: "hidden", ignored: true },
            { type: "file", url: "file:///src/app.ts", mime: "text/plain" },
          ],
        },
        {
          role: "assistant",
          parts: [
            { type: "step-start" },
            { type: "reasoning", text: "thinking about the test" },
            { type: "tool", tool: "bash", state: { status: "completed", output: "x".repeat(50_000) } },
            { type: "text", text: "The assertion compares the wrong field." },
            { type: "step-finish" },
          ],
        },
      ]),
    )
    expect(result).toEqual([
      { role: "user", text: "fix my test" },
      { role: "assistant", text: "The assertion compares the wrong field." },
    ])
  })

  test("joins multiple text parts and skips messages with no text", () => {
    const result = shrink(
      exported([
        { role: "user", parts: [{ type: "text", text: "first" }, { type: "text", text: "second" }] },
        { role: "assistant", parts: [{ type: "tool", tool: "read", state: { status: "completed", output: "..." } }] },
        { role: "assistant", parts: [{ type: "text", text: "   " }] },
      ]),
    )
    expect(result).toEqual([{ role: "user", text: "first\nsecond" }])
  })

  test("trims long assistant replies but never student text", () => {
    const long = "word ".repeat(2_000)
    const result = shrink(
      exported([
        { role: "user", parts: [{ type: "text", text: long }] },
        { role: "assistant", parts: [{ type: "text", text: long }] },
      ]),
    )
    expect(result?.[0].text).toBe(long.trim())
    expect(result?.[1].text.endsWith("[trimmed]")).toBe(true)
    expect(Token.estimate(result?.[1].text ?? "")).toBeLessThanOrEqual(300)
  })

  test("returns undefined for files that are not session exports", () => {
    expect(shrink("not json")).toBeUndefined()
    expect(shrink(JSON.stringify({ hello: "world" }))).toBeUndefined()
    expect(shrink(JSON.stringify({ messages: [{ info: { role: "system" }, parts: [] }] }))).toBeUndefined()
  })
})

describe("split", () => {
  test("keeps a short transcript in one piece", () => {
    const input = turns(4, 10)
    expect(split(input, 1_000)).toEqual([input])
  })

  test("returns no pieces for no turns", () => {
    expect(split([], 1_000)).toEqual([])
  })

  test("keeps every piece within budget and only cuts between turns", () => {
    const input = turns(20, 100)
    const pieces = split(input, 450)
    expect(pieces.length).toBeGreaterThan(1)
    pieces.forEach((piece) => {
      expect(piece.reduce((sum, turn) => sum + Token.estimate(turn.text), 0)).toBeLessThanOrEqual(450)
      piece.forEach((turn) => expect(input).toContainEqual(turn))
    })
  })

  test("covers every turn in order", () => {
    const input = turns(20, 100)
    const seen = [...new Set(split(input, 450).flat().map((turn) => turn.text))]
    expect(seen).toEqual(input.map((turn) => turn.text))
  })

  test("starts each piece with the last two turns of the previous one", () => {
    const pieces = split(turns(20, 100), 450)
    pieces.slice(1).forEach((piece, i) => {
      expect(piece.slice(0, 2)).toEqual(pieces[i].slice(-2))
    })
  })

  test("skips the overlap when it would not fit alongside the next turn", () => {
    const input: Turn[] = [
      { role: "user", text: "a".repeat(400) },
      { role: "assistant", text: "b".repeat(400) },
      { role: "user", text: "c".repeat(1_600) },
    ]
    expect(split(input, 400)).toEqual([[input[0], input[1]], [input[2]]])
  })

  test("trims a single turn larger than the budget", () => {
    const pieces = split([{ role: "user", text: "x".repeat(10_000) }], 500)
    expect(pieces).toHaveLength(1)
    expect(Token.estimate(pieces[0][0].text)).toBeLessThanOrEqual(500)
    expect(pieces[0][0].text.endsWith("[trimmed]")).toBe(true)
  })
})

describe("dedupe", () => {
  test("merges repeats that differ only in case and punctuation, keeping the deepest", () => {
    const result = dedupe([
      { description: "Thinks git pull only fetches.", evidence: "one", depth: "mild" },
      { description: "thinks Git pull only fetches", evidence: "two", depth: "severe" },
      { description: "Thinks git pull only fetches!", evidence: "three", depth: "moderate" },
    ])
    expect(result).toEqual([{ description: "thinks Git pull only fetches", evidence: "two", depth: "severe" }])
  })

  test("keeps different misconceptions", () => {
    const input = [
      { description: "Thinks git pull only fetches", evidence: "one", depth: "mild" as const },
      { description: "Confuses mocks with stubs", evidence: "two", depth: "mild" as const },
    ]
    expect(dedupe(input)).toEqual(input)
  })
})

describe("rank", () => {
  test("counts each transcript once, at its deepest finding", () => {
    const rows = rank({
      findings: [
        finding("pull only fetches", "mild", "a.json"),
        finding("pull never merges", "severe", "a.json"),
        finding("pull is fetch", "moderate", "b.json"),
      ],
      categories: [{ name: "git pull vs fetch", topic: "none", findingIds: [0, 1, 2] }],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      category: "git pull vs fetch",
      transcripts: 2,
      urgency: 3 + 2,
      depth: { mild: 0, moderate: 1, severe: 1 },
      importance: undefined,
    })
  })

  test("weights by course topic importance, matching topic names loosely", () => {
    const rows = rank({
      findings: [finding("pull only fetches", "moderate")],
      categories: [{ name: "git pull vs fetch", topic: "  version control ", findingIds: [0] }],
      topics: [{ name: "Version Control", importance: "core", reason: "every project" }],
    })
    expect(rows[0]).toMatchObject({ topic: "Version Control", importance: "core", urgency: 2 * 3 })
  })

  test("marks categories outside the course topics as uncovered", () => {
    const rows = rank({
      findings: [finding("docker volumes", "severe"), finding("kubernetes pods", "severe", "b.json")],
      categories: [
        { name: "docker", topic: "none", findingIds: [0] },
        { name: "kubernetes", topic: "Cloud Ops", findingIds: [1] },
      ],
      topics: [{ name: "Version Control", importance: "core", reason: "every project" }],
    })
    rows.forEach((row) => expect(row).toMatchObject({ importance: "uncovered", topic: undefined, urgency: 3 }))
  })

  test("ranks a widespread mild confusion on a core topic above one severe case on a peripheral topic", () => {
    const rows = rank({
      findings: [
        finding("pull only fetches", "mild", "a.json"),
        finding("pull only fetches", "mild", "b.json"),
        finding("mutation score is coverage", "severe", "c.json"),
      ],
      categories: [
        { name: "mutation testing", topic: "Mutation Testing", findingIds: [2] },
        { name: "git pull vs fetch", topic: "Version Control", findingIds: [0, 1] },
      ],
      topics: [
        { name: "Version Control", importance: "core", reason: "" },
        { name: "Mutation Testing", importance: "peripheral", reason: "" },
      ],
    })
    expect(rows.map((row) => [row.category, row.urgency])).toEqual([
      ["git pull vs fetch", 6],
      ["mutation testing", 3],
    ])
  })

  test("puts unassigned findings in Uncategorized and ignores duplicate or invalid ids", () => {
    const rows = rank({
      findings: [finding("one", "mild"), finding("two", "mild", "b.json"), finding("three", "severe", "c.json")],
      categories: [
        { name: "first", topic: "none", findingIds: [0, 0, 7, -1, 1.5] },
        { name: "second", topic: "none", findingIds: [0] },
        { name: "empty", topic: "none", findingIds: [] },
      ],
    })
    expect(rows.map((row) => [row.category, row.transcripts])).toEqual([
      ["Uncategorized", 2],
      ["first", 1],
    ])
  })

  test("shows up to two examples, deepest first", () => {
    const rows = rank({
      findings: [
        finding("x", "mild", "a.json"),
        finding("x", "severe", "b.json"),
        finding("x", "moderate", "c.json"),
      ],
      categories: [{ name: "x", topic: "none", findingIds: [0, 1, 2] }],
    })
    expect(rows[0].examples).toEqual(["quote: x (severe)", "quote: x (moderate)"])
  })

  test("breaks urgency ties by transcript count, then name", () => {
    const rows = rank({
      findings: [
        finding("b", "severe", "a.json"),
        finding("a", "mild", "a.json"),
        finding("a", "moderate", "b.json"),
        finding("c", "severe", "c.json"),
      ],
      categories: [
        { name: "zeta", topic: "none", findingIds: [0] },
        { name: "alpha", topic: "none", findingIds: [1, 2] },
        { name: "beta", topic: "none", findingIds: [3] },
      ],
    })
    expect(rows.map((row) => row.category)).toEqual(["alpha", "beta", "zeta"])
  })

  test("returns nothing when there are no findings", () => {
    expect(rank({ findings: [], categories: [] })).toEqual([])
  })
})

describe("table", () => {
  test("reports when nothing was found", () => {
    expect(table([], 3)).toBe("No misconceptions found in 3 transcript(s).")
  })

  test("lists categories with counts, topic, and examples", () => {
    const output = table(
      rank({
        findings: [finding("pull only fetches", "severe")],
        categories: [{ name: "git pull vs fetch", topic: "none", findingIds: [0] }],
        topics: [{ name: "Version Control", importance: "core", reason: "" }],
      }),
      1,
    )
    expect(output).toContain("1. git pull vs fetch  (urgency 3)")
    expect(output).toContain("1 transcript(s): 1 severe, 0 moderate, 0 mild")
    expect(output).toContain("topic: not covered by course material (uncovered)")
    expect(output).toContain("> quote: pull only fetches (severe)")
  })
})
