import { describe, expect, test } from "bun:test"
import { Token } from "@opencode-ai/core/util/token"
import { render, shrink, split, type Piece, type Turn } from "../../../src/cli/cmd/misconceptions"

const exportJson = (messages: unknown[]) => JSON.stringify({ info: { id: "ses_1", title: "t" }, messages })
const message = (role: string, parts: unknown[]) => ({ info: { id: "msg", role }, parts })
const text = (value: string, extra: Record<string, unknown> = {}) => ({ type: "text", text: value, ...extra })
const tool = { type: "tool", tool: "bash", state: { status: "completed", output: "out" } }

// Distinct, position-identifying text so substring/overlap checks are meaningful.
const prose = (prefix: string, chars: number) =>
  Array.from({ length: Math.ceil(chars / 12) }, (_, i) => `${prefix}${String(i).padStart(5, "0")} `)
    .join("")
    .slice(0, chars)
const turns = (count: number, chars: number): Turn[] =>
  Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    text: prose(`t${i}w`, chars).trim(),
    index: i,
  }))
const content = (turn: Turn) => turn.text.replace(/^\(part \d+ of \d+\) /, "")
const fits = (budget: number) => (piece: Piece) => expect(Token.estimate(render(piece))).toBeLessThanOrEqual(budget)
const overlap = (a: string, b: string) =>
  Array.from({ length: Math.min(a.length, b.length) }, (_, i) => i + 1)
    .filter((n) => a.slice(-n) === b.slice(0, n))
    .reduce((max, n) => Math.max(max, n), 0)

describe("shrink", () => {
  test.each([
    ["non-JSON", "not json {"],
    ["no messages key", JSON.stringify({ info: { id: "ses_1" } })],
    ["messages not an array", JSON.stringify({ messages: "nope" })],
    ["top-level array", JSON.stringify([1, 2, 3])],
    ["role other than user/assistant", exportJson([message("user", [text("hi")]), message("system", [text("x")])])],
    ["part without type", exportJson([message("user", [{ text: "hi" }])])],
    ["part with non-string type", exportJson([message("user", [{ type: 3, text: "hi" }])])],
  ])("returns undefined for invalid input: %s", (_, json) => {
    expect(shrink(json)).toBeUndefined()
  })

  test("joins visible text parts, ignores hidden and non-text parts, and keeps extra fields harmless", () => {
    expect(shrink(exportJson([]))).toEqual([])
    const parts = [
      text("  why does git pull change my files?", { id: "p" }),
      text("<file contents>", { synthetic: true }),
      text("hidden", { ignored: true }),
      tool,
      { type: "reasoning", text: "thinking" },
      { type: "step-start" },
      { type: "file", url: "file:///x" },
      text("second  "),
    ]
    const json = JSON.stringify({
      extra: true,
      messages: [{ info: { id: "m", role: "user", time: 1 }, more: {}, parts }],
    })
    expect(shrink(json)).toEqual([{ role: "user", text: "why does git pull change my files?\nsecond", index: 0 }])
  })

  test("omits messages with no visible text, keeps roles, export order and export positions as indexes", () => {
    const messages = [
      message("assistant", [tool]),
      message("user", [text("why?")]),
      message("assistant", [text("   \n  ")]),
      message("user", [text("x", { synthetic: true })]),
      message("assistant", [text("because")]),
      message("user", [text("ok")]),
    ]
    expect(shrink(exportJson(messages))).toEqual([
      { role: "user", text: "why?", index: 1 },
      { role: "assistant", text: "because", index: 4 },
      { role: "user", text: "ok", index: 5 },
    ])
  })

  test("never shortens student text but trims long assistant text to <= 300 tokens ending with [trimmed]", () => {
    const long = prose("u", 20_000)
    const short = "Use git status to see changes."
    const messages = [
      message("user", [text(long)]),
      message("assistant", [text(prose("a", 20_000))]),
      message("assistant", [text(short)]),
    ]
    const result = shrink(exportJson(messages)) ?? []
    expect(result[0]).toEqual({ role: "user", text: long.trim(), index: 0 })
    expect(result[1]).toMatchObject({ role: "assistant", index: 1 })
    expect(result[1].text.endsWith("[trimmed]")).toBe(true)
    expect(Token.estimate(result[1].text)).toBeLessThanOrEqual(300)
    expect(result[2]).toEqual({ role: "assistant", text: short, index: 2 })
  })
})

describe("render", () => {
  const context: Turn[] = [
    { role: "user", text: "first", index: 0 },
    { role: "assistant", text: "reply", index: 1 },
  ]
  const turns: Turn[] = [
    { role: "user", text: "second", index: 2 },
    { role: "assistant", text: "answer", index: 3 },
    { role: "user", text: "ok", index: 5 },
  ]

  test("numbers student turns by export position + 1, leaves assistant turns unnumbered, prefixes unnumbered context", () => {
    expect(render({ context: [], turns })).toBe("[3] STUDENT: second\n\nASSISTANT: answer\n\n[6] STUDENT: ok")
    expect(render({ context: [], turns: [turns[0]] })).toBe("[3] STUDENT: second")
    expect(render({ context, turns: turns.slice(0, 2) })).toBe(
      "Earlier messages, for context only:\n\nSTUDENT: first\n\nASSISTANT: reply\n\nMessages to review:\n\n[3] STUDENT: second\n\nASSISTANT: answer",
    )
  })
})

describe("split", () => {
  test("returns no pieces for an empty transcript and keeps a fitting transcript whole, even exactly", () => {
    expect(split([], 1000)).toEqual([])
    const input = turns(4, 100)
    expect(split(input, 1000)).toEqual([{ context: [], turns: input }])
    const exact = turns(3, 200)
    expect(split(exact, Token.estimate(render({ context: [], turns: exact })))).toEqual([{ context: [], turns: exact }])
  })

  test("every piece fits, each turn is reviewed once in order, and later pieces get the previous two turns as context", () => {
    const input = turns(30, 300)
    const pieces = split(input, 400)
    expect(pieces.length).toBeGreaterThan(2)
    pieces.forEach(fits(400))
    expect(pieces.flatMap((p) => p.turns)).toEqual(input)
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
    expect(pieces).toEqual(input.map((turn) => ({ context: [], turns: [turn] })))
    pieces.forEach(fits(110))
  })

  test.each([
    ["user", 3, 300],
    ["assistant", 0, 200],
  ] as const)("splits a too-long %s turn into overlapping labeled parts covering the text", (role, index, budget) => {
    const question = "So why does my rebase keep deleting the commits I made yesterday?"
    const huge: Turn = { role, text: `${prose("p", 6000)} ${question}`, index }
    const pieces = split([huge], budget)
    pieces.forEach(fits(budget))
    const parts = pieces.flatMap((p) => p.turns)
    expect(parts.length).toBeGreaterThanOrEqual(2)
    parts.forEach((part, i) => {
      expect(part).toMatchObject({ role, index })
      expect(part.text.startsWith(`(part ${i + 1} of ${parts.length}) `)).toBe(true)
      expect(huge.text).toContain(content(part))
    })
    parts.slice(1).forEach((part, i) => expect(overlap(content(parts[i]), content(part))).toBeGreaterThanOrEqual(50))
    expect(content(parts[0]).startsWith(huge.text.slice(0, 50))).toBe(true)
    expect(content(parts[parts.length - 1]).endsWith(question)).toBe(true)
    const rebuilt = parts.map(content).reduce((acc, next) => acc + next.slice(overlap(acc, next)), "")
    expect(rebuilt).toBe(huge.text)
  })

  test("keeps surrounding turns in order around a split turn", () => {
    const around = turns(6, 200)
    const huge: Turn = { role: "user", text: prose("h", 5000), index: 3 }
    const pieces = split([...around.slice(0, 3), huge, ...around.slice(4)], 250)
    pieces.forEach(fits(250))
    const reviewed = pieces.flatMap((p) => p.turns)
    const parts = reviewed.filter((t) => t.index === 3)
    expect(parts.length).toBeGreaterThanOrEqual(2)
    expect(reviewed).toEqual([...around.slice(0, 3), ...parts, ...around.slice(4)])
    parts.forEach((part) => expect(huge.text).toContain(content(part)))
  })
})
