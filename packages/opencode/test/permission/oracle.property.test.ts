import { test, expect } from "bun:test"
import fc from "fast-check"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Permission } from "../../src/permission"
import { oracleMatch, oracleEvaluate } from "./glob"

// Fixed seed so Stryker runs are reproducible (P5).
fc.configureGlobal({ seed: 42 })

// R5: Permission evaluation should be testable against a simpler, independent
// reference implementation to ensure commands are correctly allowed or denied.
// Kind: model / oracle
//
// The real evaluator compiles each pattern to a regex; the oracle in glob.ts is
// a naive character-by-character walk. Any disagreement between the two on a
// generated input is a bug in one of them.

// Generators: a small vocabulary of real shell words so generated patterns
// actually collide with generated commands. Drawing from all strings would
// almost never exercise a matching rule. Pattern tokens mix in "*", "?", and
// prefix/suffix wildcards, and permission names include wildcards too, so the
// oracle is checked on both halves of a rule.
const word = fc.constantFrom("rm", "ls", "git", "npm", "push", "install", "-rf", "-la", "a.txt", "src/x.ts", "x")
const command = fc.array(word, { minLength: 1, maxLength: 4 }).map((tokens) => tokens.join(" "))
const token = fc.oneof(
  word,
  fc.constant("*"),
  fc.constant("?"),
  word.map((w) => w + "*"),
  word.map((w) => "*" + w),
  word.map((w) => w.replace(/^./, "?")),
)
const pattern = fc.array(token, { minLength: 1, maxLength: 4 }).map((tokens) => tokens.join(" "))
const permission = fc.constantFrom("bash", "edit", "read")
const permissionPattern = fc.constantFrom("bash", "edit", "read", "*", "ba*", "?ash")
const action = fc.constantFrom<PermissionV1.Action>("allow", "ask", "deny")
const rule = fc.record({ permission: permissionPattern, pattern, action })
const ruleset = fc.array(rule, { maxLength: 6 })

test("R5: Wildcard.match agrees with a naive glob walk", () => {
  fc.assert(
    fc.property(command, pattern, (str, pat) => {
      expect(Wildcard.match(str, pat)).toBe(oracleMatch(str, pat))
    }),
    { numRuns: 500 },
  )
  console.log("R5 oracle property: Wildcard.match agreed with the glob-walk oracle for 500 runs")
})

test("R5: Permission.evaluate agrees with a naive string-matching evaluator", () => {
  fc.assert(
    fc.property(permission, command, ruleset, (perm, cmd, rules) => {
      expect(Permission.evaluate(perm, cmd, rules)).toEqual(oracleEvaluate(perm, cmd, rules))
    }),
    { numRuns: 500 },
  )
  console.log("R5 oracle property: Permission.evaluate agreed with the string-matching oracle for 500 runs")
})

test("R5: evaluating merged rulesets equals evaluating their concatenation", () => {
  fc.assert(
    fc.property(permission, command, ruleset, ruleset, (perm, cmd, a, b) => {
      expect(Permission.evaluate(perm, cmd, a, b)).toEqual(oracleEvaluate(perm, cmd, [...a, ...b]))
    }),
    { numRuns: 300 },
  )
  console.log("R5 oracle property: merged rulesets agreed with the oracle for 300 runs")
})
