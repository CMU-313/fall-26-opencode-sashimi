import { test, expect } from "bun:test"
import fc from "fast-check"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Permission } from "../../src/permission"

// Fixed seed so Stryker runs are reproducible (P5).
fc.configureGlobal({ seed: 42 })

// R3: Certain commands should require user approval before executing, even if
// they are permitted by the config.
// Kind: invariant
//
// A recursive force delete never runs without the user seeing it, no matter
// what the config allows. The strongest an allow rule can make it is "ask".
//
// Generators: `dangerous` covers every spelling of recursive-plus-force the
// interviewee worried about (S-3), with and without sudo, against targets
// like "." and "/", with untidy spacing. `harmless` produces rm/ls/git/npm
// commands with at most one of the two flags, and cp/chmod/rsync with both,
// so the downgrade is shown not to leak into ordinary commands. Rulesets mix allow/ask/deny and both "bash" and "*" permissions.
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
const target = fc.constantFrom(".", "/", "*", "node_modules", "src/", "~", "a.txt", "my-dir", "some-file.txt")
// Shell input is not always tidy: pad with stray spaces and sometimes widen
// the gaps between tokens, which is what trim() and the \s+ split absorb.
const spacing = fc.tuple(fc.constantFrom("", " ", "  "), fc.constantFrom(" ", "  "), fc.constantFrom("", " "))
const spaced = (tokens: string[], s: [string, string, string]) => s[0] + tokens.join(s[1]) + s[2]
// rm can be reached through a path or a wrapper; a PR reviewer pointed out
// that only bare "rm" and "sudo rm" were covered.
const program = fc.constantFrom("rm", "sudo rm", "sudo -u me rm", "env rm", "command rm", "/bin/rm", "/usr/bin/rm", "FOO=1 rm")
const dangerous = fc
  .tuple(program, recursiveForce, fc.array(target, { minLength: 1, maxLength: 2 }), spacing)
  .map(([cmd, flags, targets, s]) => spaced([...cmd.split(" "), ...flags.split(" "), ...targets], s))
// Harmless: rm with at most one of the two flags, plus tools that legitimately
// take -rf (cp, chmod, rsync) and must not be downgraded just for the flags.
const harmless = fc.oneof(
  fc
    .tuple(fc.constantFrom("rm", "ls", "git", "npm"), fc.constantFrom("", "-r", "-f", "-v", "-la"), target, spacing)
    .map(([cmd, flags, t, s]) => spaced([cmd, flags, t].filter(Boolean), s)),
  fc
    .tuple(fc.constantFrom("cp", "chmod", "rsync"), recursiveForce, target, spacing)
    .map(([cmd, flags, t, s]) => spaced([cmd, ...flags.split(" "), t], s)),
)

test("R3: rm -rf is never allowed outright, even under a catch-all allow", () => {
  fc.assert(
    fc.property(dangerous, ruleset, (cmd, rules) => {
      const all = [{ permission: "*", pattern: "*", action: "allow" as const }, ...rules]
      const plain = Permission.evaluate("bash", cmd, all)
      // The downgrade changes the action and nothing else; ask and deny pass through untouched.
      expect(Permission.decide("bash", cmd, all)).toEqual(plain.action === "allow" ? { ...plain, action: "ask" } : plain)
    }),
    { numRuns: 300 },
  )
  console.log("R3 invariant property: rm -rf was never allowed outright for 300 runs")
})

test("R3: a deny rule still wins over the dangerous-command downgrade", () => {
  fc.assert(
    fc.property(dangerous, ruleset, (cmd, rules) => {
      const all = [...rules, { permission: "bash", pattern: "*", action: "deny" as const }]
      expect(Permission.decide("bash", cmd, all).action).toBe("deny")
    }),
    { numRuns: 100 },
  )
  console.log("R3 invariant property: deny still won over the downgrade for 100 runs")
})

test("R3: rm with only one of recursive or force is decided purely by the rules", () => {
  // A single flag is ordinary use (rm -r on an empty dir, rm -f on a file) and must not be downgraded.
  const single = fc
    .tuple(fc.constantFrom("rm", "sudo rm"), fc.constantFrom("-r", "-R", "-f", "--recursive", "--force", "-rv", "-fv"), target, spacing)
    .map(([cmd, flag, t, s]) => spaced([...cmd.split(" "), flag, t], s))
  fc.assert(
    fc.property(single, ruleset, (cmd, rules) => {
      const all = [{ permission: "*", pattern: "*", action: "allow" as const }, ...rules]
      expect(Permission.decide("bash", cmd, all)).toEqual(Permission.evaluate("bash", cmd, all))
    }),
    { numRuns: 200 },
  )
  console.log("R3 invariant property: single-flag rm was decided purely by the rules for 200 runs")
})

test("R3: the downgrade applies to bash only; other permissions are decided purely by the rules", () => {
  fc.assert(
    fc.property(fc.constantFrom("edit", "read", "webfetch"), dangerous, ruleset, (perm, cmd, rules) => {
      const all = [{ permission: "*", pattern: "*", action: "allow" as const }, ...rules]
      expect(Permission.decide(perm, cmd, all)).toEqual(Permission.evaluate(perm, cmd, all))
    }),
    { numRuns: 100 },
  )
  console.log("R3 invariant property: non-bash permissions were decided purely by the rules for 100 runs")
})

test("R3: commands that are not recursive force deletes are decided purely by the rules", () => {
  fc.assert(
    fc.property(harmless, ruleset, (cmd, rules) => {
      expect(Permission.decide("bash", cmd, rules)).toEqual(Permission.evaluate("bash", cmd, rules))
    }),
    { numRuns: 300 },
  )
  console.log("R3 invariant property: harmless commands were decided purely by the rules for 300 runs")
})
