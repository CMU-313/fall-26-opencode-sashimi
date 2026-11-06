import { test, expect } from "bun:test"
import fc from "fast-check"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Permission } from "../../src/permission"

// R1 (revised in P4): Reordering rules that do not compete for a command never
// changes its outcome. When two rules do compete, the later one wins.
// Kind: metamorphic
//
// Interviewees agreed rule order should not surprise users, but the product's
// documented semantics are "last matching rule wins". The property that holds
// for both is: reordering rules that do not compete for the same command
// never changes the outcome.
//
// Generators: rulesets of 1 to 6 rules over a small shell vocabulary so that
// several rules often match the same command. The first property then strips
// the competition down to one matching rule before shuffling; the second
// inserts a rule that provably cannot match; the third builds the exact
// general-versus-specific conflict the interviewees asked about.
const word = fc.constantFrom("rm", "ls", "git", "npm", "push", "-rf", "-la", "a.txt", "src/x.ts", "x")
const command = fc.array(word, { minLength: 1, maxLength: 4 }).map((tokens) => tokens.join(" "))
const token = fc.oneof(word, fc.constant("*"), word.map((w) => w + "*"))
const pattern = fc.array(token, { minLength: 1, maxLength: 4 }).map((tokens) => tokens.join(" "))
const rule = fc.record({
  permission: fc.constantFrom("bash", "edit", "*"),
  pattern,
  action: fc.constantFrom<PermissionV1.Action>("allow", "ask", "deny"),
})
const ruleset = fc.array(rule, { minLength: 1, maxLength: 6 })

function matches(permission: string, cmd: string, r: PermissionV1.Rule) {
  return Wildcard.match(permission, r.permission) && Wildcard.match(cmd, r.pattern)
}

test("R1: shuffling rules that do not compete for a command leaves its outcome unchanged", () => {
  fc.assert(
    fc.property(command, ruleset, fc.infiniteStream(fc.nat()), (cmd, rules, seeds) => {
      // Keep at most one rule that matches this command so no two rules compete.
      const first = rules.findIndex((r) => matches("bash", cmd, r))
      const kept = rules.filter((r, i) => i === first || !matches("bash", cmd, r))
      const shuffled = [...kept]
      const it = seeds[Symbol.iterator]()
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = it.next().value % (i + 1)
        ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
      }
      expect(Permission.evaluate("bash", cmd, shuffled)).toEqual(Permission.evaluate("bash", cmd, kept))
    }),
    { numRuns: 300 },
  )
  console.log("R1 metamorphic property: shuffling non-competing rules changed nothing for 300 runs")
})

test("R1: a rule that cannot match the command can be inserted anywhere without effect", () => {
  fc.assert(
    fc.property(command, ruleset, rule, fc.nat(), (cmd, rules, extra, at) => {
      fc.pre(!matches("bash", cmd, extra))
      const inserted = rules.toSpliced(at % (rules.length + 1), 0, extra)
      expect(Permission.evaluate("bash", cmd, inserted)).toEqual(Permission.evaluate("bash", cmd, rules))
    }),
    { numRuns: 300 },
  )
  console.log("R1 metamorphic property: inserting a non-matching rule changed nothing for 300 runs")
})

test("R1: when two rules compete, the later one wins regardless of specificity", () => {
  // The interviewees' intuition that "more specific wins" does not hold; this
  // pins the documented behavior so the R1 revision stays honest.
  fc.assert(
    fc.property(command, fc.constantFrom<PermissionV1.Action>("allow", "deny"), (cmd, action) => {
      const general: PermissionV1.Rule = { permission: "bash", pattern: "*", action: action === "allow" ? "deny" : "allow" }
      const specific: PermissionV1.Rule = { permission: "bash", pattern: cmd, action }
      expect(Permission.evaluate("bash", cmd, [general, specific]).action).toBe(action)
      expect(Permission.evaluate("bash", cmd, [specific, general]).action).toBe(general.action)
    }),
    { numRuns: 100 },
  )
  console.log("R1 metamorphic property: competing rules resolved last-wins for 100 runs")
})
