import { generateObject } from "ai"
import { Cause, Effect, Option, Schema } from "effect"
import path from "path"
import { EOL } from "os"
import { Token } from "@opencode-ai/core/util/token"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { usable } from "@/session/overflow"
import { ToolJsonSchema } from "@/tool/json-schema"
import { effectCmd, fail } from "../effect-cmd"

// Assistant replies only give context for the student's side, so keep a short prefix of each.
const ASSISTANT_TOKENS = 300
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
const CACHE_VERSION = 1
const TRIM_MARKER = " …[trimmed]"

const Depth = Schema.Literals(["mild", "moderate", "severe"])

const Finding = Schema.Struct({
  description: Schema.String,
  evidence: Schema.String,
  depth: Depth,
})
export type Finding = typeof Finding.Type

const Findings = Schema.Struct({ misconceptions: Schema.Array(Finding) })

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

const EXTRACT_PROMPT = `You review a conversation between a student and an AI coding assistant in a software engineering course.
List every misconception, knowledge gap, or point of confusion the student shows about course material: software engineering concepts, tools, languages, and practices.
Be inclusive: wrong beliefs, missing knowledge, and repeated struggles with the same idea all count. Do not list confusion about how to operate the AI assistant itself.
For each one give:
- description: one sentence stating what the student misunderstood, in general terms that would apply to other students with the same confusion.
- evidence: a short direct quote from the student that shows it.
- depth: how confused the student was here. mild = brief slip or quickly corrected; moderate = needed explanation; severe = stuck across several turns or built work on the wrong idea.
Messages listed as earlier context were already reviewed; only report misconceptions shown in the messages to review.
Do not group, rank, or merge items. Return an empty list if there are none.`

export const MisconceptionsCommand = effectCmd({
  command: "misconceptions <dir>",
  describe: "list student misconceptions in exported sessions",
  builder: (yargs) =>
    yargs
      .positional("dir", {
        describe: "directory of session JSON files from `opencode export`",
        type: "string",
        demandOption: true,
      })
      .option("model", {
        describe: "model to use in the format of provider/model",
        type: "string",
      })
      .option("json", {
        describe: "print results as JSON",
        type: "boolean",
      }),
  handler: Effect.fn("Cli.misconceptions")(function* (args) {
    const dir = path.resolve(args.dir)
    const files = yield* Effect.promise(() => Array.fromAsync(new Bun.Glob("*.json").scan({ cwd: dir })))
    if (files.length === 0) return yield* fail(`No .json session exports found in ${dir}`)

    const llm = yield* connect(args.model)
    const cache = path.join(dir, ".misconceptions")

    const results = yield* Effect.forEach(
      files.toSorted(),
      (file, i) =>
        analyze(llm, path.join(dir, file), cache).pipe(
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

    const analyzed = results.filter((result) => result.error === undefined)

    if (args.json) {
      process.stdout.write(
        JSON.stringify(
          { transcripts: analyzed.map((result) => ({ file: result.file, misconceptions: result.findings })), skipped },
          null,
          2,
        ) + EOL,
      )
      return
    }
    process.stdout.write(report(analyzed) + EOL)
    skipped.forEach((item) => process.stderr.write(`Skipped ${item.file}: ${item.error.split(EOL)[0]}${EOL}`))
  }),
})

export type Turn = { role: "user" | "assistant"; text: string }
export type Piece = { context: Turn[]; turns: Turn[] }

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

/**
 * Split turns into pieces whose rendered text fits in `budget` tokens. Pieces cut between turns and begin with the
 * previous piece's last turns as context. A turn too long for one piece becomes overlapping parts.
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

/** Render a piece for the model, with the turns carried over from the previous piece under their own heading. */
export function render(piece: Piece) {
  const review = label(piece.turns)
  if (piece.context.length === 0) return review
  const context = label(piece.context)
  return `Earlier messages, for context only:\n\n${context}\n\nMessages to review:\n\n${review}`
}

/** One block per transcript listing its misconceptions, deepest first. */
export function report(results: readonly { file: string; findings: readonly Finding[] }[]) {
  if (results.length === 0) return "No transcripts analyzed."
  const order = { severe: 0, moderate: 1, mild: 2 }
  return results
    .flatMap((result) => [
      `${result.file}: ${result.findings.length} misconception(s)`,
      ...result.findings
        .toSorted((a, b) => order[a.depth] - order[b.depth])
        .flatMap((item) => [`  - [${item.depth}] ${item.description}`, `    > ${item.evidence}`]),
      "",
    ])
    .join(EOL)
    .trimEnd()
}

function trim(text: string, tokens: number) {
  if (Token.estimate(text) <= tokens) return text
  // Token.estimate counts four characters per token.
  return text.slice(0, tokens * 4 - TRIM_MARKER.length) + TRIM_MARKER
}

function label(turns: readonly Turn[]) {
  return turns.map((turn) => `${turn.role === "user" ? "STUDENT" : "ASSISTANT"}: ${turn.text}`).join("\n\n")
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

type Llm = Effect.Success<ReturnType<typeof connect>>

const connect = Effect.fn("Cli.misconceptions.connect")(function* (model: string | undefined) {
  const provider = yield* Provider.Service
  const config = yield* Config.Service
  const ref = model ? Provider.parseModel(model) : yield* provider.defaultModel().pipe(Effect.orDie)
  const resolved = yield* provider
    .getModel(ref.providerID, ref.modelID)
    .pipe(Effect.catchCause(() => fail(`Model not found: ${ref.providerID}/${ref.modelID}`)))
  const language = yield* provider.getLanguage(resolved).pipe(Effect.orDie)
  const cfg = yield* config.get()

  const ask = <S extends Schema.Decoder<unknown> & Schema.Top>(schema: S, system: string, prompt: string) =>
    Effect.tryPromise(
      async (): Promise<S["Type"]> =>
        (
          await generateObject({
            model: language,
            temperature: 0,
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
    )

  return {
    ask,
    key: `${ref.providerID}/${ref.modelID}`,
    budget: Math.max(PROMPT_TOKENS, Math.min(usable({ cfg, model: resolved }) || PIECE_TOKENS, PIECE_TOKENS) - PROMPT_TOKENS),
  }
})

const analyze = Effect.fn("Cli.misconceptions.analyze")(function* (llm: Llm, file: string, cache: string) {
  const turns = shrink(yield* Effect.promise(() => Bun.file(file).text()))
  if (!turns) return yield* Effect.fail(new Error("not a valid `opencode export` file"))
  const cached = path.join(
    cache,
    "findings",
    `${Bun.hash(JSON.stringify([CACHE_VERSION, llm.key, turns])).toString(16)}.json`,
  )
  const stored = decodeFindings(yield* Effect.promise(() => Bun.file(cached).text().catch(() => "")))
  if (Option.isSome(stored)) return stored.value.misconceptions

  const found = yield* Effect.forEach(split(turns, llm.budget), (piece) =>
    llm.ask(Findings, EXTRACT_PROMPT, render(piece)),
  )
  const misconceptions = found.flatMap((item) => item.misconceptions)
  yield* Effect.promise(() => Bun.write(cached, JSON.stringify({ misconceptions }, null, 2)))
  return misconceptions
})
