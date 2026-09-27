import { SessionV1 } from "@opencode-ai/core/v1/session"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Session } from "../../src/session/session"
import { SessionReminders } from "../../src/session/reminders"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(RuntimeFlags.layer(), Layer.mock(FSUtil.Service)({}), Layer.mock(Session.Service)({})),
)

function userMessage(text: string): SessionV1.WithParts {
  return {
    info: {
      id: "msg_hint",
      sessionID: "ses_hint",
      role: "user",
      time: { created: 0 },
      agent: "hint",
      model: { providerID: "test", modelID: "test" },
    },
    parts: [{ id: "prt_user", sessionID: "ses_hint", messageID: "msg_hint", type: "text", text }],
  } as SessionV1.WithParts
}

describe("hint reminder", () => {
  // Checks the wording of the hint, not the tool flags. The reply should stay
  // vague and should not include the solution. File changes are blocked in the
  // hint agent permissions, which a different test covers.
  it.effect("adds one vague hint and does not give the solution", () =>
    Effect.gen(function* () {
      const messages = yield* SessionReminders.apply({
        messages: [userMessage("I'm stuck")],
        agent: { name: "hint" } as Agent.Info,
        session: {} as Session.Info,
      })
      const hints = messages[0].parts.filter(
        (part) => part.type === "text" && part.synthetic === true && part.text.includes("high-level hint"),
      )
      expect(hints).toHaveLength(1)
      if (hints[0]?.type !== "text") return
      expect(hints[0].text).toContain("Do not reveal the full solution")
      expect(hints[0].text).toContain("Do not write the code that solves the task")
      expect(hints[0].text).not.toContain("```")
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
