import { describe, expect, test } from "bun:test"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import fc from "fast-check"
import {
  createPermissionBodyState,
  permissionAlwaysLines,
  permissionCancel,
  permissionEscape,
  permissionInfo,
  permissionLabel,
  permissionOptions,
  permissionReject,
  permissionRun,
} from "@/cli/cmd/run/permission.shared"

fc.configureGlobal({ seed: 42 })

function req(input: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    id: "perm-1",
    sessionID: "session-1",
    permission: "read",
    patterns: [],
    metadata: {},
    always: [],
    ...input,
  }
}

describe("run permission shared", () => {
  const filename = fc.stringMatching(/^[a-z][a-z0-9_-]{0,20}\.tsx$/)
  const mixedCaseFilename = fc.stringMatching(/^[A-Z][a-zA-Z0-9_-]{0,20}\.tsx$/)
  const relativePath = (name: string) => `src/components/${name}`

  test("R2: descriptions identify the requested read, write, or edit action", () => {
    // R2: The description must state the action type (read, write, or edit) and match the requested permission.
    // Kind: model/oracle. Generate each supported action and varied target paths; the expected action is the oracle.
    fc.assert(
      fc.property(fc.constantFrom("read", "write", "edit"), filename, (action, name) => {
        const filepath = relativePath(name)
        const info = permissionInfo(
          req({
            permission: action === "read" ? "read" : "edit",
            patterns: [filepath],
            metadata: {
              filepath,
              operation: action,
              exists: true,
            },
          }),
        )

        expect(info.title.startsWith(`${action[0]?.toUpperCase()}${action.slice(1)} `)).toBe(true)
      }),
    )
    console.log("R2 property passed: action wording matches the requested action")
  })

  test("R3: descriptions name the requested file and not a different file", () => {
    // R3: The description must name the specific file the tool call is requesting.
    // Kind: invariant. Distinct generated basenames ensure the property catches stale filenames.
    fc.assert(
      fc.property(mixedCaseFilename, mixedCaseFilename, (requested, other) => {
        fc.pre(requested !== other)
        const requestedName = `requested-${requested}`
        const otherName = `other-${other}`
        const info = permissionInfo(req({ permission: "read", patterns: [relativePath(requestedName)] }))

        expect(info.title).toContain(requestedName)
        expect(info.title).not.toContain(otherName)
      }),
    )
    console.log("R3 property passed: descriptions name the requested file")
  })

  test("R4: changing only a read path preserves the description shape and approval controls", () => {
    // R4: When only the requested file changes, the rest of the description and control options must remain identical.
    // Kind: metamorphic. Vary the paths and stage while checking each stage's expected controls.
    fc.assert(
      fc.property(filename, filename, fc.constantFrom("permission", "always"), (first, second, stage) => {
        fc.pre(first !== second)
        const firstPath = relativePath(first)
        const secondPath = relativePath(second)
        const firstInfo = permissionInfo(req({ permission: "read", patterns: [firstPath] }))
        const secondInfo = permissionInfo(req({ permission: "read", patterns: [secondPath] }))
        const removePath = (value: typeof firstInfo, filepath: string) => JSON.stringify(value).replaceAll(filepath, "")
        const firstControls = permissionOptions(stage).map(permissionLabel)
        const secondControls = permissionOptions(stage).map(permissionLabel)
        const expectedControls =
          stage === "permission" ? ["Allow once", "Allow always", "Reject"] : ["Confirm", "Cancel"]

        expect(removePath(firstInfo, firstPath)).toBe(removePath(secondInfo, secondPath))
        expect(firstControls).toEqual(secondControls)
        expect(firstControls).toEqual(expectedControls)
      }),
    )
    console.log("R4 property passed: changing the read path preserves description shape and controls at each stage")
  })

  test("R5: write descriptions report content size without exposing written content", () => {
    // R5: A write description must summarize content by size and must not display content or narrate line changes.
    // Kind: invariant. Non-empty generated lines exercise singular/plural sizes and ensure real content stays hidden.
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[A-Z]{5,20}$/), { minLength: 1, maxLength: 30 }),
        filename,
        (lines, name) => {
          const content = lines.join("\n")
          const info = permissionInfo(
            req({
              permission: "edit",
              patterns: [relativePath(name)],
              metadata: {
                filepath: relativePath(name),
                operation: "write",
                lineCount: lines.length,
                diff: content,
              },
            }),
          )

          expect(info.title).toContain(name)
          expect(info.lines).toEqual([`Content: ${lines.length} line${lines.length === 1 ? "" : "s"}`])
          expect(info.diff).toBeUndefined()
          expect(JSON.stringify(info)).not.toContain(content)
          for (const line of lines) {
            expect(JSON.stringify(info)).not.toContain(line)
          }
        },
      ),
    )

    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[A-Z]{5,20}$/), { minLength: 1, maxLength: 30 }),
        filename,
        (lines, name) => {
          const filepath = relativePath(name)
          const content = lines.join("\n")
          const info = permissionInfo(
            req({
              permission: "edit",
              patterns: [filepath],
              metadata: {
                filepath,
                operation: "write",
                diff: content,
              },
            }),
          )

          expect(info.lines).toEqual([])
          expect(info.diff).toBeUndefined()
          expect(JSON.stringify(info)).not.toContain(content)
        },
      ),
    )
    console.log("R5 property passed: write descriptions summarize content without exposing it")
  })

  test("R5-PRIVACY: write content must not appear in description and diff must not be exposed", () => {
    // R5 privacy: generated write content must not appear in permission description, and write diff must not be exposed.
    // Kind: invariant. Property specific to privacy aspect of R5 - ensures content and diffs are hidden.
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[A-Z]{5,20}$/), { minLength: 1, maxLength: 30 }),
        filename,
        (lines, name) => {
          const content = lines.join("\n")
          const filepath = relativePath(name)
          const info = permissionInfo(
            req({
              permission: "edit",
              patterns: [filepath],
              metadata: {
                filepath,
                operation: "write",
                lineCount: lines.length,
                diff: content,
              },
            }),
          )

          // Privacy: generated write content must not appear in the permission description
          expect(JSON.stringify(info)).not.toContain(content)
          for (const line of lines) {
            expect(JSON.stringify(info)).not.toContain(line)
          }

          // Privacy: write diff must not be exposed
          expect(info.diff).toBeUndefined()
          expect(info.lines).toEqual([`Content: ${lines.length} line${lines.length === 1 ? "" : "s"}`])
          // Also reject title narration of individual line changes.
          expect(info.title).toBe(`Write existing file ${filepath}`)
        },
      ),
    )
    console.log("R5-PRIVACY property passed: write content and diff are fully hidden")
  })

  test("R6: write descriptions distinguish new files from existing files", () => {
    // R6: A write permission explanation must identify whether it creates a new file or modifies an existing file.
    // Kind: metamorphic. Compare requests for the same generated path while changing only whether it exists.
    fc.assert(
      fc.property(filename, (name) => {
        const filepath = relativePath(name)
        const create = permissionInfo(
          req({
            permission: "edit",
            patterns: [filepath],
            metadata: { filepath, operation: "write", exists: false, lineCount: 1, diff: "+new file" },
          }),
        )
        const modify = permissionInfo(
          req({
            permission: "edit",
            patterns: [filepath],
            metadata: { filepath, operation: "write", exists: true, lineCount: 1, diff: "-old\n+new" },
          }),
        )
        const createControls = permissionOptions("permission").map(permissionLabel)
        const modifyControls = permissionOptions("permission").map(permissionLabel)

        expect(create.title).toBe(`Write new file ${filepath}`)
        expect(modify.title).toBe(`Write existing file ${filepath}`)
        expect(create.diff).toBeUndefined()
        expect(modify.diff).toBeUndefined()
        expect(createControls).toEqual(modifyControls)
        expect(createControls).toEqual(["Allow once", "Allow always", "Reject"])
      }),
    )
    console.log("R6 property passed: write descriptions distinguish new from existing files")
  })

  test("replies immediately for allow once", () => {
    const out = permissionRun(createPermissionBodyState("perm-1"), "perm-1", "once")

    expect(out.reply).toEqual({
      requestID: "perm-1",
      reply: "once",
    })
  })

  test("requires confirmation for allow always", () => {
    const next = permissionRun(createPermissionBodyState("perm-1"), "perm-1", "always")
    expect(next.state.stage).toBe("always")
    expect(next.state.selected).toBe("confirm")
    expect(next.reply).toBeUndefined()

    expect(permissionRun(next.state, "perm-1", "confirm").reply).toEqual({
      requestID: "perm-1",
      reply: "always",
    })

    expect(permissionRun(next.state, "perm-1", "cancel").state).toMatchObject({
      stage: "permission",
      selected: "always",
    })
  })

  test("builds trimmed reject replies and stage transitions", () => {
    const next = permissionRun(createPermissionBodyState("perm-1"), "perm-1", "reject")
    expect(next.state.stage).toBe("reject")

    const out = permissionReject({ ...next.state, message: "  use rg  " }, "perm-1")
    expect(out).toEqual({
      requestID: "perm-1",
      reply: "reject",
      message: "use rg",
    })

    expect(permissionCancel(next.state)).toMatchObject({
      stage: "permission",
      selected: "reject",
    })

    expect(permissionEscape(createPermissionBodyState("perm-1"))).toMatchObject({
      stage: "reject",
      selected: "reject",
    })

    expect(permissionEscape({ ...next.state, stage: "always", selected: "confirm" })).toMatchObject({
      stage: "permission",
      selected: "always",
    })
  })

  test("maps supported permission types into display info", () => {
    expect(
      permissionInfo(
        req({
          permission: "bash",
          metadata: {
            input: {
              command: "git status --short",
            },
          },
        }),
      ),
    ).toMatchObject({
      title: "Shell command",
      lines: ["$ git status --short"],
    })

    expect(
      permissionInfo(
        req({
          permission: "task",
          metadata: {
            description: "investigate stream",
            subagent_type: "general",
          },
        }),
      ),
    ).toMatchObject({
      title: "General Task",
      lines: ["◉ investigate stream"],
    })

    expect(
      permissionInfo(
        req({
          permission: "external_directory",
          patterns: ["/tmp/work/**/*.ts", "/tmp/work/**/*.tsx"],
        }),
      ),
    ).toMatchObject({
      title: "Access external directory /tmp/work",
      lines: ["- /tmp/work/**/*.ts", "- /tmp/work/**/*.tsx"],
    })

    expect(permissionInfo(req({ permission: "doom_loop" }))).toMatchObject({
      title: "Continue after repeated failures",
    })

    expect(permissionInfo(req({ permission: "custom_tool" }))).toMatchObject({
      title: "Call tool custom_tool",
      lines: ["Tool: custom_tool"],
    })
  })

  test("formats always-allow copy for wildcard and explicit patterns", () => {
    expect(permissionAlwaysLines(req({ permission: "bash", always: ["*"] }))).toEqual([
      "This will allow bash until OpenCode is restarted.",
    ])

    expect(permissionAlwaysLines(req({ always: ["src/**/*.ts", "src/**/*.tsx"] }))).toEqual([
      "This will allow the following patterns until OpenCode is restarted.",
      "- src/**/*.ts",
      "- src/**/*.tsx",
    ])
  })
})
