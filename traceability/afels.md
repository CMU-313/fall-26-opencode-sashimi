# Traceability — Arianne Fels (afels)

**Target feature:** Bookmarking responses in the OpenCode TUI (bookmark the latest response, view the list, rename, remove, jump back to the message).

**Main source files:**
- `packages/tui/src/context/local.tsx`: bookmark logic (`addBookmark`, `removeBookmark`, `renameBookmark`, `loadBookmarks`, `saveBookmarks`...)
- `packages/tui/src/util/persistence.ts`: reading and writing `bookmark.json`
- `packages/tui/src/routes/session/index.tsx`: the "Bookmark last assistant response" command
- `packages/tui/src/component/dialog-bookmark-list.tsx`: the bookmark list (select, rename, remove)
- `packages/tui/src/component/dialog-bookmark-rename.tsx`: the rename prompt

**Property tests:** `packages/tui/test/bookmark/bookmark.property.test.ts`

## Requirements

| ID | Interview evidence | Requirement | Acceptance Criteria | Changed in P4? | Property (kind) | Test | Mutants it kills |
|---|---|---|---|---|---|---|---|
| R1 | C-15, S-16, O-16: "make sure the first few characters of the bookmark match the first few characters of the response" | A bookmark saves the full text of the response it was made from, and the list shows the start of that text when there's no custom name. | Ask "what is python" and bookmark the answer. The list entry begins with the same words as the response in the chat. | No | **Model/oracle** (saved text) **and invariant** (title): for any mix of response parts (text, synthetic text, tool calls), the saved text equals a simple reference: the non-synthetic text parts joined in order. For any unnamed bookmark, the list title is the start of that text. | `R1: saved text matches the response's visible text`, `R1: an unnamed bookmark's title is the start of its text`, `R1: the bookmark command picks the latest assistant response` (P5 red team) | H5 (after P5 strengthening), slaman A3 |
| R2 | C-5, C-9, S-9, O-10: "the list is the exact same except that bookmark is removed" | Removing a bookmark removes only that entry from the list and leaves the response in the chat. | With bookmarks A, B and C, select B and press ctrl d. The list shows A and C in their original order with their names unchanged, and B's response is still visible in its session. | No | **Invariant:** for any list of bookmarks and any one of them, removing it leaves every other bookmark, in the same order and unchanged. | `R2: removing a bookmark leaves every other bookmark unchanged` | H1 |
| R3 | C-7, S-7, S-8, O-8, O-9: "the timestamps shouldn't be different, and it should take me to the correct spot" | A bookmark keeps its name, saved time, session and target message across a restart. | Bookmark a response, rename it to "fix", quit OpenCode and restart. The bookmark list shows "fix" with the same date and session title, and selecting it opens that same message. | No | **Round-trip:** for any set of bookmarks (including emoji, newlines, quotes and custom names), saving to a real `bookmark.json` and loading it back returns exactly the same bookmarks. Added in P5: **model/oracle** (a file mixing valid and broken entries loads exactly the valid ones) and **invariant** (missing, wrong-shape and corrupted files load as empty; a corrupted file is backed up). | `R3: saving then loading bookmarks returns them unchanged`, `R3: loading keeps exactly the valid bookmarks from a file with broken entries` (P5), `R3: an unreadable bookmark.json loads as empty and a corrupted one is backed up` (P5), `R3: a rename survives the app's save path (merge, save, load)` (P5 red team) | H2, slaman A2 |
| R4 | C-6, S-6, O-7: "I would probably expect some sort of error or an 'already bookmarked' message" | Bookmarking an already bookmarked response never creates a second entry, and it tells the user the response is already saved. | Bookmark the latest response, then run the bookmark command on it again. The list still has exactly one entry for it, and a message says it is already bookmarked and gives its name. | No | **Metamorphic:** for any bookmark list and response, bookmarking it twice gives the same list as bookmarking it once, and the second attempt gives a message that it already exists. | `R4: bookmarking twice gives the same list as bookmarking once` | H3 (after P5 strengthening), slaman A1 |
| R5 | C-11, S-12, O-12: "deleting the name and closing it should put back the original name" | Clearing a custom name restores the default snippet title. | Rename a bookmark to "what is python", then rename it to an empty or all-spaces name. The title goes back to the same first-80-character snippet it showed before the first rename. | No | **Round-trip:** for an unnamed bookmark and any name, renaming it and then clearing the name gives back the original title. | `R5: renaming then clearing the name restores the original title` | H4 |
| R6 | C-10, S-10, O-11: "the consequence of deleting something is high" | Removing a bookmark from the list asks for confirmation first. | Press ctrl d on a bookmark and a confirmation appears. Cancel and the bookmark is still listed. Repeat and confirm, and it is gone. | No | — (UI dialog; checked by hand) | — | |

**AI-generated properties:** The properties for R1 and R3, and R6 (said it should be checked manually) were suggested by Claude. I reviewed each one by comparing against the requirement and acceptance criteria.

## Requirement changes

No requirements changed. Each requirement is buildable as written. R1, R2, R3 and R5 already hold in the current code, R4 needs only a change to the bookmark command so a second press reports "already bookmarked" instead of removing the bookmark, and R6 can use the confirmation dialog OpenCode uses.

## Hand-written mutants

Patches are in `mutants/afels/`. Each mutant changes `packages/tui/src/context/local.tsx`. Predictions were written before running each mutant. Results are with the fast-check seed fixed at 42.

| ID | Requirement targeted | Change | Predicted killer | Actual result |
|---|---|---|---|---|
| H1 | R2 | `removeBookmark` removes every bookmark saved on the same day as the target, not just the target | Probably none. The R2 invariant would catch it if a list had another bookmark on the same day as the removed one, since it checks every other bookmark is still there. But the generator spreads `createdAt` over 1970 to 2100, so two bookmarks on the same day are very unlikely. | **Killed** by R2 (invariant). Counterexample: two bookmarks, both with `createdAt: 0`; removing one also removed the other. My prediction was wrong because fast-check favors edge values like the minimum (0) when generating integers, so bookmarks with identical timestamps, come up even though the range is huge. |
| H2 | R3 | `isLocalBookmark` checks `typeof item.name === "number"` instead of `"string"`, so renamed bookmarks are dropped when `bookmark.json` is loaded after a restart. | R3 round-trip: it saves bookmarks and compares what `loadBookmarks` returns to what was saved. The generator includes bookmarks with custom names, which the mutant drops on load, so the lists would differ. | **Killed** by R3 (round-trip), as predicted. Counterexample: one bookmark with `name: "!"`; after saving and loading, it was missing from the list. |
| H3 | R4 | `addBookmark` decides "already bookmarked" by matching the response text instead of the message id, so a different response with the same text is reported as already saved. | None: the R4 property only bookmarks the same response twice, and generated responses almost never have identical text, so the mutant's text match never triggers. | **Survived**. The R4 property never bookmarks two different responses with the same text. After strengthening R4 (a different response with the same text must still be added), **killed** by R4. |
| H4 | R5 | `renameBookmark` treats an empty or all-spaces name as "no change" (`trimmed \|\| item.name`), so clearing a custom name keeps the old name. | R5 round-trip: after renaming and then clearing, it checks the title equals the original snippet. With the mutant the custom name stays, so the title is the custom name, not the snippet. | **Killed** by R5 (round-trip), as predicted. Counterexample: rename to `"!"`, then clear with `""`; the name stayed `"!"` instead of going back to the snippet. |
| H5 | R1 (default title; the 80-character length is from R5's acceptance criteria) | `bookmarkSnippet` truncates to 79 characters instead of 80, so a long response's default title is one character short. | None. Responses of 79 characters or fewer are not truncated, so the mutant behaves the same. For longer responses the title is 79 characters, but the R1 title property only checks it is at most 80, starts the response text, and keeps the same leading words, so a title one character short still passes. | **Survived**. The R1 title property only checks the title is at most 80 characters, so a long response titled with 79 still passes. After strengthening R1 (exact 80-character title for long responses), **killed** by R1. |

## Stryker comparison

Config: `packages/tui/stryker.config.json` mutates the bookmark logic in `packages/tui/src/context/local.tsx` (lines 30–145) and runs only the property tests (`bun test test/bookmark`). Reports: `mutants/afels/mutation-initial.html` (before strengthening) and `mutants/afels/mutation.html` (final).

**Seed:** fast-check is seeded with `fc.configureGlobal({ seed: 42 })` at the top of the property test file, so every run (both Stryker runs and the hand-written mutant runs) uses the same generated inputs and a mutant is killed or survives the same way each time.

**Initial mutation score:** 64.80% (81 killed, 44 survived, 125 mutants).

Where the 44 survivors are:

| Code | Survivors | Why they survived |
|---|---|---|
| `isLocalBookmark` (checks entries read from `bookmark.json`) | 20 | The R3 generator only produces valid bookmarks, so making a check more permissive (e.g. `typeof item.id === "string"` → `true`) is never noticed. Making a check stricter is caught, because valid bookmarks get dropped. |
| `loadBookmarks` error handling | 13 | R3 only saves and loads a valid file. A missing, corrupted, or wrongly shaped file is never tested. |
| `pruneBookmarksForSession` | 6 | Not covered by any requirement (R1–R6), so no property calls it. |
| `sortBookmarks` | 3 | Not covered by any requirement, so no property calls it. |
| `renameBookmark` | 1 | `item.id === id` → `false` makes rename do nothing, and R5 still passes (see below). |
| `bookmarkText` | 1 | `part.text ?? ""` → `part.text ?? "Stryker was here!"`. Equivalent (see below). |

**Which hand-written mutants did Stryker never generate, and why?**
Stryker never generated H1, H3, H4, or H5. It only makes small syntax-level changes (flip an operator, replace a condition with `true`/`false`, empty a block or string), so it doesn't invent new logic like grouping by day (H1), compare a different field (H3), or substitute a different value (H4). It never changed the `80` in H5 at all, because Stryker has no mutator for number literals. The only one it came close to is H2: on the same line it generated `typeof item.name === ""`, which also drops renamed bookmarks on load.

**Which Stryker survivors would I never have thought of? Are any plausible real bugs?**
- **Rename that does nothing** (`renameBookmark`, `item.id === id` → `false`). The R5 property renames and then clears the name, and checks the title is back to the original. If rename never changes anything, the title is "back to the original" too, so R5 passes. This is a plausible bug (e.g. comparing the wrong id), and users would notice immediately.
- **Corrupted-file backup that silently fails** (`loadBookmarks`, the backup name `` `${filePath}.corrupt-…` `` → `` ` ` ``). The rename fails and is ignored, so a corrupted `bookmark.json` isn't backed up and is overwritten on the next save, which is a plausible data-loss bug.
- **Loading without filtering** (`items.filter(isLocalBookmark)` → `items`) and the weakened `isLocalBookmark` checks. A bad entry would be loaded and could crash the list later. Plausible if someone "simplifies" the validation.
- Returning `["Stryker was here"]` from `loadBookmarks`, is unrealistic but shows that the error paths are untested.

**What does each approach find that the other doesn't?**
Hand-written mutants come from the requirements and interviews, so they are realistic and targeted. They showed specific blind spots in my generators (H3 never makes two responses with the same text) and assertions (H5 only checks an upper limit). Stryker is exhaustive and mechanical: it found whole code paths no property reaches (validation and error handling), and a weak round-trip property (rename doing nothing) that I didn't think to break. But many of its mutants are unrealistic, and it measures code that isn't related to any requirement, so its score should not be taken at face value.

**Equivalent mutants**
- `bookmarkText`: `part.text ?? ""` → `part.text ?? "Stryker was here!"`. The fallback only runs when a `text` part has no `text`, and in OpenCode a text part always has a `text` string (it's required by the part type), so the fallback is never used. The saved text is the same for every real response, so this mutant has no observable effect.
- `isLocalBookmark`: `typeof value !== "object"` → `false`. This only removes the early exit for non-objects like `42`, `"x"` or `true`. Those values have no `id` property, so the very next check (`typeof item.id === "string"`) rejects them anyway, and the result is the same for every input.
- `loadBookmarks`: `typeof data !== "object"` → `false`. If the file holds a number, string or boolean, reading `.items` from it gives `undefined`, which fails the `Array.isArray` check and returns `[]`, exactly as before.
- `loadBookmarks`: `isMissingFileError(error)` → `false`. For a missing file, the code then tries to rename a file that doesn't exist, that rename fails, the failure is ignored, and it still returns `[]`. No file is created or changed, so the result is identical.

**Strengthening** (properties only, no example tests):
- R1: a response longer than 80 characters must get exactly the first 79 characters plus "…" (kills H5).
- R4: a different response with the same text must still be added (kills H3).
- R5: the rename itself must take effect before it is cleared (kills the "rename does nothing" survivor).
- R3: two new properties. One loads files that mix valid bookmarks with broken entries (not an object, or one field missing or the wrong type) and checks exactly the valid ones come back. The other loads missing, wrong-shape and corrupted files and checks they load as empty, and that a corrupted file is backed up with its exact contents. Together these kill most of the `isLocalBookmark` and `loadBookmarks` survivors.

**Final mutation score:** 87.20% as Stryker reports it (109 killed, 16 survived, 125 mutants). Excluding the 4 equivalent mutants: 90.08% (109 of 121).

The 12 non-equivalent survivors left:
- `sortBookmarks` (3) and `pruneBookmarksForSession` (6): not covered by any requirement (R1–R6), so I didn't add properties for them. They are real behavior (list order, cleanup when a session is deleted), so they're not equivalent, just out of scope for my requirements.
- `loadBookmarks` (3): `!data || typeof data !== "object"` → `false` or `&&`, and `!Array.isArray(items)` → `false`. These only change whether a file that is valid JSON but the wrong shape (like `null` or `{"items":3}`) gets backed up before returning `[]`. The loaded bookmarks are the same. None of my requirements say how to handle htis, so I didn't add a property that would lock in the current behavior.

## Agent failure case

I asked opencode to write one for R4, model: Nemotron 3 Ultra. The property is in `packages/tui/test/bookmark/agent-r4.property.test.ts`.

**1. Transcript excerpt**

My prompt:

> I'm writing property-based tests with fast-check for a bookmark feature in packages/tui/src/context/local.tsx. Write one fast-check property for this requirement:
>
> R4: Bookmarking an already bookmarked response never creates a second entry, and it tells the user the response is already saved.
>
> Acceptance criteria: Bookmark the latest response, then run the bookmark command on it again. The list still has exactly one entry for it, and a message says it is already bookmarked and gives its name.
>
> The function to test is addBookmark(items, entry) in local.tsx. Put the property in a new file, packages/tui/test/bookmark/agent-r4.property.test.ts, using bun:test and fc.assert(fc.property(...)). Use fc.configureGlobal({ seed: 42 }) at the top. Don't read or reuse the other files in packages/tui/test/bookmark/.

The property opencode wrote:

```ts
const bookmarkArb = fc.record({
  id: fc.string({ minLength: 1 }),
  sessionID: fc.string({ minLength: 1 }),
  sessionTitle: fc.string({ minLength: 1 }),
  text: fc.string(),
  name: fc.option(fc.string()),
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
```

Opencode reported "The test passes consistently with fc.configureGlobal({ seed: 42 }) for reproducibility." 

**2. The mutant it let survive:** H3 (`addBookmark` decides "already bookmarked" by matching `text` instead of the message `id`). With H3 applied, opencode's property still passes. (It also passes against H1, H2, H4 and H5, since it only calls `addBookmark`.)

**3. Why the property was too weak:** It always starts from an empty list and adds the same entry twice, so the second call finds a match whether the code compares ids or texts. It never adds a second, different response, so it can't tell "same message" apart from "same text", which is exactly the mistake H3 makes. It also starts from an empty list every time, so it never checks that existing bookmarks are left alone.

**4. Strengthened version and evidence:** Below opencode's property in the same file, the strengthened property starts from a generated list of existing bookmarks, checks that re-adding the same response returns `"exists"` and leaves the list exactly the same, and then adds a different response (`id` + `"-copy"`) with the same text, which must be `"added"` as a new entry. With H3 applied:

```
(pass) R4: addBookmark - duplicate handling > bookmarking an already bookmarked response never creates a second entry and returns exists
(fail) R4: addBookmark - duplicate handling (strengthened) > re-adding the same response says exists, but a different response with the same text is added
Counterexample: [[],{"id":" ","sessionID":" ","sessionTitle":" ","text":"","name":undefined}]
```

On the real code, both properties pass.

## Red team

Mutants received from **Sara Laman (slaman)**, written against commit `9eb4cdf`. Her patches are saved in `mutants/afels/received/`. Results are with the fast-check seed fixed at 42.

| ID | Requirement targeted | Change | Result | Fix |
|---|---|---|---|---|
| slaman A1 | R4 | `addBookmark` returns the incoming response as `existing` instead of the saved bookmark, so the "already bookmarked" message loses the custom name. | **Survived.** R4 checked the list and the `"exists"` result but never which bookmark was reported back; the agent property only checked `existing.id`. | Strengthened R4: rename the saved bookmark, bookmark the same response again, and check `existing` is the saved bookmark and its title is the custom name. **Killed** by R4. |
| slaman A2 | R3 | `mergeBookmarks` keeps the on-disk copy when a bookmark is in both lists, so a rename is lost on save. | **Survived.** R3 only round-tripped `saveBookmarks`/`loadBookmarks` directly, but the app always saves through `mergeBookmarks`, which no property called. | New R3 round-trip property that saves the way the app loads, renames, merges with the re-read file, saves, loads again, and check the rename is still there. **Killed** by `R3: a rename survives the app's save path (merge, save, load)`. |
| slaman A3 | R1 | The bookmark command uses `find` instead of `findLast`, so it bookmarks the first response in the session instead of the latest. | **Survived.** Choosing the message happened inside the UI command, which no property could reach. R1 only tested how text is taken from a message it is given. | Moved the choice into `latestAssistantMessage(messages)` in `local.tsx` and used it in the command, then added a model/oracle property that compares it to walking the messages backwards. Sara's patch targets the old line, so I applied the same `find` change to `latestAssistantMessage`: **killed** by `R1: the bookmark command picks the latest assistant response`. |

All three of Sara's mutants survived my properties at first, and all three are killed after strengthening. My hand-written mutants H1–H5 are still all killed, and all 12 bookmark properties pass on the real code.
