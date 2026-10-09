import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { Command } from "../../src/command"
import PROMPT_AUTONAME from "../../src/command/template/autoname.txt"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Command.node))

describe("autoname command integration", () => {
  it.instance("registers autoname with correct fields", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      const info = yield* command.get("autoname")

      expect(info).toBeDefined()
      expect(info).toMatchObject({
        name: "autoname",
        source: "command",
        description: expect.any(String),
        hints: [],
      })

      expect(info?.template).toBe(PROMPT_AUTONAME)
    }),
  )

  it.instance("autoname appears in command list", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      const commands = yield* command.list()

      const autoname = commands.find(
        (item) => item.name === "autoname",
      )

      expect(autoname).toBeDefined()
      expect(autoname?.source).toBe("command")
    }),
  )

  it.instance("autoname prompt contains naming instructions", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      const info = yield* command.get("autoname")

      const template = info?.template

      expect(template).toBe(PROMPT_AUTONAME)
      expect(template).toContain("RENAMED:")
      expect(template).toContain("2-5 words")
      expect(template).toContain("Summarize")
    }),
  )
})
