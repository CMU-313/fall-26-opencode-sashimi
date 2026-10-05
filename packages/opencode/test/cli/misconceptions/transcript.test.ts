import { describe, expect, test } from "bun:test"
import { Token } from "@opencode-ai/core/util/token"
import { render, shrink, split, type Piece, type Turn } from "../../../src/cli/cmd/misconceptions"

function exportJson(messages: unknown[]) {
  return JSON.stringify({ info: { id: "ses_1", title: "t" }, messages })
}

function message(role: string, parts: unknown[]) {
  return { info: { id: "msg", role }, parts }
}

function text(value: string, extra: Record<string, unknown> = {}) {
  return { type: "text", text: value, ...extra }
}

// Distinct, position-identifying text so substring/overlap checks are meaningful.
function prose(prefix: string, chars: number) {
  return Array.from({ length: Math.ceil(chars / 12) }, (_, i) => `${prefix}${String(i).padStart(5, "0")} `)
    .join("")
    .slice(0, chars)
}

function turns(count: number, chars: number): Turn[] {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    text: prose(`t${i}w`, chars).trim(),
    index: i,
  }))
}

const LABEL = /^\(part (\d+) of (\d+)\) /

function content(turn: Turn) {
  return turn.text.replace(LABEL, "")
}

function overlap(a: string, b: string) {
  return Array.from({ length: Math.min(a.length, b.length) }, (_, i) => i + 1)
    .filter((n) => a.slice(-n) === b.slice(0, n))
    .reduce((max, n) => Math.max(max, n), 0)
}

describe("shrink", () => {
  test("returns undefined for non-JSON input", () => {
    expect(shrink("not json {")).toBeUndefined()
  })

  test("returns undefined when there is no messages array", () => {
    expect(shrink(JSON.stringify({ info: { id: "ses_1" } }))).toBeUndefined()
    expect(shrink(JSON.stringify({ messages: "nope" }))).toBeUndefined()
    expect(shrink(JSON.stringify([1, 2, 3]))).toBeUndefined()
  })

  test("returns undefined when a message role is not user or assistant", () => {
    expect(shrink(exportJson([message("user", [text("hi")]), message("system", [text("x")])]))).toBeUndefined()
  })

  test("returns undefined when a part lacks a string type", () => {
    expect(shrink(exportJson([message("user", [{ text: "hi" }])]))).toBeUndefined()
    expect(shrink(exportJson([message("user", [{ type: 3, text: "hi" }])]))).toBeUndefined()
  })

  test("returns an empty list for an export with no messages", () => {
    expect(shrink(exportJson([]))).toEqual([])
  })

  test("joins visible text parts with newlines and trims the result", () => {
    expect(shrink(exportJson([message("user", [text("  first"), text("second  ")])]))).toEqual([
      { role: "user", text: "first\nsecond", index: 0 },
    ])
  })

  test("ignores synthetic, ignored, and non-text parts", () => {
    const result = shrink(
      exportJson([
        message("user", [
          text("why does git pull change my files?"),
          text("<file contents>", { synthetic: true }),
          text("hidden", { ignored: true }),
          { type: "tool", tool: "bash", state: { status: "completed", output: "tool output" } },
          { type: "reasoning", text: "thinking" },
          { type: "step-start" },
          { type: "file", url: "file:///x" },
        ]),
      ]),
    )
    expect(result).toEqual([{ role: "user", text: "why does git pull change my files?", index: 0 }])
  })

  test("omits messages with no visible text but keeps export positions as indexes", () => {
    const result = shrink(
      exportJson([
        message("assistant", [{ type: "tool", tool: "bash", state: { status: "completed", output: "out" } }]),
        message("user", [text("why?")]),
        message("assistant", [text("   \n  ")]),
        message("user", [text("x", { synthetic: true })]),
        message("assistant", [text("because")]),
      ]),
    )
    expect(result).toEqual([
      { role: "user", text: "why?", index: 1 },
      { role: "assistant", text: "because", index: 4 },
    ])
  })

  test("keeps roles and export order", () => {
    const result = shrink(
      exportJson([message("user", [text("a")]), message("assistant", [text("b")]), message("user", [text("c")])]),
    )
    expect(result).toEqual([
      { role: "user", text: "a", index: 0 },
      { role: "assistant", text: "b", index: 1 },
      { role: "user", text: "c", index: 2 },
    ])
  })

  test("ignores extra fields anywhere in the export", () => {
    const result = shrink(
      JSON.stringify({
        extra: true,
        messages: [{ info: { id: "m", role: "user", time: 1 }, parts: [text("hello", { id: "p" })], more: {} }],
      }),
    )
    expect(result).toEqual([{ role: "user", text: "hello", index: 0 }])
  })

  test("never shortens student text", () => {
    const long = prose("u", 20_000)
    expect(shrink(exportJson([message("user", [text(long)])]))).toEqual([{ role: "user", text: long.trim(), index: 0 }])
  })

  test("leaves short assistant text unchanged", () => {
    expect(shrink(exportJson([message("assistant", [text("Use git status to see changes.")])]))).toEqual([
      { role: "assistant", text: "Use git status to see changes.", index: 0 },
    ])
  })

  test("shortens long assistant text to at most 300 tokens ending with [trimmed]", () => {
    const result = shrink(exportJson([message("assistant", [text(prose("a", 20_000))])]))
    expect(result).toHaveLength(1)
    const turn = result![0]
    expect(turn.role).toBe("assistant")
    expect(turn.index).toBe(0)
    expect(turn.text.endsWith("[trimmed]")).toBe(true)
    expect(Token.estimate(turn.text)).toBeLessThanOrEqual(300)
  })
})

describe("render", () => {
  test("numbers student turns by export position and leaves assistant turns unnumbered", () => {
    expect(
      render({
        context: [],
        turns: [
          { role: "user", text: "why?", index: 1 },
          { role: "assistant", text: "because", index: 2 },
          { role: "user", text: "ok", index: 5 },
        ],
      }),
    ).toBe("[2] STUDENT: why?\n\nASSISTANT: because\n\n[6] STUDENT: ok")
  })

  test("renders a single turn with no extra text when context is empty", () => {
    expect(render({ context: [], turns: [{ role: "user", text: "hi", index: 0 }] })).toBe("[1] STUDENT: hi")
  })

  test("renders context unnumbered before the turns to review", () => {
    expect(
      render({
        context: [
          { role: "user", text: "first", index: 0 },
          { role: "assistant", text: "reply", index: 1 },
        ],
        turns: [
          { role: "user", text: "second", index: 2 },
          { role: "assistant", text: "answer", index: 3 },
        ],
      }),
    ).toBe(
      "Earlier messages, for context only:\n\nSTUDENT: first\n\nASSISTANT: reply\n\nMessages to review:\n\n[3] STUDENT: second\n\nASSISTANT: answer",
    )
  })
})

describe("split", () => {
  test("returns no pieces for an empty transcript", () => {
    expect(split([], 1000)).toEqual([])
  })

  test("keeps a transcript that fits the budget in one piece", () => {
    const input = turns(4, 100)
    expect(split(input, 1000)).toEqual([{ context: [], turns: input }])
  })

  test("keeps a transcript whole when it exactly fits the budget", () => {
    const input = turns(3, 200)
    const budget = Token.estimate(render({ context: [], turns: input }))
    expect(split(input, budget)).toEqual([{ context: [], turns: input }])
  })

  test("every piece of a long transcript fits the budget", () => {
    const pieces = split(turns(30, 300), 250)
    expect(pieces.length).toBeGreaterThan(1)
    pieces.forEach((piece) => expect(Token.estimate(render(piece))).toBeLessThanOrEqual(250))
  })

  test("reviews each turn exactly once and in order", () => {
    const input = turns(30, 300)
    expect(split(input, 250).flatMap((p) => p.turns)).toEqual(input)
  })

  test("gives the first piece no context and later pieces the last two turns of the previous piece", () => {
    const pieces = split(turns(30, 300), 400)
    expect(pieces.length).toBeGreaterThan(2)
    expect(pieces[0].context).toEqual([])
    pieces.slice(1).forEach((piece, i) => {
      const previous = [...pieces[i].context, ...pieces[i].turns].slice(-2)
      expect(previous.length).toBe(2)
      expect(piece.context).toEqual(previous)
      piece.context.forEach((turn) => expect(piece.turns).not.toContainEqual(turn))
    })
  })

  test("drops context when it would keep the piece's first turn from fitting", () => {
    // Turns of ~90 tokens with budget 110: a turn fits alone but not with any context turn.
    const input = turns(4, 350)
    const pieces = split(input, 110)
    expect(pieces).toHaveLength(4)
    pieces.forEach((piece, i) => {
      expect(piece.context).toEqual([])
      expect(piece.turns).toEqual([input[i]])
      expect(Token.estimate(render(piece))).toBeLessThanOrEqual(110)
    })
  })

  describe("a turn too long for one piece", () => {
    const question = "So why does my rebase keep deleting the commits I made yesterday?"
    const huge: Turn = { role: "user", text: `${prose("p", 6000)} ${question}`, index: 3 }
    const budget = 300
    const pieces = split([huge], budget)
    const parts = pieces.flatMap((p) => p.turns)

    test("is split into labeled parts with the same role and index", () => {
      expect(parts.length).toBeGreaterThanOrEqual(2)
      parts.forEach((part, i) => {
        const match = part.text.match(LABEL)
        expect(match).not.toBeNull()
        expect(Number(match![1])).toBe(i + 1)
        expect(Number(match![2])).toBe(parts.length)
        expect(part.role).toBe("user")
        expect(part.index).toBe(3)
      })
    })

    test("keeps every piece within the budget", () => {
      pieces.forEach((piece) => expect(Token.estimate(render(piece))).toBeLessThanOrEqual(budget))
    })

    test("overlaps consecutive parts by at least 50 characters", () => {
      parts.slice(1).forEach((part, i) => {
        expect(overlap(content(parts[i]), content(part))).toBeGreaterThanOrEqual(50)
      })
    })

    test("starts with the start of the original text and ends with its end", () => {
      expect(huge.text.startsWith(content(parts[0]).slice(0, 50))).toBe(true)
      expect(content(parts[0]).startsWith(huge.text.slice(0, 50))).toBe(true)
      expect(content(parts[parts.length - 1]).endsWith(question)).toBe(true)
    })

    test("adds no text other than the part labels", () => {
      parts.forEach((part) => expect(huge.text).toContain(content(part)))
    })

    test("covers the whole original text", () => {
      const rebuilt = parts
        .map(content)
        .reduce((acc, next) => acc + next.slice(overlap(acc, next)), "")
      expect(rebuilt).toBe(huge.text)
    })
  })

  test("splits a long assistant turn the same way", () => {
    const huge: Turn = { role: "assistant", text: prose("q", 3000), index: 0 }
    const pieces = split([huge], 200)
    const parts = pieces.flatMap((p) => p.turns)
    expect(parts.length).toBeGreaterThanOrEqual(2)
    parts.forEach((part, i) => {
      expect(part.role).toBe("assistant")
      expect(part.index).toBe(0)
      expect(part.text.startsWith(`(part ${i + 1} of ${parts.length}) `)).toBe(true)
    })
    pieces.forEach((piece) => expect(Token.estimate(render(piece))).toBeLessThanOrEqual(200))
  })

  test("keeps surrounding turns in order around a split turn", () => {
    const before = turns(3, 200)
    const huge: Turn = { role: "user", text: prose("h", 5000), index: 3 }
    const after: Turn[] = [
      { role: "assistant", text: prose("x", 200).trim(), index: 4 },
      { role: "user", text: prose("y", 200).trim(), index: 5 },
    ]
    const budget = 250
    const pieces: Piece[] = split([...before, huge, ...after], budget)
    pieces.forEach((piece) => expect(Token.estimate(render(piece))).toBeLessThanOrEqual(budget))
    const reviewed = pieces.flatMap((p) => p.turns)
    const parts = reviewed.filter((t) => t.index === 3)
    expect(parts.length).toBeGreaterThanOrEqual(2)
    expect(reviewed).toEqual([...before, ...parts, ...after])
    parts.forEach((part) => expect(huge.text).toContain(content(part)))
  })
})
