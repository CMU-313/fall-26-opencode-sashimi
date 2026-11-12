import { expect } from "bun:test"
import fc from "fast-check"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
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
// Rules for another permission ride along so the error's rule list is shown
// to be filtered to the permission that was asked for.
const rule = fc.record({
  permission: fc.constantFrom("bash", "edit"),
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
            if (!Exit.isFailure(blocked)) throw new Error("expected the deny rule to block the command")
            // The error carries the bash rules that applied, so the user can see which one blocked them.
            const err = Cause.squash(blocked.cause)
            expect(err).toBeInstanceOf(PermissionV1.DeniedError)
            expect((err as PermissionV1.DeniedError).ruleset).toEqual([...base, deny].filter((r) => r.permission === "bash"))
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

// R3 (acceptance criterion): a command that resolves to "ask" prompts the user
// instead of running. The decide-level R3 properties stop one call short of
// this; here the service itself must park the request until someone replies.
// Kind: invariant
//
// Generators: any base ruleset plus a trailing ask rule for the command, so
// the ask wins regardless of what the base said.
it.instance(
  "R3: an ask rule parks the command on a prompt until the user replies",
  () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const context = yield* Effect.context()

      const pendingOne = Effect.gen(function* () {
        while (true) {
          const list = yield* permission.list()
          if (list.length === 1) return list[0]
          yield* Effect.sleep("10 millis")
        }
      }).pipe(
        Effect.timeoutOrElse({
          duration: "1 second",
          orElse: () => Effect.fail(new Error("timed out waiting for the permission prompt")),
        }),
      )

      yield* Effect.promise(() =>
        fc.assert(
          fc.asyncProperty(command, ruleset, async (cmd, base) => {
            await Effect.runPromiseWith(context)(
              Effect.gen(function* () {
                const fiber = yield* permission
                  .ask({
                    sessionID: SessionID.make("session_test"),
                    permission: "bash",
                    patterns: [cmd],
                    metadata: {},
                    always: [],
                    ruleset: [...base, { permission: "bash", pattern: cmd, action: "ask" }],
                  })
                  .pipe(Effect.exit, Effect.forkChild)

                // The request is waiting for a human, and nothing resolves it on its own.
                const request = yield* pendingOne
                expect(request).toMatchObject({ permission: "bash", patterns: [cmd] })
                expect(fiber.pollUnsafe()).toBeUndefined()

                yield* permission.reply({ requestID: request.id, reply: "reject" })
                expect(Exit.isFailure(yield* Fiber.join(fiber))).toBe(true)
                expect(yield* permission.list()).toHaveLength(0)
              }),
            )
          }),
          { numRuns: 50 },
        ),
      )
      console.log("R3 ask property: ask rules prompted and waited for a reply for 50 runs")
    }),
  { git: true },
  60000,
)
