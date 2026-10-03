import { expect, test } from "bun:test"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { tmpdir } from "../fixture/fixture"
import { mount, wait, waitAsync } from "./bookmark-fixture"
import { loadBookmarks, saveBookmarks, type LocalBookmark } from "../../src/context/local"

// These are true end-to-end tests: they mount the real provider stack
// LocalProvider runs inside in the actual app (SDKProvider, SyncProvider,
// RouteProvider, etc. - see src/app.tsx), against a real bookmark.json on a
// real temp directory. Unlike the pure-function tests in local.test.ts and
// the loadBookmarks/saveBookmarks/mergeBookmarks tests in
// bookmark-persistence.test.ts, these prove the actual wiring between them -
// a real SDK event triggering a real prune-and-save, and two independently
// reactive sessions actually sharing one file - works correctly, not just
// the extracted logic in isolation.

function deletedEvent(sessionID: string, directory: string): GlobalEvent {
  return {
    directory,
    project: "proj_test",
    workspace: undefined,
    payload: {
      id: `evt_${sessionID}`,
      type: "session.deleted",
      properties: {
        sessionID,
        info: { id: sessionID } as never,
      },
    },
  }
}

test("a real session.deleted event prunes that session's bookmarks and persists the change to disk", async () => {
  await using tmp = await tmpdir()
  const filePath = `${tmp.path}/bookmark.json`
  const bookmark: LocalBookmark = {
    id: "msg_a",
    sessionID: "session_to_delete",
    sessionTitle: "Doomed session",
    text: "a response",
    createdAt: 1,
  }
  await saveBookmarks(filePath, [bookmark])

  const { app, emit, local } = await mount(tmp.path)
  try {
    await wait(() => local.bookmark.list().length === 1)
    expect(local.bookmark.list().map((b) => b.id)).toEqual(["msg_a"])

    emit(deletedEvent("session_to_delete", tmp.path))

    // The in-memory list updates synchronously inside the event handler...
    await wait(() => local.bookmark.list().length === 0)

    // ...and the save it triggers is fire-and-forget, so the write to the
    // real file happens slightly after - confirm it actually lands on disk,
    // not just in the reactive store.
    await waitAsync(async () => (await loadBookmarks(filePath)).length === 0)
  } finally {
    app.renderer.destroy()
  }
})

test("a session.deleted event for an unrelated session leaves bookmarks untouched", async () => {
  await using tmp = await tmpdir()
  const filePath = `${tmp.path}/bookmark.json`
  const bookmark: LocalBookmark = {
    id: "msg_a",
    sessionID: "session_still_alive",
    sessionTitle: "Still here",
    text: "a response",
    createdAt: 1,
  }
  await saveBookmarks(filePath, [bookmark])

  const { app, emit, local } = await mount(tmp.path)
  try {
    await wait(() => local.bookmark.list().length === 1)

    emit(deletedEvent("some_other_session", tmp.path))
    await Bun.sleep(50)

    expect(local.bookmark.list().map((b) => b.id)).toEqual(["msg_a"])
  } finally {
    app.renderer.destroy()
  }
})

test("two TUI sessions open at once, each bookmarking a different response, both survive", async () => {
  await using tmp = await tmpdir()
  const filePath = `${tmp.path}/bookmark.json`

  const session1 = await mount(tmp.path)
  const session2 = await mount(tmp.path)

  try {
    // Both sessions start from the same (empty) file.
    await wait(() => session1.local.bookmark.list().length === 0)
    await wait(() => session2.local.bookmark.list().length === 0)

    // Session 1 bookmarks response "a" and saves.
    await session1.local.bookmark.toggle({
      id: "a",
      sessionID: "session-1",
      sessionTitle: "Session 1",
      text: "response a",
    })

    // Session 2, unaware of session 1's save, bookmarks a *different*
    // response, "b". Without merge-on-save, session 2's write would
    // silently wipe out "a".
    await session2.local.bookmark.toggle({
      id: "b",
      sessionID: "session-2",
      sessionTitle: "Session 2",
      text: "response b",
    })

    // Session 2's own view picks up both immediately, since its save()
    // re-read the file and merged before writing.
    expect(session2.local.bookmark.list().map((b) => b.id).sort()).toEqual(["a", "b"])

    // The file on disk has both, not just whichever session wrote last.
    const onDisk = await loadBookmarks(filePath)
    expect(onDisk.map((b) => b.id).sort()).toEqual(["a", "b"])

    // Session 1 doesn't find out about "b" until it does something that
    // triggers another save - a known limitation (no live file-watching)
    // called out in the user guide. Confirm that it does catch up then.
    expect(session1.local.bookmark.list().map((b) => b.id)).toEqual(["a"])
    await session1.local.bookmark.rename("a", "My bookmark")
    expect(session1.local.bookmark.list().map((b) => b.id).sort()).toEqual(["a", "b"])
  } finally {
    session1.app.renderer.destroy()
    session2.app.renderer.destroy()
  }
})
