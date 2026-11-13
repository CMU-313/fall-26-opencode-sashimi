// Property-based tests for hint mode (P4/P5, hzoccoli).
// Each property names the requirement it checks (see traceability/hzoccoli.md).
//
// The opencode test script runs with --only-failures, which hides passing tests
// in the CI log. Each test prints one line after fast-check finishes so the log
// shows that every property actually ran and how many inputs it checked.
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer, Sink } from "effect"
import fc from "fast-check"
import { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Session } from "../../src/session/session"
import { SessionReminders } from "../../src/session/reminders"
import { Skill } from "../../src/skill"
import PROMPT_HINT from "../../src/session/prompt/hint.txt"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { withTmpdirInstance } from "../fixture/fixture"

// Fixed seed so Stryker runs are reproducible (P5). Same seed recorded in
// traceability/hzoccoli.md under Stryker comparison.
fc.configureGlobal({ seed: 42 })

function report(id: string, kind: string, runs: number) {
  console.log(`[hint properties] ${id} (${kind}): passed ${runs} generated cases`)
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const level = fc.integer({ min: 1, max: 5 })
const storedLevel = fc.integer({ min: -3, max: 12 })
const messageId = fc
  .stringMatching(/^[a-z0-9_-]{1,24}$/)
  .map((s) => `msg_hint_${s}`)

const distinctMessages = fc.uniqueArray(messageId, { minLength: 1, maxLength: 8 })

const action = fc.constantFrom("allow", "ask", "deny") as fc.Arbitrary<"allow" | "ask" | "deny">

// User configs that try to turn file changes back on, plus a few other tools
// so the real hint agent merge sees more than just the three hint denies.
const userPermissionConfig = fc.record({
  edit: action,
  bash: action,
  task: action,
  read: action,
  question: action,
})

// ---------------------------------------------------------------------------
// Shared helpers for apply()-based properties
// ---------------------------------------------------------------------------

const filesystem = Layer.mock(FSUtil.Service)({
  "~effect/platform/FileSystem": "~effect/platform/FileSystem",
  sink: () => Sink.drain,
  globMatch: () => false,
})

function layerWithSave(
  onSave: (input: { sessionID: string; metadata: { hintLevel?: number; hintMessageID?: string } }) => void,
) {
  return Layer.mergeAll(
    RuntimeFlags.layer(),
    filesystem,
    Layer.mock(Session.Service)({
      setMetadata: (input: { sessionID: string; metadata: { hintLevel?: number; hintMessageID?: string } }) => {
        onSave(input)
        return Effect.void
      },
    }),
  )
}

function userMessage(id: string, agent = "hint"): SessionV1.WithParts {
  return {
    info: {
      id,
      sessionID: "ses_hint",
      role: "user",
      time: { created: 0 },
      agent,
      model: { providerID: "test", modelID: "test" },
    },
    parts: [{ id: `prt_${id}`, sessionID: "ses_hint", messageID: id, type: "text", text: "stuck" }],
  } as SessionV1.WithParts
}

function hintText(messages: SessionV1.WithParts[]) {
  const part = messages.at(-1)?.parts.find((item) => item.type === "text" && item.synthetic)
  if (part?.type !== "text") return
  return part.text
}

async function applyHint(session: Session.Info, messageID: string) {
  let saved: { sessionID: string; metadata: { hintLevel?: number; hintMessageID?: string } } | undefined
  const messages = await Effect.runPromise(
    SessionReminders.apply({
      messages: [userMessage(messageID)],
      agent: { name: "hint" } as Agent.Info,
      session,
    }).pipe(
      Effect.provide(
        layerWithSave((input) => {
          saved = input
        }),
      ),
    ),
  )
  // P5 strengthening: assert the persisted metadata, not only the in-memory
  // session copy. Otherwise emptying setMetadata({...}) still passes.
  expect(saved?.metadata.hintLevel).toBe(session.metadata?.hintLevel)
  expect(saved?.metadata.hintMessageID).toBe(messageID)
  return messages
}

// Oracle for the visible label: same clamp the production label() uses.
function expectedLabel(raw?: number) {
  const shown = typeof raw === "number" ? Math.min(Math.max(raw, 1), 5) : 1
  return `Hint level ${shown} of 5`
}

// Real Agent service so R4 reads production hint denies from agent.ts (kills H4).
const agentLayer = LayerNode.compile(
  LayerNode.group([Agent.node, Plugin.node, Provider.node, Auth.node, Config.node, Skill.node, RuntimeFlags.node]),
)
const agentIt = testEffect(agentLayer)

afterEach(async () => {
  await disposeAllInstances()
})

describe("hint properties", () => {
  // R1 (invariant): A hint never gives the full solution or writes the code,
  // at any level.
  test("R1: every level withholds the solution and has no code fence at level 1", () => {
    const runs = 100
    fc.assert(
      fc.property(level, (n) => {
        const text = PROMPT_HINT.replaceAll("${level}", String(n))
        expect(text).toContain("Do not reveal the full solution")
        expect(text).toContain("Do not write the code that solves the task")
        expect(text).toContain(`Follow only level ${n}`)
        expect(text).toContain(`This is hint level ${n} of 5`)
        if (n === 1) expect(text).not.toContain("```")
      }),
      { numRuns: runs },
    )
    report("R1", "invariant", runs)
  })

  // R2 (invariant): Early hints point without naming the change or stating
  // the solution.
  test("R2: levels 1 and 2 point without naming the change or stating the solution", () => {
    const runs = 50
    fc.assert(
      fc.property(fc.constantFrom(1, 2), (n) => {
        const text = PROMPT_HINT.replaceAll("${level}", String(n))
        expect(text).toContain("Do not reveal the full solution")
        expect(text).toContain("Do not write the code that solves the task")
        if (n === 1) {
          expect(text).toContain("high-level hint")
          expect(text).toContain("Do not name the specific code change")
        }
        if (n === 2) {
          expect(text).toContain("area of the code")
          expect(text).toContain("but not the change")
        }
      }),
      { numRuns: runs },
    )
    report("R2", "invariant", runs)
  })

  // R3 (invariant): Each consecutive hint is more specific than the last, up
  // to level 5.
  test("R3: distinct hint messages climb from 1 and stay at 5", async () => {
    const runs = 80
    await fc.assert(
      fc.asyncProperty(distinctMessages, async (ids) => {
        // No metadata field on a fresh session — optional-chaining mutants must
        // still behave like the real code (treat missing metadata as empty).
        const session = { id: "ses_hint" } as unknown as Session.Info
        for (let i = 0; i < ids.length; i++) {
          const messages = await applyHint(session, ids[i]!)
          const expected = Math.min(i + 1, 5)
          expect(session.metadata?.hintLevel).toBe(expected)
          expect(hintText(messages)).toContain(`This is hint level ${expected} of 5`)
          expect(hintText(messages)).toContain(`Follow only level ${expected}`)
        }
      }),
      { numRuns: runs },
    )
    report("R3", "invariant", runs)
  })

  // R3 companion (strengthened for P5): hint reminders must not run for the
  // build agent. Kills `if (input.agent.name === "hint")` → `if (true)`.
  // (Plan still injects its own reminder text; we only assert no hint climb.)
  test("R3: build agent does not climb the hint level or inject the hint prompt", async () => {
    const runs = 40
    await fc.assert(
      fc.asyncProperty(messageId, async (id) => {
        const session = { id: "ses_hint", metadata: {} } as unknown as Session.Info
        let saved: { metadata: { hintLevel?: number } } | undefined
        const messages = await Effect.runPromise(
          SessionReminders.apply({
            messages: [userMessage(id, "build")],
            agent: { name: "build" } as Agent.Info,
            session,
          }).pipe(
            Effect.provide(
              layerWithSave((input) => {
                saved = input
              }),
            ),
          ),
        )
        expect(session.metadata?.hintLevel).toBeUndefined()
        expect(saved).toBeUndefined()
        const text = hintText(messages) ?? ""
        expect(text).not.toContain("This is hint level")
        expect(text).not.toContain("Follow only level")
      }),
      { numRuns: runs },
    )
    report("R3-non-hint", "invariant", runs)
  })

  // R4 (invariant): Hint mode cannot change the project, even if the user's
  // config allows edits. Strengthened in P5 to load the real hint agent from
  // agent.ts (the old version rebuilt the deny map in the test, so H4 survived).
  agentIt.effect("R4: hint denies win over any user edit/bash/task allow", () =>
    Effect.gen(function* () {
      const samples = fc.sample(userPermissionConfig, { numRuns: 12, seed: 42 })
      for (const user of samples) {
        yield* Effect.gen(function* () {
          const hint = yield* Agent.Service.use((svc) => svc.get("hint"))
          expect(Permission.evaluate("edit", "*", hint.permission).action).toBe("deny")
          expect(Permission.evaluate("bash", "*", hint.permission).action).toBe("deny")
          expect(Permission.evaluate("task", "*", hint.permission).action).toBe("deny")
          expect(Permission.disabled(["edit", "write", "apply_patch", "bash"], hint.permission)).toEqual(
            new Set(["edit", "write", "apply_patch", "bash"]),
          )
        }).pipe(withTmpdirInstance({ config: { permission: user } }))
      }
      report("R4", "invariant", samples.length)
    }),
  )

  // R5 (metamorphic): The hint level resets when the student leaves hint mode.
  test("R5: after a reset to 0 the next hint is level 1", async () => {
    const runs = 80
    await fc.assert(
      fc.asyncProperty(storedLevel, messageId, async (prior, id) => {
        const session = {
          id: "ses_hint",
          metadata: { hintLevel: prior, hintMessageID: "msg_old" },
        } as unknown as Session.Info
        session.metadata = { ...session.metadata, hintLevel: 0 }
        const messages = await applyHint(session, id)
        expect(session.metadata?.hintLevel).toBe(1)
        expect(hintText(messages)).toContain("This is hint level 1 of 5")
        expect(SessionReminders.label(session)).toBe("Hint level 1 of 5")
      }),
      { numRuns: runs },
    )
    report("R5", "metamorphic", runs)
  })

  // R6 (model/oracle): Every hint reply shows the current level.
  // Includes a session object with no metadata field so optional-chaining
  // mutants on label() cannot hide behind "metadata always present".
  test("R6: label matches the clamped stored level", () => {
    const runs = 200
    fc.assert(
      fc.property(fc.option(storedLevel, { nil: undefined }), (raw) => {
        const session =
          raw === undefined ? undefined : ({ metadata: { hintLevel: raw } } as unknown as Session.Info)
        expect(SessionReminders.label(session)).toBe(expectedLabel(raw))
      }),
      { numRuns: runs },
    )
    expect(SessionReminders.label({ id: "ses_hint" } as Session.Info)).toBe("Hint level 1 of 5")
    expect(SessionReminders.label({ id: "ses_hint", metadata: {} } as Session.Info)).toBe(
      "Hint level 1 of 5",
    )
    report("R6", "model/oracle", runs)
  })

  // R7 (metamorphic): Reusing the same hint message does not raise the level
  // a second time.
  test("R7: the same message id does not raise the level twice", async () => {
    const runs = 80
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 4 }), messageId, async (prior, id) => {
        // Start with no metadata field so optional-chaining mutants on
        // bumpedHintLevel throw instead of matching the real code.
        const session = { id: "ses_hint" } as unknown as Session.Info
        session.metadata = { hintLevel: prior }
        const first = await applyHint(session, id)
        const afterFirst = session.metadata?.hintLevel
        const second = await applyHint(session, id)
        const expected = Math.min(prior + 1, 5)
        expect(afterFirst).toBe(expected)
        expect(session.metadata?.hintLevel).toBe(expected)
        expect(session.metadata?.hintMessageID).toBe(id)
        expect(hintText(first)).toContain(`This is hint level ${expected} of 5`)
        expect(hintText(second)).toContain(`This is hint level ${expected} of 5`)
      }),
      { numRuns: runs },
    )
    report("R7", "metamorphic", runs)
  })

  // R5/R7 companion (P5): leave-mode can write hintLevel: 0 while the last
  // hintMessageID is still stored. Re-asking with that same id must still
  // become level 1 (fall through the same-id guard when current < 1).
  test("R5: same message id after a reset to 0 still yields level 1", async () => {
    const runs = 60
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 5 }), messageId, async (prior, id) => {
        const session = {
          id: "ses_hint",
          metadata: { hintLevel: prior, hintMessageID: id },
        } as unknown as Session.Info
        session.metadata = { ...session.metadata, hintLevel: 0 }
        const messages = await applyHint(session, id)
        expect(session.metadata?.hintLevel).toBe(1)
        expect(hintText(messages)).toContain("This is hint level 1 of 5")
      }),
      { numRuns: runs },
    )
    report("R5-same-id-after-reset", "metamorphic", runs)
  })
})
