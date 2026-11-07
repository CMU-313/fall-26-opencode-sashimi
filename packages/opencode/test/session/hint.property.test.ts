// Property-based tests for hint mode (P4, hzoccoli).
// Each property names the requirement it checks (see traceability/hzoccoli.md).
//
// The opencode test script runs with --only-failures, which hides passing tests
// in the CI log. Each test prints one line after fast-check finishes so the log
// shows that every property actually ran and how many inputs it checked.
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Sink } from "effect"
import fc from "fast-check"
import { Agent } from "../../src/agent/agent"
import { Permission } from "../../src/permission"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Session } from "../../src/session/session"
import { SessionReminders } from "../../src/session/reminders"
import PROMPT_HINT from "../../src/session/prompt/hint.txt"

function report(id: string, kind: string, runs: number) {
  console.log(`[hint properties] ${id} (${kind}): passed ${runs} generated cases`)
}

// ---------------------------------------------------------------------------
// Generators
//
// Levels and message ids are what the feature actually stores. Sequences of
// distinct ids hit the climb/cap path. Repeating an id hits the same-message
// guard. Weird stored levels (0, negative, past 5) hit the clamp in label().
// User permission configs that allow edit/bash/task hit the R4 override case.
// ---------------------------------------------------------------------------

const level = fc.integer({ min: 1, max: 5 })
const storedLevel = fc.integer({ min: -3, max: 12 })
const messageId = fc
  .stringMatching(/^[a-z0-9_-]{1,24}$/)
  .map((s) => `msg_hint_${s}`)

const distinctMessages = fc.uniqueArray(messageId, { minLength: 1, maxLength: 8 })

const action = fc.constantFrom("allow", "ask", "deny") as fc.Arbitrary<"allow" | "ask" | "deny">

// User configs that try to turn file changes back on, plus a few other tools
// so the merge sees more than just the three hint denies.
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

function userMessage(id: string): SessionV1.WithParts {
  return {
    info: {
      id,
      sessionID: "ses_hint",
      role: "user",
      time: { created: 0 },
      agent: "hint",
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
  return Effect.runPromise(
    SessionReminders.apply({
      messages: [userMessage(messageID)],
      agent: { name: "hint" } as Agent.Info,
      session,
    }).pipe(Effect.provide(layerWithSave(() => {}))),
  )
}

// Oracle for the visible label: same clamp the production label() uses.
function expectedLabel(raw?: number) {
  const shown = typeof raw === "number" ? Math.min(Math.max(raw, 1), 5) : 1
  return `Hint level ${shown} of 5`
}

describe("hint properties", () => {
  // R1 (invariant): A hint never gives the full solution or writes the code,
  // at any level.
  // Kind: invariant
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
  // Kind: invariant
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
  // Kind: invariant
  // Generator: 1–8 distinct message ids so we hit the climb and the cap.
  test("R3: distinct hint messages climb from 1 and stay at 5", async () => {
    const runs = 80
    await fc.assert(
      fc.asyncProperty(distinctMessages, async (ids) => {
        const session = { id: "ses_hint", metadata: {} } as unknown as Session.Info
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

  // R4 (invariant): Hint mode cannot change the project, even if the user's
  // config allows edits.
  // Kind: invariant
  // Generator: every mix of allow/ask/deny for edit/bash/task (and a couple of
  // other tools). The hint denies are merged last, so they must win.
  test("R4: hint denies win over any user edit/bash/task allow", () => {
    const runs = 200
    fc.assert(
      fc.property(userPermissionConfig, (user) => {
        const defaults = Permission.fromConfig({ "*": "allow" })
        const hintDenies = Permission.fromConfig({
          question: "allow",
          edit: "deny",
          bash: "deny",
          task: "deny",
        })
        // Same order as agent.ts: defaults, user, then the hint denies.
        const merged = Permission.merge(defaults, Permission.fromConfig(user), hintDenies)
        expect(Permission.evaluate("edit", "*", merged).action).toBe("deny")
        expect(Permission.evaluate("bash", "*", merged).action).toBe("deny")
        expect(Permission.evaluate("task", "*", merged).action).toBe("deny")
        expect(Permission.disabled(["edit", "write", "apply_patch", "bash"], merged)).toEqual(
          new Set(["edit", "write", "apply_patch", "bash"]),
        )
      }),
      { numRuns: runs },
    )
    report("R4", "invariant", runs)
  })

  // R5 (metamorphic): The hint level resets when the student leaves hint mode.
  // Kind: metamorphic
  // Leaving hint mode writes hintLevel: 0. For any prior level, the next hint
  // after that write is level 1.
  test("R5: after a reset to 0 the next hint is level 1", async () => {
    const runs = 80
    await fc.assert(
      fc.asyncProperty(storedLevel, messageId, async (prior, id) => {
        const session = {
          id: "ses_hint",
          metadata: { hintLevel: prior, hintMessageID: "msg_old" },
        } as unknown as Session.Info
        // Metamorphic step: leave hint mode (write 0), then ask again.
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
  // Kind: model/oracle
  // Oracle is the clamp formula; label() must agree for every stored value,
  // including missing, 0, and numbers past 5.
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
    report("R6", "model/oracle", runs)
  })

  // R7 (metamorphic): Reusing the same hint message does not raise the level
  // a second time.
  // Kind: metamorphic
  // Start below the cap so a second bump would be visible if the guard failed.
  test("R7: the same message id does not raise the level twice", async () => {
    const runs = 80
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 4 }), messageId, async (prior, id) => {
        const session = {
          id: "ses_hint",
          metadata: { hintLevel: prior },
        } as unknown as Session.Info
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
})
