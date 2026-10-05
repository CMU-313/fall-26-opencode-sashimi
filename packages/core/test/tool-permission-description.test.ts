import { describe, expect, test } from "bun:test"
import { explainPermissionReq } from "@opencode-ai/core/tool/permission-description"

// Unit tests for the pure formatter; tool-level tests cover metadata construction.
describe("explainPermissionReq", () => {
  test("describes read operations using the actual file path", () => {
    expect(explainPermissionReq("read", { path: "src/components/Button.tsx" })).toBe(
      "Agent wants to read the file src/components/Button.tsx",
    )
  })

  test("summarizes write operations by size when content is large", () => {
    const content = ["const a = 1", "const b = 2", "const c = 3", "const d = 4"].join("\n")
    expect(explainPermissionReq("write", { path: "app.js", content })).toBe("Agent wants to write 4 lines to app.js")
  })

  test("describes edit operations without dumping the diff", () => {
    expect(explainPermissionReq("edit", { path: "src/app.ts", oldString: "const a = 1", newString: "const a = 2" })).toBe(
      "Agent wants to edit src/app.ts",
    )
  })

  test("describes apply-patch metadata using its target path", () => {
    expect(explainPermissionReq("edit", { path: "src/app.ts", patchText: "*** Begin Patch" })).toBe(
      "Agent wants to edit src/app.ts",
    )
  })

  test("summarizes long shell commands with a safe truncation", () => {
    const command = [
      "npm",
      "install",
      "react",
      "react-dom",
      "@types/react",
      "--save",
      "--verbose",
      "--legacy-peer-deps",
    ].join(" ")
    const result = explainPermissionReq("bash", { command })
    expect(result.startsWith("Agent wants to run: ")).toBe(true)
    expect(result).toContain("npm install react")
    expect(result).not.toContain("\n")
    expect(result.length).toBeLessThanOrEqual(120)
  })

  test("truncates long paths while retaining the filename", () => {
    const path = `src/${"long-directory/".repeat(12)}Button.tsx`
    const result = explainPermissionReq("read", { path })
    expect(result).toContain("…/Button.tsx")
    expect(result.length).toBeLessThanOrEqual(120)
  })

  test("keeps grapheme clusters intact when truncating commands", () => {
    const command = `npm ${"👨‍👩‍👧‍👦".repeat(20)}`
    const result = explainPermissionReq("bash", { command })
    const summary = result.slice("Agent wants to run: ".length).replace(/…$/, "")
    const boundaries = new Set<number>()
    let offset = 0
    for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(command)) {
      offset += segment.length
      boundaries.add(offset)
    }
    expect(boundaries.has(summary.length)).toBe(true)
  })

  test("describes search, web, todo, and named skill actions", () => {
    const cases = [
      ["glob", { pattern: "**/*.ts" }, "Agent wants to find files matching **/*.ts"],
      ["grep", { pattern: "needle" }, "Agent wants to search for needle"],
      ["webfetch", { url: "https://example.test/docs" }, "Agent wants to fetch https://example.test/docs"],
      ["websearch", { query: "effect docs" }, "Agent wants to search the web for effect docs"],
      ["todowrite", {}, "Agent wants to update the todo list"],
      ["skill", { name: "effect" }, "Agent wants to load the skill effect"],
    ] as const
    for (const [permission, metadata, expected] of cases) {
      expect(explainPermissionReq(permission, metadata)).toBe(expected)
    }
  })

  test("handles empty and missing arguments gracefully", () => {
    expect(explainPermissionReq("read", {})).toBe("Agent wants to read a file")
    expect(explainPermissionReq("write", { input: {} })).toBe("Agent wants to write a file")
    expect(explainPermissionReq("skill", {})).toBe("Agent wants to load a skill")
  })

  test("sanitizes multiline arguments and unknown tools", () => {
    expect(
      explainPermissionReq("write", { path: "notes.txt", content: "first line\nsecond line\nthird line" }),
    ).toBe("Agent wants to write 3 lines to notes.txt")
    expect(explainPermissionReq("custom_tool", { command: "echo \"hi\nthere\"" })).toContain(
      "Agent wants to run custom_tool",
    )
    expect(explainPermissionReq("custom_tool", { command: "echo \"hi\nthere\"" })).not.toContain("\n")
  })
})
