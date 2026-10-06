// Subprocess tests for `opencode misconceptions <dir>`. Each test spawns the real CLI against a
// non-streaming fake OpenAI-compatible server started with Bun.serve, so no real model is called.
//
// The fake model reads markers out of the transcript text. A student message containing
// `MC{name|depth|evidence}` yields a misconception `name` with that depth and evidence, cited at the
// `[n] STUDENT:` label it appears under. `MC{...|noturn}` omits `turn`, `MC{...|badturn}` cites turn 99.
// A transcript containing BADREPLY gets a non-JSON reply, BADSHAPE gets JSON of the wrong shape.
// Grouping puts each distinct description in its own category `Cat-<description>`.
// Verify keeps every candidate except those whose description is in `drop`, citing every `[n]` label
// nearest before an occurrence of the candidate's quote in the transcript, with `acted: false`.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { EOL } from "os"
import path from "path"
import fs from "fs/promises"
import { cliIt } from "../../lib/cli-process"
import { testProviderConfig } from "../../lib/test-provider"

type Kind = "extraction" | "verify" | "grouping" | "outline"
type Recorded = { kind: Kind; model: string; system: string; user: string }
type Topic = { name: string; importance: string; reason: string }
type FakeOptions = { topics?: Topic[]; topicOf?: Record<string, string>; drop?: string[] }

const MARKER = /\[(\d+)\] ([A-Z]+):|MC\{([\w-]+)\|(mild|moderate|severe)\|([\w-]+)(?:\|(noturn|badturn))?\}/g

function fakeModel(options: FakeOptions = {}) {
  return Effect.gen(function* () {
    const requests: Recorded[] = []
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          port: 0,
          hostname: "127.0.0.1",
          fetch: async (req) => {
            const body = (await req.json()) as {
              model: string
              stream?: boolean
              messages: { role: string; content: unknown }[]
            }
            const system = text(body.messages.find((m) => m.role === "system")?.content)
            const user = text(body.messages.find((m) => m.role === "user")?.content)
            const kind = classify(system)
            requests.push({ kind, model: body.model, system, user })
            return Response.json({
              id: "x",
              object: "chat.completion",
              created: 0,
              model: body.model,
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: reply(kind, user, options) },
                  finish_reason: "stop",
                },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            })
          },
        }),
      ),
      (server) => Effect.promise(() => server.stop(true)),
    )
    const url = `http://127.0.0.1:${server.port}/v1`
    const base = testProviderConfig(url)
    const config = {
      ...base,
      provider: {
        test: {
          ...base.provider.test,
          models: {
            ...base.provider.test.models,
            "test-model-2": { ...base.provider.test.models["test-model"], id: "test-model-2", name: "Test Model 2" },
          },
        },
      },
    }
    return {
      requests,
      env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) },
      take: () => requests.splice(0, requests.length),
    }
  })
}

function text(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content))
    return content
      .map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : ""))
      .join("\n")
  return ""
}

function classify(system: string): Kind {
  if (system.includes('"kept"')) return "verify"
  if (system.includes('"categories"')) return "grouping"
  if (system.includes('"misconceptions"')) return "extraction"
  if (system.includes('"topics"')) return "outline"
  throw new Error(`unrecognized request kind, system message: ${system.slice(0, 500)}`)
}

function occurrences(haystack: string, needle: string, from = 0): number[] {
  const at = needle.length === 0 ? -1 : haystack.indexOf(needle, from)
  if (at === -1) return []
  return [at, ...occurrences(haystack, needle, at + needle.length)]
}

function reply(kind: Kind, user: string, options: FakeOptions) {
  if (kind === "outline") return JSON.stringify({ topics: options.topics ?? [] })
  if (kind === "verify") {
    const split = user.indexOf("Candidates:")
    const transcript = split === -1 ? user : user.slice(0, split)
    const labels = [...transcript.matchAll(/\[(\d+)\] [A-Z]+:/g)].map((m) => ({ turn: Number(m[1]), at: m.index }))
    const kept = user
      .slice(split === -1 ? user.length : split)
      .split("\n")
      .flatMap((line) => {
        const match = /^\s*(\d+)\.\s+(.*?)\s+\(quote: "(.*)"\)\s*$/.exec(line)
        return match ? [{ id: Number(match[1]), description: match[2], quote: match[3] }] : []
      })
      .filter((candidate) => !options.drop?.includes(candidate.description))
      .map((candidate) => ({
        id: candidate.id,
        cited: [
          ...new Set(
            occurrences(transcript, candidate.quote).flatMap((at) => {
              const label = labels.findLast((l) => l.at < at)
              return label ? [label.turn] : []
            }),
          ),
        ],
        acted: false,
      }))
    return JSON.stringify({ kept })
  }
  if (kind === "grouping") {
    const names = [
      ...user
        .split("\n")
        .flatMap((line) => {
          const match = /^\s*(\d+)\.\s+(.*)$/.exec(line)
          return match ? [{ id: Number(match[1]), description: match[2].trim() }] : []
        })
        .reduce((groups, finding) => {
          groups.set(finding.description, [...(groups.get(finding.description) ?? []), finding.id])
          return groups
        }, new Map<string, number[]>()),
    ]
    return JSON.stringify({
      categories: names.map(([description, findingIds]) => ({
        name: `Cat-${description}`,
        topic: options.topicOf?.[description] ?? "none",
        findingIds,
      })),
    })
  }
  if (user.includes("BADREPLY")) return "this is not json"
  if (user.includes("BADSHAPE")) return JSON.stringify({ problems: ["nope"] })
  const misconceptions = [...user.matchAll(MARKER)].reduce(
    (state, match) => {
      if (match[1]) return { ...state, label: { turn: Number(match[1]), role: match[2] } }
      if (state.label?.role !== "STUDENT") return state
      const item = { description: match[3], evidence: match[5], depth: match[4] }
      if (match[6] === "noturn") return { ...state, items: [...state.items, item] }
      return {
        ...state,
        items: [...state.items, { ...item, turn: match[6] === "badturn" ? 99 : state.label.turn }],
      }
    },
    { label: undefined as { turn: number; role: string } | undefined, items: [] as object[] },
  ).items
  return JSON.stringify({ misconceptions })
}

const user = (...texts: string[]) => ({
  info: { id: "u", role: "user" },
  parts: texts.map((value) => ({ type: "text", text: value })),
})
const assistant = (value: string) => ({ info: { id: "a", role: "assistant" }, parts: [{ type: "text", text: value }] })
const exportOf = (...messages: object[]) => JSON.stringify({ info: { id: "ses_1", title: "t" }, messages })

// a.json: student messages at export positions 0 and 2. Hidden (synthetic/ignored) text must not be analyzed.
const transcriptA = exportOf(
  {
    info: { id: "m0", role: "user" },
    parts: [
      { type: "text", text: "git pull deleted my work MC{pull|severe|a-pull}" },
      { type: "text", text: "file contents MC{ghost|severe|a-ghost}", synthetic: true },
      { type: "text", text: "MC{ghost|severe|a-ghost2}", ignored: true },
      { type: "step-start" },
      { type: "reasoning", text: "thinking" },
      { type: "file", url: "file:///x.txt" },
    ],
  },
  {
    info: { id: "m1", role: "assistant" },
    parts: [
      { type: "text", text: "It does not delete work." },
      { type: "tool", tool: "bash", state: { status: "completed", output: "ok" } },
    ],
  },
  user("merge always loses changes MC{merge|mild|a-merge}", "and MC{scope|mild|a-scope|badturn}"),
)

// b.json: student messages at export positions 1 and 3.
const transcriptB = (evidence = "b-pull") =>
  exportOf(
    assistant("welcome"),
    user(`pull MC{pull|moderate|${evidence}}`),
    assistant("ok"),
    user("loops MC{loop|mild|b-loop|noturn}"),
  )

type Row = {
  category: string
  transcripts: number
  depth: { mild: number; moderate: number; severe: number }
  urgency: number
  topic?: string
  importance?: string
  examples: { transcript: string; evidence: string; messageIndex?: number }[]
}
type Finding = {
  description: string
  evidence: string
  depth: string
  messageIndex?: number
  cited?: number[]
  acted?: boolean
}
type JsonOutput = {
  transcripts: number
  rows: Row[]
  skipped: { file: string; error: string }[]
  findings: { file: string; misconceptions: Finding[] }[]
}

const write = (file: string, content: string) => Effect.promise(() => Bun.write(file, content))
const readText = (file: string) => Effect.promise(() => Bun.file(file).text())
const mkdir = (dir: string) => Effect.promise(() => fs.mkdir(dir, { recursive: true }))
const parse = (stdout: string) => JSON.parse(stdout) as JsonOutput
const kinds = (requests: Recorded[], kind: Kind) => requests.filter((r) => r.kind === kind)

describe("opencode misconceptions (subprocess)", () => {
  cliIt.live(
    "analyzes exports, prints JSON and table, saves the ranking and caches per transcript (--no-verify)",
    ({ opencode, home }) =>
      Effect.gen(function* () {
        const model = yield* fakeModel()
        const dir = path.join(home, "class")
        yield* mkdir(path.join(dir, "nested"))
        yield* write(path.join(dir, "a.json"), transcriptA)
        yield* write(path.join(dir, "b.json"), transcriptB())
        yield* write(path.join(dir, "notes.txt"), "not a transcript")
        yield* write(path.join(dir, "nested", "c.json"), exportOf(user("MC{nested|severe|c-nested}")))
        const ranking = path.join(dir, "misconceptions-ranking.txt")
        // --no-verify: candidates are reported exactly as extracted, so depths and positions below are
        // the extraction fake's.
        const args = ["misconceptions", dir, "--model", "test/test-model", "--no-verify"]

        // Run 1: --json on a fresh directory.
        const first = yield* opencode.spawn([...args, "--json"], { env: model.env, timeoutMs: 60_000 })
        opencode.expectExit(first, 0)
        const firstRequests = model.take()
        expect(kinds(firstRequests, "extraction").length).toBeGreaterThanOrEqual(2)
        expect(kinds(firstRequests, "verify")).toEqual([])
        expect(kinds(firstRequests, "grouping").length).toBe(1)
        expect(firstRequests.some((r) => r.user.includes("c-nested"))).toBe(false)
        expect(firstRequests.some((r) => r.user.includes("a-ghost"))).toBe(false)
        expect(first.stderr).toMatch(/\[[12]\/2\] a\.json/)
        expect(first.stderr).toMatch(/\[[12]\/2\] b\.json/)
        expect(first.stderr).toContain("Saved ranking to ")
        expect(first.stderr).toContain("misconceptions-ranking.txt")

        const output = parse(first.stdout)
        expect(output.transcripts).toBe(2)
        expect(output.skipped).toEqual([])
        expect(output.rows.map((row) => row.category)).toEqual(["Cat-pull", "Cat-loop", "Cat-merge", "Cat-scope"])
        const nameA = output.rows[0].examples[0].transcript
        const nameB = output.rows[0].examples[1].transcript
        expect(nameA).toMatch(/^a(\.json)?$/)
        expect(nameB).toMatch(/^b(\.json)?$/)
        expect(output.rows[0]).toMatchObject({
          transcripts: 2,
          urgency: 5,
          depth: { severe: 1, moderate: 1, mild: 0 },
          examples: [
            { transcript: nameA, evidence: "a-pull", messageIndex: 0 },
            { transcript: nameB, evidence: "b-pull", messageIndex: 1 },
          ],
        })
        expect(output.rows[0].importance).toBeUndefined()
        expect(output.rows[2].examples).toEqual([{ transcript: nameA, evidence: "a-merge", messageIndex: 2 }])
        // No turn, or a turn matching no student message: messageIndex is absent.
        expect(output.rows[1].examples[0].messageIndex).toBeUndefined()
        expect(output.rows[3].examples[0].messageIndex).toBeUndefined()

        const expectedTable = [
          "Misconceptions across 2 transcript(s), most urgent first:",
          "",
          "1. Cat-pull  (urgency 5)",
          "   2 transcript(s): 1 severe, 1 moderate, 0 mild",
          `   > a-pull  (${nameA}, message 0)`,
          `   > b-pull  (${nameB}, message 1)`,
          "",
          "2. Cat-loop  (urgency 1)",
          "   1 transcript(s): 0 severe, 0 moderate, 1 mild",
          `   > b-loop  (${nameB})`,
          "",
          "3. Cat-merge  (urgency 1)",
          "   1 transcript(s): 0 severe, 0 moderate, 1 mild",
          `   > a-merge  (${nameA}, message 2)`,
          "",
          "4. Cat-scope  (urgency 1)",
          "   1 transcript(s): 0 severe, 0 moderate, 1 mild",
          `   > a-scope  (${nameA})`,
        ].join(EOL)
        // The saved ranking is written with --json too.
        expect((yield* readText(ranking)).trim()).toBe(expectedTable)

        // Run 2: table output, unchanged transcripts -> no extraction requests, one grouping request.
        yield* Effect.promise(() => fs.rm(ranking))
        const second = yield* opencode.spawn(args, { env: model.env, timeoutMs: 60_000 })
        opencode.expectExit(second, 0)
        const secondRequests = model.take()
        expect(kinds(secondRequests, "extraction")).toEqual([])
        expect(kinds(secondRequests, "grouping").length).toBe(1)
        expect(second.stdout.trim()).toBe(expectedTable)
        expect((yield* readText(ranking)).trim()).toBe(expectedTable)
        expect(second.stderr).toContain("Saved ranking to ")
        expect((yield* Effect.promise(() => fs.readdir(path.join(dir, ".misconceptions")))).length).toBeGreaterThan(0)

        // Run 3: edit b.json -> only b is analyzed again; the saved ranking is not read as a transcript.
        yield* write(path.join(dir, "b.json"), transcriptB("b-edited"))
        const third = yield* opencode.spawn([...args, "--json"], { env: model.env, timeoutMs: 60_000 })
        opencode.expectExit(third, 0)
        const thirdExtraction = kinds(model.take(), "extraction")
        expect(thirdExtraction.length).toBeGreaterThanOrEqual(1)
        expect(thirdExtraction.every((r) => r.user.includes("b-edited"))).toBe(true)
        expect(third.stderr).not.toMatch(/(\] |Skipped )misconceptions-ranking/)
        const thirdOutput = parse(third.stdout)
        expect(thirdOutput.transcripts).toBe(2)
        expect(thirdOutput.skipped).toEqual([])
        expect(thirdOutput.rows[0].examples.map((e) => e.evidence)).toEqual(["a-pull", "b-edited"])

        // Run 4: a different model analyzes everything again.
        const fourth = yield* opencode.spawn(
          ["misconceptions", dir, "--model", "test/test-model-2", "--no-verify", "--json"],
          { env: model.env, timeoutMs: 60_000 },
        )
        opencode.expectExit(fourth, 0)
        const fourthRequests = model.take()
        expect(kinds(fourthRequests, "verify")).toEqual([])
        const fourthExtraction = kinds(fourthRequests, "extraction")
        expect(fourthExtraction.some((r) => r.user.includes("a-pull"))).toBe(true)
        expect(fourthExtraction.some((r) => r.user.includes("b-edited"))).toBe(true)
        expect(fourthExtraction.every((r) => r.model === "test-model-2")).toBe(true)
        expect(parse(fourth.stdout).transcripts).toBe(2)
      }),
    240_000,
  )

  cliIt.live(
    "skips invalid exports and unusable model replies but analyzes the rest",
    ({ opencode, home }) =>
      Effect.gen(function* () {
        const model = yield* fakeModel()
        const dir = path.join(home, "class")
        yield* mkdir(dir)
        yield* write(path.join(dir, "a.json"), transcriptA)
        yield* write(path.join(dir, "notjson.json"), "{ this is not json")
        yield* write(path.join(dir, "nomessages.json"), JSON.stringify({ info: { id: "ses" } }))
        yield* write(
          path.join(dir, "role.json"),
          exportOf({ info: { id: "m", role: "system" }, parts: [{ type: "text", text: "hi" }] }),
        )
        yield* write(
          path.join(dir, "parttype.json"),
          exportOf({ info: { id: "m", role: "user" }, parts: [{ text: "no type" }] }),
        )
        yield* write(path.join(dir, "reply.json"), exportOf(user("BADREPLY MC{x|mild|x}")))
        yield* write(path.join(dir, "shape.json"), exportOf(user("BADSHAPE MC{y|mild|y}")))
        const bad = ["notjson.json", "nomessages.json", "role.json", "parttype.json", "reply.json", "shape.json"]
        const args = ["misconceptions", dir, "--model", "test/test-model"]

        const plain = yield* opencode.spawn(args, { env: model.env, timeoutMs: 60_000 })
        opencode.expectExit(plain, 0)
        bad.forEach((file) => expect(plain.stderr).toContain(`Skipped ${file}:`))
        expect(plain.stderr).not.toContain("Skipped a.json")
        expect(plain.stdout.split(EOL)[0]).toBe("Misconceptions across 1 transcript(s), most urgent first:")
        expect(plain.stdout).toContain("Cat-pull")

        const json = yield* opencode.spawn([...args, "--json"], { env: model.env, timeoutMs: 60_000 })
        opencode.expectExit(json, 0)
        const output = parse(json.stdout)
        expect(output.transcripts).toBe(1)
        expect(output.skipped.map((s) => s.file).toSorted()).toEqual(bad.toSorted())
        output.skipped.forEach((s) => {
          expect(typeof s.error).toBe("string")
          expect(s.error.length).toBeGreaterThan(0)
        })
        expect(output.rows.map((row) => row.category)).toContain("Cat-pull")
      }),
    120_000,
  )

  cliIt.live(
    "exits non-zero with no exports, when every transcript fails, or with a missing course path",
    ({ opencode, home }) =>
      Effect.gen(function* () {
        const model = yield* fakeModel()

        const empty = path.join(home, "empty")
        yield* mkdir(path.join(empty, "nested"))
        yield* write(path.join(empty, "notes.txt"), "hi")
        yield* write(path.join(empty, "nested", "a.json"), transcriptA)
        const none = yield* opencode.spawn(["misconceptions", empty, "--model", "test/test-model"], {
          env: model.env,
          timeoutMs: 60_000,
        })
        expect(none.exitCode).not.toBe(0)
        expect(none.stdout + none.stderr).toContain("No .json session exports found")

        const broken = path.join(home, "broken")
        yield* mkdir(broken)
        yield* write(path.join(broken, "one.json"), "nope")
        yield* write(path.join(broken, "two.json"), exportOf(user("BADREPLY")))
        const failed = yield* opencode.spawn(["misconceptions", broken, "--model", "test/test-model"], {
          env: model.env,
          timeoutMs: 60_000,
        })
        expect(failed.exitCode).not.toBe(0)
        expect(failed.stdout + failed.stderr).toContain("Could not analyze any transcript")

        const ok = path.join(home, "ok")
        yield* mkdir(ok)
        yield* write(path.join(ok, "a.json"), transcriptA)
        const missing = yield* opencode.spawn(
          ["misconceptions", ok, "--model", "test/test-model", "--course", path.join(home, "no-such-course.md")],
          { env: model.env, timeoutMs: 60_000 },
        )
        expect(missing.exitCode).not.toBe(0)
        expect(missing.stdout + missing.stderr).toContain("Course material not found")
      }),
    180_000,
  )

  cliIt.live(
    "--course saves topics, reuses them without a request, and hand edits change the ranking",
    ({ opencode, home }) =>
      Effect.gen(function* () {
        const model = yield* fakeModel({
          topics: [
            { name: "Git Pull", importance: "core", reason: "week 1" },
            { name: "Merging", importance: "peripheral", reason: "optional" },
          ],
          topicOf: { pull: "git pull", merge: "Merging", loop: "Merging" },
        })
        const dir = path.join(home, "class")
        yield* mkdir(dir)
        yield* write(path.join(dir, "a.json"), transcriptA)
        yield* write(path.join(dir, "b.json"), transcriptB())
        const course = path.join(home, "course.md")
        yield* write(course, "# Week 1\nGit pull fetches and merges.\n# Week 5\nMerging branches.\n")
        const topicsFile = path.join(dir, ".misconceptions", "topics.json")
        // --no-verify keeps the extraction fake's depths, which the urgencies below are computed from.
        const args = ["misconceptions", dir, "--model", "test/test-model", "--course", course, "--no-verify"]

        const first = yield* opencode.spawn([...args, "--json"], { env: model.env, timeoutMs: 60_000 })
        opencode.expectExit(first, 0)
        const firstRequests = model.take()
        expect(kinds(firstRequests, "outline").length).toBe(1)
        expect(kinds(firstRequests, "outline")[0].user).toContain("Git pull fetches and merges.")
        const saved = JSON.parse(yield* readText(topicsFile)) as { topics: Topic[] }
        expect(saved).toEqual({
          topics: [
            { name: "Git Pull", importance: "core", reason: "week 1" },
            { name: "Merging", importance: "peripheral", reason: "optional" },
          ],
        })
        const rows = parse(first.stdout).rows
        expect(rows.map((row) => row.category)).toEqual(["Cat-pull", "Cat-loop", "Cat-merge", "Cat-scope"])
        expect(rows[0]).toMatchObject({ urgency: 15, topic: "Git Pull", importance: "core" })
        expect(rows[1]).toMatchObject({ urgency: 1, topic: "Merging", importance: "peripheral" })
        expect(rows[3]).toMatchObject({ urgency: 1, importance: "uncovered" })
        expect(rows[3].topic).toBeUndefined()

        // Hand edit: pull is no longer covered, merging becomes core.
        yield* write(
          topicsFile,
          JSON.stringify({ topics: [{ name: "Merging", importance: "core", reason: "edited" }] }, null, 2),
        )
        const second = yield* opencode.spawn(args, { env: model.env, timeoutMs: 60_000 })
        opencode.expectExit(second, 0)
        expect(kinds(model.take(), "outline")).toEqual([])
        const lines = second.stdout.trim().split(EOL)
        expect(lines.slice(0, 5)).toEqual([
          "Misconceptions across 2 transcript(s), most urgent first:",
          "",
          "1. Cat-pull  (urgency 5)",
          "   2 transcript(s): 1 severe, 1 moderate, 0 mild",
          "   topic: not covered by course material (uncovered)",
        ])
        expect(lines).toContain("2. Cat-loop  (urgency 3)")
        expect(lines).toContain("3. Cat-merge  (urgency 3)")
        expect(lines).toContain("   topic: Merging (core)")
        expect(lines).toContain("4. Cat-scope  (urgency 1)")
      }),
    180_000,
  )

  cliIt.live(
    "verifies candidates by default, drops unconfirmed ones, reports findings, caches per setting",
    ({ opencode, home }) =>
      Effect.gen(function* () {
        const model = yield* fakeModel({ drop: ["drop-me"] })
        const dir = path.join(home, "class")
        yield* mkdir(dir)
        // v.json: `pull` is cited at positions 0 and 2 (the quote "v-pull" recurs after an assistant
        // reply) -> severe; `merge` is mild with one citation -> mild; `drop-me` is not confirmed.
        yield* write(
          path.join(dir, "v.json"),
          exportOf(
            user("git pull deleted my work MC{pull|severe|v-pull}"),
            assistant("It does not delete work."),
            user("still think v-pull is what happened MC{merge|mild|v-merge}"),
            assistant("No."),
            user("ok and MC{drop-me|severe|v-drop}"),
          ),
        )
        // w.json: extraction finds nothing, so no verify request is made for it.
        yield* write(path.join(dir, "w.json"), exportOf(user("nothing-wrong-here"), assistant("great")))
        // x.json: one severe candidate with a single citation and no repetition -> moderate.
        yield* write(path.join(dir, "x.json"), exportOf(user("pull again MC{pull|severe|x-pull}")))
        const args = ["misconceptions", dir, "--model", "test/test-model"]

        // Run 1: verify on by default, --json.
        const first = yield* opencode.spawn([...args, "--json"], { env: model.env, timeoutMs: 60_000 })
        opencode.expectExit(first, 0)
        const firstRequests = model.take()
        const verifies = kinds(firstRequests, "verify")
        expect(verifies.length).toBe(2)
        expect(verifies.some((r) => r.user.includes("nothing-wrong-here"))).toBe(false)
        const verifyV = verifies.find((r) => r.user.includes("v-pull"))
        expect(verifyV).toBeDefined()
        expect(verifyV?.user).toContain("[1] STUDENT:")
        expect(verifyV?.user).toContain("[3] STUDENT:")
        expect(verifyV?.user).toContain("Candidates:")
        expect(verifyV?.user).toMatch(/^0\. pull \(quote: "v-pull"\)$/m)
        expect(verifyV?.user).toMatch(/^1\. merge \(quote: "v-merge"\)$/m)
        expect(verifyV?.user).toMatch(/^2\. drop-me \(quote: "v-drop"\)$/m)
        expect(verifyV?.user.indexOf("Candidates:")).toBeGreaterThan(verifyV?.user.indexOf("[3] STUDENT:") ?? 0)
        expect(verifies.some((r) => r.user.includes("x-pull") && /^0\. pull \(quote: "x-pull"\)$/m.test(r.user))).toBe(
          true,
        )
        expect(kinds(firstRequests, "grouping").length).toBe(1)
        expect(kinds(firstRequests, "grouping")[0].user).not.toContain("drop-me")

        const output = parse(first.stdout)
        expect(output.transcripts).toBe(3)
        expect(output.skipped).toEqual([])
        expect(output.findings.map((f) => f.file.replace(/\.json$/, ""))).toEqual(["v", "w", "x"])
        expect(output.findings[0].misconceptions).toHaveLength(2)
        expect(output.findings[0].misconceptions[0]).toMatchObject({
          description: "pull",
          evidence: "v-pull",
          depth: "severe",
          messageIndex: 0,
          cited: [0, 2],
          acted: false,
        })
        expect(output.findings[0].misconceptions[1]).toMatchObject({
          description: "merge",
          evidence: "v-merge",
          depth: "mild",
          messageIndex: 2,
          cited: [2],
          acted: false,
        })
        expect(output.findings[1].misconceptions).toEqual([])
        expect(output.findings[2].misconceptions).toHaveLength(1)
        expect(output.findings[2].misconceptions[0]).toMatchObject({
          description: "pull",
          evidence: "x-pull",
          depth: "moderate",
          messageIndex: 0,
          cited: [0],
          acted: false,
        })
        expect(output.rows.map((row) => row.category)).toEqual(["Cat-pull", "Cat-merge"])
        const nameV = output.rows[0].examples[0].transcript
        const nameX = output.rows[0].examples[1].transcript
        expect(nameV).toMatch(/^v(\.json)?$/)
        expect(nameX).toMatch(/^x(\.json)?$/)
        expect(output.rows[0]).toMatchObject({
          transcripts: 2,
          urgency: 5,
          depth: { severe: 1, moderate: 1, mild: 0 },
          examples: [
            { transcript: nameV, evidence: "v-pull", messageIndex: 0 },
            { transcript: nameX, evidence: "x-pull", messageIndex: 0 },
          ],
        })
        expect(output.rows[1]).toMatchObject({
          transcripts: 1,
          urgency: 1,
          depth: { severe: 0, moderate: 0, mild: 1 },
          examples: [{ transcript: nameV, evidence: "v-merge", messageIndex: 2 }],
        })
        expect(JSON.stringify(output.rows)).not.toContain("drop")

        const verifiedTable = [
          "Misconceptions across 3 transcript(s), most urgent first:",
          "",
          "1. Cat-pull  (urgency 5)",
          "   2 transcript(s): 1 severe, 1 moderate, 0 mild",
          `   > v-pull  (${nameV}, message 0)`,
          `   > x-pull  (${nameX}, message 0)`,
          "",
          "2. Cat-merge  (urgency 1)",
          "   1 transcript(s): 0 severe, 0 moderate, 1 mild",
          `   > v-merge  (${nameV}, message 2)`,
        ].join(EOL)
        expect((yield* readText(path.join(dir, "misconceptions-ranking.txt"))).trim()).toBe(verifiedTable)

        // Run 2: same setting, unchanged transcripts -> no extraction and no verify requests.
        const second = yield* opencode.spawn(args, { env: model.env, timeoutMs: 60_000 })
        opencode.expectExit(second, 0)
        const secondRequests = model.take()
        expect(kinds(secondRequests, "extraction")).toEqual([])
        expect(kinds(secondRequests, "verify")).toEqual([])
        expect(kinds(secondRequests, "grouping").length).toBe(1)
        expect(second.stdout.trim()).toBe(verifiedTable)

        // Run 3: --no-verify re-extracts, makes no verify request and reports candidates as they are.
        const third = yield* opencode.spawn([...args, "--no-verify", "--json"], { env: model.env, timeoutMs: 60_000 })
        opencode.expectExit(third, 0)
        const thirdRequests = model.take()
        expect(kinds(thirdRequests, "verify")).toEqual([])
        expect(kinds(thirdRequests, "extraction").some((r) => r.user.includes("v-pull"))).toBe(true)
        expect(kinds(thirdRequests, "extraction").some((r) => r.user.includes("x-pull"))).toBe(true)
        const thirdOutput = parse(third.stdout)
        expect(thirdOutput.transcripts).toBe(3)
        expect(thirdOutput.findings.map((f) => f.file.replace(/\.json$/, ""))).toEqual(["v", "w", "x"])
        expect(thirdOutput.findings[0].misconceptions).toHaveLength(3)
        expect(thirdOutput.findings[0].misconceptions[0]).toMatchObject({
          description: "pull",
          evidence: "v-pull",
          depth: "severe",
          messageIndex: 0,
        })
        expect(thirdOutput.findings[0].misconceptions[0].acted).toBeUndefined()
        expect(thirdOutput.findings[0].misconceptions[0].cited).toBeUndefined()
        expect(thirdOutput.findings[0].misconceptions[2]).toMatchObject({
          description: "drop-me",
          evidence: "v-drop",
          depth: "severe",
          messageIndex: 4,
        })
        expect(thirdOutput.findings[2].misconceptions[0]).toMatchObject({ description: "pull", depth: "severe" })
        expect(thirdOutput.rows.map((row) => [row.category, row.urgency])).toEqual([
          ["Cat-pull", 6],
          ["Cat-drop-me", 3],
          ["Cat-merge", 1],
        ])

        // Run 4: --no-verify again -> cached within that setting.
        const fourth = yield* opencode.spawn([...args, "--no-verify"], { env: model.env, timeoutMs: 60_000 })
        opencode.expectExit(fourth, 0)
        const fourthRequests = model.take()
        expect(kinds(fourthRequests, "extraction")).toEqual([])
        expect(kinds(fourthRequests, "verify")).toEqual([])
        expect(fourth.stdout.trim().split(EOL)).toContain("1. Cat-pull  (urgency 6)")
        expect(fourth.stdout.trim().split(EOL)).toContain("2. Cat-drop-me  (urgency 3)")

        // Run 5: back to --verify -> the verified ranking again (from its own cache or re-extraction),
        // never the --no-verify one.
        const fifth = yield* opencode.spawn([...args, "--verify"], { env: model.env, timeoutMs: 60_000 })
        opencode.expectExit(fifth, 0)
        expect(fifth.stdout.trim()).toBe(verifiedTable)
      }),
    300_000,
  )
})
