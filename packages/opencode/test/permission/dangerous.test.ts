import { test, expect } from "bun:test"
import fc from "fast-check"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Permission } from "../../src/permission"

// R3 invariant: a recursive force delete never runs without the user seeing
// it, no matter what the config allows. The strongest an allow rule can make
// it is "ask".
const word = fc.constantFrom("rm", "ls", "git", "npm", "push", "-la", "-v", "a.txt", "src/x.ts", "x", ".", "/")
const token = fc.oneof(word, fc.constant("*"), word.map((w) => w + "*"))
const pattern = fc.array(token, { minLength: 1, maxLength: 4 }).map((tokens) => tokens.join(" "))
const rule = fc.record({
  permission: fc.constantFrom("bash", "*"),
  pattern,
  action: fc.constantFrom<PermissionV1.Action>("allow", "ask", "deny"),
})
const ruleset = fc.array(rule, { maxLength: 5 })

const recursiveForce = fc.constantFrom("-rf", "-fr", "-Rf", "-fR", "-r -f", "-f -r", "--recursive --force", "-rfv")
const target = fc.constantFrom(".", "/", "*", "node_modules", "src/", "~", "a.txt")
const dangerous = fc
  .tuple(fc.constantFrom("rm", "sudo rm"), recursiveForce, fc.array(target, { minLength: 1, maxLength: 2 }))
  .map(([cmd, flags, targets]) => `${cmd} ${flags} ${targets.join(" ")}`)
const harmless = fc
  .tuple(fc.constantFrom("rm", "ls", "git", "npm"), fc.constantFrom("", "-r", "-f", "-v", "-la"), target)
  .map(([cmd, flags, t]) => [cmd, flags, t].filter(Boolean).join(" "))

test("invariant: rm -rf is never allowed outright, even under a catch-all allow", () => {
  fc.assert(
    fc.property(dangerous, ruleset, (cmd, rules) => {
      const result = Permission.decide("bash", cmd, [{ permission: "*", pattern: "*", action: "allow" }, ...rules])
      expect(result.action).not.toBe("allow")
    }),
    { numRuns: 300 },
  )
})

test("invariant: a deny rule still wins over the dangerous-command downgrade", () => {
  fc.assert(
    fc.property(dangerous, ruleset, (cmd, rules) => {
      const all = [...rules, { permission: "bash", pattern: "*", action: "deny" as const }]
      expect(Permission.decide("bash", cmd, all).action).toBe("deny")
    }),
    { numRuns: 100 },
  )
})

test("invariant: commands that are not recursive force deletes are decided purely by the rules", () => {
  fc.assert(
    fc.property(harmless, ruleset, (cmd, rules) => {
      expect(Permission.decide("bash", cmd, rules)).toEqual(Permission.evaluate("bash", cmd, rules))
    }),
    { numRuns: 300 },
  )
})
