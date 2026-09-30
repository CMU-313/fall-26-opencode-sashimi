###Bookmark feature (afels)
##How to use the feature
- This feature uses the leader key idea a lot, which is a prefix key you press first then release before pressing a second key to run a specific command. In OpenCode this is `ctrl x`, so the convention `<leader> w` means `ctrl x` then `w`
- To trigger a bookmark, one can either press `<leader> w` on the latest response, or open the command palette an look up "Bookmark latest response and click that.
- Both of the actions are a toggle, so one can bookmark and remove with the same command. However, an important limitation is that only the latest response can be bookmarked. Only the latest bookmark can be removed with a toggle as well, but any bookmark can be removed from the bookmark list.
- You also cannot bookmark a response as it is still streaming.
- To view saved bookmarks, `<leader> v` will open the list that is sorted newest first, or can open the command palette and look up "View bookmarked responses". 
- The list shows either a snippet from the response or a custom name, which session it came from, and when it was saved.
- When looking at the list of bookmarks, `crtl r` lets you to rename a bookmark, and `ctrl d` lets you to remove the bookmark, and clicking on one for selection will jump you to that message in its corresponding session.
- Since bookmarks live in  `bookmark.json` under the state directory, they persist across restarts.
##How to manually test it
- Ask Opencode a question.
- Bookmark a response using either method mentioned above, see the confirmation message, and check that it is in the `<leader>v`list. 
- Bookmark the same response again (with the toggle, which should say "Remove Bookmark" in looking in command palette) and check to make sure it is removed.
- Add a bookmark, exit out of OpenCode, restart it, and ensure the bookmark is still there.
- Find a bookmark in the list, and remove it using `ctrl d`
- Rename a bookmark, confirm the custom name is what you see and not the snippet
- Delete the session a bookmark belongs to (`<leader> l` to open session list) then `ctrl d` twice to delete, and confirm bookmarks from that session are deleted from the list.