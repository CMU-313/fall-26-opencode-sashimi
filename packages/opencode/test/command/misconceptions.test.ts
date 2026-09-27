import { describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { Command } from "../../src/command"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Command.node))

describe("misconceptions command", () => {
  it.instance("runs this opencode's misconceptions CLI with the typed arguments", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      const info = yield* command.get(Command.Default.MISCONCEPTIONS)
      const template = yield* Effect.promise(async () => info?.template)
      expect(info?.hints).toEqual(["$ARGUMENTS"])
      expect(template).toContain("Arguments: $ARGUMENTS")
      expect(template).toContain(`${Command.self()} misconceptions <arguments> --json`)
      // The analysis runs as a visible bash tool call rather than a silent `!` shell block before the chat starts.
      expect(template).not.toContain("!`")
      expect(template).not.toContain("${cli}")
    }),
  )

  test("keeps only bun's --conditions flag when running from source", () => {
    expect(Command.sourceFlags(["--cwd", "packages/opencode", "--conditions=browser"])).toEqual(["--conditions=browser"])
    expect(Command.sourceFlags(["-e", "console.log(1)"])).toEqual([])
  })
})
