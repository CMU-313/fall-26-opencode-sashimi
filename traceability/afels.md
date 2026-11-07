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
| R1 | C-15, S-16, O-16: "make sure the first few characters of the bookmark match the first few characters of the response" | A bookmark saves the full text of the response it was made from, and the list shows the start of that text when there's no custom name. | Ask "what is python" and bookmark the answer. The list entry begins with the same words as the response in the chat. | No | **Model/oracle** (saved text) **and invariant** (title): for any mix of response parts (text, synthetic text, tool calls), the saved text equals a simple reference: the non-synthetic text parts joined in order. For any unnamed bookmark, the list title is the start of that text. | `R1: saved text matches the response's visible text`, `R1: an unnamed bookmark's title is the start of its text` | |
| R2 | C-5, C-9, S-9, O-10: "the list is the exact same except that bookmark is removed" | Removing a bookmark removes only that entry from the list and leaves the response in the chat. | With bookmarks A, B and C, select B and press ctrl d. The list shows A and C in their original order with their names unchanged, and B's response is still visible in its session. | No | **Invariant:** for any list of bookmarks and any one of them, removing it leaves every other bookmark, in the same order and unchanged. | `R2: removing a bookmark leaves every other bookmark unchanged` | H1 |
| R3 | C-7, S-7, S-8, O-8, O-9: "the timestamps shouldn't be different, and it should take me to the correct spot" | A bookmark keeps its name, saved time, session and target message across a restart. | Bookmark a response, rename it to "fix", quit OpenCode and restart. The bookmark list shows "fix" with the same date and session title, and selecting it opens that same message. | No | **Round-trip:** for any set of bookmarks (including emoji, newlines, quotes and custom names), saving to a real `bookmark.json` and loading it back returns exactly the same bookmarks. | `R3: saving then loading bookmarks returns them unchanged` | H2 |
| R4 | C-6, S-6, O-7: "I would probably expect some sort of error or an 'already bookmarked' message" | Bookmarking an already bookmarked response never creates a second entry, and it tells the user the response is already saved. | Bookmark the latest response, then run the bookmark command on it again. The list still has exactly one entry for it, and a message says it is already bookmarked and gives its name. | No | **Metamorphic:** for any bookmark list and response, bookmarking it twice gives the same list as bookmarking it once, and the second attempt gives a message that it already exists. | `R4: bookmarking twice gives the same list as bookmarking once` | |
| R5 | C-11, S-12, O-12: "deleting the name and closing it should put back the original name" | Clearing a custom name restores the default snippet title. | Rename a bookmark to "what is python", then rename it to an empty or all-spaces name. The title goes back to the same first-80-character snippet it showed before the first rename. | No | **Round-trip:** for an unnamed bookmark and any name, renaming it and then clearing the name gives back the original title. | `R5: renaming then clearing the name restores the original title` | H4 |
| R6 | C-10, S-10, O-11: "the consequence of deleting something is high" | Removing a bookmark from the list asks for confirmation first. | Press ctrl d on a bookmark and a confirmation appears. Cancel and the bookmark is still listed. Repeat and confirm, and it is gone. | No | — (UI dialog; checked by hand) | — | |

**AI-generated properties:** The properties for R1 and R3, and R6 (said it should be checked manually) were suggested by Claude. I reviewed each one by comparing against the requirement and acceptance criteria.

## Requirement changes

No requirements changed. Each requirement is buildable as written. R1, R2, R3 and R5 already hold in the current code, R4 needs only a change to the bookmark command so a second press reports "already bookmarked" instead of removing the bookmark, and R6 can use the confirmation dialog OpenCode uses.

## Hand-written mutants

Patches are in `mutants/afels/`. Each mutant changes `packages/tui/src/context/local.tsx`. Predictions were written before running each mutant.

| ID | Requirement targeted | Change | Predicted killer | Actual result |
|---|---|---|---|---|
| H1 | R2 | `removeBookmark` removes every bookmark saved on the same day as the target, not just the target | Probably none. The R2 invariant would catch it if a list had another bookmark on the same day as the removed one, since it checks every other bookmark is still there. But the generator spreads `createdAt` over 1970 to 2100, so two bookmarks on the same day are very unlikely. | **Killed** by R2 (invariant). Counterexample: two bookmarks, both with `createdAt: 0`; removing one also removed the other. My prediction was wrong because fast-check favors edge values like the minimum (0) when generating integers, so bookmarks with identical timestamps, come up even though the range is huge. |
| H2 | R3 | `isLocalBookmark` checks `typeof item.name === "number"` instead of `"string"`, so renamed bookmarks are dropped when `bookmark.json` is loaded after a restart. | R3 round-trip: it saves bookmarks and compares what `loadBookmarks` returns to what was saved. The generator includes bookmarks with custom names, which the mutant drops on load, so the lists would differ. | **Killed** by R3 (round-trip), as predicted. Counterexample: one bookmark with `name: "!"`; after saving and loading, it was missing from the list. |
| H3 | R4 | `addBookmark` decides "already bookmarked" by matching the response text instead of the message id, so a different response with the same text is reported as already saved. | None: the R4 property only bookmarks the same response twice, and generated responses almost never have identical text, so the mutant's text match never triggers. | **Survived**. The R4 property never bookmarks two different responses with the same text. |
| H4 | R5 | `renameBookmark` treats an empty or all-spaces name as "no change" (`trimmed \|\| item.name`), so clearing a custom name keeps the old name. | R5 round-trip: after renaming and then clearing, it checks the title equals the original snippet. With the mutant the custom name stays, so the title is the custom name, not the snippet. | **Killed** by R5 (round-trip), as predicted. Counterexample: rename to `"!"`, then clear with `""`; the name stayed `"!"` instead of going back to the snippet. |
| H5 | R1 (default title; the 80-character length is from R5's acceptance criteria) | `bookmarkSnippet` truncates to 79 characters instead of 80, so a long response's default title is one character short. | None. Responses of 79 characters or fewer are not truncated, so the mutant behaves the same. For longer responses the title is 79 characters, but the R1 title property only checks it is at most 80, starts the response text, and keeps the same leading words, so a title one character short still passes. | **Survived**. The R1 title property only checks the title is at most 80 characters, so a long response titled with 79 still passes. |

## Stryker comparison

Config: `packages/tui/stryker.config.json` mutates the bookmark logic in `packages/tui/src/context/local.tsx` (lines 30–145) and runs only the property tests (`bun test test/bookmark`). Report: `mutants/afels/mutation.html`.

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

