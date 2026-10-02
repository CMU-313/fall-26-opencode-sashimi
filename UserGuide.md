# Sashimi feature User Guide
## Bookmark feature (afels)
### How to use the feature
- This feature uses the leader key idea a lot, which is a prefix key you press first then release before pressing a second key to run a specific command. In OpenCode this is `ctrl x`, so the convention `<leader> w` means `ctrl x` then `w`
- To trigger a bookmark, one can either press `<leader> w` on the latest response, or open the command palette and look up "Bookmark latest response and click that.
- Both of the actions are a toggle, so one can bookmark and remove with the same command. However, an important limitation is that only the latest response can be bookmarked. Only the latest response can be removed with a toggle as well, but any bookmark can be removed from the bookmark list.
- You also cannot bookmark a response as it is still streaming.
- To view saved bookmarks, `<leader> v` will open the list that is sorted newest first, or can open the command palette and look up "View bookmarked responses". 
- The list shows either a snippet from the response or a custom name, which session it came from, and when it was saved.
- When looking at the list of bookmarks, `ctrl r` lets you rename a bookmark, and `ctrl d` lets you to remove the bookmark, and clicking on one for selection will jump you to that message in its corresponding session.
- Since bookmarks live in  `bookmark.json` under the state directory, they persist across restarts.
### How to manually test it
- *The steps below should be run by going either through the command palette or using the keybinds (`<leader>w`, `<leader>v`, `ctrl+d`, `ctrl+r`)
- Ask Opencode a question.
- Bookmark a response using either method mentioned above, see the confirmation message, and check that it is in the `<leader> v`list. 
- Bookmark the same response again (with the toggle, which should say "Remove Bookmark" in looking in command palette) and check to make sure it is removed.
- Add a bookmark, exit out of OpenCode, restart it, and ensure the bookmark is still there.
- Find a bookmark in the list, and remove it using `ctrl d`
- Rename a bookmark, confirm the custom name is what you see and not the snippet
- Delete the session a bookmark belongs to (`<leader> l` to open session list) then `ctrl d` twice to delete, and confirm bookmarks from that session are deleted from the list.
### Written tests for this feature 
#### Location of tests
- `packages/tui/test/context/local.test.ts` has the bookmark add/toggle/remove/rename/sort/merge tests
- `packages/tui/test/context/bookmark-prune.test.ts` has cleanup logic tests for deleting sessions
-  `packages/tui/test/util/persistence.test.ts` tests for file read error when loading bookmarks
- `packages/tui/test/util/locale.test.ts` tests for emoji and plain text truncation 
- `packages/tui/test/context/bookmark-persistence.test.ts` has real filesystem tests for saving and loading `bookmark.json`, recovering a corrupted file, and two TUIs saving at the same time
- `packages/tui/test/context/bookmark-e2e.test.ts` has true end-to-end tests that mount the real app's provider stack (SDK, sync, route, etc.) against a real file, not just the extracted functions
#### What's being tested
Looking at the acceptance criterion, we can see it is all tested
- Bookmarking a response adds it to the list (`toggleBookmark`)
- Bookmarking the same response twice won't duplicate it, it will remove it instead (`toggleBookmark`)
- Removing a bookmark only removes targeted one, leaves other ones (`removeBookmark`)
- Bookmarks appear in saved list with the newest first (`sortBookmarks`)
- Renaming a bookmark will correctly update it (`renameBookmark`)
- Bookmarks are cleared when session is deleted (`pruneBookmarksForSession`)
- A missing `bookmark.json` from a first run for example, will be handled properly as no bookmarks, which makes it persistent
- A corrupted `bookmark.json` gets backed up instead of discarded
- Saving and loading `bookmark.json` works on a real file, not just a mocked object (`loadBookmarks`/ `saveBookmarks`)
- Two TUI sessions open at once will not overwrite each other's bookmarks when they are saved at the same time (`mergeBookmarks`)
- (end to end) A real `session.deleted` SDK event fires through the actual event system, prunes that session's bookmarks, and the change is confirmed on the real file on disk
- (end to end) A `session.deleted` event for an unrelated session correctly leaves other sessions' bookmarks untouched
- (end to end) Two actual app sessions (not two isolated function calls) sharing one `bookmark.json` each bookmark a different response at the same time, and both survive
#### Why these are sufficient
- Every mutation (`toggle`/`remove`/`prune`/`sort`/`merge`) is a pure function that I export so that they can be tested with simple arrays, so that the logic of those functions can be tested without depending on the UI. The UI was tested manually, as can be seen in the screen recordings.
- All these tests cover my acceptance criteria exhaustively (as can be seen in section above)
- Edge cases that were found were also covered, such as trying to remove a bookmark that doesn't exist, renaming a bookmark to blank or whitespace, pruning a session with no bookmarks, pruning a session with bookmarks, having a corrupted or missing bookmark file, and two sessions saving different bookmarks around the same time.
- Save/load and corruption recovery used to only be manually verified. They're now also automated against a real temporary file (not mocks) in `bookmark-persistence.test.ts`, the file gets renamed and backed up to `bookmark.json.corrupt-<timestamp>`, not just that the error gets classified correctly. That same file also has an integration test simulating two sessions writing to the same `bookmark.json`, proving `mergeBookmarks` resolves the conflict correctly against real file I/O. `bookmark-e2e.test.ts` goes further and proves this same thing through the actual running app, two real sessions with independent reactive state.
- I still have manual tests for making the state directory unwritable and confirming a failed save produces an error instead of failing silently (I manually tested this and got an error notification as expected), and confirming the keybinds are correctly wired to the right commands.
- Combined, all the acceptance criterion has both has a unit test proving the logic is correct, and a manual test proving it works with the UI and file system. The end-to-end tests added target two specific things: the session.deleted cleanup behavior (a real event firing through the real event system, including a negative case for an unrelated session) and the two-TUI merge fix (two real, independently reactive sessions sharing one file). However there is still a gap because there is no automated component level coverage for the bookmark list viewing and bookmark renaming, and no automated tests for the keybinds. The manual testing is my current substitute for that, and a `testRender` based test would be the next natural step to close that gap. 