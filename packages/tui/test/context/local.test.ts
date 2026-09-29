import { expect, test } from "bun:test"
import {
  parseModel,
  recentModels,
  removeBookmark,
  renameBookmark,
  toggleBookmark,
  type LocalBookmark,
} from "../../src/context/local"

test("parses model IDs containing slashes", () => {
  expect(parseModel("provider/family/model")).toEqual({
    providerID: "provider",
    modelID: "family/model",
  })
})

test("moves a model to the front, deduplicates, and limits recents", () => {
  const recent = Array.from({ length: 12 }, (_, index) => ({
    providerID: "provider",
    modelID: `model-${index}`,
  }))

  expect(recentModels({ providerID: "provider", modelID: "model-5" }, recent)).toEqual([
    { providerID: "provider", modelID: "model-5" },
    ...recent.slice(0, 5),
    ...recent.slice(6, 10),
  ])
})

function makeBookmark(id: string): Omit<LocalBookmark, "createdAt"> {
  return { id, sessionID: `session-${id}`, sessionTitle: "Session", text: `response ${id}` }
}

test("bookmarking a response adds it to the list", () => {
  const result = toggleBookmark([], makeBookmark("a"))
  expect(result.result).toBe("added")
  expect(result.items.map((item) => item.id)).toEqual(["a"])
})

test("bookmarking the same response twice does not create a duplicate", () => {
  const first = toggleBookmark([], makeBookmark("a"))
  const second = toggleBookmark(first.items, makeBookmark("a"))
  expect(second.result).toBe("removed")
  expect(second.items).toEqual([])
})

test("removing a bookmark only removes the matching one, leaving the rest intact", () => {
  const items: LocalBookmark[] = [
    { ...makeBookmark("a"), createdAt: 1 },
    { ...makeBookmark("b"), createdAt: 2 },
    { ...makeBookmark("c"), createdAt: 3 },
  ]

  expect(removeBookmark(items, "b").map((item) => item.id)).toEqual(["a", "c"])
})

test("removing a bookmark that doesn't exist leaves the list unchanged", () => {
  const items: LocalBookmark[] = [{ ...makeBookmark("a"), createdAt: 1 }]
  expect(removeBookmark(items, "nonexistent")).toEqual(items)
})

test("renaming a bookmark sets its name and leaves others untouched", () => {
  const items: LocalBookmark[] = [
    { ...makeBookmark("a"), createdAt: 1 },
    { ...makeBookmark("b"), createdAt: 2 },
  ]

  const renamed = renameBookmark(items, "a", "Important answer")
  expect(renamed.find((item) => item.id === "a")?.name).toBe("Important answer")
  expect(renamed.find((item) => item.id === "b")?.name).toBeUndefined()
})

test("renaming a bookmark trims whitespace and clearing the name removes it", () => {
  const items: LocalBookmark[] = [{ ...makeBookmark("a"), createdAt: 1 }]

  const renamed = renameBookmark(items, "a", "  Padded name  ")
  expect(renamed[0].name).toBe("Padded name")

  const cleared = renameBookmark(renamed, "a", "   ")
  expect(cleared[0].name).toBeUndefined()
})
