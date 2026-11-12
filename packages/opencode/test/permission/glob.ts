import { PermissionV1 } from "@opencode-ai/core/v1/permission"

// Independent reference matcher shared by the R1 and R5 properties: a naive
// character-by-character glob walk, deliberately nothing like the regex
// compilation in Wildcard.match, so a test anchored to it cannot drift along
// with the code under test.
export function glob(str: string, pattern: string): boolean {
  if (pattern === "") return str === ""
  if (pattern[0] === "*") return glob(str, pattern.slice(1)) || (str !== "" && glob(str.slice(1), pattern))
  if (str === "") return false
  if (pattern[0] === "?" || pattern[0] === str[0]) return glob(str.slice(1), pattern.slice(1))
  return false
}

// Mirrors the documented special case: "ls *" also matches a bare "ls".
export function oracleMatch(str: string, pattern: string) {
  if (pattern.endsWith(" *")) return glob(str, pattern) || glob(str, pattern.slice(0, -2))
  return glob(str, pattern)
}

export function oracleEvaluate(permission: string, pattern: string, rules: PermissionV1.Rule[]): PermissionV1.Rule {
  const matched = rules.filter((rule) => oracleMatch(permission, rule.permission) && oracleMatch(pattern, rule.pattern))
  return matched.at(-1) ?? { action: "ask", permission, pattern: "*" }
}
