import { SessionV1 } from "@opencode-ai/core/v1/session"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { describe, expect } from "bun:test"
import { Effect, Layer, Sink } from "effect"
import { Agent } from "../../src/agent/agent"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Session } from "../../src/session/session"
import { SessionReminders } from "../../src/session/reminders"
import { testEffect } from "../lib/effect"

// The hint path never calls the filesystem. Layer.mock still requires the
// fields that are not Effects, or tsgo rejects an empty object.
const filesystem = Layer.mock(FSUtil.Service)({
  "~effect/platform/FileSystem": "~effect/platform/FileSystem",
  sink: () => Sink.drain,
  globMatch: () => false,
})

const it = testEffect(
  Layer.mergeAll(
    RuntimeFlags.layer(),
    filesystem,
    Layer.mock(Session.Service)({
      setMetadata: () => Effect.void,
    }),
  ),
)

function userMessage(text: string, agent = "hint", created = 0): SessionV1.WithParts {
  return {
    info: {
      id: `msg_${agent}_${text}`,
      sessionID: "ses_hint",
      role: "user",
      time: { created },
      agent,
      model: { providerID: "test", modelID: "test" },
    },
    parts: [{ id: `prt_${agent}_${text}`, sessionID: "ses_hint", messageID: `msg_${agent}_${text}`, type: "text", text }],
  } as SessionV1.WithParts
}

function hintText(messages: SessionV1.WithParts[]) {
  const part = messages.at(-1)?.parts.find((item) => item.type === "text" && item.synthetic)
  if (part?.type !== "text") return
  return part.text
}

describe("hint reminder", () => {
  // Checks the wording, not the tool flags. The prompt lists every level, but
  // this turn must follow level 1 and must not include the solution. File
  // changes are blocked in the hint agent permissions, which a different test covers.
  it.effect("adds one vague hint and does not give the solution", () =>
    Effect.gen(function* () {
      const session = {} as Session.Info
      const messages = yield* SessionReminders.apply({
        messages: [userMessage("I'm stuck")],
        agent: { name: "hint" } as Agent.Info,
        session,
      })
      const text = hintText(messages)
      expect(text).toContain("This is hint level 1 of 5")
      expect(text).toContain("Follow only level 1")
      expect(text).not.toContain("Start your reply")
      expect(SessionReminders.label(session)).toBe("Hint level 1 of 5")
      expect(text).toContain("high-level hint")
      expect(text).toContain("extremely specific")
      expect(text).toContain("Do not reveal the full solution")
      expect(text).toContain("Do not write the code that solves the task")
      expect(text).not.toContain("```")
    }),
  )

  // The saved number climbs by one per hint and stops at 5. Asking again on
  // the same message does not add another level.
  it.effect("gets more specific and stops at level 5", () =>
    Effect.gen(function* () {
      const session = { metadata: { hintLevel: 2 } } as unknown as Session.Info
      const third = yield* SessionReminders.apply({
        messages: [userMessage("three")],
        agent: { name: "hint" } as Agent.Info,
        session,
      })
      const capped = { metadata: { hintLevel: 5 } } as unknown as Session.Info
      const fifth = yield* SessionReminders.apply({
        messages: [userMessage("six")],
        agent: { name: "hint" } as Agent.Info,
        session: capped,
      })
      const again = yield* SessionReminders.apply({
        messages: [userMessage("six")],
        agent: { name: "hint" } as Agent.Info,
        session: capped,
      })
      expect(hintText(third)).toContain("This is hint level 3 of 5")
      expect(hintText(third)).toContain("Follow only level 3")
      expect(SessionReminders.label(session)).toBe("Hint level 3 of 5")
      expect(hintText(fifth)).toContain("This is hint level 5 of 5")
      expect(hintText(again)).toContain("This is hint level 5 of 5")
      expect(capped.metadata?.hintLevel).toBe(5)
      expect(hintText(fifth)).toContain("Do not reveal the full solution")
    }),
  )

  // Leaving hint mode stores 0. The next hint is level 1 even if older hint
  // messages are still in the session.
  it.effect("starts over after leaving hint mode", () =>
    Effect.gen(function* () {
      const session = { metadata: { hintLevel: 0 } } as unknown as Session.Info
      const messages = yield* SessionReminders.apply({
        messages: [userMessage("one"), userMessage("two"), userMessage("again")],
        agent: { name: "hint" } as Agent.Info,
        session,
      })
      expect(hintText(messages)).toContain("This is hint level 1 of 5")
      expect(SessionReminders.label(session)).toBe("Hint level 1 of 5")
    }),
  )

  // Build mode must not get this text, or a normal message would be treated as a hint.
  it.effect("leaves a normal message alone", () =>
    Effect.gen(function* () {
      const messages = yield* SessionReminders.apply({
        messages: [userMessage("hello")],
        agent: { name: "build" } as Agent.Info,
        session: {} as Session.Info,
      })
      expect(messages[0].parts).toHaveLength(1)
    }),
  )
})
