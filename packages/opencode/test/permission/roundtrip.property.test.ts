import { expect } from "bun:test"
import fc from "fast-check"
import { Effect, Exit, Layer } from "effect"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Permission } from "../../src/permission"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

// Fixed seed so Stryker runs are reproducible (P5).
fc.configureGlobal({ seed: 42 })

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Permission.node, EventV2Bridge.node, CrossSpawnSpawner.node, InstanceStore.node]),
    [[InstanceStore.bootstrapNode, noopBootstrap]],
  ),
)

// R2: Removing a blocking rule should give a notice/warning if something runs
// that would have been blocked by it.
// Kind: round-trip
//
// A command denied by a rule runs again once that rule is removed, and the
// user is told exactly once that the change unblocked it.
//
// Generators: base rulesets start with a catch-all allow and use allow/deny
// only, so the service never parks a request waiting for an interactive "ask"
// reply. The vocabulary avoids recursive force flags, since Permission.decide
// downgrades those to "ask" regardless of the rules (see
// dangerous.property.test.ts). Commands and patterns share a small vocabulary
// so the base rules sometimes match the command and sometimes do not, which
// exercises both the "restored to allow" and "still denied" branches.
const word = fc.constantFrom("rm", "ls", "git", "npm", "push", "-r", "-la", "a.txt", "src/x.ts", "x")
const command = fc.array(word, { minLength: 1, maxLength: 4 }).map((tokens) => tokens.join(" "))
const token = fc.oneof(word, fc.constant("*"), word.map((w) => w + "*"))
const pattern = fc.array(token, { minLength: 1, maxLength: 4 }).map((tokens) => tokens.join(" "))
const rule = fc.record({
  permission: fc.constant("bash"),
  pattern,
  action: fc.constantFrom<PermissionV1.Action>("allow", "deny"),
})
const ruleset = fc
  .array(rule, { maxLength: 5 })
  .map((rules): PermissionV1.Rule[] => [{ permission: "bash", pattern: "*", action: "allow" }, ...rules])

it.instance(
  "R2: removing a deny rule re-enables the command and reports it once",
  () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const events = yield* EventV2Bridge.Service
      const seen: unknown[] = []
      const unsub = yield* events.listen((event) => {
        if (event.type === Permission.Event.Unblocked.type) seen.push(event.data)
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)
      // Capture the instance-scoped context so asks issued from fast-check's
      // async callback run against the same instance state.
      const context = yield* Effect.context()

      const ask = (cmd: string, rules: PermissionV1.Rule[]) =>
        Effect.runPromiseWith(context)(
          permission
            .ask({ sessionID: SessionID.make("session_test"), permission: "bash", patterns: [cmd], metadata: {}, always: [], ruleset: rules })
            .pipe(Effect.exit),
        )

      yield* Effect.promise(() =>
        fc.assert(
          fc.asyncProperty(command, ruleset, async (cmd, base) => {
            seen.length = 0
            const deny: PermissionV1.Rule = { permission: "bash", pattern: cmd, action: "deny" }

            const blocked = await ask(cmd, [...base, deny])
            expect(Exit.isFailure(blocked)).toBe(true)
            expect(seen).toHaveLength(0)

            // Undo: evaluate the same command with the deny rule removed.
            const after = await ask(cmd, base)
            const baseDenies = Permission.evaluate("bash", cmd, base).action === "deny"
            expect(Exit.isFailure(after)).toBe(baseDenies)
            if (baseDenies) {
              expect(seen).toHaveLength(0)
              // Clear the remembered denial so the next sample starts clean.
              await ask(cmd, [{ permission: "bash", pattern: "*", action: "allow" }])
              return
            }
            expect(seen).toEqual([{ sessionID: SessionID.make("session_test"), permission: "bash", pattern: cmd, rule: deny }])

            // Repeating the now-allowed command does not nag again.
            await ask(cmd, base)
            expect(seen).toHaveLength(1)
          }),
          { numRuns: 100 },
        ),
      )
      console.log("R2 round-trip property: deny, remove, retry held for 100 runs")
    }),
  { git: true },
  60000,
)
