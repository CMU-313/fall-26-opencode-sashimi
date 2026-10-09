import { generateObject } from "ai"
import { Cause, Effect, Option, Schedule, Schema } from "effect"
import path from "path"
import { EOL } from "os"
import { Token } from "@opencode-ai/core/util/token"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { usable } from "@/session/overflow"
import { ToolJsonSchema } from "@/tool/json-schema"
import { effectCmd, fail } from "../effect-cmd"

// Assistant replies only give context for the student's side, so keep a short prefix of each.
const ASSISTANT_TOKENS = 150
// Consecutive pieces of a long transcript share their last turns, so a question and its
// follow-up are never split apart.
const OVERLAP_TURNS = 2
// Room for the labels in front of a turn cut to fit in one piece.
const LABEL_TOKENS = 25
// Upper bound per extraction call; very long inputs lose detail even when the model accepts them.
const PIECE_TOKENS = 60_000
// Room left for the system prompt and instructions around each piece.
const PROMPT_TOKENS = 2_000
const CONCURRENCY = 4
// Bump when the extraction prompt or schema changes so cached findings are recomputed.
const CACHE_VERSION = 3
const TRIM_MARKER = " …[trimmed]"

export const DEPTH_WEIGHT = { mild: 1, moderate: 2, severe: 3 }
export const IMPORTANCE_WEIGHT = { core: 3, supporting: 2, peripheral: 1, uncovered: 1 }

const Depth = Schema.Literals(["mild", "moderate", "severe"])
const Importance = Schema.Literals(["core", "supporting", "peripheral"])

// What the model returns: `turn` points at the numbered student message the evidence quotes.
const Extracted = Schema.Struct({
  description: Schema.String,
  evidence: Schema.String,
  depth: Depth,
  turn: Schema.optional(Schema.Number),
})
export type Extracted = typeof Extracted.Type

const Extraction = Schema.Struct({ misconceptions: Schema.Array(Extracted) })

// `messageIndex` is the cited student message's position in the export's `messages` array, when the model
// cited one that exists, so the full message can be looked up in the transcript file. After verification,
// `cited` lists every student message showing the misconception and `acted` whether the student acted on it.
const Finding = Schema.Struct({
  description: Schema.String,
  evidence: Schema.String,
  depth: Depth,
  messageIndex: Schema.optional(Schema.Number),
  cited: Schema.optional(Schema.Array(Schema.Number)),
  acted: Schema.optional(Schema.Boolean),
})
export type Finding = typeof Finding.Type

const Findings = Schema.Struct({ misconceptions: Schema.Array(Finding) })

const Topic = Schema.Struct({ name: Schema.String, importance: Importance, reason: Schema.String })
export type Topic = typeof Topic.Type

const Topics = Schema.Struct({ topics: Schema.Array(Topic) })

const Category = Schema.Struct({
  name: Schema.String,
  topic: Schema.String,
  findingIds: Schema.Array(Schema.Number),
})
export type Category = typeof Category.Type

const Categories = Schema.Struct({ categories: Schema.Array(Category) })

// What the verify pass returns: which candidates survive, where each one shows up, and whether it was acted on.
const Verified = Schema.Struct({
  kept: Schema.Array(Schema.Struct({ id: Schema.Number, cited: Schema.Array(Schema.Number), acted: Schema.Boolean })),
})

// Only the fields the analysis reads; everything else in an `opencode export` file is ignored.
const ExportFile = Schema.Struct({
  messages: Schema.Array(
    Schema.Struct({
      info: Schema.Struct({ role: Schema.Literals(["user", "assistant"]) }),
      parts: Schema.Array(
        Schema.Struct({
          type: Schema.String,
          text: Schema.optional(Schema.String),
          synthetic: Schema.optional(Schema.Boolean),
          ignored: Schema.optional(Schema.Boolean),
        }),
      ),
    }),
  ),
})

const decodeExport = Schema.decodeUnknownOption(Schema.fromJsonString(ExportFile))
const decodeFindings = Schema.decodeUnknownOption(Schema.fromJsonString(Findings))
const decodeTopics = Schema.decodeUnknownOption(Schema.fromJsonString(Topics))

const EXTRACT_PROMPT = `You review a conversation between a student and an AI coding assistant in a software engineering course.
List every misconception, knowledge gap, or point of confusion the student shows about course material: software engineering concepts, tools, languages, and practices.
Be inclusive: wrong beliefs, missing knowledge, and repeated struggles with the same idea all count. Do not list confusion about how to operate the AI assistant itself.
For each one give:
- description: one sentence stating what the student misunderstood, in general terms that would apply to other students with the same confusion.
- evidence: a short direct quote from the student that shows it.
- turn: the number in brackets before the student message the evidence quotes.
- depth: how confused the student was here. mild = brief slip or quickly corrected; moderate = needed explanation; severe = stuck across several turns or built work on the wrong idea.
Messages listed as earlier context were already reviewed; only report misconceptions shown in the messages to review.
Do not group, rank, or merge items. Return an empty list if there are none.`

const VERIFY_PROMPT = `You check candidate misconceptions against the student conversation they were taken from. Student messages are numbered in brackets.
Keep a candidate only if a student message shows the student holding or acting on the wrong belief about software engineering course material. A question on its own, or confusion about operating the AI assistant, is not a misconception.
For each kept candidate give:
- id: the candidate's number.
- cited: the bracket numbers of every student message where the student states, repeats or relies on this misconception.
- acted: true only if the student carried out something wrong because of it (for example force-pushed the shared branch, committed the secret, merged with the failing check); doing ordinary work in the session is not acting on it.
Return only the kept candidates.`

const OUTLINE_PROMPT = `You read course material for a software engineering course and produce an outline of its topics.
For each topic give its name, its importance, and a one-sentence reason.
importance: core = the course is built on it (appears in learning objectives, spans multiple weeks, later topics or graded projects depend on it); supporting = taught and used but not central; peripheral = mentioned briefly.
Use 5 to 30 topics at a consistent level of detail.`

const MERGE_PROMPT = `You receive numbered descriptions of student misconceptions collected from many conversations.
Group descriptions that describe the same underlying misconception into one category with a short, specific name.
Every id must appear in exactly one category. Prefer specific categories over broad ones, but do not create near-duplicate categories.
For topic, use the exact name of the best matching course topic when a topic list is given, or "none" if no topic covers it or no list is given.`

export const MisconceptionsCommand = effectCmd({
  command: "misconceptions <dir>",
  describe: "rank common student misconceptions across exported sessions",
  builder: (yargs) =>
    yargs
      .positional("dir", {
        describe: "directory of session JSON files from `opencode export`",
        type: "string",
        demandOption: true,
      })
      .option("course", {
        describe: "course material (markdown or text file, or a directory of them) used to weight topics",
        type: "string",
      })
      .option("model", {
        describe: "model to use in the format of provider/model",
        type: "string",
      })
      .option("json", {
        describe: "print results as JSON",
        type: "boolean",
      })
      .option("verify", {
        describe: "check each candidate misconception against its transcript in a second model call (--no-verify to skip)",
        type: "boolean",
        default: true,
      }),
  handler: (args) => run(args).pipe(Effect.map((output) => process.stdout.write(output))),
})

export type Args = { dir: string; course?: string; model?: string; json?: boolean; verify: boolean }

/** The whole command apart from printing: returns what goes to stdout, writes progress and notes to stderr. */
export const run = Effect.fn("Cli.misconceptions")(function* (args: Args) {
    const dir = path.resolve(args.dir)
    const files = yield* Effect.promise(() => Array.fromAsync(new Bun.Glob("*.json").scan({ cwd: dir })))
    if (files.length === 0) return yield* fail(`No .json session exports found in ${dir}`)

    const llm = yield* connect(args.model)
    const cache = path.join(dir, ".misconceptions")
    const topics = args.course ? yield* outline(llm, path.resolve(args.course), cache) : undefined

    const results = yield* Effect.forEach(
      files.toSorted(),
      (file, i) =>
        analyze(llm, path.join(dir, file), cache, args.verify).pipe(
          Effect.map((findings) => ({ file, findings, error: undefined })),
          Effect.catchCause((cause) => Effect.succeed({ file, findings: [], error: Cause.pretty(cause) })),
          Effect.tap(() => Effect.sync(() => process.stderr.write(`[${i + 1}/${files.length}] ${file}${EOL}`))),
        ),
      { concurrency: CONCURRENCY },
    )

    const skipped = results.filter((result) => result.error !== undefined)
    // Every file failing usually means a bad model or credentials, not "no misconceptions".
    if (skipped.length === results.length)
      return yield* fail(`Could not analyze any transcript: ${skipped[0].error.split(EOL)[0]}`)

    const allFindings = results.flatMap((result) =>
      result.findings.map((item) => ({ ...item, transcript: result.file })),
    )
    const categories = allFindings.length ? yield* merge(llm, allFindings, topics) : []
    const rows = rank({ findings: allFindings, categories, topics })

    const ranking = table(rows, results.length - skipped.length)
    // Saved even with --json, which is what the TUI command reads, so the TA always gets a readable copy. The name
    // is not *.json so later runs do not mistake it for a transcript.
    const saved = path.join(dir, "misconceptions-ranking.txt")
    yield* Effect.promise(() => Bun.write(saved, ranking + EOL))
    process.stderr.write(`Saved ranking to ${saved}${EOL}`)

    skipped.forEach((item) => process.stderr.write(`Skipped ${item.file}: ${item.error.split(EOL)[0]}${EOL}`))
    if (args.json)
      return (
        JSON.stringify(
          {
            transcripts: results.length - skipped.length,
            rows,
            skipped,
            findings: results.filter((result) => result.error === undefined).map((result) => ({ file: result.file, misconceptions: result.findings })),
          },
          null,
          2,
        ) + EOL
      )
    return ranking + EOL
})

// `index` is the message's position in the export's `messages` array.
export type Turn = { role: "user" | "assistant"; text: string; index: number }
export type Piece = { context: Turn[]; turns: Turn[] }

/** Reduce an `opencode export` file to the text of each turn, or undefined if it is not a valid export. */
export function shrink(json: string) {
  const file = decodeExport(json)
  if (Option.isNone(file)) return undefined
  return file.value.messages.flatMap((message, index): Turn[] => {
    const text = message.parts
      .filter((part) => part.type === "text" && !part.synthetic && !part.ignored)
      .map((part) => part.text ?? "")
      .join("\n")
      .trim()
    if (!text) return []
    return [{ role: message.info.role, text: message.info.role === "assistant" ? trim(text, ASSISTANT_TOKENS) : text, index }]
  })
}

/**
 * Split turns into pieces whose rendered text fits in `budget` tokens. Pieces cut between turns and begin with the
 * previous piece's last turns as unnumbered context. A turn too long for one piece becomes overlapping parts.
 */
export function split(turns: readonly Turn[], budget: number) {
  return turns
    .flatMap((turn) => parts(turn, budget))
    .reduce<Piece[]>((pieces, turn) => {
      const current = pieces.at(-1)
      if (current && size({ context: current.context, turns: [...current.turns, turn] }) <= budget) {
        current.turns.push(turn)
        return pieces
      }
      const context = current ? [...current.context, ...current.turns].slice(-OVERLAP_TURNS) : []
      pieces.push(size({ context, turns: [turn] }) <= budget ? { context, turns: [turn] } : { context: [], turns: [turn] })
      return pieces
    }, [])
}

/** Render a piece for the model: context turns unnumbered, student turns to review numbered by position. */
export function render(piece: Piece) {
  const review = piece.turns
    .map((turn) => (turn.role === "user" ? `[${turn.index + 1}] STUDENT: ${turn.text}` : `ASSISTANT: ${turn.text}`))
    .join("\n\n")
  if (piece.context.length === 0) return review
  const context = piece.context
    .map((turn) => `${turn.role === "user" ? "STUDENT" : "ASSISTANT"}: ${turn.text}`)
    .join("\n\n")
  return `Earlier messages, for context only:\n\n${context}\n\nMessages to review:\n\n${review}`
}

/** Record which message the evidence came from when the model cites a numbered student turn from this piece. */
export function locate(item: Extracted, piece: Piece): Finding {
  const finding = { description: item.description, evidence: item.evidence, depth: item.depth }
  const turn = piece.turns.find((candidate) => candidate.role === "user" && candidate.index + 1 === item.turn)
  if (!turn) return finding
  return { ...finding, messageIndex: turn.index }
}

/**
 * Drop repeated findings within one transcript, keeping the deepest. Findings that cite a student message repeat
 * when they cite the same one; findings without a cited message repeat when they share a description.
 */
export function dedupe(findings: readonly Finding[]) {
  return findings.reduce<Finding[]>((kept, item) => {
    const match = kept.findIndex((other) => repeats(other, item))
    if (match === -1) return [...kept, item]
    if (DEPTH_WEIGHT[item.depth] <= DEPTH_WEIGHT[kept[match].depth]) return kept
    return kept.map((other, i) => (i === match ? item : other))
  }, [])
}

/**
 * Rank categories by urgency: for each transcript in the category, the weight of its deepest
 * finding times the importance of the category's course topic, summed. Without course topics
 * every category has importance weight 1.
 */
export function rank(input: {
  findings: readonly (Finding & { transcript: string })[]
  categories: readonly Category[]
  topics?: readonly Topic[]
}) {
  const owner = new Map<number, number>()
  input.categories.forEach((category, index) =>
    category.findingIds.forEach((id) => {
      if (Number.isInteger(id) && id >= 0 && id < input.findings.length && !owner.has(id)) owner.set(id, index)
    }),
  )
  const groups = [
    ...input.categories.map((category, index) => ({
      name: category.name,
      topic: category.topic,
      members: input.findings.filter((_, id) => owner.get(id) === index),
    })),
    // The model can leave ids out of every category; keep those findings visible rather than dropping them.
    { name: "Uncategorized", topic: "none", members: input.findings.filter((_, id) => !owner.has(id)) },
  ].filter((group) => group.members.length > 0)

  return groups
    .map((group) => {
      const topic = input.topics?.find((item) => item.name.trim().toLowerCase() === group.topic.trim().toLowerCase())
      const importance = input.topics ? (topic?.importance ?? "uncovered") : undefined
      const deepest = [
        ...Map.groupBy(group.members, (item) => item.transcript)
          .values()
          .map((items) => items.toSorted((a, b) => DEPTH_WEIGHT[b.depth] - DEPTH_WEIGHT[a.depth])[0]),
      ]
      return {
        category: group.name,
        topic: topic?.name,
        importance,
        transcripts: deepest.length,
        urgency: deepest.reduce(
          (sum, item) => sum + DEPTH_WEIGHT[item.depth] * (importance ? IMPORTANCE_WEIGHT[importance] : 1),
          0,
        ),
        depth: {
          mild: deepest.filter((item) => item.depth === "mild").length,
          moderate: deepest.filter((item) => item.depth === "moderate").length,
          severe: deepest.filter((item) => item.depth === "severe").length,
        },
        examples: deepest
          .toSorted((a, b) => DEPTH_WEIGHT[b.depth] - DEPTH_WEIGHT[a.depth])
          .slice(0, 2)
          .map((item) => ({
            transcript: item.transcript,
            evidence: item.evidence,
            messageIndex: item.messageIndex,
          })),
      }
    })
    .toSorted((a, b) => b.urgency - a.urgency || b.transcripts - a.transcripts || a.category.localeCompare(b.category))
}

export type Row = ReturnType<typeof rank>[number]

export function table(rows: readonly Row[], transcripts: number) {
  if (rows.length === 0) return `No misconceptions found in ${transcripts} transcript(s).`
  return [
    `Misconceptions across ${transcripts} transcript(s), most urgent first:`,
    ...rows.flatMap((row, i) => [
      "",
      `${i + 1}. ${row.category}  (urgency ${row.urgency})`,
      `   ${row.transcripts} transcript(s): ${row.depth.severe} severe, ${row.depth.moderate} moderate, ${row.depth.mild} mild`,
      ...(row.importance ? [`   topic: ${row.topic ?? "not covered by course material"} (${row.importance})`] : []),
      ...row.examples.map(
        (example) =>
          `   > ${example.evidence}  (${example.transcript}${example.messageIndex === undefined ? "" : `, message ${example.messageIndex}`})`,
      ),
    ]),
  ].join(EOL)
}

// The AI SDK's validation errors embed the whole reply; keep the first line so a skipped transcript reads clearly.
function describe(error: unknown) {
  const text = error instanceof Error ? error.message : String(error)
  return text.split("\n")[0].slice(0, 200)
}

function trim(text: string, tokens: number) {
  if (Token.estimate(text) <= tokens) return text
  // Token.estimate counts four characters per token.
  return text.slice(0, tokens * 4 - TRIM_MARKER.length) + TRIM_MARKER
}

// Measured on the rendered text, so labels and separators count against the budget too.
function size(piece: Piece) {
  return Token.estimate(render(piece))
}

// A turn too long for one piece is cut into overlapping parts instead of truncated, so nothing the student wrote is lost.
function parts(turn: Turn, budget: number) {
  if (size({ context: [], turns: [turn] }) <= budget) return [turn]
  const chars = (budget - LABEL_TOKENS) * 4
  const texts = windows(turn.text, chars, Math.floor(chars / 10))
  return texts.map((text, i) => ({ ...turn, text: `(part ${i + 1} of ${texts.length}) ${text}` }))
}

// Fixed-size slices of `text` where each slice repeats the last `overlap` characters of the previous one.
function windows(text: string, size: number, overlap: number) {
  const step = size - overlap
  const count = text.length <= size ? 1 : Math.ceil((text.length - size) / step) + 1
  return Array.from({ length: count }, (_, i) => text.slice(i * step, i * step + size))
}

function normalize(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
}

// Compared by position rather than text, so two different messages that read the same are not merged.
function repeats(a: Finding, b: Finding) {
  if (a.messageIndex !== undefined || b.messageIndex !== undefined) return a.messageIndex === b.messageIndex
  return normalize(a.description) === normalize(b.description)
}

export type Llm = Effect.Success<ReturnType<typeof connect>>

export const connect = Effect.fn("Cli.misconceptions.connect")(function* (model: string | undefined) {
  const provider = yield* Provider.Service
  const config = yield* Config.Service
  const ref = model ? Provider.parseModel(model) : yield* provider.defaultModel().pipe(Effect.orDie)
  const resolved = yield* provider
    .getModel(ref.providerID, ref.modelID)
    .pipe(Effect.catchCause(() => fail(`Model not found: ${ref.providerID}/${ref.modelID}`)))
  const language = yield* provider.getLanguage(resolved).pipe(Effect.orDie)
  const cfg = yield* config.get()

  // A model call can fail transiently (network, a malformed reply); retry twice before giving up on the piece.
  const ask = <S extends Schema.Decoder<unknown> & Schema.Top>(schema: S, system: string, prompt: string) =>
    Effect.tryPromise({
      try: async (): Promise<S["Type"]> =>
        (
          await generateObject({
            model: language,
            temperature: 0,
            // Replies are JSON; a reply cut off at a provider's default output limit is unparseable, so ask for the
            // model's full output allowance.
            maxOutputTokens: resolved.limit.output,
            schema: Object.assign(Schema.toStandardSchemaV1(schema), Schema.toStandardJSONSchemaV1(schema)),
            messages: [
              // Providers whose JSON mode is `json_object` (such as DeepSeek) reject prompts that never mention
              // JSON and do not enforce the schema, so the model has to see the exact field names.
              {
                role: "system",
                content: `${system}\nRespond in JSON matching this schema: ${JSON.stringify(ToolJsonSchema.fromSchema(schema))}`,
              },
              { role: "user", content: prompt },
            ],
          })
        ).object,
      catch: (error) => new Error(`model call failed: ${describe(error)}`),
    }).pipe(Effect.retry(Schedule.recurs(2)))

  return {
    ask,
    key: `${ref.providerID}/${ref.modelID}`,
    budget: Math.max(PROMPT_TOKENS, Math.min(usable({ cfg, model: resolved }) || PIECE_TOKENS, PIECE_TOKENS) - PROMPT_TOKENS),
  }
})

export const analyze = Effect.fn("Cli.misconceptions.analyze")(function* (llm: Llm, file: string, cache: string, verify: boolean) {
  const turns = shrink(yield* Effect.promise(() => Bun.file(file).text()))
  if (!turns) return yield* Effect.fail(new Error("not a valid `opencode export` file"))
  // A transcript where the student never wrote anything has nothing to analyze, so it costs no model call.
  if (!turns.some((turn) => turn.role === "user")) return []
  const cached = path.join(
    cache,
    "findings",
    `${Bun.hash(JSON.stringify([CACHE_VERSION, llm.key, verify, turns])).toString(16)}.json`,
  )
  const stored = decodeFindings(yield* Effect.promise(() => Bun.file(cached).text().catch(() => "")))
  if (Option.isSome(stored)) return stored.value.misconceptions

  const found = yield* Effect.forEach(split(turns, llm.budget), (piece) =>
    llm
      .ask(Extraction, EXTRACT_PROMPT, render(piece))
      .pipe(Effect.map((result) => result.misconceptions.map((item) => locate(item, piece)))),
  )
  const candidates = dedupe(found.flat())
  const misconceptions = verify && candidates.length ? yield* check(llm, turns, candidates) : candidates
  yield* Effect.promise(() => Bun.write(cached, JSON.stringify({ misconceptions }, null, 2)))
  return misconceptions
})

// Second pass over one transcript: drop candidates the transcript does not support and ground each survivor's
// severity in what the student actually did, instead of the extraction model's guess.
const check = Effect.fn("Cli.misconceptions.check")(function* (llm: Llm, turns: readonly Turn[], candidates: readonly Finding[]) {
  const transcript = split(turns, llm.budget).map(render).join("\n\n")
  const list = candidates.map((item, id) => `${id}. ${item.description} (quote: "${item.evidence}")`).join("\n")
  const result = yield* llm.ask(Verified, VERIFY_PROMPT, `${transcript}\n\nCandidates:\n${list}`)
  return confirm(candidates, result.kept, turns)
})

/**
 * Apply a verify reply to the candidates: keep each candidate the reply names (first mention wins), record the student
 * messages it cites as export positions, and set depth from the evidence.
 */
export function confirm(
  candidates: readonly Finding[],
  kept: readonly { id: number; cited: readonly number[]; acted: boolean }[],
  turns: readonly Turn[],
): Finding[] {
  const students = turns.filter((turn) => turn.role === "user").map((turn) => turn.index)
  return kept
    .filter((item, i, all) => Number.isInteger(item.id) && item.id >= 0 && item.id < candidates.length && all.findIndex((other) => other.id === item.id) === i)
    .map((item) => {
      const candidate = candidates[item.id]
      const cited = [...new Set([...(candidate.messageIndex === undefined ? [] : [candidate.messageIndex]), ...item.cited.map((n) => n - 1)])]
        .filter((index) => students.includes(index))
        .toSorted((a, b) => a - b)
      return {
        ...candidate,
        messageIndex: cited[0] ?? candidate.messageIndex,
        cited,
        acted: item.acted,
        depth: severity({ cited, acted: item.acted, depth: candidate.depth, turns }),
      }
    })
}

/**
 * Severity: the extraction model's rating, raised to severe when the evidence shows the student repeating the
 * misconception after the assistant had already replied. The verify model's `acted` flag is recorded but not used
 * here: in practice it was set for most findings, since students do things in nearly every session.
 */
export function severity(input: { cited: readonly number[]; acted: boolean; depth: Finding["depth"]; turns: readonly Turn[] }) {
  const first = input.cited[0]
  const last = input.cited.at(-1)
  const repeated =
    input.cited.length >= 2 &&
    first !== undefined &&
    last !== undefined &&
    input.turns.some((turn) => turn.role === "assistant" && turn.index > first && turn.index < last)
  return repeated ? "severe" : input.depth
}

export const outline = Effect.fn("Cli.misconceptions.outline")(function* (llm: Llm, course: string, cache: string) {
  // Saved outlines are reused as-is so a TA can correct topic importance by editing the file.
  const saved = path.join(cache, "topics.json")
  const existing = decodeTopics(yield* Effect.promise(() => Bun.file(saved).text().catch(() => "")))
  if (Option.isSome(existing)) {
    process.stderr.write(`Using course topics from ${saved} (delete it to regenerate)${EOL}`)
    return existing.value.topics
  }

  const directory = yield* Effect.tryPromise(() => Bun.file(course).stat().then((stat) => stat.isDirectory())).pipe(
    Effect.catchCause(() => fail(`Course material not found: ${course}`)),
  )
  const files = directory
    ? (yield* Effect.promise(() => Array.fromAsync(new Bun.Glob("**/*.{md,txt}").scan({ cwd: course })))).map(
        (file) => path.join(course, file),
      )
    : [course]
  if (files.length === 0) return yield* fail(`No .md or .txt course material found in ${course}`)
  const material = yield* Effect.forEach(files.toSorted(), (file) =>
    Effect.promise(() => Bun.file(file).text()).pipe(Effect.map((text) => `# ${path.basename(file)}\n\n${text}`)),
  )
  const text = material.join("\n\n")
  if (Token.estimate(text) > llm.budget)
    return yield* fail(`Course material is too large for one request (${Token.estimate(text)} tokens); pass a syllabus or summary instead`)

  const result = yield* llm
    .ask(Topics, OUTLINE_PROMPT, text)
    .pipe(Effect.catchCause((cause) => fail(`Could not outline course material: ${Cause.pretty(cause)}`)))
  yield* Effect.promise(() => Bun.write(saved, JSON.stringify(result, null, 2)))
  process.stderr.write(`Saved course topics to ${saved}; edit it to adjust importance${EOL}`)
  return result.topics
})

export const merge = Effect.fn("Cli.misconceptions.merge")(function* (
  llm: Llm,
  findings: readonly Finding[],
  topics: readonly Topic[] | undefined,
) {
  const prompt = [
    topics ? `Course topics:\n${topics.map((topic) => `- ${topic.name}`).join("\n")}` : "No course topic list given.",
    `Misconceptions:\n${findings.map((item, id) => `${id}. ${item.description}`).join("\n")}`,
  ].join("\n\n")
  if (Token.estimate(prompt) > llm.budget)
    return yield* fail(`Too many findings to group in one request (${findings.length}); analyze fewer transcripts at a time`)
  const result = yield* llm
    .ask(Categories, MERGE_PROMPT, prompt)
    .pipe(Effect.catchCause((cause) => fail(`Could not group misconceptions: ${Cause.pretty(cause)}`)))
  return result.categories
})
