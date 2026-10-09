// Subprocess tests for `opencode misconceptions <dir>` against a non-streaming fake model (Bun.serve). The fake reads
// markers out of student text: `MC{name|depth|evidence}` is a misconception cited at the `[n] STUDENT:` label above it
// (`|noturn` omits turn, `|badturn` cites 99); BADREPLY / BADSHAPE make the extraction reply unusable. Grouping makes
// one `Cat-<description>` per description. Verify keeps candidates not in `drop`, citing each block holding its quote.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { EOL } from "os"
import path from "path"
import fs from "fs/promises"
import { cliIt, type OpencodeCli } from "../../lib/cli-process"
import { testProviderConfig } from "../../lib/test-provider"
import { table, type Finding, type Row } from "../../../src/cli/cmd/misconceptions"

// Request kinds by the top-level schema property of the system message, checked in this order.
const KIND = { kept: "verify", categories: "grouping", misconceptions: "extraction", topics: "outline" } as const
type Kind = (typeof KIND)[keyof typeof KIND]
type Topic = { name: string; importance: string; reason: string }
type FakeOptions = { topics?: Topic[]; topicOf?: Record<string, string>; drop?: string[] }
type Skipped = { file: string; error: string }
type Found = { file: string; misconceptions: Finding[] }
type JsonOutput = { transcripts: number; rows: Row[]; skipped: Skipped[]; findings: Found[] }

const MC = /MC\{([\w-]+)\|(mild|moderate|severe)\|([\w-]+)(?:\|(noturn|badturn))?\}/g
const LINE = /^\s*(\d+)\.\s+(.*?)(?:\s+\(quote: "(.*)"\))?\s*$/gm
const BLOCK = /\[(\d+)\] STUDENT:[^]*?(?=\[\d+\] [A-Z]+:|$)/g
const USAGE = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }

const text = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((p) => p?.text ?? "").join("\n") : ""
const blocks = (t: string) => [...t.matchAll(BLOCK)].map((m) => ({ n: Number(m[1]), block: m[0] }))
const lines = (s: string) => [...s.matchAll(LINE)].map((m) => ({ id: Number(m[1]), desc: m[2], quote: m[3] ?? "" }))
const turnOf = (flag: string | undefined, n: number) => (flag === "noturn" ? {} : { turn: flag === "badturn" ? 99 : n })
const item = (m: string[], n: number) => ({ description: m[1], evidence: m[3], depth: m[2], ...turnOf(m[4], n) })

function reply(kind: Kind, user: string, options: FakeOptions) {
  if (kind === "outline") return JSON.stringify({ topics: options.topics ?? [] })
  if (kind === "verify") {
    const at = user.indexOf("Candidates:")
    const transcript = blocks(user.slice(0, at))
    const kept = lines(user.slice(at)).filter((c) => !options.drop?.includes(c.desc))
    const cited = (quote: string) => transcript.filter((b) => b.block.includes(quote)).map((b) => b.n)
    return JSON.stringify({ kept: kept.map((c) => ({ id: c.id, cited: cited(c.quote), acted: false })) })
  }
  if (kind === "grouping") {
    const topic = (d: string) => options.topicOf?.[d] ?? "none"
    const groups = [...Map.groupBy(lines(user), (f) => f.desc)]
    const categories = groups.map(([d, fs]) => ({ name: `Cat-${d}`, topic: topic(d), findingIds: fs.map((f) => f.id) }))
    return JSON.stringify({ categories })
  }
  if (user.includes("BADREPLY")) return "this is not json"
  if (user.includes("BADSHAPE")) return JSON.stringify({ problems: ["nope"] })
  const misconceptions = blocks(user).flatMap((b) => [...b.block.matchAll(MC)].map((m) => item(m, b.n)))
  return JSON.stringify({ misconceptions })
}

function fakeModel(cli: OpencodeCli, options: FakeOptions = {}) {
  return Effect.gen(function* () {
    const requests: { kind: Kind; model: string; user: string }[] = []
    const fetch = async (req: Request) => {
      const body = (await req.json()) as { model: string; messages: { role: string; content: unknown }[] }
      const system = text(body.messages.find((m) => m.role === "system")?.content)
      const user = text(body.messages.find((m) => m.role === "user")?.content)
      const kind = Object.entries(KIND).find(([prop]) => system.includes(`"${prop}"`))?.[1]
      if (!kind) throw new Error(`unrecognized request kind: ${system.slice(0, 300)}`)
      requests.push({ kind, model: body.model, user })
      const message = { role: "assistant", content: reply(kind, user, options) }
      const choices = [{ index: 0, message, finish_reason: "stop" }]
      return Response.json({ id: "x", object: "chat.completion", created: 0, model: body.model, choices, usage: USAGE })
    }
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => Bun.serve({ port: 0, hostname: "127.0.0.1", fetch })),
      (server) => Effect.promise(() => server.stop(true)),
    )
    const base = testProviderConfig(`http://127.0.0.1:${server.port}/v1`)
    const second = { ...base.provider.test.models["test-model"], id: "test-model-2", name: "Test Model 2" }
    const models = { ...base.provider.test.models, "test-model-2": second }
    const config = { ...base, provider: { test: { ...base.provider.test, models } } }
    const env = { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) }
    const spawn = (args: string[]) => cli.spawn(args, { env, timeoutMs: 60_000 })
    return {
      spawn,
      run: (args: string[]) => Effect.tap(spawn(args), (result) => Effect.sync(() => cli.expectExit(result, 0))),
      take: () => requests.splice(0, requests.length),
      of: (kind: Kind) => requests.filter((r) => r.kind === kind),
      has: (kind: Kind, needle: string) => requests.some((r) => r.kind === kind && r.user.includes(needle)),
    }
  })
}

const msg = (role: string, parts: object[]) => ({ info: { id: "m", role }, parts })
const part = (text: string) => ({ type: "text", text })
const user = (...texts: string[]) => msg("user", texts.map(part))
const assistant = (t: string) => msg("assistant", [part(t)])
const exportOf = (...messages: object[]) => JSON.stringify({ info: { id: "ses_1", title: "t" }, messages })
const cmd = (dir: string, m: string, ...extra: string[]) => ["misconceptions", dir, "--model", `test/${m}`, ...extra]

// a.json: student messages at export positions 0 and 2. Hidden (synthetic/ignored) text must not be analyzed.
const transcriptA = exportOf(
  msg("user", [
    part("git pull deleted my work MC{pull|severe|a-pull}"),
    { type: "text", text: "file contents MC{ghost|severe|a-ghost}", synthetic: true },
    { type: "text", text: "MC{ghost|severe|a-ghost2}", ignored: true },
    { type: "tool", tool: "bash", state: { status: "completed", output: "ok" } },
  ]),
  assistant("It does not delete work."),
  user("merge always loses changes MC{merge|mild|a-merge}", "and MC{scope|mild|a-scope|badturn}"),
)
// b.json: student messages at export positions 1 and 3.
const transcriptB = (e = "b-pull") =>
  exportOf(
    assistant("welcome"),
    user(`pull MC{pull|moderate|${e}}`),
    assistant("ok"),
    user("MC{loop|mild|b-loop|noturn}"),
  )

const files = (dir: string, entries: Record<string, string>) =>
  Effect.promise(async () => {
    await fs.mkdir(dir, { recursive: true })
    await Promise.all(Object.entries(entries).map(([name, content]) => Bun.write(path.join(dir, name), content)))
  })
const readText = (file: string) => Effect.promise(() => Bun.file(file).text())
const parse = (stdout: string) => JSON.parse(stdout) as JsonOutput
const examples = (rows: Row[]) => rows.map((r) => r.examples.map((e) => `${e.evidence}@${e.messageIndex}`))

describe("opencode misconceptions (subprocess)", () => {
  cliIt.live(
    "analyzes exports, prints JSON and table, saves the ranking, caches per transcript and applies --course topics",
    ({ opencode, home }) =>
      Effect.gen(function* () {
        const topics = [
          { name: "Git Pull", importance: "core", reason: "week 1" },
          { name: "Merging", importance: "peripheral", reason: "optional" },
        ]
        const model = yield* fakeModel(opencode, {
          topics,
          topicOf: { pull: "git pull", merge: "Merging", loop: "Merging" },
        })
        const dir = path.join(home, "class")
        yield* files(dir, { "a.json": transcriptA, "b.json": transcriptB(), "notes.txt": "not a transcript" })
        yield* files(path.join(dir, "nested"), { "c.json": exportOf(user("MC{nested|severe|c-nested}")) })
        const ranking = path.join(dir, "misconceptions-ranking.txt")
        const args = cmd(dir, "test-model", "--no-verify")

        // Run 1: --json on a fresh directory; --no-verify reports candidates exactly as extracted.
        const first = yield* model.run([...args, "--json"])
        expect(model.of("extraction").length).toBeGreaterThanOrEqual(2)
        expect(model.of("verify")).toEqual([])
        expect(model.of("grouping").length).toBe(1)
        expect(model.take().some((r) => r.user.includes("c-nested") || r.user.includes("a-ghost"))).toBe(false)
        expect(first.stderr).toMatch(/\[[12]\/2\] a\.json/)
        expect(first.stderr).toMatch(/\[[12]\/2\] b\.json/)
        expect(first.stderr).toMatch(/Saved ranking to .*misconceptions-ranking\.txt/)
        const output = parse(first.stdout)
        expect(output.transcripts).toBe(2)
        expect(output.skipped).toEqual([])
        expect(output.rows.map((row) => row.category)).toEqual(["Cat-pull", "Cat-loop", "Cat-merge", "Cat-scope"])
        expect(output.rows[0]).toMatchObject({ transcripts: 2, urgency: 5, depth: { severe: 1, moderate: 1, mild: 0 } })
        expect(output.rows[0].importance).toBeUndefined()
        expect(output.rows[0].examples.map((e) => e.transcript.replace(/\.json$/, ""))).toEqual(["a", "b"])
        // messageIndex is the cited message's export position; absent for no turn or a turn matching nothing.
        const cited = [["a-pull@0", "b-pull@1"], ["b-loop@undefined"], ["a-merge@2"], ["a-scope@undefined"]]
        expect(examples(output.rows)).toEqual(cited)
        // The saved ranking (written with --json too) is the table of these rows; its exact format is unit-tested.
        const expectedTable = table(output.rows, 2)
        expect(expectedTable).toContain(`> a-pull  (${output.rows[0].examples[0].transcript}, message 0)`)
        expect((yield* readText(ranking)).trim()).toBe(expectedTable)

        // Run 2: table output, unchanged transcripts -> no extraction requests, one grouping request.
        yield* Effect.promise(() => fs.rm(ranking))
        const second = yield* model.run(args)
        expect(model.take().map((r) => r.kind)).toEqual(["grouping"])
        expect(second.stdout.trim()).toBe(expectedTable)
        expect((yield* readText(ranking)).trim()).toBe(expectedTable)
        expect(second.stderr).toContain("Saved ranking to ")
        expect((yield* Effect.promise(() => fs.readdir(path.join(dir, ".misconceptions")))).length).toBeGreaterThan(0)

        // Run 3: edit b.json -> only b is analyzed again; the saved ranking is not read as a transcript.
        yield* files(dir, { "b.json": transcriptB("b-edited") })
        const third = yield* model.run([...args, "--json"])
        expect(model.of("extraction").length).toBeGreaterThanOrEqual(1)
        expect(model.take().every((r) => r.kind !== "extraction" || r.user.includes("b-edited"))).toBe(true)
        expect(third.stderr).not.toMatch(/(\] |Skipped )misconceptions-ranking/)
        expect(parse(third.stdout)).toMatchObject({ transcripts: 2, skipped: [] })
        expect(examples(parse(third.stdout).rows)[0]).toEqual(["a-pull@0", "b-edited@1"])

        // Run 4: a different model analyzes everything again.
        const fourth = yield* model.run(cmd(dir, "test-model-2", "--no-verify", "--json"))
        expect(model.of("verify")).toEqual([])
        expect(model.has("extraction", "a-pull") && model.has("extraction", "b-edited")).toBe(true)
        expect(model.take().every((r) => r.model === "test-model-2")).toBe(true)
        expect(parse(fourth.stdout).transcripts).toBe(2)

        // Run 5: --course outlines the material once, saves topics.json and weights rows by importance.
        yield* files(home, { "course.md": "# Week 1\nGit pull fetches and merges.\n# Week 5\nMerging branches.\n" })
        const topicsFile = path.join(dir, ".misconceptions", "topics.json")
        const course = [...args, "--course", path.join(home, "course.md")]
        const fifth = yield* model.run([...course, "--json"])
        expect(model.of("outline").length).toBe(1)
        expect(model.has("outline", "Git pull fetches and merges.")).toBe(true)
        expect(model.take().some((r) => r.kind === "extraction")).toBe(false)
        expect(JSON.parse(yield* readText(topicsFile))).toEqual({ topics })
        expect(parse(fifth.stdout).rows.map((r) => [r.category, r.urgency, r.topic, r.importance])).toEqual([
          ["Cat-pull", 15, "Git Pull", "core"],
          ["Cat-loop", 1, "Merging", "peripheral"],
          ["Cat-merge", 1, "Merging", "peripheral"],
          ["Cat-scope", 1, undefined, "uncovered"],
        ])

        // Run 6: a hand-edited topics.json is reused without a request: pull is now uncovered, merging is core.
        const edited = JSON.stringify({ topics: [{ name: "Merging", importance: "core", reason: "edited" }] })
        yield* files(path.dirname(topicsFile), { "topics.json": edited })
        const sixth = yield* model.run(course)
        expect(model.of("outline")).toEqual([])
        expect(sixth.stdout.trim().split(EOL).slice(0, 5)).toEqual([
          "Misconceptions across 2 transcript(s), most urgent first:",
          "",
          "1. Cat-pull  (urgency 5)",
          "   2 transcript(s): 1 severe, 1 moderate, 0 mild",
          "   topic: not covered by course material (uncovered)",
        ])
        expect(sixth.stdout).toMatch(
          /2\. Cat-loop {2}\(urgency 3\)[^]*3\. Cat-merge {2}\(urgency 3\)[^]*Merging \(core\)/,
        )
      }),
    360_000,
  )

  cliIt.live(
    "skips invalid exports and unusable replies, and exits non-zero with no exports, all failures or a missing course",
    ({ opencode, home }) =>
      Effect.gen(function* () {
        const model = yield* fakeModel(opencode)
        const dir = path.join(home, "class")
        yield* files(dir, {
          "a.json": transcriptA,
          "notjson.json": "{ this is not json",
          "role.json": exportOf(msg("system", [{ type: "text", text: "hi" }])),
          "parttype.json": exportOf(msg("user", [{ text: "no type" }])),
          "reply.json": exportOf(user("BADREPLY MC{x|mild|x}")),
          "shape.json": exportOf(user("BADSHAPE MC{y|mild|y}")),
        })
        const bad = ["notjson.json", "role.json", "parttype.json", "reply.json", "shape.json"]

        const plain = yield* model.run(cmd(dir, "test-model"))
        bad.forEach((file) => expect(plain.stderr).toContain(`Skipped ${file}:`))
        expect(plain.stderr).not.toContain("Skipped a.json")
        expect(plain.stdout.split(EOL)[0]).toBe("Misconceptions across 1 transcript(s), most urgent first:")
        expect(plain.stdout).toContain("Cat-pull")

        const output = parse((yield* model.run(cmd(dir, "test-model", "--json"))).stdout)
        expect(output.transcripts).toBe(1)
        expect(output.skipped.map((s) => s.file).toSorted()).toEqual(bad.toSorted())
        output.skipped.forEach((s) => expect(typeof s.error === "string" && s.error.length > 0).toBe(true))
        expect(output.rows.map((row) => row.category)).toContain("Cat-pull")

        yield* files(path.join(home, "empty"), { "notes.txt": "hi" })
        yield* files(path.join(home, "empty", "nested"), { "a.json": transcriptA })
        yield* files(path.join(home, "broken"), { "one.json": "nope", "two.json": exportOf(user("BADREPLY")) })
        const failures = [
          [cmd(path.join(home, "empty"), "test-model"), "No .json session exports found"],
          [cmd(path.join(home, "broken"), "test-model"), "Could not analyze any transcript"],
          [cmd(dir, "test-model", "--course", path.join(home, "no-such-course.md")), "Course material not found"],
        ] as const
        for (const [args, message] of failures) {
          const result = yield* model.spawn(args)
          expect(result.exitCode).not.toBe(0)
          expect(result.stdout + result.stderr).toContain(message)
        }
      }),
    300_000,
  )

  cliIt.live(
    "verifies candidates by default, drops unconfirmed ones, reports findings, caches per setting",
    ({ opencode, home }) =>
      Effect.gen(function* () {
        const model = yield* fakeModel(opencode, { drop: ["drop-me"] })
        const dir = path.join(home, "class")
        // v.json: `pull` recurs after an assistant reply -> severe; `merge` is cited once -> stays mild; `drop-me` is
        // not confirmed. w.json extracts nothing, so it is not verified. x.json: one citation, no repetition.
        yield* files(dir, {
          "v.json": exportOf(
            user("git pull deleted my work MC{pull|severe|v-pull}"),
            assistant("It does not delete work."),
            user("still think v-pull is what happened MC{merge|mild|v-merge}"),
            assistant("No."),
            user("ok and MC{drop-me|severe|v-drop}"),
          ),
          "w.json": exportOf(user("nothing-wrong-here"), assistant("great")),
          "x.json": exportOf(user("pull again MC{pull|severe|x-pull}")),
        })
        const args = cmd(dir, "test-model")

        // Run 1: verify on by default, --json.
        const first = yield* model.run([...args, "--json"])
        expect(model.of("verify").length).toBe(2)
        expect(model.has("verify", "nothing-wrong-here")).toBe(false)
        const verifyV = model.of("verify").find((r) => r.user.includes("v-pull"))?.user ?? ""
        expect(verifyV).toMatch(/\[1\] STUDENT:[^]*\[3\] STUDENT:[^]*Candidates:/)
        const candidates = ['0. pull (quote: "v-pull")', '1. merge (quote: "v-merge")', '2. drop-me (quote: "v-drop")']
        expect(verifyV.split(/\r?\n/)).toEqual(expect.arrayContaining(candidates))
        expect(model.of("verify").some((r) => r.user.split(/\r?\n/).includes('0. pull (quote: "x-pull")'))).toBe(true)
        expect(model.of("grouping").length).toBe(1)
        expect(model.has("grouping", "drop-me")).toBe(false)
        model.take()
        const output = parse(first.stdout)
        expect(output.transcripts).toBe(3)
        expect(output.skipped).toEqual([])
        expect(output.findings.map((f) => f.file.replace(/\.json$/, ""))).toEqual(["v", "w", "x"])
        expect(output.findings.map((f) => f.misconceptions)).toEqual([
          [
            { description: "pull", evidence: "v-pull", depth: "severe", messageIndex: 0, cited: [0, 2], acted: false },
            { description: "merge", evidence: "v-merge", depth: "mild", messageIndex: 2, cited: [2], acted: false },
          ],
          [],
          [{ description: "pull", evidence: "x-pull", depth: "severe", messageIndex: 0, cited: [0], acted: false }],
        ])
        expect(output.rows.map((r) => [r.category, r.transcripts, r.urgency, r.depth])).toEqual([
          ["Cat-pull", 2, 6, { severe: 2, moderate: 0, mild: 0 }],
          ["Cat-merge", 1, 1, { severe: 0, moderate: 0, mild: 1 }],
        ])
        expect(examples(output.rows)).toEqual([["v-pull@0", "x-pull@0"], ["v-merge@2"]])
        const verifiedTable = table(output.rows, 3)
        expect(verifiedTable).not.toContain("drop")
        expect((yield* readText(path.join(dir, "misconceptions-ranking.txt"))).trim()).toBe(verifiedTable)

        // Run 2: same setting, unchanged transcripts -> no extraction and no verify requests.
        const second = yield* model.run(args)
        expect(model.take().map((r) => r.kind)).toEqual(["grouping"])
        expect(second.stdout.trim()).toBe(verifiedTable)

        // Run 3: --no-verify re-extracts, makes no verify request and reports candidates as they are.
        const third = parse((yield* model.run([...args, "--no-verify", "--json"])).stdout)
        expect(model.of("verify")).toEqual([])
        expect(model.has("extraction", "v-pull") && model.has("extraction", "x-pull")).toBe(true)
        model.take()
        expect(third.transcripts).toBe(3)
        expect(third.findings.map((f) => f.misconceptions.length)).toEqual([3, 0, 1])
        const v = third.findings[0].misconceptions
        expect(v[0]).toStrictEqual({ description: "pull", evidence: "v-pull", depth: "severe", messageIndex: 0 })
        expect(v[2]).toMatchObject({ description: "drop-me", depth: "severe", messageIndex: 4 })
        expect(third.rows.map((r) => `${r.category}:${r.urgency}`).join(" ")).toBe(
          "Cat-pull:6 Cat-drop-me:3 Cat-merge:1",
        )

        // Run 4: --no-verify again -> cached within that setting.
        const fourth = yield* model.run([...args, "--no-verify"])
        expect(model.take().map((r) => r.kind)).toEqual(["grouping"])
        expect(fourth.stdout).toContain("2. Cat-drop-me  (urgency 3)")

        // Run 5: back to --verify -> the verified ranking again, never the --no-verify one.
        expect((yield* model.run([...args, "--verify"])).stdout.trim()).toBe(verifiedTable)
      }),
    300_000,
  )
})
