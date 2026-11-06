# Traceability — Harrison Zoccoli (hzoccoli)

**Target feature:** Hint mode, specifically the hint level logic (level rises from 1 to 5, caps at 5, resets when the student leaves hint mode) and the guarantee that hint mode cannot change the project.

**Main source files:**
- `packages/opencode/src/agent/agent.ts`: hint agent and permission denies (`edit`, `bash`, `task`)
- `packages/opencode/src/session/reminders.ts`: saved `hintLevel` / `hintMessageID`, reminder text, `label()`
- `packages/opencode/src/session/prompt/hint.txt`: the five-level prompt
- `packages/opencode/src/session/prompt.ts`: visible `Hint level N of 5` line on step 1
- `packages/tui/src/context/local.tsx`: reset to `hintLevel: 0` when leaving hint mode

**Property tests:** `packages/opencode/test/session/hint.property.test.ts`

## Requirements

| ID | Interview evidence | Requirement | Acceptance Criteria | Changed in P4? | Property (kind) | Test |
|---|---|---|---|---|---|---|
| R1 | S-3, C-2 | A hint never gives the full solution or writes the code, at any level. | At levels 1 to 5, the reminder text includes the solution-withholding instruction, and the level 1 text contains no code fence. | No | **Invariant:** for every level 1–5, the prompt withholds the solution and the code, and level 1 has no code fence. | `R1: every level withholds the solution and has no code fence at level 1` |
| R2 | S-3, C-1 | Early hints point the student at where to look or what to think about, without naming the change or stating the solution. | At levels 1 and 2, the prompt text withholds the solution and the code, and does not name the specific code change (level 1) or the change itself (level 2). | Yes | **Invariant:** for levels 1 and 2, the prompt withholds the solution and matches the early-hint wording. | `R2: levels 1 and 2 point without naming the change or stating the solution` |
| R3 | C-1, S-3 | Each consecutive hint is more specific than the last, up to level 5. | Starting from a fresh session, five distinct hint messages produce levels 1, 2, 3, 4, 5, and a sixth distinct message stays at 5. | No | **Invariant:** for any sequence of 1–8 distinct hint messages from a fresh session, the saved level is `min(i, 5)` after the i-th message. | `R3: distinct hint messages climb from 1 and stay at 5` |
| R4 | O-2, C-2 | Hint mode cannot change the project, even if the user’s config allows edits. | With `edit`, `bash`, and `task` set to allow in user config, the hint agent still denies all three, and `write` / `apply_patch` stay disabled with `edit`. | No | **Invariant:** for any user config of allow/ask/deny on edit/bash/task, merging defaults + user + hint denies still denies edit/bash/task and disables write/apply_patch. | `R4: hint denies win over any user edit/bash/task allow` |
| R5 | C-4, O-3 | The hint level resets when the student leaves hint mode. | After the session has been raised to level 3 or higher, writing `hintLevel: 0` (as leaving hint mode does) makes the next hint level 1. | No | **Metamorphic:** for any prior stored level, writing `hintLevel: 0` then asking again yields level 1. | `R5: after a reset to 0 the next hint is level 1` |
| R6 | C-7 | Every hint reply shows the current level. | `label(session)` is `Hint level N of 5`, where N is the stored level clamped to 1–5. | No | **Model/oracle:** for any stored level (including missing, 0, and past 5), `label()` equals the clamp formula. | `R6: label matches the clamped stored level` |
| R7 | C-5 | Reusing the same hint message does not raise the level a second time. | After a level-2 session has applied a given message once (level becomes 3), applying that same message id again leaves the level at 3. | Yes | **Metamorphic:** for any start level 0–4 and any message id, applying that id twice leaves the level at `min(start+1, 5)`. | `R7: the same message id does not raise the level twice` |

**AI-generated properties:** Cursor helped draft the property file and generators. I checked each property against the requirement and acceptance criteria in this table.

## Requirement changes

| ID | Original (P3) | Revised (P4) | Why it changed |
|---|---|---|---|
| R2 | Early hints guide with a question or a pointer instead of stating the answer. Acceptance: the level 1 and 2 prompt text tells the model to ask a guiding question and contains no instruction to state the solution. | Early hints point the student at where to look or what to think about, without naming the change or stating the solution. Acceptance: at levels 1 and 2, the prompt text withholds the solution and the code, and does not name the specific code change (level 1) or the change itself (level 2). | Checkability. The prompt has a soft “Ask a question if that helps” line for every level, not a hard requirement to ask a question at levels 1 and 2. The interviewees (C-1, S-3) needed early hints that guide without giving the answer. That is already what levels 1 and 2 say, so the requirement now checks that wording instead of a mandatory question. |
| R7 | Asking to clarify a hint does not raise the level. Acceptance: after a level 2 hint, a message marked as a clarification leaves the level at 2. | Reusing the same hint message does not raise the level a second time. Acceptance: after a level-2 session has applied a given message once, applying that same message id again leaves the level at 3. | Feasibility. The product has no “clarification” message type, and free-text detection of “what do you mean?” is not reliable enough to build as stated. What C-5 needed was that clarifying or continuing the same ask should not jump to a more specific hint. The code already stores `hintMessageID` so a later step of the same message does not bump the level; the revised requirement checks that. |
