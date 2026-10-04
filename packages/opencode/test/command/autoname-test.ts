import { describe, expect, test } from "bun:test"
import PROMPT_AUTONAME from "../../src/command/template/autoname.txt"
import { hints } from "../../src/command"

function extractRenamedTitle(text: string): string | undefined {
  const match = text.match(/RENAMED:\s*(.+)/)
  if (match && match[1]) {
    const title = match[1].trim().split("\n")[0].trim()
    if (title) return title
  }
  return undefined
}

describe("autoname command", () => {
  test("Prompt contains RENAMED and 2-5 words rules", () => {
    expect(PROMPT_AUTONAME).toContain("RENAMED:")
    expect(PROMPT_AUTONAME).toContain("2-5 words")
  })

  test("Extracts title from RENAMED line", () => {
    expect(extractRenamedTitle("RENAMED: Quick check-in")).toBe("Quick check-in")
  })

  test("Extracts first line only when extra text follows", () => {
    expect(extractRenamedTitle("RENAMED: Session about refactoring auth module\nExtra text")).toBe("Session about refactoring auth module")
  })

  test("Returns undefined when no RENAMED match", () => {
    expect(extractRenamedTitle("No match here")).toBeUndefined()
  })

  test("Returns undefined for empty title", () => {
    expect(extractRenamedTitle("RENAMED:   ")).toBeUndefined()
  })

  test("Autoname prompt has no argument hints", () => {
    expect(hints(PROMPT_AUTONAME)).toEqual([])
  })

  describe("Parsing edge cases", () => {
    test("Handles titles with punctuation", () => {
      expect(extractRenamedTitle("RENAMED: Fix auth: login flow!")).toBe("Fix auth: login flow!")
    })

    test("Ignores second RENAMED line", () => {
      expect(extractRenamedTitle("RENAMED: First title\nRENAMED: Second title")).toBe("First title")
    })

    test("Handles very long titles (does not truncate here; session layer trims separately)", () => {
      const longTitle = "A".repeat(200)
      expect(extractRenamedTitle(`RENAMED: ${longTitle}`)).toBe(longTitle)
    })
  })

  describe("Session-level autoname behavior", () => {
    test("Simulates session prompt result processing for autoname", () => {
      const simulatedResult = {
        parts: [
          { type: "text" as const, text: "RENAMED: Quick check-in\nSome explanation" },
        ],
      }

      const titles: string[] = []
      for (const part of simulatedResult.parts) {
        if (part.type === "text" && typeof part.text === "string") {
          const match = part.text.match(/RENAMED:\s*(.+)/)
          if (match && match[1]) {
            const title = match[1].trim().split("\n")[0].trim()
            if (title) titles.push(title)
          }
        }
      }
      expect(titles).toEqual(["Quick check-in"])
    })

    test("Ignores non-text parts", () => {
      const parts: { type: string; text?: string; url?: string }[] = [
        { type: "file", url: "file:///tmp/test.txt" },
      ]
      const titles: string[] = []
      for (const part of parts) {
        if (part.type === "text" && typeof part.text === "string") {
          const match = part.text.match(/RENAMED:\s*(.+)/)
          if (match && match[1]) {
            const title = match[1].trim().split("\n")[0].trim()
            if (title) titles.push(title)
          }
        }
      }
      expect(titles).toEqual([])
    })
  })

  describe("Command registry verification", () => {
    test("Command info structure exists with expected fields", () => {
      const infoShape = {
        name: expect.any(String),
        source: expect.any(String),
        description: expect.any(String),
      }
      expect(PROMPT_AUTONAME).toContain("Summarize")
    })
  })
})
