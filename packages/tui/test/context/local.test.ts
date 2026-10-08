import { expect, test } from "bun:test"
import {
  parseModel,
  recentModels,
  mergeBookmarks,
  removeBookmark,
  renameBookmark,
  sortBookmarks,
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

test("the saved list shows the newest bookmark first", () => {
  const items: LocalBookmark[] = [
    { ...makeBookmark("a"), createdAt: 1 },
    { ...makeBookmark("b"), createdAt: 3 },
    { ...makeBookmark("c"), createdAt: 2 },
  ]

  expect(sortBookmarks(items).map((item) => item.id)).toEqual(["b", "c", "a"])
})

test("the saved list no longer shows a bookmark once it's removed", () => {
  const afterAdd = toggleBookmark([], makeBookmark("a")).items
  const afterRemove = removeBookmark(afterAdd, "a")

  expect(sortBookmarks(afterRemove)).toEqual([])
})

test("sorting the saved list does not mutate the original array", () => {
  const items: LocalBookmark[] = [
    { ...makeBookmark("a"), createdAt: 1 },
    { ...makeBookmark("b"), createdAt: 2 },
  ]

  sortBookmarks(items)
  expect(items.map((item) => item.id)).toEqual(["a", "b"])
})

// mergeBookmarks is what keeps two TUI sessions open at once from clobbering
// each other's bookmarks when they both save around the same time - without
// it, whichever session's save() ran last would silently overwrite the file
// with only its own in-memory list.
test("a bookmark added by another TUI session is picked up, not lost", () => {
  const base = [makeBookmark("a")].map((b) => ({ ...b, createdAt: 1 }))
  const mine = base // this session hasn't changed anything
  const theirs = [...base, { ...makeBookmark("b"), createdAt: 2 }] // the other session added "b"

  expect(mergeBookmarks(base, mine, theirs).map((item) => item.id).sort()).toEqual(["a", "b"])
})

test("a bookmark this session adds is kept even if the other session hasn't seen it yet", () => {
  const base = [{ ...makeBookmark("a"), createdAt: 1 }]
  const mine = [...base, { ...makeBookmark("b"), createdAt: 2 }] // this session added "b"
  const theirs = base // the other session's copy is still the old one

  expect(mergeBookmarks(base, mine, theirs).map((item) => item.id).sort()).toEqual(["a", "b"])
})

test("removing a bookmark locally is not undone by the other session's stale copy still having it", () => {
  const base = [{ ...makeBookmark("a"), createdAt: 1 }]
  const mine: LocalBookmark[] = [] // this session removed "a"
  const theirs = base // the other session hasn't removed it on their end

  expect(mergeBookmarks(base, mine, theirs)).toEqual([])
})

test("a bookmark removed by the other session is not resurrected by this session's stale copy", () => {
  const base = [{ ...makeBookmark("a"), createdAt: 1 }]
  const mine = base // this session hasn't touched it
  const theirs: LocalBookmark[] = [] // the other session removed it

  expect(mergeBookmarks(base, mine, theirs)).toEqual([])
})

test("both sessions adding different bookmarks at once keeps both, order aside", () => {
  const base: LocalBookmark[] = []
  const mine = [{ ...makeBookmark("a"), createdAt: 1 }]
  const theirs = [{ ...makeBookmark("b"), createdAt: 2 }]

  expect(mergeBookmarks(base, mine, theirs).map((item) => item.id).sort()).toEqual(["a", "b"])
})

test("a rename in this session wins over the other session's unchanged copy of the same bookmark", () => {
  const base = [{ ...makeBookmark("a"), createdAt: 1 }]
  const mine = [{ ...base[0], name: "My new name" }]
  const theirs = base // the other session still has the old (unnamed) copy

  expect(mergeBookmarks(base, mine, theirs)).toEqual(mine)
})

test("both sessions unchanged since base merges back to exactly the same list", () => {
  const base = [{ ...makeBookmark("a"), createdAt: 1 }, { ...makeBookmark("b"), createdAt: 2 }]

  expect(mergeBookmarks(base, base, base).map((item) => item.id).sort()).toEqual(["a", "b"])
})
