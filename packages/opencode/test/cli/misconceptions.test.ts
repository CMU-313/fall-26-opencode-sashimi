import { describe, expect, test } from "bun:test"
import { Token } from "@opencode-ai/core/util/token"
import {
  dedupe,
  locate,
  rank,
  render,
  shrink,
  split,
  table,
  type Finding,
  type Piece,
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
    index: i,
  }))
}

function turn(role: Turn["role"], text: string, index: number): Turn {
  return { role, text, index }
}

function withoutPartLabel(text: string) {
  return text.replace(/^\(part \d+ of \d+\) /, "")
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
      { role: "user", text: "why does git pull change my files?", index: 0 },
      { role: "assistant", text: "Pull runs fetch and then merge.", index: 1 },
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
      { role: "user", text: "fix my test", index: 0 },
      { role: "assistant", text: "The assertion compares the wrong field.", index: 1 },
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
    expect(result).toEqual([{ role: "user", text: "first\nsecond", index: 0 }])
  })

  test("numbers turns by their position in the export, counting messages without text", () => {
    const result = shrink(
      exported([
        { role: "assistant", parts: [{ type: "tool", tool: "read", state: { status: "completed", output: "..." } }] },
        { role: "user", parts: [{ type: "text", text: "why?" }] },
      ]),
    )
    expect(result).toEqual([{ role: "user", text: "why?", index: 1 }])
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
    expect(split(input, 1_000)).toEqual([{ context: [], turns: input }])
  })

  test("returns no pieces for no turns", () => {
    expect(split([], 1_000)).toEqual([])
  })

  test("keeps every rendered piece within budget", () => {
    const pieces = split(turns(20, 100), 450)
    expect(pieces.length).toBeGreaterThan(1)
    pieces.forEach((piece) => expect(Token.estimate(render(piece))).toBeLessThanOrEqual(450))
  })

  test("counts labels and separators against the budget", () => {
    // Many short turns are mostly labels once rendered.
    split(turns(200, 1), 100).forEach((piece) => expect(Token.estimate(render(piece))).toBeLessThanOrEqual(100))
  })

  test("reviews every turn exactly once, in order", () => {
    const input = turns(20, 100)
    expect(split(input, 450).flatMap((piece) => piece.turns)).toEqual(input)
  })

  test("starts each piece with the last two turns of the previous one as context", () => {
    const pieces = split(turns(20, 100), 450)
    pieces.slice(1).forEach((piece, i) => {
      expect(piece.context).toEqual([...pieces[i].context, ...pieces[i].turns].slice(-2))
    })
  })

  test("drops the context when it would not fit alongside the next turn", () => {
    const input = [turn("user", "a".repeat(400), 0), turn("assistant", "b".repeat(400), 1), turn("user", "c".repeat(1_700), 2)]
    const pieces = split(input, 500)
    expect(pieces.at(-1)?.context).toEqual([])
  })

  test("splits a student message too long for one piece into overlapping parts instead of cutting it off", () => {
    const question = "so why does my test still fail?"
    const pieces = split([turn("user", `${"x".repeat(10_000)} ${question}`, 0)], 500)
    const texts = pieces.flatMap((piece) => piece.turns).map((item) => item.text)
    expect(texts.length).toBeGreaterThan(1)
    expect(texts[0].startsWith(`(part 1 of ${texts.length}) `)).toBe(true)
    expect(texts.at(-1)?.endsWith(question)).toBe(true)
    texts.slice(1).forEach((text, i) => {
      expect(withoutPartLabel(text).startsWith(withoutPartLabel(texts[i]).slice(-100))).toBe(true)
    })
    pieces.forEach((piece) => expect(Token.estimate(render(piece))).toBeLessThanOrEqual(500))
  })
})

describe("render", () => {
  test("numbers student turns to review by position and leaves context unnumbered", () => {
    const piece: Piece = {
      context: [turn("user", "old question", 0)],
      turns: [turn("assistant", "an answer", 1), turn("user", "new question", 2)],
    }
    expect(render(piece)).toBe(
      "Earlier messages, for context only:\n\nSTUDENT: old question\n\nMessages to review:\n\nASSISTANT: an answer\n\n[3] STUDENT: new question",
    )
  })

  test("omits the context heading when there is no context", () => {
    expect(render({ context: [], turns: [turn("user", "hi", 0)] })).toBe("[1] STUDENT: hi")
  })
})

describe("locate", () => {
  const item = { description: "d", evidence: "full", depth: "mild" as const }

  test("records the position of the student message the model cited, even when the piece holds only a part", () => {
    const piece: Piece = { context: [], turns: [turn("user", "(part 1 of 2) the full", 4)] }
    expect(locate({ ...item, turn: 5 }, piece)).toEqual({ ...item, messageIndex: 4 })
  })

  test("leaves the position off when the cited turn is missing, not a student turn, or only context", () => {
    const piece: Piece = { context: [turn("user", "old", 0)], turns: [turn("assistant", "reply", 1), turn("user", "later", 2)] }
    expect(locate(item, piece)).toEqual(item)
    expect(locate({ ...item, turn: 2 }, piece)).toEqual(item)
    expect(locate({ ...item, turn: 1 }, piece)).toEqual(item)
    expect(locate({ ...item, turn: 9 }, piece)).toEqual(item)
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

  test("merges findings that cite the same message, however they are described, keeping the deepest", () => {
    const result = dedupe([
      { description: "Thinks pull only downloads", evidence: "pull just downloads", depth: "mild", messageIndex: 1 },
      { description: "Trusts local runs over CI", evidence: "it passes on my laptop", depth: "severe", messageIndex: 1 },
    ])
    expect(result).toEqual([
      { description: "Trusts local runs over CI", evidence: "it passes on my laptop", depth: "severe", messageIndex: 1 },
    ])
  })

  test("keeps findings with the same description when they cite different messages", () => {
    const input: Finding[] = [
      { description: "Thinks pull only downloads", evidence: "one", depth: "mild", messageIndex: 1 },
      { description: "Thinks pull only downloads", evidence: "two", depth: "mild", messageIndex: 2 },
    ]
    expect(dedupe(input)).toEqual(input)
  })

  test("keeps matching quotes from different messages", () => {
    const input: Finding[] = [
      { description: "Trusts local runs over CI", evidence: "it works for me", depth: "mild", messageIndex: 1 },
      { description: "Skips code review", evidence: "it works for me", depth: "mild", messageIndex: 2 },
    ]
    expect(dedupe(input)).toEqual(input)
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
    expect(rows[0].examples.map((example) => [example.evidence, example.transcript])).toEqual([
      ["quote: x (severe)", "b.json"],
      ["quote: x (moderate)", "c.json"],
    ])
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
    expect(output).toContain("> quote: pull only fetches (severe)  (a.json)")
    expect(
      table(
        rank({
          findings: [{ ...finding("pull only fetches", "severe"), messageIndex: 7 }],
          categories: [{ name: "git pull vs fetch", topic: "none", findingIds: [0] }],
        }),
        1,
      ),
    ).toContain("(a.json, message 7)")
  })
})
