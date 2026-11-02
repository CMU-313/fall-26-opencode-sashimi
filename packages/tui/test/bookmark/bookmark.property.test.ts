// Property-based tests for the bookmark feature (P4, afels).
// Each property names the requirement it checks (see traceability/afels.md).
//
// The tui test script runs with --only-failures, which hides passing tests in
// the CI log. Each test prints one line after fast-check finishes so the log
// shows that every property actually ran and how many inputs it checked.
import { afterAll, beforeAll, expect, test } from "bun:test"
import fc from "fast-check"
import { mkdtemp, rm } from "fs/promises"
import os from "os"
import path from "path"
import {
  bookmarkText,
  bookmarkTitle,
  loadBookmarks,
  removeBookmark,
  renameBookmark,
  saveBookmarks,
  addBookmark,
  type LocalBookmark,
} from "../../src/context/local"

function report(id: string, kind: string, runs: number) {
  console.log(`[bookmark properties] ${id} (${kind}): passed ${runs} generated cases`)
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

// Whitespace that shows up in real responses and that interviewees' "all
// spaces" names could contain: spaces, tabs, newlines, and the non-breaking
// and full-width spaces that String.trim() also strips.
const whitespace = fc.constantFrom(" ", "  ", "\t", "\n", "\n\n", " ", "　")

// A word made of graphemes, so emoji, accented letters and CJK characters
// appear, not just ASCII.
const word = fc.string({ unit: "grapheme", minLength: 1, maxLength: 12 }).filter((s) => s.trim() === s && !/\s/.test(s))

// Response-like text: words separated by mixed whitespace (including blank
// lines, like a real markdown answer). Lengths go well past 80 characters so
// the list title's truncation boundary is reached often.
const responseText = fc
  .array(fc.tuple(word, whitespace), { minLength: 1, maxLength: 40 })
  .map((pairs) => pairs.map(([w, ws]) => w + ws).join(""))

// A custom name: any non-blank string (the rename prompt trims it).
const customName = fc.string({ unit: "grapheme", minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0)

// A blank name: empty, or only whitespace, which should clear a custom name.
const blankName = fc.array(whitespace, { maxLength: 5 }).map((parts) => parts.join(""))

// Saved times are Date.now() values, so generate realistic millisecond
// timestamps (1970 to 2100) rather than NaN or Infinity, which Date.now()
// never returns.
const createdAt = fc.integer({ min: 0, max: 4_102_444_800_000 })

const bookmark: fc.Arbitrary<LocalBookmark> = fc.record(
  {
    id: fc.string({ minLength: 1, maxLength: 12 }).map((s) => `msg_${s}`),
    sessionID: fc.constantFrom("ses_a", "ses_b", "ses_c"),
    sessionTitle: fc.string({ unit: "grapheme", maxLength: 20 }),
    text: responseText,
    createdAt,
    name: customName,
  },
  { requiredKeys: ["id", "sessionID", "sessionTitle", "text", "createdAt"] },
)

// A list of bookmarks as the app keeps it: every bookmark points at a
// different message, so ids are unique. Sizes from 0 up to 20.
const bookmarkList = (minLength = 0) =>
  fc.uniqueArray(bookmark, { selector: (b) => b.id, minLength, maxLength: 20 })

// ---------------------------------------------------------------------------
// R1 (model/oracle and invariant): "A bookmark saves the full text of the response it was
// made from, and the list shows the start of that text when there's no
// custom name."
// ---------------------------------------------------------------------------

// Message parts as the session sends them: visible text, synthetic text that
// OpenCode adds (not part of the answer), and non-text parts. Reasoning parts
// also carry text, so they check that only "text" parts are saved.
const part = fc.oneof(
  fc.record({ type: fc.constant("text"), text: responseText }),
  fc.record({ type: fc.constant("text"), text: responseText, synthetic: fc.boolean() }),
  fc.record({ type: fc.constant("reasoning"), text: responseText }),
  fc.record({ type: fc.constantFrom("tool", "step-start", "step-finish", "file") }),
)

// Oracle: the obviously correct version, written as a plain loop.
function expectedText(parts: { type: string; text?: string; synthetic?: boolean }[]) {
  const visible: string[] = []
  for (const p of parts) {
    if (p.type !== "text") continue
    if (p.synthetic === true) continue
    visible.push(p.text ?? "")
  }
  return visible.join("\n").trim()
}

// R1 (model/oracle): the saved text is the response's visible text, compared against expectedText.
test("R1: saved text matches the response's visible text", () => {
  const runs = 300
  fc.assert(
    fc.property(fc.array(part, { maxLength: 8 }), (parts) => {
      expect(bookmarkText(parts)).toBe(expectedText(parts))
    }),
    { numRuns: runs },
  )
  report("R1", "model/oracle", runs)
})

// R1 (invariant): for every unnamed bookmark, the list title is the start of its text.
test("R1: an unnamed bookmark's title is the start of its text", () => {
  const runs = 300
  fc.assert(
    fc.property(responseText, (text) => {
      const title = bookmarkTitle({ text })
      const shown = text.replace(/\s+/g, " ").trim()
      const truncated = title !== shown
      const kept = truncated ? title.slice(0, -1) : title

      // The title is the response's text from the start, never something else.
      expect(shown.startsWith(kept)).toBe(true)
      if (truncated) expect(title.endsWith("…")).toBe(true)
      // It fits in the list: at most 80 characters (graphemes).
      expect([...new Intl.Segmenter().segment(title)].length).toBeLessThanOrEqual(80)

      // Acceptance criteria: "begins with the same words as the response".
      // Every whole word in the title matches the response's words in order
      // (the last one may be cut off by truncation).
      const titleWords = kept.split(" ")
      const responseWords = shown.split(" ")
      const whole = truncated ? titleWords.slice(0, -1) : titleWords
      expect(responseWords.slice(0, whole.length)).toEqual(whole)
    }),
    { numRuns: runs },
  )
  report("R1", "invariant", runs)
})

// ---------------------------------------------------------------------------
// R2 (invariant): "Removing a bookmark removes only that entry from the list
// and leaves the response in the chat."
// ---------------------------------------------------------------------------

// R2 (invariant): removing one bookmark never changes any other bookmark or their order.
test("R2: removing a bookmark leaves every other bookmark unchanged", () => {
  const runs = 300
  fc.assert(
    fc.property(
      // Pick a non-empty list and a position in it to remove.
      bookmarkList(1).chain((items) => fc.tuple(fc.constant(items), fc.nat({ max: items.length - 1 }))),
      ([items, index]) => {
        const target = items[index]!
        const before = structuredClone(items)
        const after = removeBookmark(items, target.id)

        // Exactly the others remain, in the same order, unchanged.
        expect(after).toEqual(before.filter((_, i) => i !== index))
        // The input list itself is not modified.
        expect(items).toEqual(before)
      },
    ),
    { numRuns: runs },
  )
  report("R2", "invariant", runs)
})

// ---------------------------------------------------------------------------
// R3 (round-trip): "A bookmark keeps its name, saved time, session and target
// message across a restart."
// ---------------------------------------------------------------------------

let dir = ""
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "bookmark-property-"))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

// R3 (round-trip): save to a real bookmark.json, load it back, get the same bookmarks.
test("R3: saving then loading bookmarks returns them unchanged", async () => {
  // Each case writes and reads a real file, so fewer runs than the pure ones.
  const runs = 100
  let n = 0
  await fc.assert(
    fc.asyncProperty(bookmarkList(), async (items) => {
      // A fresh file per case, like a fresh restart.
      const file = path.join(dir, `bookmark-${n++}.json`)
      await saveBookmarks(file, items)
      const loaded = await loadBookmarks(file)
      expect(loaded).toEqual(items)
    }),
    { numRuns: runs },
  )
  report("R3", "round-trip", runs)
})

// ---------------------------------------------------------------------------
// R4 (metamorphic): "Bookmarking an already bookmarked response never creates
// a second entry, and it tells the user the response is already saved."
// ---------------------------------------------------------------------------

// R4 (metamorphic): bookmarking a response twice gives the same list as bookmarking it once.
test("R4: bookmarking twice gives the same list as bookmarking once", () => {
  const runs = 300
  fc.assert(
    fc.property(bookmarkList(), bookmark, (items, entry) => {
      // The response being bookmarked is not saved yet.
      const start = items.filter((item) => item.id !== entry.id)
      const { createdAt: _, ...response } = entry

      const once = addBookmark(start, response)
      const twice = addBookmark(once.items, response)

      // Metamorphic relation: a second bookmark of the same response changes nothing...
      expect(twice.items).toEqual(once.items)
      expect(twice.items.filter((item) => item.id === entry.id)).toHaveLength(1)
      // ...and reports that it was already saved.
      expect(twice.result).toBe("exists")
    }),
    { numRuns: runs },
  )
  report("R4", "metamorphic", runs)
})

// ---------------------------------------------------------------------------
// R5 (round-trip): "Clearing a custom name restores the default snippet title."
// ---------------------------------------------------------------------------

// R5 (round-trip): rename, then clear the name, and the title is back to the original snippet.
test("R5: renaming then clearing the name restores the original title", () => {
  const runs = 300
  fc.assert(
    fc.property(
      // An unnamed bookmark somewhere in a list, a new name, and a blank name.
      bookmarkList(1).chain((items) => fc.tuple(fc.constant(items), fc.nat({ max: items.length - 1 }))),
      customName,
      blankName,
      ([items, index], name, blank) => {
        const list = items.map((item, i) => (i === index ? { ...item, name: undefined } : item))
        const target = list[index]!
        const original = bookmarkTitle(target)

        const renamed = renameBookmark(list, target.id, name)
        const cleared = renameBookmark(renamed, target.id, blank)

        expect(bookmarkTitle(cleared[index]!)).toBe(original)
        // Round-trip: the list is back to exactly where it started.
        expect(cleared).toEqual(list)
      },
    ),
    { numRuns: runs },
  )
  report("R5", "round-trip", runs)
})
