// In-process tests for the misconceptions stages (connect, analyze, merge, outline, rank) against the real provider and
// config services plus a non-streaming fake model (Bun.serve). The extraction fake reads `MC{name|depth|evidence}`
// markers out of student text and cites the `[n] STUDENT:` block that holds them; verify keeps every candidate; grouping
// makes one `Cat-<description>` per description. Tests override individual kinds through `fakeModel({ ... })`.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import fs from "fs/promises"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Config } from "@/config/config"
import { Env } from "../../../src/env"
import { Plugin } from "../../../src/plugin"
import { Provider } from "@/provider/provider"
import { CliError } from "../../../src/cli/effect-cmd"
import { TestInstance } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"
import { testProviderConfig } from "../../lib/test-provider"
import {
  analyze,
  connect,
  merge,
  outline,
  rank,
  type Category,
  type Finding,
  type Topic,
} from "../../../src/cli/cmd/misconceptions"

// Request kinds by the top-level schema property of the system message, checked in this order.
const KIND = { kept: "verify", categories: "grouping", misconceptions: "extraction", topics: "outline" } as const
type Kind = (typeof KIND)[keyof typeof KIND]
type Reply = (user: string) => unknown
type Replies = Partial<Record<Kind, Reply>>

const MC = /MC\{([\w-]+)\|(mild|moderate|severe)\|([\w-]+)\}/g
const LINE = /^\s*(\d+)\.\s+(.*?)(?:\s+\(quote: "(.*)"\))?\s*$/gm
const BLOCK = /\[(\d+)\] STUDENT:[^]*?(?=\[\d+\] [A-Z]+:|ASSISTANT:|$)/g
const USAGE = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }

const text = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((p) => p?.text ?? "").join("\n") : ""
const blocks = (t: string) => [...t.matchAll(BLOCK)].map((m) => ({ n: Number(m[1]), block: m[0] }))
const lines = (s: string) => [...s.matchAll(LINE)].map((m) => ({ id: Number(m[1]), desc: m[2], quote: m[3] ?? "" }))

const DEFAULT: Record<Kind, Reply> = {
  extraction: (user) => ({
    misconceptions: blocks(user).flatMap((b) =>
      [...b.block.matchAll(MC)].map((m) => ({ description: m[1], evidence: m[3], depth: m[2], turn: b.n })),
    ),
  }),
  verify: (user) => {
    const at = user.indexOf("Candidates:")
    const transcript = blocks(user.slice(0, at))
    const cited = (quote: string) => transcript.filter((b) => b.block.includes(quote)).map((b) => b.n)
    return { kept: lines(user.slice(at)).map((c) => ({ id: c.id, cited: cited(c.quote), acted: false })) }
  },
  grouping: (user) => {
    const at = user.indexOf("Misconceptions:")
    const groups = [...Map.groupBy(lines(user.slice(at)), (f) => f.desc)]
    return {
      categories: groups.map(([d, fs]) => ({ name: `Cat-${d}`, topic: "none", findingIds: fs.map((f) => f.id) })),
    }
  },
  outline: () => ({ topics: [] }),
}

function fakeModel(replies: Replies = {}) {
  return Effect.gen(function* () {
    const requests: { kind: Kind; user: string }[] = []
    const fetch = async (req: Request) => {
      const body = (await req.json()) as { model: string; messages: { role: string; content: unknown }[] }
      const system = text(body.messages.find((m) => m.role === "system")?.content)
      const user = text(body.messages.find((m) => m.role === "user")?.content)
      const kind = Object.entries(KIND).find(([prop]) => system.includes(`"${prop}"`))?.[1]
      if (!kind) throw new Error(`unrecognized request kind: ${system.slice(0, 300)}`)
      requests.push({ kind, user })
      const reply = (replies[kind] ?? DEFAULT[kind])(user)
      if (reply instanceof Response) return reply
      const message = { role: "assistant", content: JSON.stringify(reply) }
      const choices = [{ index: 0, message, finish_reason: "stop" }]
      return Response.json({ id: "x", object: "chat.completion", created: 0, model: body.model, choices, usage: USAGE })
    }
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => Bun.serve({ port: 0, hostname: "127.0.0.1", fetch })),
      (server) => Effect.promise(() => server.stop(true)),
    )
    return {
      url: `http://127.0.0.1:${server.port}/v1`,
      kinds: () => requests.map((r) => r.kind),
      take: () => requests.splice(0, requests.length),
      of: (kind: Kind) => requests.filter((r) => r.kind === kind),
    }
  })
}

// Starts the fake, points the instance's opencode.json at it, loads the config and connects to test/test-model.
const setup = (replies: Replies = {}) =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const model = yield* fakeModel(replies)
    yield* write(path.join(test.directory, "opencode.json"), JSON.stringify(testProviderConfig(model.url)))
    const config = yield* Config.Service
    yield* config.get()
    const llm = yield* connect("test/test-model")
    return { dir: test.directory, cache: path.join(test.directory, ".misconceptions"), model, llm }
  })

const write = (file: string, content: string) => Effect.promise(() => Bun.write(file, content))
const readJson = (file: string) => Effect.promise(() => Bun.file(file).json())
const msg = (role: string, parts: object[]) => ({ info: { id: "m", role }, parts })
const user = (...texts: string[]) =>
  msg(
    "user",
    texts.map((t) => ({ type: "text", text: t })),
  )
const assistant = (t: string) => msg("assistant", [{ type: "text", text: t }])
const exportOf = (...messages: object[]) => JSON.stringify({ info: { id: "ses_1", title: "t" }, messages })
const finding = (description: string, depth: Finding["depth"] = "mild"): Finding => ({
  description,
  evidence: `q-${description}`,
  depth,
})

// Student messages at export positions 0, 2 and 4, one candidate each, with assistant replies between them.
const transcript = exportOf(
  user("git pull deletes my work MC{pull|mild|a-pull}"),
  assistant("It does not delete work."),
  user("but pull deleted it again MC{again|mild|a-again}"),
  assistant("ok"),
  user("merge loses changes MC{merge|moderate|a-merge}"),
)
const candidates: Finding[] = [
  { description: "pull", evidence: "a-pull", depth: "mild", messageIndex: 0 },
  { description: "again", evidence: "a-again", depth: "mild", messageIndex: 2 },
  { description: "merge", evidence: "a-merge", depth: "moderate", messageIndex: 4 },
]

const it = testEffect(LayerNode.compile(LayerNode.group([Provider.node, Config.node, Env.node, Plugin.node])))
const TIMEOUT = 60_000

describe("misconceptions stages (in-process)", () => {
  it.instance(
    "connect resolves test/test-model and fails on an unknown model",
    Effect.gen(function* () {
      const ctx = yield* setup()
      expect(ctx.llm.key).toBe("test/test-model")
      expect(ctx.llm.budget).toBeGreaterThan(0)
      const error = yield* connect("test/nope").pipe(Effect.flip)
      expect(error).toBeInstanceOf(CliError)
      expect(error.message).toContain("Model not found: test/nope")
      expect(ctx.model.kinds()).toEqual([])
    }),
    TIMEOUT,
  )

  it.instance(
    "analyze extracts then verifies, applying kept, cited, acted and repetition severity",
    Effect.gen(function* () {
      // Keep "pull" citing [1] and [3] (positions 0 and 2, assistant in between), drop "again", keep "merge" as is.
      const kept = [
        { id: 0, cited: [1, 3], acted: true },
        { id: 2, cited: [], acted: false },
      ]
      const ctx = yield* setup({ verify: () => ({ kept }) })
      const file = path.join(ctx.dir, "a.json")
      yield* write(file, transcript)
      const findings = yield* analyze(ctx.llm, file, ctx.cache, true)
      expect(ctx.model.kinds()).toEqual(["extraction", "verify"])
      const extraction = ctx.model.of("extraction")[0].user
      expect(extraction).toContain("[1] STUDENT: git pull deletes my work")
      expect(extraction).toContain("[3] STUDENT: but pull deleted it again")
      expect(extraction).toContain("[5] STUDENT: merge loses changes")
      expect(extraction).toContain("ASSISTANT: It does not delete work.")
      const verify = ctx.model.of("verify")[0].user
      expect(verify).toContain("[1] STUDENT: git pull deletes my work")
      expect(verify).toContain("Candidates:")
      expect(verify).toContain('0. pull (quote: "a-pull")')
      expect(verify).toContain('1. again (quote: "a-again")')
      expect(verify).toContain('2. merge (quote: "a-merge")')
      expect(findings).toEqual([
        { description: "pull", evidence: "a-pull", depth: "severe", messageIndex: 0, cited: [0, 2], acted: true },
        { description: "merge", evidence: "a-merge", depth: "moderate", messageIndex: 4, cited: [4], acted: false },
      ])
    }),
    TIMEOUT,
  )

  it.instance(
    "analyze with verify false makes no verify request and returns candidates as they are",
    Effect.gen(function* () {
      const ctx = yield* setup()
      const file = path.join(ctx.dir, "a.json")
      yield* write(file, transcript)
      const findings = yield* analyze(ctx.llm, file, ctx.cache, false)
      expect(ctx.model.kinds()).toEqual(["extraction"])
      expect(findings).toEqual(candidates)
    }),
    TIMEOUT,
  )

  it.instance(
    "analyze caches per file, model and verify setting",
    Effect.gen(function* () {
      const ctx = yield* setup()
      const file = path.join(ctx.dir, "a.json")
      yield* write(file, transcript)
      const first = yield* analyze(ctx.llm, file, ctx.cache, true)
      expect(ctx.model.take().map((r) => r.kind)).toEqual(["extraction", "verify"])
      expect((yield* Effect.promise(() => fs.readdir(path.join(ctx.cache, "findings")))).length).toBeGreaterThan(0)

      // Same file, model and verify setting: served from the cache.
      expect(yield* analyze(ctx.llm, file, ctx.cache, true)).toEqual(first)
      expect(ctx.model.take()).toEqual([])

      // The other verify setting is a different cache entry.
      expect(yield* analyze(ctx.llm, file, ctx.cache, false)).toEqual(candidates)
      expect(ctx.model.take().map((r) => r.kind)).toEqual(["extraction"])
      expect(yield* analyze(ctx.llm, file, ctx.cache, false)).toEqual(candidates)
      expect(ctx.model.take()).toEqual([])

      // Changing the file's content analyzes it again.
      yield* write(file, exportOf(user("rebase rewrites nothing MC{rebase|severe|a-rebase}")))
      const edited = yield* analyze(ctx.llm, file, ctx.cache, false)
      expect(ctx.model.take().map((r) => r.kind)).toEqual(["extraction"])
      expect(edited).toEqual([{ description: "rebase", evidence: "a-rebase", depth: "severe", messageIndex: 0 }])
    }),
    TIMEOUT,
  )

  it.instance(
    "analyze rejects invalid exports and skips the model for transcripts without student text",
    Effect.gen(function* () {
      const ctx = yield* setup()
      const invalid = {
        "not-json.json": "{ this is not json",
        "no-messages.json": JSON.stringify({ info: { id: "x" } }),
        "bad-role.json": exportOf(msg("system", [{ type: "text", text: "hi" }])),
        "bad-part.json": exportOf(msg("user", [{ text: "no type" }])),
      }
      for (const [name, content] of Object.entries(invalid)) {
        const file = path.join(ctx.dir, name)
        yield* write(file, content)
        const error = yield* analyze(ctx.llm, file, ctx.cache, true).pipe(Effect.flip)
        expect(error, name).toBeInstanceOf(Error)
        expect(error.message, name).toContain("not a valid")
      }
      const silent = {
        "assistant-only.json": exportOf(assistant("welcome"), assistant("anything else?")),
        "hidden-only.json": exportOf(
          msg("user", [
            { type: "text", text: "MC{ghost|severe|ghost}", synthetic: true },
            { type: "tool", tool: "bash", state: { status: "completed", output: "MC{ghost|severe|ghost}" } },
          ]),
        ),
        "empty.json": exportOf(),
      }
      for (const [name, content] of Object.entries(silent)) {
        const file = path.join(ctx.dir, name)
        yield* write(file, content)
        expect(yield* analyze(ctx.llm, file, ctx.cache, true), name).toEqual([])
      }
      expect(ctx.model.kinds()).toEqual([])
    }),
    TIMEOUT,
  )

  it.instance(
    "merge sends the grouping prompt with or without course topics and returns the categories as-is",
    Effect.gen(function* () {
      const categories: Category[] = [{ name: "Git pull", topic: "Git Pull", findingIds: [0, 1, 99] }]
      const ctx = yield* setup({ grouping: () => ({ categories }) })
      const findings = [finding("pull"), finding("pull again", "severe"), finding("merge")]
      expect(yield* merge(ctx.llm, findings, undefined)).toEqual(categories)
      const plain = ctx.model.take()
      expect(plain.map((r) => r.kind)).toEqual(["grouping"])
      expect(plain[0].user).toContain("No course topic list given.")
      expect(plain[0].user).not.toContain("Course topics:")
      expect(plain[0].user).toContain("Misconceptions:")
      expect(plain[0].user).toMatch(/0\. pull\n1\. pull again\n2\. merge/)

      const topics: Topic[] = [
        { name: "Git Pull", importance: "core", reason: "week 1" },
        { name: "Merging", importance: "peripheral", reason: "optional" },
      ]
      expect(yield* merge(ctx.llm, findings, topics)).toEqual(categories)
      const withTopics = ctx.model.take()
      expect(withTopics.map((r) => r.kind)).toEqual(["grouping"])
      expect(withTopics[0].user).not.toContain("No course topic list given.")
      expect(withTopics[0].user).toMatch(/Course topics:\n- Git Pull\n- Merging/)
      expect(withTopics[0].user.indexOf("Course topics:")).toBeLessThan(withTopics[0].user.indexOf("Misconceptions:"))
    }),
    TIMEOUT,
  )

  it.instance(
    "merge fails without a request when over budget and reports model failures",
    Effect.gen(function* () {
      const ctx = yield* setup({ grouping: () => new Response("boom", { status: 400 }) })
      const huge = [finding("x".repeat(ctx.llm.budget * 4 + 400))]
      const over = yield* merge(ctx.llm, huge, undefined).pipe(Effect.flip)
      expect(over).toBeInstanceOf(CliError)
      expect(over.message).toContain("Too many findings to group")
      expect(ctx.model.kinds()).toEqual([])

      const failed = yield* merge(ctx.llm, [finding("pull")], undefined).pipe(Effect.flip)
      expect(failed).toBeInstanceOf(CliError)
      expect(failed.message).toContain("Could not group misconceptions")
      // The provider SDK may retry a failed HTTP request, so only the kind is asserted.
      expect(ctx.model.of("grouping").length).toBeGreaterThanOrEqual(1)
    }),
    TIMEOUT,
  )

  it.instance(
    "outline reads a file or a directory, saves topics.json and reuses it without a request",
    Effect.gen(function* () {
      const topics: Topic[] = [{ name: "Git Pull", importance: "core", reason: "week 1" }]
      const ctx = yield* setup({ outline: () => ({ topics }) })
      const course = path.join(ctx.dir, "course.md")
      yield* write(course, "# Week 1\nGit pull fetches and merges.\n")
      expect(yield* outline(ctx.llm, course, ctx.cache)).toEqual(topics)
      const single = ctx.model.take()
      expect(single.map((r) => r.kind)).toEqual(["outline"])
      expect(single[0].user).toContain("# course.md")
      expect(single[0].user).toContain("Git pull fetches and merges.")
      expect(yield* readJson(path.join(ctx.cache, "topics.json"))).toEqual({ topics })

      // Saved topics are reused as they are on disk, hand edits included.
      expect(yield* outline(ctx.llm, course, ctx.cache)).toEqual(topics)
      const edited: Topic[] = [{ name: "Merging", importance: "peripheral", reason: "edited by hand" }]
      yield* write(path.join(ctx.cache, "topics.json"), JSON.stringify({ topics: edited }))
      expect(yield* outline(ctx.llm, course, ctx.cache)).toEqual(edited)
      expect(ctx.model.take()).toEqual([])

      // A directory: .md and .txt files in sorted order, each under its own heading; other files are ignored.
      const dir = path.join(ctx.dir, "material")
      yield* write(path.join(dir, "b.txt"), "Branches diverge.")
      yield* write(path.join(dir, "a.md"), "Pull is fetch plus merge.")
      yield* write(path.join(dir, "ignored.json"), "NOT-COURSE")
      const cache = path.join(ctx.dir, "other-cache")
      expect(yield* outline(ctx.llm, dir, cache)).toEqual(topics)
      const multi = ctx.model.take()
      expect(multi.map((r) => r.kind)).toEqual(["outline"])
      expect(multi[0].user).toMatch(/# a\.md\n[^]*Pull is fetch plus merge\.[^]*# b\.txt\n[^]*Branches diverge\./)
      expect(multi[0].user).not.toContain("NOT-COURSE")
      expect(yield* readJson(path.join(cache, "topics.json"))).toEqual({ topics })

      // Material in a nested subdirectory is included too, under its base name.
      yield* write(path.join(dir, "week2", "notes.md"), "Rebase replays commits.")
      expect(yield* outline(ctx.llm, dir, path.join(ctx.dir, "nested-cache"))).toEqual(topics)
      const nested = ctx.model.take()
      expect(nested.map((r) => r.kind)).toEqual(["outline"])
      expect(nested[0].user).toMatch(/# notes\.md\n[^]*Rebase replays commits\./)
      expect(nested[0].user).toContain("Pull is fetch plus merge.")
    }),
    TIMEOUT,
  )

  it.instance(
    "outline fails on a missing path, a directory without material and material over budget",
    Effect.gen(function* () {
      const ctx = yield* setup()
      yield* write(path.join(ctx.dir, "empty", "notes.json"), "{}")
      yield* write(path.join(ctx.dir, "huge.txt"), "y".repeat(ctx.llm.budget * 4 + 400))
      const cases = [
        { course: path.join(ctx.dir, "missing.md"), message: "Course material not found" },
        { course: path.join(ctx.dir, "empty"), message: "No .md or .txt course material found" },
        { course: path.join(ctx.dir, "huge.txt"), message: "Course material is too large" },
      ]
      for (const [i, c] of cases.entries()) {
        const error = yield* outline(ctx.llm, c.course, path.join(ctx.dir, `cache-${i}`)).pipe(Effect.flip)
        expect(error, c.message).toBeInstanceOf(CliError)
        expect(error.message, c.message).toContain(c.message)
      }
      expect(ctx.model.kinds()).toEqual([])
    }),
    TIMEOUT,
  )

  it.instance(
    "analyze, merge and rank across two transcripts count a shared misconception once per transcript",
    Effect.gen(function* () {
      const ctx = yield* setup()
      const a = path.join(ctx.dir, "a.json")
      const b = path.join(ctx.dir, "b.json")
      yield* write(a, exportOf(user("git pull deleted my work MC{pull|severe|a-pull}")))
      yield* write(
        b,
        exportOf(assistant("welcome"), user("pull MC{pull|moderate|b-pull}"), user("MC{loop|mild|b-loop}")),
      )
      const findings = [
        ...(yield* analyze(ctx.llm, a, ctx.cache, true)).map((f) => ({ ...f, transcript: "a.json" })),
        ...(yield* analyze(ctx.llm, b, ctx.cache, true)).map((f) => ({ ...f, transcript: "b.json" })),
      ]
      expect(findings.map((f) => `${f.transcript}:${f.description}@${f.messageIndex}`)).toEqual([
        "a.json:pull@0",
        "b.json:pull@1",
        "b.json:loop@2",
      ])
      expect(ctx.model.take().map((r) => r.kind)).toEqual(["extraction", "verify", "extraction", "verify"])

      const categories = yield* merge(ctx.llm, findings, undefined)
      expect(ctx.model.kinds()).toEqual(["grouping"])
      expect(categories).toEqual([
        { name: "Cat-pull", topic: "none", findingIds: [0, 1] },
        { name: "Cat-loop", topic: "none", findingIds: [2] },
      ])

      const rows = rank({ findings, categories })
      expect(rows.map((r) => r.category)).toEqual(["Cat-pull", "Cat-loop"])
      expect(rows[0]).toMatchObject({ transcripts: 2, urgency: 5, depth: { severe: 1, moderate: 1, mild: 0 } })
      expect(rows[0].examples.map((e) => `${e.evidence}@${e.transcript}:${e.messageIndex}`)).toEqual([
        "a-pull@a.json:0",
        "b-pull@b.json:1",
      ])
      expect(rows[1]).toMatchObject({ transcripts: 1, urgency: 1, depth: { severe: 0, moderate: 0, mild: 1 } })
      expect(rows[0].importance).toBeUndefined()
    }),
    TIMEOUT,
  )
})
