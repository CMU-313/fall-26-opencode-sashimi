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

## Permission action descriptions (inseok)
### How to use the feature
- This feature is available in the OpenCode app interface, not in the TUI permission prompt.
- When a tool call requires permission, OpenCode pauses the call and shows an approval dock with a short description of the requested action next to the permission controls.
- The description uses the permission request's existing metadata. For example, a read request can say `Agent wants to read the file src/components/Button.tsx`, and a write request can summarize content as a line or character count instead of showing the content.
- Long commands and search patterns are shortened to keep the description readable. Long paths are bounded while retaining the filename when possible; truncation avoids splitting grapheme clusters such as emoji.
- The permission request's resource patterns remain available separately in the dock, so a shortened command description does not replace the full command/resource shown there.
- Descriptions are formatted locally and deterministically; no LLM call is made to explain a permission request.

### How to manually test it
- Follow these steps in the OpenCode app interface; the TUI does not display these action descriptions.
- Configure a tool such as `read`, `edit`, or `bash` to require approval, then start a session.
- Ask the agent to read a file with a recognizable path. Confirm the permission dock names the file and shows the approval controls before the read completes.
- Reject the request and confirm the tool does not complete. Repeat and approve once; confirm the tool proceeds.
- Ask the agent to write several lines or edit a file. Confirm the description summarizes the content rather than dumping it.
- Trigger a long bash command. Confirm the one-line description is shortened and the full command remains available in the permission resources list.
- If possible, test a long path and a path containing emoji or combined characters. Confirm the description remains bounded, retains the filename where possible, and does not show a broken character.

### Written tests for this feature
#### Location of tests
- `packages/core/test/tool-permission-description.test.ts` contains unit tests for formatting descriptions from flat permission metadata, including read/write/edit, apply-patch, shell commands, search and web actions, todo and skill actions, missing values, long paths, and grapheme-safe truncation.
- `packages/core/test/tool-apply-patch.test.ts`, `tool-bash.test.ts`, `tool-edit.test.ts`, `tool-read.test.ts`, `tool-skill.test.ts`, `tool-todowrite.test.ts`, `tool-webfetch.test.ts`, `tool-websearch.test.ts`, and `tool-write.test.ts` assert that tool integrations pass the expected flat metadata to permission requests.
- `packages/core/test/tool-search-permission-metadata.test.ts` executes glob and grep through the tool registry and checks their permission metadata.
- `packages/core/test/tool-read.test.ts` also holds a real ReadTool registry call at the permission boundary, verifies no read happens before approval, checks the captured request produces the expected description, then releases the call.
- `packages/opencode/test/tool/read.test.ts` checks the V1 read permission uses a worktree-relative rule pattern while retaining the full target path in metadata.
- `packages/app/e2e/regression/session-request-docks.spec.ts` contains Playwright browser tests for a path-specific description, permission controls, approval reply, and long-command summary. The tests use mocked permission requests rather than a live OpenCode server.

#### What's being tested
- Read descriptions include the requested path, and long paths stay bounded while retaining their filename when possible.
- Write and edit descriptions identify the target without exposing full content; write content is summarized by line or character count.
- Apply-patch requests include a target path so the edit description can identify a file.
- Bash, glob, grep, webfetch, and websearch descriptions include useful action context and safely truncate long values.
- Skill, todo, missing-argument, unknown-tool, control-character, and multiline cases produce readable fallback descriptions.
- Tool integration tests verify permission metadata is flat and avoids duplicate nested `input` payloads.
- The ReadTool permission test verifies the tool call waits at the permission boundary; the browser tests verify the dock renders the description beside the controls and sends the approval reply.
- The long-command browser test checks that the hint is a single bounded line while the full command remains available as a permission resource.

#### Why these are sufficient
- Pure formatter tests cover the description rules without requiring UI or filesystem setup, while tool-registry tests verify real built-in tools supply the metadata those rules consume.
- The ReadTool integration test exercises an actual registered tool call and proves it does not read before the permission assertion is released.
- The Playwright tests exercise the rendered dock and approval interaction in a browser, but use a mocked API request. They do not currently run one live tool call all the way through the server and browser UI in a single test.
- Manual testing remains useful for verifying real provider/tool behavior across every tool and checking how long resource patterns are presented in the running app.

## Autoname feature (smao2)
### How to use this feature
- Sessions in opencode are automatically named to the date and time that they are created. This makes it very easy to lose track of sessions.
- Sessions can be renamed as well, but must be done manually.
- Therefore, if we have an autoname feature that works similarly to how other AI models automatically rename the sessions after the first prompt, we can let the user easily rename the session.
- To use this, after the first few prompts or even one prompt, the user can use the command /autoname, which will rename the session to a brief 2-5 word summary of the previous chats. This can be used multiple times.
- The instructions for this are displayed in a .txt file, which is shown as the /autoname command is run.

### How to manually test it
- Start a new OpenCode session and send a few prompts about a specific topic.
- Type '/autoname' and run the command using enter. Confirm that the session title changes to a short, relevant 2–5 word summary of the conversation.
- Continue the conversation with additional prompts and run `/autoname` again. Make sure that the session can be renamed multiple times based on its updated context.
- Test the command with different types of conversations to check that the generated names accurately summarize their topics.
- Confirm that the renamed session title appears correctly in the session list and remains after restarting OpenCode, using the /session command or just viewing the sessions through the button to display sessions.

### Written tests for this feature
#### Location of tests
- `packages/opencode/test/command/autoname.test.ts` contains tests for the autoname prompt, title extraction, parsing edge cases, simulated session result processing, and command-related behavior.
- `packages/opencode/test/command/autoname-end2end.test.ts` contains an end to end test for the autoname prompt.
- `packages/opencode/src/command/template/autoname.txt` contains the prompt instructions used to generate the session title.

#### What's being tested
- The autoname prompt contains the `RENAMED:` marker, which is used to identify the generated session title.
- The prompt specifies that generated titles should contain 2–5 words.
- The `extractRenamedTitle` helper correctly extracts a title from a response containing `RENAMED:`.
- Only the first title line is extracted when additional text follows the generated title.
- Responses without a `RENAMED:` marker return `undefined`.
- Empty or whitespace-only titles return `undefined`.
- Titles containing punctuation, such as colons and exclamation marks, are extracted correctly.
- When multiple `RENAMED:` lines appear, only the first matching title is used.
- Very long titles are extracted without truncation at the parsing stage. Any length restrictions must be handled separately.
- The autoname prompt has no argument hints, as verified by `hints(PROMPT_AUTONAME)` returning an empty array.
- Simulated session result processing correctly extracts the generated title from text response parts.
- Non-text response parts are ignored during title extraction.

#### Why these are sufficient
- The tests cover the main title extraction logic and several important edge cases without requiring an actual AI response or running the OpenCode interface.
- The parsing tests verify that the feature can identify a generated title using the `RENAMED:` marker and handle missing, empty, multiline, or unusually long responses.
- The simulated session tests check that text response parts can be processed correctly while non-text parts are ignored. This helps verify the expected structure of the response-processing logic.
- The prompt tests confirm that the instructions contain the expected title format and word-count requirement.
- Additionally, the command registry test currently checks the prompt content but does not actually verify that `/autoname` is registered with the correct name, source, and description.
- Manual testing can verify these user-facing behaviors and the current automated tests provide good coverage of the formatting and title parsing behavior, as the actual command is quite small.
## Misconceptions feature (mdarin)
### How to use the feature
- This feature is for TAs and instructors. It reads a folder of exported OpenCode sessions, lists what each student misunderstood, groups the same misconception across students, and ranks the groups by urgency so the most common and most severe ones can be addressed in lecture.
- Each student exports a session with `opencode export <session-id> > <name>.json` and sends the file to the TA, who puts all of them in one folder.
- From the terminal, run `opencode misconceptions <folder> --model <provider/model>` (from a source checkout: `bun dev misconceptions ...` at the repo root). The model must be one you have a key for; OpenCode's free models reject calls from a source build.
- `--course <syllabus.md or folder of .md/.txt>` weights each group by how central its topic is to the course (core ×3, supporting ×2, peripheral ×1). `--json` prints the result as JSON, including each transcript's findings. `--no-verify` skips the second extraction pass (see below).
- Extraction runs in two stages: the model first lists candidate misconceptions from chunks of the conversation, then a second call checks each candidate against the whole conversation, drops the ones it does not support, and records every student message where the misconception recurs. A misconception the student repeats after the assistant has corrected it is rated severe.
- The output is a ranked table: group name, urgency score, how many students had it, severity counts (severe/moderate/mild), the course topic, and up to two student quotes with the transcript file and message index so the exact message can be opened. The same table is saved to `<folder>/misconceptions-ranking.txt`.
- Results are cached per transcript in `<folder>/.misconceptions/`, so rerunning only analyzes new or changed transcripts. With `--course`, the topic list is saved to `.misconceptions/topics.json`; edit it to adjust a topic's importance, or delete it to regenerate.
- From the TUI, type `/misconceptions <folder> [--course ...] [--model ...]`. It runs the same analysis with live progress and summarizes the ranking with suggestions for what to cover first. Only the typed command shows in the chat.

### How to manually test it
- Sample transcripts are in `packages/opencode/test/fixtures/misconceptions/sessions`: 44 generated student sessions from 6 to 104 messages (including sessions with no misconceptions, terse students, and long sessions whose topic drifts), plus two malformed files. `course.md` is a sample syllabus and `manifest.json` lists each session's kind and length.
- From the repo root: `bun dev misconceptions packages/opencode/test/fixtures/misconceptions/sessions --course packages/opencode/test/fixtures/misconceptions/course.md --model <provider/model>`. Check that a progress line prints per file, the two malformed files are reported as skipped, the table ranks groups such as "100% coverage means no bugs", "force-pushing a shared branch" and "ignoring red CI" near the top, each quote names a file and message, and `misconceptions-ranking.txt` appears in the folder.
- Run it again: it finishes in seconds with no model calls, because of the cache.
- Open `.misconceptions/topics.json`, change a topic to `peripheral`, rerun, and check its groups drop in the ranking.
- Run with `--no-verify` and compare: the single pass reports more findings, including some in the sessions that have none (`student-13`, `-21`, `-29`, `-37`).
- Start the TUI (`bun dev --model <provider/model>`), type `/misconceptions <same arguments>`, and check that only the command shows, progress lines appear, then a table and lecture suggestions.

### Written tests for this feature
#### Location of tests
- `packages/opencode/test/cli/misconceptions/transcript.test.ts` has unit tests for reading export files and splitting long transcripts into pieces that fit the model.
- `packages/opencode/test/cli/misconceptions/ranking.test.ts` has unit tests for locating the quoted message, dedupe, the urgency ranking, and the table.
- `packages/opencode/test/cli/misconceptions/verify.test.ts` has unit tests for applying the second-pass reply and the severity rule.
- `packages/opencode/test/cli/misconceptions/cli.test.ts` has end-to-end tests that spawn the real `opencode misconceptions` binary in an isolated home directory against a fake model server.
- `packages/opencode/test/command/misconceptions.test.ts` has integration tests for the `/misconceptions` command through the real command service, and an end-to-end check that the shell command it generates starts OpenCode from another directory.
- `packages/opencode/test/session/prompt.test.ts` ("quiet built-in commands") checks that the command's prompt is hidden in the chat.

#### What's being tested
- Export files are reduced to what the student and assistant wrote: tool output, reasoning and hidden text are dropped, student text is never shortened, assistant text is trimmed, and invalid files are rejected.
- Long transcripts are split into pieces that each fit the model's budget, cut only between turns, with the previous piece's last turns carried over as context; a single message too long for one piece is split into overlapping parts so nothing at its end is lost.
- Each quote is tied to the student message it came from, repeats within a transcript are merged keeping the deepest, and the second pass drops unconfirmed candidates, converts cited message numbers to export positions, ignores invalid ids, and raises severity only when the student repeats a misconception after the assistant replied.
- Ranking counts each student once at their deepest severity, weights by course topic importance, keeps findings the model forgot to group, and orders rows by urgency, then student count, then name; the table prints every line format.
- The CLI end to end: a directory of exports produces the table or JSON, invalid files and unusable model replies are skipped without stopping the run, every file failing exits non-zero, the ranking is saved to a file, a rerun makes no model requests, editing a transcript or changing the model re-analyzes it, `--course` saves and reuses topics and hand edits change the ranking, and `--no-verify` skips the second pass.
- The `/misconceptions` command is registered with the right hints, its template runs this same OpenCode, and its prompt is hidden.

#### Why these are sufficient
- The acceptance criteria in #14 are each covered: a directory of transcripts (CLI tests), an optional course document (`--course` tests), categorizing with severity (extraction, verify and dedupe tests), ranking by an urgency score that accounts for severity (ranking tests), and long-context conversations (splitting tests plus the 104-message sample).
- Every pure function is tested in isolation, and the end-to-end tests run the real binary exactly as a TA would, with a fake model so they are deterministic and need no network or key.
- The tests were written from a behavior specification by someone who had not seen the implementation, so they check the specified behavior rather than mirror the code. Running them against 13 deliberately planted bugs (for example "cache ignores the model", "urgency ignores topic weight", "long message cut off instead of split", "second pass never drops anything") caught all 13.
- What the fake model cannot prove is accuracy. The 44 sample sessions carry labels seeded at generation (`sessions/expected.json`, not human-written); on them the two-stage extraction finds 96% of the seeded misconceptions with 57% precision, versus 99% and 41% for the single pass, and the sessions with no misconceptions go from 16 invented findings to 1. The evaluation harness that measures this is submitted separately.
- Not automated: the chat model's write-up in the TUI (checked manually, see the recordings) and real-model accuracy on human-labeled transcripts.
