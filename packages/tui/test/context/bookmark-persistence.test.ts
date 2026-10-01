import { afterEach, beforeEach, expect, test } from "bun:test"
import path from "path"
import { mkdtemp, rm, writeFile, readFile } from "fs/promises"
import { tmpdir } from "os"
import { loadBookmarks, mergeBookmarks, saveBookmarks, type LocalBookmark } from "../../src/context/local"

// These tests exercise the real filesystem (a temp directory per test), not
// mocked file I/O - that's the point. The unit tests on isMissingFileError
// only prove the error classifier is correct; these prove the actual
// save/load/corruption-recovery behavior built on top of it works end to end.

let dir: string
let filePath: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "bookmark-persistence-"))
  filePath = path.join(dir, "bookmark.json")
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function makeBookmark(id: string): LocalBookmark {
  return { id, sessionID: `session-${id}`, sessionTitle: "Session", text: `response ${id}`, createdAt: 1 }
}

test("loading bookmarks before any file exists returns an empty list, not an error", async () => {
  expect(await loadBookmarks(filePath)).toEqual([])
})

test("a saved bookmark can be loaded back, surviving a save/load round trip", async () => {
  const items = [makeBookmark("a"), makeBookmark("b")]
  await saveBookmarks(filePath, items)

  expect(await loadBookmarks(filePath)).toEqual(items)
})

test("saving again (simulating a restart and a new change) overwrites the previous contents", async () => {
  await saveBookmarks(filePath, [makeBookmark("a")])
  await saveBookmarks(filePath, [makeBookmark("a"), makeBookmark("b")])

  expect(await loadBookmarks(filePath)).toEqual([makeBookmark("a"), makeBookmark("b")])
})

test("a corrupted bookmark.json is backed up instead of silently discarded", async () => {
  await writeFile(filePath, "{ this is not valid json ]]]")

  const items = await loadBookmarks(filePath)
  expect(items).toEqual([])

  // The original broken file must not just vanish - it should be renamed
  // aside so nothing is silently lost, and nothing else should be left
  // sitting at the original bookmark.json path.
  const { readdir } = await import("fs/promises")
  const entries = await readdir(dir)
  expect(entries).not.toContain("bookmark.json")
  const backup = entries.find((name) => name.startsWith("bookmark.json.corrupt-"))
  expect(backup).toBeDefined()

  const backedUpContent = await readFile(path.join(dir, backup!), "utf8")
  expect(backedUpContent).toBe("{ this is not valid json ]]]")
})

test("a bookmark.json containing an unexpected shape (not {items: [...]}) is treated as empty, not thrown", async () => {
  await writeFile(filePath, JSON.stringify({ notItems: "surprise" }))
  expect(await loadBookmarks(filePath)).toEqual([])
})

test("entries that don't look like real bookmarks are filtered out on load", async () => {
  await writeFile(
    filePath,
    JSON.stringify({
      items: [makeBookmark("a"), { id: "bad", missingFields: true }, makeBookmark("b")],
    }),
  )

  expect(await loadBookmarks(filePath)).toEqual([makeBookmark("a"), makeBookmark("b")])
})

test("after recovering from a corrupted file, saving creates a fresh valid bookmark.json", async () => {
  await writeFile(filePath, "not json at all")
  await loadBookmarks(filePath)

  await saveBookmarks(filePath, [makeBookmark("a")])
  expect(await loadBookmarks(filePath)).toEqual([makeBookmark("a")])
})

test("two sessions bookmarking different responses around the same time both survive, simulating two TUIs open at once", async () => {
  // Session 1 starts with an empty file and loads its baseline.
  const session1Base = await loadBookmarks(filePath)
  expect(session1Base).toEqual([])

  // Session 2 opens a moment later and loads the same (still empty) baseline.
  const session2Base = await loadBookmarks(filePath)
  expect(session2Base).toEqual([])

  // Session 1 bookmarks response "a" and saves - merging its baseline against
  // whatever's currently on disk (still nothing).
  const session1Items = [makeBookmark("a")]
  const session1OnDisk = await loadBookmarks(filePath)
  const session1Merged = mergeBookmarks(session1Base, session1Items, session1OnDisk)
  await saveBookmarks(filePath, session1Merged)

  // Session 2, unaware of session 1's save, bookmarks response "b" and saves.
  // Without merge-on-save this write would silently wipe out "a".
  const session2Items = [makeBookmark("b")]
  const session2OnDisk = await loadBookmarks(filePath)
  const session2Merged = mergeBookmarks(session2Base, session2Items, session2OnDisk)
  await saveBookmarks(filePath, session2Merged)

  const final = await loadBookmarks(filePath)
  expect(final.map((item) => item.id).sort()).toEqual(["a", "b"])
})
