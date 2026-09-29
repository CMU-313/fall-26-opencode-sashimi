import { expect, test } from "bun:test"
import { pruneBookmarksForSession, type LocalBookmark } from "../../src/context/local"

function makeBookmark(id: string, sessionID: string): LocalBookmark {
  return { id, sessionID, sessionTitle: "Session", text: `response ${id}`, createdAt: 1 }
}

test("removes every bookmark belonging to the deleted session", () => {
  const items: LocalBookmark[] = [
    makeBookmark("a", "session-1"),
    makeBookmark("b", "session-1"),
    makeBookmark("c", "session-2"),
  ]

  const result = pruneBookmarksForSession(items, "session-1")
  expect(result.map((item) => item.id)).toEqual(["c"])
})

test("leaves bookmarks from other sessions untouched", () => {
  const items: LocalBookmark[] = [makeBookmark("a", "session-1"), makeBookmark("b", "session-2")]

  const result = pruneBookmarksForSession(items, "session-1")
  expect(result).toEqual([items[1]])
})

test("pruning a session with no bookmarks leaves the list unchanged", () => {
  const items: LocalBookmark[] = [makeBookmark("a", "session-1")]

  const result = pruneBookmarksForSession(items, "session-does-not-exist")
  expect(result).toEqual(items)
})
