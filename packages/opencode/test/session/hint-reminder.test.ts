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

const it = testEffect(Layer.mergeAll(RuntimeFlags.layer(), filesystem, Layer.mock(Session.Service)({})))

function userMessage(text: string, agent = "hint"): SessionV1.WithParts {
  return {
    info: {
      id: `msg_${agent}_${text}`,
      sessionID: "ses_hint",
      role: "user",
      time: { created: 0 },
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
      const messages = yield* SessionReminders.apply({
        messages: [userMessage("I'm stuck")],
        agent: { name: "hint" } as Agent.Info,
        session: {} as Session.Info,
      })
      const text = hintText(messages)
      expect(text).toContain("Hint level 1 of 5")
      expect(text).toContain("Follow only level 1")
      expect(text).toContain("high-level hint")
      expect(text).toContain("extremely specific")
      expect(text).toContain("Do not reveal the full solution")
      expect(text).toContain("Do not write the code that solves the task")
      expect(text).not.toContain("```")
    }),
  )

  // The prompt always lists every level. This checks that the filled-in number
  // climbs and stops at 5, and the solution is still withheld.
  it.effect("gets more specific and stops at level 5", () =>
    Effect.gen(function* () {
      const third = yield* SessionReminders.apply({
        messages: [userMessage("one"), userMessage("two"), userMessage("three")],
        agent: { name: "hint" } as Agent.Info,
        session: {} as Session.Info,
      })
      const fifth = yield* SessionReminders.apply({
        messages: [1, 2, 3, 4, 5, 6].map((n) => userMessage(String(n))),
        agent: { name: "hint" } as Agent.Info,
        session: {} as Session.Info,
      })
      expect(hintText(third)).toContain("Hint level 3 of 5")
      expect(hintText(third)).toContain("Follow only level 3")
      expect(hintText(fifth)).toContain("Hint level 5 of 5")
      expect(hintText(fifth)).toContain("extremely specific")
      expect(hintText(fifth)).toContain("Do not reveal the full solution")
      expect(hintText(fifth)).not.toContain("Hint level 6 of 5")
    }),
  )

  // A turn in another mode ends the streak. The next hint is vague again.
  it.effect("starts over after a message from another mode", () =>
    Effect.gen(function* () {
      const messages = yield* SessionReminders.apply({
        messages: [userMessage("stuck"), userMessage("fix it", "build"), userMessage("still stuck")],
        agent: { name: "hint" } as Agent.Info,
        session: {} as Session.Info,
      })
      expect(hintText(messages)).toContain("Hint level 1 of 5")
      expect(hintText(messages)).toContain("high-level hint")
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
