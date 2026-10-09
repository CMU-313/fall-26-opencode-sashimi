import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import path from "path"
import { Command } from "../../src/command"
import { provideTmpdirInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(LayerNode.compile(Command.node), LayerNode.compile(CrossSpawnSpawner.node), testInstanceStoreLayer),
)

describe("/misconceptions command", () => {
  it.live("is a quiet built-in command with $ARGUMENTS hints and a template that runs this opencode", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        expect(Command.Default.MISCONCEPTIONS).toBe("misconceptions")
        expect(Command.Quiet).toBeInstanceOf(Set)
        expect(Command.Quiet.has("misconceptions")).toBe(true)
        const command = yield* Command.Service
        const info = (yield* command.list()).find((item) => item.name === Command.Default.MISCONCEPTIONS)
        expect(info?.hints).toEqual(["$ARGUMENTS"])
        const template = yield* Effect.promise(async () => await info?.template)
        expect(typeof template).toBe("string")
        expect(template).toContain(`${Command.self()} misconceptions`)
        expect(template).toContain("$ARGUMENTS")
        expect(template).not.toMatch(/\$\{[^}]*\}/)
      }),
    ),
  )

  it.effect("sourceFlags keeps only --conditions flags and self() returns single-quoted shell words", () =>
    Effect.sync(() => {
      expect(Command.sourceFlags(["--cwd", "packages/opencode", "--conditions=browser"])).toEqual([
        "--conditions=browser",
      ])
      expect(Command.sourceFlags(["--hot", "--watch"])).toEqual([])
      const words = Command.self().split(" ").filter(Boolean)
      expect(words.length).toBeGreaterThan(0)
      words.forEach((word) => expect(word).toMatch(/^'.*'$/))
      expect(words[0]).toContain("bun")
      // The --conditions flag is only present when this process was started with one (bun test is not).
      words.slice(1, -1).forEach((word) => expect(word).toStartWith("'--conditions"))
      expect(words.at(-1)).toBe(`'${path.resolve(import.meta.dir, "../../src/index.ts")}'`)
    }),
  )
})
