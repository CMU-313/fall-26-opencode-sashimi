
import { describe, expect } from "bun:test"
import fc from "fast-check"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "../../src/background/job"
import { Command } from "../../src/command"
import { Config } from "../../src/config/config"
import { Database } from "@opencode-ai/core/database/database"
import { Env } from "../../src/env"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"
import { Instruction } from "../../src/session/instruction"
import { LLM } from "../../src/session/llm"
import { LSP } from "../../src/lsp/lsp"
import { MCP } from "../../src/mcp"
import { MessageV2 } from "../../src/session/message-v2"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { Question } from "../../src/question"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Session } from "../../src/session/session"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { Skill } from "../../src/skill"
import { Snapshot } from "../../src/snapshot"
import { SystemPrompt } from "../../src/session/system"
import { Todo } from "../../src/session/todo"
import { ToolRegistry } from "../../src/tool/registry"
import { Truncate } from "../../src/tool/truncate"
import { Format } from "../../src/format"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import PROMPT_AUTONAME from "../../src/command/template/autoname.txt"

// Test dependency graph using the repository's real Effect services
// and a controlled local LLM server.
const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

function makeMcp(instructions: MCP.ServerInstructions[] = []) {
  return Layer.succeed(
    MCP.Service,
    MCP.Service.of({
      status: () => Effect.succeed({}),
      clients: () => Effect.succeed({}),
      instructions: () => Effect.succeed(instructions),
      tools: () => Effect.succeed({}),
      prompts: () => Effect.succeed({}),
      resources: () => Effect.succeed({}),
      resourceTemplates: () => Effect.succeed({}),
      add: () =>
        Effect.succeed({
          status: { status: "disabled" as const },
        }),
      connect: () => Effect.void,
      disconnect: () => Effect.void,
      getPrompt: () => Effect.succeed(undefined),
      readResource: () => Effect.succeed(undefined),
      startAuth: () =>
        Effect.die("unexpected MCP auth in prompt-effect tests"),
      authenticate: () =>
        Effect.die("unexpected MCP auth in prompt-effect tests"),
      finishAuth: () =>
        Effect.die("unexpected MCP auth in prompt-effect tests"),
      removeAuth: () => Effect.void,
      supportsOAuth: () => Effect.succeed(false),
      hasStoredTokens: () => Effect.succeed(false),
      getAuthStatus: () =>
        Effect.succeed("not_authenticated" as const),
    }),
  )
}

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const root = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  Snapshot.node,
  LLM.node,
  Env.node,
  Agent.node,
  Command.node,
  Permission.node,
  Plugin.node,
  Config.node,
  Provider.node,
  LSP.node,
  MCP.node,
  FSUtil.node,
  BackgroundJob.node,
  SessionStatus.node,
  SessionRunState.node,
  Database.node,
  EventV2Bridge.node,
  Question.node,
  Todo.node,
  ToolRegistry.node,
  Skill.node,
  Git.node,
  Ripgrep.node,
  Format.node,
  Truncate.node,
  SessionProcessor.node,
  Image.node,
  SessionCompaction.node,
  SessionRevert.node,
  Instruction.node,
  SystemPrompt.node,
  CrossSpawnSpawner.node,
  RuntimeFlags.node,
  LayerNode.make({
    service: TestLLMServer,
    layer: TestLLMServer.layer,
    deps: [],
  }),
])

const testLayer = LayerNode.compile(root, [
  [SessionSummary.node, summary],
  [LSP.node, lsp],
  [MCP.node, makeMcp()],
  [
    RuntimeFlags.node,
    RuntimeFlags.layer({ experimentalEventSystem: true }),
  ],
])

const it = testEffect(testLayer)

const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

// Property-based generators
const word = fc.stringMatching(/^[a-z]{2,10}$/)

const titleArb = fc
  .array(word, { minLength: 2, maxLength: 5 })
  .map((words) => words.join(" "))

const historyArb = fc.array(
  fc.string({ minLength: 1, maxLength: 60 }),
  { minLength: 1, maxLength: 4 },
)

// Execute the real /autoname command on a new session.
const runAutoname = (response: string, history: string[]) =>
  Effect.gen(function* () {
    const llm = yield* TestLLMServer
    const config = yield* Config.Service
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const { directory } = yield* TestInstance
    const fs = yield* FSUtil.Service

    yield* fs.writeWithDirs(
      `${directory}/opencode.json`,
      JSON.stringify({
        ...cfg,
        provider: {
          ...cfg.provider,
          test: {
            ...cfg.provider.test,
            options: {
              ...cfg.provider.test.options,
              baseURL: llm.url,
            },
          },
        },
      }),
    )

    yield* config.get()

    const session = yield* sessions.create({
      title: "Original session title",
    })

    for (const content of history) {
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: content }],
      })
    }

    const before = yield* sessions.messages({
      sessionID: session.id,
    })

    const sessionBefore = yield* sessions.get(session.id)
    const modelBefore = sessionBefore.model
    const agentBefore = sessionBefore.agent

    yield* llm.text(response)

    const result = yield* prompt.command({
      sessionID: session.id,
      command: "autoname",
      arguments: "",
      model: "test/test-model",
    })

    const after = yield* sessions.get(session.id)
    const messages = yield* sessions.messages({
      sessionID: session.id,
    })

    // Verify that all preexisting messages remain unchanged.
    const oldById = new Map(
      messages.map((m) => [m.info.id, m]),
    )

    for (const message of before) {
      expect(oldById.get(message.info.id)).toEqual(message)
    }

    expect(after.model).toEqual(modelBefore)
    expect(after.agent).toEqual(agentBefore)
    expect(result.info.role).toBe("assistant")

    return {
      title: after.title,
      response: result.parts,
      agentBefore,
      agentAfter: after.agent,
      modelBefore,
      modelAfter: after.model,
      messagesBefore: before,
      messagesAfter: messages,
    }
  })

// Run /autoname twice on the SAME session.
const runAutonameTwice = (first: string, second: string) =>
  Effect.gen(function* () {
    const llm = yield* TestLLMServer
    const config = yield* Config.Service
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const { directory } = yield* TestInstance
    const fs = yield* FSUtil.Service

    yield* fs.writeWithDirs(
      `${directory}/opencode.json`,
      JSON.stringify({
        ...cfg,
        provider: {
          ...cfg.provider,
          test: {
            ...cfg.provider.test,
            options: {
              ...cfg.provider.test.options,
              baseURL: llm.url,
            },
          },
        },
      }),
    )

    yield* config.get()

    const session = yield* sessions.create({
      title: "Original session title",
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [
        {
          type: "text",
          text: "Help me refactor authentication code",
        },
      ],
    })

    // First rename
    yield* llm.text(`RENAMED: ${first}`)

    yield* prompt.command({
      sessionID: session.id,
      command: "autoname",
      arguments: "",
      model: "test/test-model",
    })

    const firstSaved = (
      yield* sessions.get(session.id)
    ).title

    // Second rename
    yield* llm.text(`RENAMED: ${second}`)

    yield* prompt.command({
      sessionID: session.id,
      command: "autoname",
      arguments: "",
      model: "test/test-model",
    })

    const secondSaved = (
      yield* sessions.get(session.id)
    ).title

    return { firstSaved, secondSaved }
  })


describe("/autoname: real command with controlled LLM responses", () => {
  // PROPERTY 1: Command registration
  // The /autoname command must be registered with the correct
  // prompt, source, and title-format instructions.
  it.instance(
    "P1 - Registration: autoname is registered with the correct prompt",
    () =>
      Effect.gen(function* () {
        const commands = yield* Command.Service
        const info = yield* commands.get("autoname")

        expect(info?.source).toBe("command")
        expect(info?.template).toBe(PROMPT_AUTONAME)
        expect(PROMPT_AUTONAME).toContain("2-5 words")
        expect(PROMPT_AUTONAME).toContain("RENAMED:")
      }),
  )

  // PROPERTY 2: Title persistence
  // For any valid 2-5 word title returned by the test LLM,
  // /autoname must save exactly that title in the session.
  it.instance(
    "P2 - Persistence: valid model-provided titles are saved correctly",
    () =>
      Effect.gen(function* () {
        const cases = fc.sample(
          fc.tuple(titleArb, historyArb),
          { numRuns: 12, seed: 313 },
        )

        for (const [title, history] of cases) {
          const actual = yield* runAutoname(
            `RENAMED: ${title}`,
            history,
          )

          expect(actual.title).toBe(title)
        }
      }),
    120_000,
  )

  // PROPERTY 3: Extra-output tolerance
  // Adding an explanation after a valid RENAMED line should
  // not change the title saved by /autoname.
  // Pattern: Metamorphic testing.
  it.instance(
    "P3 - Metamorphic: extra output after the title does not change it",
    () =>
      Effect.gen(function* () {
        const titles = fc.sample(titleArb, {
          numRuns: 6,
          seed: 210,
        })

        for (const title of titles) {
          const actual = yield* runAutoname(
            `RENAMED: ${title}\nExtra explanation`,
            ["Discussing code"],
          )

          expect(actual.title).toBe(title)
        }
      }),
    90_000,
  )

  // PROPERTY 4: Invalid response handling
  // If the model response does not contain RENAMED:,
  // the original session title should remain unchanged.
  // Pattern: Invariant / negative testing.
  it.instance(
    "P4 - Invariant: missing RENAMED marker preserves original title",
    () =>
      Effect.gen(function* () {
        const titles = fc.sample(titleArb, {
          numRuns: 6,
          seed: 251,
        })

        for (const title of titles) {
          const actual = yield* runAutoname(
            `TITLE: ${title}`,
            ["Discussing code"],
          )

          expect(actual.title).toBe(
            "Original session title",
          )
        }
      }),
    90_000,
  )


  // PROPERTY R2: Title length restriction
  // Every generated title must contain fewer than 5 words.
  // Pattern: Invariant / boundary testing.
  it.instance(
    "R2 - Invariant: generated title contains fewer than 5 words",
    () =>
      Effect.gen(function* () {
        const titles = fc.sample(
          fc.array(word, {
            minLength: 1,
            maxLength: 8,
          }).map((words) => words.join(" ")),
          { numRuns: 12, seed: 207 },
        )

        for (const title of titles) {
          const actual = yield* runAutoname(
            `RENAMED: ${title}`,
            ["Help me improve my code"],
          )

          const wordCount = actual.title
            .trim()
            .split(/\s+/)
            .length

          expect(wordCount).toBeLessThan(6)
        }
      }),
    120_000,
  )


  // PROPERTY R3: Conversation relevance
  // A title should share at least one word with the conversation.
  // This test checks the overlap of a deliberately relevant
  // model-provided title, not whether the LLM creates relevance.
  it.instance(
    "R3 - Invariant: saved title shares a word with conversation history",
    () =>
      Effect.gen(function* () {
        const cases = fc.sample(
          fc.tuple(word, word, word),
          { numRuns: 8, seed: 308 },
        )

        for (const [topic, action, other] of cases) {
          const history = [
            `Please help me with ${topic}`,
            `We need to ${action} the ${topic}`,
          ]

          const expectedTitle = `${topic} ${other}`

          const actual = yield* runAutoname(
            `RENAMED: ${expectedTitle}`,
            history,
          )

          const historyWords = new Set(
            history
              .join(" ")
              .toLowerCase()
              .match(/[a-z]+/g) ?? [],
          )

          const titleWords =
            actual.title.toLowerCase().match(/[a-z]+/g) ?? []

          expect(actual.title).toBe(expectedTitle)

          expect(
            titleWords.some((w) => historyWords.has(w)),
          ).toBe(true)
        }
      }),
    120_000,
  )

  // PROPERTY R4: Repeated renaming
  // Running /autoname a second time on the same session
  // should allow the new title to replace the previous title.
  // Pattern: Algebraic / sequential testing.
  it.instance(
    "R4 - Algebraic: second autoname execution replaces first title",
    () =>
      Effect.gen(function* () {
        const pairs = fc.sample(
          fc.tuple(titleArb, titleArb).filter(
            ([a, b]) => a !== b,
          ),
          { numRuns: 5, seed: 404 },
        )

        for (const [first, second] of pairs) {
          const actual = yield* runAutonameTwice(
            first,
            second,
          )

          expect(actual.firstSaved).toBe(first)
          expect(actual.secondSaved).toBe(second)

          expect(actual.secondSaved).not.toBe(
            actual.firstSaved,
          )

          expect(actual.secondSaved).not.toBe(
            "Original session title",
          )
        }
      }),
    120_000,
  )

  // PROPERTY R5: Session state preservation
  // Running /autoname must not modify preexisting messages,
  // the session agent, or the session model.
  // Pattern: Invariant testing.
  it.instance(
    "R5 - Invariant: existing messages, agent, and model are preserved",
    () =>
      Effect.gen(function* () {
        const cases = fc.sample(
          fc.tuple(titleArb, historyArb),
          { numRuns: 8, seed: 503 },
        )

        for (const [title, history] of cases) {
          const actual = yield* runAutoname(
            `RENAMED: ${title}`,
            history,
          )

          const afterById = new Map(
            actual.messagesAfter.map(
              (m) => [m.info.id, m],
            ),
          )

          for (const previous of actual.messagesBefore) {
            expect(
              afterById.get(previous.info.id),
            ).toEqual(previous)
          }

          expect(actual.agentAfter).toEqual(
            actual.agentBefore,
          )

          expect(actual.modelAfter).toEqual(
            actual.modelBefore,
          )
        }
      }),
    120_000,
  )
})
