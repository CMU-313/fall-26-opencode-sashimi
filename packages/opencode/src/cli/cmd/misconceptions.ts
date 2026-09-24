import { generateObject, streamObject } from "ai"
import { Cause, Effect, Option, Schema } from "effect"
import path from "path"
import { EOL } from "os"
import { Token } from "@opencode-ai/core/util/token"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { usable } from "@/session/overflow"
import { ToolJsonSchema } from "@/tool/json-schema"
import { effectCmd, fail } from "../effect-cmd"

// Assistant replies only give context for the student's side, so keep a short prefix of each.
const ASSISTANT_TOKENS = 300
// Consecutive pieces of a long transcript share their last turns, so a question and its
// follow-up are never split apart.
const OVERLAP_TURNS = 2
// Upper bound per extraction call; very long inputs lose detail even when the model accepts them.
const PIECE_TOKENS = 60_000
// Room left for the system prompt and instructions around each piece.
const PROMPT_TOKENS = 2_000
const CONCURRENCY = 4
// Bump when the extraction prompt or schema changes so cached findings are recomputed.
const CACHE_VERSION = 1
const TRIM_MARKER = " …[trimmed]"

export const DEPTH_WEIGHT = { mild: 1, moderate: 2, severe: 3 }
export const IMPORTANCE_WEIGHT = { core: 3, supporting: 2, peripheral: 1, uncovered: 1 }

const Depth = Schema.Literals(["mild", "moderate", "severe"])
const Importance = Schema.Literals(["core", "supporting", "peripheral"])

const Finding = Schema.Struct({
  description: Schema.String,
  evidence: Schema.String,
  depth: Depth,
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
- depth: how confused the student was here. mild = brief slip or quickly corrected; moderate = needed explanation; severe = stuck across several turns or built work on the wrong idea.
Do not group, rank, or merge items. Return an empty list if there are none.`

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
      .option("raw", {
        describe: "send files that are not valid `opencode export` output to the model as plain text instead of skipping them",
        type: "boolean",
      }),
  handler: Effect.fn("Cli.misconceptions")(function* (args) {
    const dir = path.resolve(args.dir)
    const files = yield* Effect.promise(() => Array.fromAsync(new Bun.Glob("*.json").scan({ cwd: dir })))
    if (files.length === 0) return yield* fail(`No .json session exports found in ${dir}`)

    const llm = yield* connect(args.model)
    const cache = path.join(dir, ".misconceptions")
    const topics = args.course ? yield* outline(llm, path.resolve(args.course), cache) : undefined

    const results = yield* Effect.forEach(
      files.toSorted(),
      (file, i) =>
        analyze(llm, path.join(dir, file), cache, args.raw ?? false).pipe(
          Effect.map((result) => ({ file, findings: result.misconceptions, raw: result.raw, error: undefined })),
          Effect.catchCause((cause) =>
            Effect.succeed({ file, findings: [], raw: false, error: Cause.pretty(cause) }),
          ),
          Effect.tap(() => Effect.sync(() => process.stderr.write(`[${i + 1}/${files.length}] ${file}${EOL}`))),
        ),
      { concurrency: CONCURRENCY },
    )

    const allFindings = results.flatMap((result) =>
      result.findings.map((item) => ({ ...item, transcript: result.file })),
    )
    const categories = allFindings.length ? yield* merge(llm, allFindings, topics) : []
    const rows = rank({ findings: allFindings, categories, topics })
    const skipped = results.filter((result) => result.error !== undefined)
    const raw = results.filter((result) => result.raw).map((result) => result.file)

    if (args.json) {
      process.stdout.write(
        JSON.stringify({ transcripts: results.length - skipped.length, rows, raw, skipped }, null, 2) + EOL,
      )
      return
    }
    process.stdout.write(table(rows, results.length - skipped.length) + EOL)
    raw.forEach((file) => process.stderr.write(`Read ${file} as raw text: not a valid \`opencode export\` file${EOL}`))
    skipped.forEach((item) => process.stderr.write(`Skipped ${item.file}: ${item.error.split(EOL)[0]}${EOL}`))
  }),
})

export type Turn = { role: "user" | "assistant"; text: string }

/** Reduce an `opencode export` file to the text of each turn, or undefined if it is not a valid export. */
export function shrink(json: string) {
  const file = decodeExport(json)
  if (Option.isNone(file)) return undefined
  return file.value.messages.flatMap((message): Turn[] => {
    const text = message.parts
      .filter((part) => part.type === "text" && !part.synthetic && !part.ignored)
      .map((part) => part.text ?? "")
      .join("\n")
      .trim()
    if (!text) return []
    return [{ role: message.info.role, text: message.info.role === "assistant" ? trim(text, ASSISTANT_TOKENS) : text }]
  })
}

/** Split turns into pieces of at most `budget` tokens, cutting only between turns and overlapping consecutive pieces. */
export function split(turns: Turn[], budget: number) {
  return turns
    .map((turn) => ({ ...turn, text: trim(turn.text, budget) }))
    .reduce<Turn[][]>((pieces, turn) => {
      const current = pieces.at(-1)
      if (current && size([...current, turn]) <= budget) {
        current.push(turn)
        return pieces
      }
      const overlap = current?.slice(-OVERLAP_TURNS) ?? []
      pieces.push(size([...overlap, turn]) <= budget ? [...overlap, turn] : [turn])
      return pieces
    }, [])
}

/** Drop repeated findings within one transcript, such as those seen twice in overlapping pieces, keeping the deepest. */
export function dedupe(findings: readonly Finding[]) {
  const unique = new Map<string, Finding>()
  findings.forEach((item) => {
    const key = item.description.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
    const existing = unique.get(key)
    if (!existing || DEPTH_WEIGHT[item.depth] > DEPTH_WEIGHT[existing.depth]) unique.set(key, item)
  })
  return [...unique.values()]
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
          .map((item) => item.evidence),
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
      ...row.examples.map((example) => `   > ${example}`),
    ]),
  ].join(EOL)
}

function trim(text: string, tokens: number) {
  if (Token.estimate(text) <= tokens) return text
  // Token.estimate counts four characters per token.
  return text.slice(0, tokens * 4 - TRIM_MARKER.length) + TRIM_MARKER
}

function size(turns: readonly Turn[]) {
  return turns.reduce((sum, turn) => sum + Token.estimate(turn.text), 0)
}

function render(turns: readonly Turn[]) {
  return turns.map((turn) => `${turn.role === "user" ? "STUDENT" : "ASSISTANT"}: ${turn.text}`).join("\n\n")
}

type Llm = Effect.Success<ReturnType<typeof connect>>

const connect = Effect.fn("Cli.misconceptions.connect")(function* (model: string | undefined) {
  const provider = yield* Provider.Service
  const auth = yield* Auth.Service
  const config = yield* Config.Service
  const ref = model ? Provider.parseModel(model) : yield* provider.defaultModel().pipe(Effect.orDie)
  const resolved = yield* provider
    .getModel(ref.providerID, ref.modelID)
    .pipe(Effect.catchCause(() => fail(`Model not found: ${ref.providerID}/${ref.modelID}`)))
  const language = yield* provider.getLanguage(resolved).pipe(Effect.orDie)
  const cfg = yield* config.get()
  // OpenAI OAuth (ChatGPT plans) rejects system messages; instructions go in provider options instead.
  const oauth = ref.providerID === "openai" && (yield* auth.get(ref.providerID).pipe(Effect.orDie))?.type === "oauth"

  const ask = <S extends Schema.Decoder<unknown> & Schema.Top>(schema: S, system: string, prompt: string) =>
    Effect.tryPromise(async (): Promise<S["Type"]> => {
      const params = {
        model: language,
        temperature: 0,
        schema: Object.assign(Schema.toStandardSchemaV1(schema), Schema.toStandardJSONSchemaV1(schema)),
        messages: [
          // Providers whose JSON mode is `json_object` (such as DeepSeek) reject prompts that never mention
          // JSON and do not enforce the schema, so the model has to see the exact field names.
          ...(oauth
            ? []
            : [
                {
                  role: "system" as const,
                  content: `${system}\nRespond in JSON matching this schema: ${JSON.stringify(ToolJsonSchema.fromSchema(schema))}`,
                },
              ]),
          { role: "user" as const, content: prompt },
        ],
      }
      if (!oauth) return (await generateObject(params)).object
      const result = streamObject({
        ...params,
        providerOptions: ProviderTransform.providerOptions(resolved, { instructions: system, store: false }),
        onError: () => {},
      })
      for await (const part of result.fullStream) {
        if (part.type === "error") throw part.error
      }
      return result.object
    })

  return {
    ask,
    key: `${ref.providerID}/${ref.modelID}`,
    budget: Math.max(PROMPT_TOKENS, Math.min(usable({ cfg, model: resolved }) || PIECE_TOKENS, PIECE_TOKENS) - PROMPT_TOKENS),
  }
})

const analyze = Effect.fn("Cli.misconceptions.analyze")(function* (
  llm: Llm,
  file: string,
  cache: string,
  raw: boolean,
) {
  const text = yield* Effect.promise(() => Bun.file(file).text())
  const turns = shrink(text)
  if (!turns && !raw) return yield* Effect.fail(new Error("not a valid `opencode export` file"))
  // Raw files have no turn boundaries, so they are cut into fixed-size chunks (Token.estimate counts four characters per token).
  const chunk = llm.budget * 4
  const pieces = turns
    ? split(turns, llm.budget).map(render)
    : Array.from(
        { length: Math.ceil(text.trim().length / chunk) },
        (_, i) =>
          `The transcript below is a raw file in an unrecognized format. Work out which lines the student wrote.\n\n${text.trim().slice(i * chunk, (i + 1) * chunk)}`,
      )
  const cached = path.join(
    cache,
    "findings",
    `${Bun.hash(JSON.stringify([CACHE_VERSION, llm.key, turns ?? text])).toString(16)}.json`,
  )
  const hit = yield* Effect.promise(() => Bun.file(cached).text().catch(() => ""))
  const stored = decodeFindings(hit)
  if (Option.isSome(stored)) return { misconceptions: stored.value.misconceptions, raw: !turns }

  const found = yield* Effect.forEach(pieces, (piece) => llm.ask(Findings, EXTRACT_PROMPT, piece))
  const misconceptions = dedupe(found.flatMap((item) => item.misconceptions))
  yield* Effect.promise(() => Bun.write(cached, JSON.stringify({ misconceptions }, null, 2)))
  return { misconceptions, raw: !turns }
})

const outline = Effect.fn("Cli.misconceptions.outline")(function* (llm: Llm, course: string, cache: string) {
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

const merge = Effect.fn("Cli.misconceptions.merge")(function* (
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
