// In-process tests of the whole `opencode misconceptions` command through `run(args)` with a non-streaming fake model.
// Same conventions as integration.test.ts: `MC{name|depth|evidence}` markers in student text drive extraction, verify
// keeps every candidate, grouping makes one `Cat-<description>` category whose topic is the description.
import { expect } from "bun:test"
import { Effect } from "effect"
import os from "os"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Config } from "@/config/config"
import { Env } from "../../../src/env"
import { Plugin } from "../../../src/plugin"
import { Provider } from "@/provider/provider"
import { CliError } from "../../../src/cli/effect-cmd"
import { TestInstance } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"
import { testProviderConfig } from "../../lib/test-provider"
import { run, type Args, type Finding, type Row } from "../../../src/cli/cmd/misconceptions"

const KIND = { kept: "verify", categories: "grouping", misconceptions: "extraction", topics: "outline" } as const
type Kind = (typeof KIND)[keyof typeof KIND]
type Replies = Partial<Record<Kind, (user: string) => unknown>>
type Found = { file: string; misconceptions: Finding[] }
type Json = { transcripts: number; rows: Row[]; skipped: unknown[]; findings: Found[] }
const MC = /MC\{([\w-]+)\|(mild|moderate|severe)\|([\w-]+)\}/g
const LINE = /^\s*(\d+)\.\s+(.*?)(?:\s+\(quote: "(.*)"\))?\s*$/gm
const BLOCK = /\[(\d+)\] STUDENT:[^]*?(?=\[\d+\] [A-Z]+:|ASSISTANT:|$)/g
const text = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((p) => p?.text ?? "").join("\n") : ""
const USAGE = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
const lines = (s: string) => [...s.matchAll(LINE)].map((m) => ({ id: Number(m[1]), desc: m[2] }))
const DEFAULT: Record<Kind, (user: string) => unknown> = {
  extraction: (user) => ({
    misconceptions: [...user.matchAll(BLOCK)].flatMap((b) =>
      [...b[0].matchAll(MC)].map((m) => ({ description: m[1], evidence: m[3], depth: m[2], turn: Number(b[1]) })),
    ),
  }),
  verify: (user) => ({
    kept: lines(user.slice(user.indexOf("Candidates:"))).map((c) => ({ id: c.id, cited: [], acted: false })),
  }),
  grouping: (user) => {
    const groups = Map.groupBy(lines(user.slice(user.indexOf("Misconceptions:"))), (f) => f.desc)
    return {
      categories: [...groups].map(([d, fs]) => ({ name: `Cat-${d}`, topic: d, findingIds: fs.map((f) => f.id) })),
    }
  },
  outline: () => ({ topics: [] }),
}

// Starts the fake, points the instance's opencode.json at it and loads the config. Exports go in a subdirectory so
// opencode.json itself is never read as a transcript.
const setup = (replies: Replies = {}) =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const requests: Kind[] = []
    const fetch = async (req: Request) => {
      const body = (await req.json()) as { model: string; messages: { role: string; content: unknown }[] }
      const system = text(body.messages.find((m) => m.role === "system")?.content)
      const kind = Object.entries(KIND).find(([prop]) => system.includes(`"${prop}"`))?.[1]
      if (!kind) throw new Error(`unrecognized request kind: ${system.slice(0, 300)}`)
      requests.push(kind)
      const reply = (replies[kind] ?? DEFAULT[kind])(text(body.messages.find((m) => m.role === "user")?.content))
      const message = { role: "assistant", content: JSON.stringify(reply) }
      const choices = [{ index: 0, message, finish_reason: "stop" }]
      return Response.json({ id: "x", object: "chat.completion", created: 0, model: body.model, choices, usage: USAGE })
    }
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => Bun.serve({ port: 0, hostname: "127.0.0.1", fetch })),
      (server) => Effect.promise(() => server.stop(true)),
    )
    const url = `http://127.0.0.1:${server.port}/v1`
    yield* write(path.join(test.directory, "opencode.json"), JSON.stringify(testProviderConfig(url)))
    const config = yield* Config.Service
    yield* config.get()
    const dir = path.join(test.directory, "exports")
    const args = (extra: Partial<Args> = {}): Args => ({ dir, model: "test/test-model", verify: true, ...extra })
    // Transcripts may be analyzed concurrently, so request kinds are compared in sorted order.
    return { home: test.directory, dir, args, taken: () => requests.splice(0, requests.length).sort() }
  })

const write = (file: string, content: string) => Effect.promise(() => Bun.write(file, content))
const read = (file: string) => Effect.promise(() => Bun.file(file).text())
const msg = (role: string, parts: object[]) => ({ info: { id: "m", role }, parts })
const user = (t: string) => msg("user", [{ type: "text", text: t }])
const assistant = (t: string) => msg("assistant", [{ type: "text", text: t }])
const exportOf = (...messages: object[]) => JSON.stringify({ info: { id: "ses_1", title: "t" }, messages })
const parse = (out: string): Json => JSON.parse(out)
const pull = exportOf(user("git pull deleted my work MC{pull|severe|a-pull}"))
const loop = exportOf(assistant("welcome"), user("pull MC{pull|moderate|b-pull}"), user("MC{loop|mild|b-loop}"))
const first = (n: number) => `Misconceptions across ${n} transcript(s), most urgent first:`
const brief = (rows: Row[]) => rows.map((r) => `${r.category}:${r.transcripts}/${r.urgency}`)
const found = (f: Found) => `${f.file}=${f.misconceptions.map((m) => `${m.description}@${m.messageIndex}`).join(",")}`

const it = testEffect(LayerNode.compile(LayerNode.group([Provider.node, Config.node, Env.node, Plugin.node])))
const scenario = (name: string, body: Parameters<typeof it.instance>[1]) => it.instance(name, body, 60_000)

scenario("run returns the table ending in EOL, saves it in dir and honours verify: false", () =>
  Effect.gen(function* () {
    const ctx = yield* setup()
    yield* write(path.join(ctx.dir, "a.json"), pull)
    yield* write(path.join(ctx.dir, "b.json"), loop)
    const out = yield* run(ctx.args({ verify: false }))
    expect(ctx.taken()).toEqual(["extraction", "extraction", "grouping"])
    expect(out.endsWith(os.EOL)).toBe(true)
    expect(out.split(os.EOL).slice(0, 3)).toEqual([first(2), "", "1. Cat-pull  (urgency 5)"])
    expect(out).toContain("> a-pull  (a.json, message 0)")
    expect(out).toContain("2. Cat-loop  (urgency 1)")
    expect(yield* read(path.join(ctx.dir, "misconceptions-ranking.txt"))).toBe(out)
  }),
)

scenario("run with json returns transcripts, rows, skipped and findings in file-name order", () =>
  Effect.gen(function* () {
    const ctx = yield* setup()
    yield* write(path.join(ctx.dir, "b.json"), loop)
    yield* write(path.join(ctx.dir, "a.json"), pull)
    const out = yield* run(ctx.args({ json: true }))
    expect(ctx.taken()).toEqual(["extraction", "extraction", "grouping", "verify", "verify"])
    expect(out.endsWith(os.EOL)).toBe(true)
    const json = parse(out)
    expect(Object.keys(json).sort()).toEqual(["findings", "rows", "skipped", "transcripts"])
    expect(json.transcripts).toBe(2)
    expect(json.skipped).toEqual([])
    expect(brief(json.rows)).toEqual(["Cat-pull:2/5", "Cat-loop:1/1"])
    expect(json.findings.map(found)).toEqual(["a.json=pull@0", "b.json=pull@1,loop@2"])
    expect(json.findings[1].misconceptions[0]).toMatchObject({ evidence: "b-pull", cited: [1], acted: false })
  }),
)

scenario("course writes topics.json, rows carry topic and importance, a hand edit changes urgency on rerun", () =>
  Effect.gen(function* () {
    const topics = [{ name: "pull", importance: "core", reason: "week 1" }]
    const ctx = yield* setup({ outline: () => ({ topics }) })
    const course = path.join(ctx.home, "course.md")
    const saved = path.join(ctx.dir, ".misconceptions", "topics.json")
    yield* write(path.join(ctx.dir, "a.json"), pull)
    yield* write(course, "# Week 1\nGit pull fetches and merges.\n")
    const before = parse(yield* run(ctx.args({ course, json: true })))
    expect(ctx.taken()).toEqual(["extraction", "grouping", "outline", "verify"])
    expect(JSON.parse(yield* read(saved))).toEqual({ topics })
    expect(before.rows[0]).toMatchObject({ category: "Cat-pull", topic: "pull", importance: "core", urgency: 9 })
    yield* write(saved, JSON.stringify({ topics: [{ ...topics[0], importance: "peripheral" }] }))
    const after = parse(yield* run(ctx.args({ course, json: true })))
    expect(ctx.taken()).toEqual(["grouping"])
    expect(after.rows[0]).toMatchObject({ category: "Cat-pull", topic: "pull", importance: "peripheral", urgency: 3 })
  }),
)

scenario("run fails with a CliError for no exports, no analyzable transcript or missing course material", () =>
  Effect.gen(function* () {
    const ctx = yield* setup()
    yield* write(path.join(ctx.dir, "none", "readme.txt"), "no exports here")
    yield* write(path.join(ctx.dir, "broken", "a.json"), "{ not json")
    yield* write(path.join(ctx.dir, "broken", "b.json"), exportOf(msg("system", [{ type: "text", text: "x" }])))
    yield* write(path.join(ctx.dir, "ok", "a.json"), pull)
    const sub = (name: string) => path.join(ctx.dir, name)
    const cases: { args: Partial<Args>; message: string }[] = [
      { args: { dir: sub("none") }, message: "No .json session exports found" },
      { args: { dir: sub("broken") }, message: "Could not analyze any transcript" },
      { args: { dir: sub("ok"), course: sub("nope.md") }, message: "Course material not found" },
    ]
    for (const c of cases) {
      const error = yield* run(ctx.args(c.args)).pipe(Effect.flip)
      expect(error, c.message).toBeInstanceOf(CliError)
      expect(error.message, c.message).toContain(c.message)
    }
    expect(ctx.taken()).not.toContain("grouping")
  }),
)

scenario("run skips an invalid export, reports it under skipped and still analyzes the rest", () =>
  Effect.gen(function* () {
    const ctx = yield* setup()
    yield* write(path.join(ctx.dir, "a.json"), pull)
    yield* write(path.join(ctx.dir, "bad.json"), "{ not json")
    const json = parse(yield* run(ctx.args({ json: true })))
    expect(ctx.taken()).toEqual(["extraction", "grouping", "verify"])
    expect(json.transcripts).toBe(1)
    expect(json.skipped).toHaveLength(1)
    expect(json.skipped[0]).toMatchObject({ file: "bad.json", error: expect.any(String) })
    expect(json.findings.map(found)).toEqual(["a.json=pull@0"])
    expect(brief(json.rows)).toEqual(["Cat-pull:1/3"])
    expect((yield* run(ctx.args())).split(os.EOL)[0]).toBe(first(1))
  }),
)

scenario("a rerun with the same arguments is served from the cache and only makes the grouping request", () =>
  Effect.gen(function* () {
    const ctx = yield* setup()
    yield* write(path.join(ctx.dir, "a.json"), pull)
    yield* write(path.join(ctx.dir, "b.json"), loop)
    const out = yield* run(ctx.args())
    expect(ctx.taken()).toEqual(["extraction", "extraction", "grouping", "verify", "verify"])
    // The saved ranking and the cache directory left by the first run are not treated as transcripts.
    expect(yield* run(ctx.args())).toBe(out)
    expect(ctx.taken()).toEqual(["grouping"])
    expect(out.split(os.EOL)[0]).toBe(first(2))
  }),
)
