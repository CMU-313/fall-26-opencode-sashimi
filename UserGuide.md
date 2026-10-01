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
- `packages/tui/test/context/local.test.ts` has the bookmark add/toggle/remove/rename/sort tests
- `packages/tui/test/context/bookmark-prune.test.ts` has cleanup logic tests for deleting sessions
-  `packages/tui/test/util/persistence.test.ts` tests for file read error when loading bookmarks
- `packages/tui/test/util/locale.test.ts` tests for emoji and plain text truncation 
#### What's being tested
Looking at the acceptance criterion, we can see it is all tested
- Bookmarking a response adds it to the list (`toggleBookmark`)
- Bookmarking the same response twice won't duplicate it, it will remove it instead (`toggleBookmark`)
- Removing a bookmark only removes targeted one, leaves other ones (`removeBookmark`)
- Bookmarks appear in saved list with the newest first (`sortBookmarks`)
- Renaming a bookmark will correctly update it (`renameBookmark`)
- Bookmarks are cleared when session is deleted (`pruneBookmarksForSession`)
- A missing `bookmark.json` from a first run for example, will be handled properly as no bookmarks, which makes it persistent
#### Why these are sufficient
- Every mutation (`toggle`/`remove`/`prune`/`sort`) is a pure function that I export so that they can be tested with simple arrays, so that the logic of those functions can be tested without depending on the UI. The UI was tested manually, as can be seen in the screen recordings.
- All these tests cover my acceptance criteria exhaustively (as can be seen in section above)
- Edge cases that were found were also covered, such as trying to remove a bookmark that doesn't exist, renaming a bookmark to blank or whitespace, pruning a session with no bookmarks, pruning a session with bookmarks, having a corrupted or missing bookmark file.
- I also did some manual testing that cover things that could not be tested effectively with automated tests. There are three things specifically I tested. I tested that bookmarks genuinely persist across restarted OpenCode and across sessions. I also tested that the keybinds are correctly wired, and that the app can correctly handle errors. I manually corrupted `bookmark.json` to make sure the app backs it up to a `bookmark.json.corrupt` file, and then trying to save a bookmark when the state directory is unwritebale and getting an error notification instead of failing silently. The unit tests for the missing `bookmark.json` only look for correct error classification, the manual tests showed that the recovery behavior was correct.
- Combined, all the acceptance criterion has both has a unit test proving the logic is correct, and a manual test proving it works with the UI and file system. However there is still a gap because there is no automated component level coverage for the bookmark list viewing and bookmark renaming, and no automated tests for the keybinds. The manual testing is my current substitute for that, and a `testRender` based test would be the next natural step to close that gap. 