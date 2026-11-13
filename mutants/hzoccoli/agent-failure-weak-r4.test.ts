// Reproduce the Cursor-suggested weak R4 (P4). Copy into packages/opencode and
// run with H4 applied to see it survive:
//   cp mutants/hzoccoli/agent-failure-weak-r4.test.ts packages/opencode/test/session/
//   git apply mutants/hzoccoli/H4.patch
//   cd packages/opencode && bun test test/session/agent-failure-weak-r4.test.ts
//   git checkout -- src/agent/agent.ts
//   rm test/session/agent-failure-weak-r4.test.ts
import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { Permission } from "../../src/permission"

fc.configureGlobal({ seed: 42 })

const action = fc.constantFrom("allow", "ask", "deny") as fc.Arbitrary<"allow" | "ask" | "deny">
const userPermissionConfig = fc.record({
  edit: action,
  bash: action,
  task: action,
  read: action,
  question: action,
})

describe("agent-failure weak R4", () => {
  test("inlined denies ignore agent.ts (H4 should survive this property)", () => {
    fc.assert(
      fc.property(userPermissionConfig, (user) => {
        const defaults = Permission.fromConfig({ "*": "allow" })
        const hintDenies = Permission.fromConfig({
          question: "allow",
          edit: "deny",
          bash: "deny",
          task: "deny",
        })
        const merged = Permission.merge(defaults, Permission.fromConfig(user), hintDenies)
        expect(Permission.evaluate("edit", "*", merged).action).toBe("deny")
        expect(Permission.evaluate("bash", "*", merged).action).toBe("deny")
        expect(Permission.evaluate("task", "*", merged).action).toBe("deny")
      }),
      { numRuns: 100 },
    )
  })
})
