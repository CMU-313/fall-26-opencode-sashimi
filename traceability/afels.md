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

| ID | Interview evidence | Requirement | Acceptance Criteria | Changed in P4? | Property (kind) | Test |
|---|---|---|---|---|---|---|
| R1 | C-15, S-16, O-16: "make sure the first few characters of the bookmark match the first few characters of the response" | A bookmark saves the full text of the response it was made from, and the list shows the start of that text when there's no custom name. | Ask "what is python" and bookmark the answer. The list entry begins with the same words as the response in the chat. | No | **Model/oracle** (saved text) **and invariant** (title): for any mix of response parts (text, synthetic text, tool calls), the saved text equals a simple reference: the non-synthetic text parts joined in order. For any unnamed bookmark, the list title is the start of that text. | `R1: saved text matches the response's visible text`, `R1: an unnamed bookmark's title is the start of its text` |
| R2 | C-5, C-9, S-9, O-10: "the list is the exact same except that bookmark is removed" | Removing a bookmark removes only that entry from the list and leaves the response in the chat. | With bookmarks A, B and C, select B and press ctrl d. The list shows A and C in their original order with their names unchanged, and B's response is still visible in its session. | No | **Invariant:** for any list of bookmarks and any one of them, removing it leaves every other bookmark, in the same order and unchanged. | `R2: removing a bookmark leaves every other bookmark unchanged` |
| R3 | C-7, S-7, S-8, O-8, O-9: "the timestamps shouldn't be different, and it should take me to the correct spot" | A bookmark keeps its name, saved time, session and target message across a restart. | Bookmark a response, rename it to "fix", quit OpenCode and restart. The bookmark list shows "fix" with the same date and session title, and selecting it opens that same message. | No | **Round-trip:** for any set of bookmarks (including emoji, newlines, quotes and custom names), saving to a real `bookmark.json` and loading it back returns exactly the same bookmarks. | `R3: saving then loading bookmarks returns them unchanged` |
| R4 | C-6, S-6, O-7: "I would probably expect some sort of error or an 'already bookmarked' message" | Bookmarking an already bookmarked response never creates a second entry, and it tells the user the response is already saved. | Bookmark the latest response, then run the bookmark command on it again. The list still has exactly one entry for it, and a message says it is already bookmarked and gives its name. | No | **Metamorphic:** for any bookmark list and response, bookmarking it twice gives the same list as bookmarking it once, and the second attempt gives a message that it already exists. | `R4: bookmarking twice gives the same list as bookmarking once` |
| R5 | C-11, S-12, O-12: "deleting the name and closing it should put back the original name" | Clearing a custom name restores the default snippet title. | Rename a bookmark to "what is python", then rename it to an empty or all-spaces name. The title goes back to the same first-80-character snippet it showed before the first rename. | No | **Round-trip:** for an unnamed bookmark and any name, renaming it and then clearing the name gives back the original title. | `R5: renaming then clearing the name restores the original title` |
| R6 | C-10, S-10, O-11: "the consequence of deleting something is high" | Removing a bookmark from the list asks for confirmation first. | Press ctrl d on a bookmark and a confirmation appears. Cancel and the bookmark is still listed. Repeat and confirm, and it is gone. | No | — (UI dialog; checked by hand) | — |

**AI-generated properties:** The properties for R1 and R3, and R6 (said it should be checked manually) were suggested by Claude. I reviewed each one by comparing against the requirement and acceptance criteria.

## Requirement changes

No requirements changed. Each requirement is buildable as written. R1, R2, R3 and R5 already hold in the current code, R4 needs only a change to the bookmark command so a second press reports "already bookmarked" instead of removing the bookmark, and R6 can use the confirmation dialog OpenCode uses.

## Hand-written mutants

Patches are in `mutants/afels/`. Each mutant changes `packages/tui/src/context/local.tsx`. Predictions were written before running each mutant.

| ID | Requirement targeted | Change | Predicted killer | Actual result |
|---|---|---|---|---|
| H1 | R2 | `removeBookmark` removes every bookmark saved on the same day as the target, not just the target (reuses the list's "group by day" idea). | | |
| H2 | R3 | `isLocalBookmark` checks `typeof item.name === "number"` instead of `"string"`, so renamed bookmarks are dropped when `bookmark.json` is loaded after a restart. | | |
| H3 | R4 | `addBookmark` decides "already bookmarked" by matching the response text instead of the message id, so a different response with the same text is reported as already saved. | | |
| H4 | R5 | `renameBookmark` treats an empty or all-spaces name as "no change" (`trimmed \|\| item.name`), so clearing a custom name keeps the old name. | | |
| H5 | R1 | `bookmarkSnippet` truncates to 79 characters instead of 80, so a long response's default title is one character short. | | |
