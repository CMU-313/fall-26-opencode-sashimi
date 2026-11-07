import { expect } from "bun:test"
import fc from "fast-check"
import path from "path"
import { Effect } from "effect"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import type { Tool } from "@/tool/tool"
import { assertExternalDirectoryEffect } from "../../src/tool/external-directory"
import { Permission } from "../../src/permission"
import { TestInstance } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(CrossSpawnSpawner.node))

// R4: By default, agents should only have read/write access to the repository
// root directory and its subdirectories, assuming the agent is launched in a
// repository.
// Kind: invariant
//
// For any target path, the tool layer asks for `external_directory`
// permission exactly when the path resolves outside the instance directory,
// and the default agent rules never grant that permission outright.
//
// Generators: paths are built from a few segments that include ".." so that
// traversal out of the project (C-3's "unrelated directories") is reached
// often, and from sibling and parent directories of the instance. The oracle
// for "inside" is a plain prefix check on the resolved path, independent of
// the FSUtil.contains helper the code uses.
const segment = fc.constantFrom("src", "a", "b.txt", "main.py", "node_modules", "..", ".")
const relative = fc.array(segment, { minLength: 1, maxLength: 5 }).map((parts) => parts.join(path.sep))

const defaults = Permission.fromConfig({ "*": "allow", external_directory: { "*": "ask" } })

function makeCtx() {
  const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
  const ctx: Tool.Context = {
    sessionID: SessionID.make("ses_test"),
    messageID: MessageID.make("msg_test"),
    callID: "",
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: (req) =>
      Effect.sync(() => {
        requests.push(req)
      }),
  }
  return { requests, ctx }
}

it.instance(
  "R4: external_directory is requested exactly for paths outside the project, and defaults never allow it",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const root = path.resolve(test.directory)
      const context = yield* Effect.context()
      const base = fc.constantFrom(root, path.dirname(root), path.join(path.dirname(root), "other"))
      const target = fc.tuple(base, relative).map(([dir, rel]) => path.resolve(dir, rel))

      yield* Effect.promise(() =>
        fc.assert(
          fc.asyncProperty(target, async (file) => {
            const inside = file === root || file.startsWith(root + path.sep)
            const { requests, ctx } = makeCtx()
            await Effect.runPromiseWith(context)(assertExternalDirectoryEffect(ctx, file))

            if (inside) {
              expect(requests).toHaveLength(0)
              return
            }
            expect(requests).toHaveLength(1)
            expect(requests[0].permission).toBe("external_directory")
            for (const pattern of requests[0].patterns) {
              expect(Permission.evaluate("external_directory", pattern, defaults).action).not.toBe("allow")
            }
          }),
          { numRuns: 200 },
        ),
      )
      console.log("R4 invariant property: external paths always required external_directory permission for 200 runs")
    }),
  { git: true },
  60000,
)
