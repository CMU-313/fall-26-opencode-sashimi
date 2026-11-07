import { describe, it, expect } from "bun:test"
import fc from "fast-check"
import { addBookmark, type LocalBookmark } from "../../src/context/local"

fc.configureGlobal({ seed: 42 })

const bookmarkArb = fc.record({
  id: fc.string({ minLength: 1 }),
  sessionID: fc.string({ minLength: 1 }),
  sessionTitle: fc.string({ minLength: 1 }),
  text: fc.string(),
  // Changed from fc.option(fc.string()) so names are undefined, not null, to
  // match the LocalBookmark type (needed for typecheck in CI).
  name: fc.option(fc.string(), { nil: undefined }),
})

describe("R4: addBookmark - duplicate handling", () => {
  it("bookmarking an already bookmarked response never creates a second entry and returns exists", () => {
    fc.assert(
      fc.property(bookmarkArb, (entry) => {
        const items: LocalBookmark[] = []
        const firstResult = addBookmark(items, entry)
        expect(firstResult.result).toBe("added")
        expect(firstResult.items).toHaveLength(1)
        expect(firstResult.existing).toBeUndefined()

        const secondResult = addBookmark(firstResult.items, entry)
        expect(secondResult.result).toBe("exists")
        expect(secondResult.items).toHaveLength(1)
        expect(secondResult.existing).toBeDefined()
        expect(secondResult.existing?.id).toBe(entry.id)
      })
    )
  })
})

// Strengthened version (P5 agent failure case). The property above, written by
// opencode, let mutant H3 survive (addBookmark matching by text instead of
// message id): it always starts from an empty list and only ever re-adds the
// same entry, so "same message" and "same text" look identical. This version
// starts from an existing list and also adds a *different* response that has
// the same text, which must get its own entry.
describe("R4: addBookmark - duplicate handling (strengthened)", () => {
  it("re-adding the same response says exists, but a different response with the same text is added", () => {
    fc.assert(
      fc.property(fc.uniqueArray(bookmarkArb, { selector: (b) => b.id, maxLength: 10 }), bookmarkArb, (others, entry) => {
        const start = others
          .filter((b) => b.id !== entry.id && b.id !== `${entry.id}-copy`)
          .map((b) => ({ ...b, name: b.name ?? undefined, createdAt: 0 }))
        const response = { ...entry, name: entry.name ?? undefined }

        const first = addBookmark(start, response)
        expect(first.result).toBe("added")
        expect(first.items).toHaveLength(start.length + 1)

        const second = addBookmark(first.items, response)
        expect(second.result).toBe("exists")
        expect(second.items).toEqual(first.items)
        expect(second.existing?.id).toBe(response.id)

        // A different message whose text happens to be identical.
        const sameText = { ...response, id: `${response.id}-copy` }
        const third = addBookmark(second.items, sameText)
        expect(third.result).toBe("added")
        expect(third.items).toHaveLength(first.items.length + 1)
      }),
    )
  })
})
