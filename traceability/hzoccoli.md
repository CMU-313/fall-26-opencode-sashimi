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

| ID | Interview evidence | Requirement | Acceptance Criteria | Changed in P4? | Property (kind) | Test | Mutants it kills |
|---|---|---|---|---|---|---|---|
| R1 | S-3, C-2 | A hint never gives the full solution or writes the code, at any level. | At levels 1 to 5, the reminder text includes the solution-withholding instruction, and the level 1 text contains no code fence. | No | **Invariant:** for every level 1–5, the prompt withholds the solution and the code, and level 1 has no code fence. | `R1: every level withholds the solution and has no code fence at level 1` | H5 |
| R2 | S-3, C-1 | Early hints point the student at where to look or what to think about, without naming the change or stating the solution. | At levels 1 and 2, the prompt text withholds the solution and the code, and does not name the specific code change (level 1) or the change itself (level 2). | Yes | **Invariant:** for levels 1 and 2, the prompt withholds the solution and matches the early-hint wording. | `R2: levels 1 and 2 point without naming the change or stating the solution` | H5 |
| R3 | C-1, S-3 | Each consecutive hint is more specific than the last, up to level 5. | Starting from a fresh session, five distinct hint messages produce levels 1, 2, 3, 4, 5, and a sixth distinct message stays at 5. | No | **Invariant:** for any sequence of 1–8 distinct hint messages from a fresh session, the saved level is `min(i, 5)` after the i-th message; build agent must not climb. | `R3: distinct hint messages climb from 1 and stay at 5`, `R3: build agent does not climb the hint level or inject the hint prompt` | H1, H3 |
| R4 | O-2, C-2 | Hint mode cannot change the project, even if the user’s config allows edits. | With `edit`, `bash`, and `task` set to allow in user config, the hint agent still denies all three, and `write` / `apply_patch` stay disabled with `edit`. | No | **Invariant:** for sampled user configs of allow/ask/deny on edit/bash/task, `Agent.get("hint")` still denies edit/bash/task and disables write/apply_patch. | `R4: hint denies win over any user edit/bash/task allow` | H4 (after P5 strengthening) |
| R5 | C-4, O-3 | The hint level resets when the student leaves hint mode. | After the session has been raised to level 3 or higher, writing `hintLevel: 0` (as leaving hint mode does) makes the next hint level 1. | No | **Metamorphic:** for any prior stored level, writing `hintLevel: 0` then asking again yields level 1 (including when the same `hintMessageID` is kept). | `R5: after a reset to 0 the next hint is level 1`, `R5: same message id after a reset to 0 still yields level 1` | H3 |
| R6 | C-7 | Every hint reply shows the current level. | `label(session)` is `Hint level N of 5`, where N is the stored level clamped to 1–5. | No | **Model/oracle:** for any stored level (including missing, 0, and past 5), `label()` equals the clamp formula. | `R6: label matches the clamped stored level` | *(none of H1–H5 targeted R6; Stryker label mutants killed)* |
| R7 | C-5 | Reusing the same hint message does not raise the level a second time. | After a level-2 session has applied a given message once (level becomes 3), applying that same message id again leaves the level at 3. | Yes | **Metamorphic:** for any start level 0–4 and any message id, applying that id twice leaves the level at `min(start+1, 5)`. | `R7: the same message id does not raise the level twice` | H2, H3 |

**AI-generated properties:** Cursor helped draft the property file and generators (see Agent failure case for the weak R4 it suggested). I checked each property against the requirement and acceptance criteria in this table; R4 was strengthened in P5 after H4 survived.

## Requirement changes

| ID | Original (P3) | Revised (P4) | Why it changed |
|---|---|---|---|
| R2 | Early hints guide with a question or a pointer instead of stating the answer. Acceptance: the level 1 and 2 prompt text tells the model to ask a guiding question and contains no instruction to state the solution. | Early hints point the student at where to look or what to think about, without naming the change or stating the solution. Acceptance: at levels 1 and 2, the prompt text withholds the solution and the code, and does not name the specific code change (level 1) or the change itself (level 2). | Checkability. The prompt has a soft “Ask a question if that helps” line for every level, not a hard requirement to ask a question at levels 1 and 2. The interviewees (C-1, S-3) needed early hints that guide without giving the answer. That is already what levels 1 and 2 say, so the requirement now checks that wording instead of a mandatory question. |
| R7 | Asking to clarify a hint does not raise the level. Acceptance: after a level 2 hint, a message marked as a clarification leaves the level at 2. | Reusing the same hint message does not raise the level a second time. Acceptance: after a level-2 session has applied a given message once, applying that same message id again leaves the level at 3. | Feasibility. The product has no “clarification” message type, and free-text detection of “what do you mean?” is not reliable enough to build as stated. What C-5 needed was that clarifying or continuing the same ask should not jump to a more specific hint. The code already stores `hintMessageID` so a later step of the same message does not bump the level; the revised requirement checks that. |

## Hand-written mutants

Patches live in `mutants/hzoccoli/H1.patch` … `H5.patch`. Predictions were written before applying each patch. Actual results are from `bun test test/session/hint.property.test.ts` in `packages/opencode` after `git apply`.

| ID | Requirement targeted | Change | Predicted killer | Actual result |
|---|---|---|---|---|
| H1 | R3 | `reminders.ts`: removed the level-5 cap in `bumpedHintLevel` (`Math.max(level, 0) + 1` instead of `Math.min(..., 5)`), so a 6th distinct hint can reach level 6 | R3 | **Killed by R3:** after 6 distinct messages, expected level 5, got 6 |
| H2 | R7 | `reminders.ts`: deleted the `hintMessageID === messageID` early return, so a later step of the same message bumps again | R7 | **Killed by R7:** second apply of the same id raised the level (expected 1, got 2) |
| H3 | R5 | `reminders.ts`: bump uses `Math.max(level, 1) + 1`, so after a leave-mode reset to 0 the next hint becomes 2 | R5 | **Killed by R5** (also R3 and R7): after reset to 0, next level was 2 instead of 1; fresh climb and same-id cases that start at 0 also broke |
| H4 | R4 | `agent.ts`: hint agent `edit: "deny"` changed to `edit: "allow"` | R4 | **Survived** on the original R4 (it rebuilt the deny map in the test and never read `agent.ts`). **Killed by R4 after strengthening:** R4 now loads `Agent.get("hint")` under sampled user permission configs; with H4 applied, `edit` evaluates to `allow` |
| H5 | R1 | `hint.txt`: removed `Do not write the code that solves the task.` from the shared withholding line | R1 | **Killed by R1 and R2:** both assert that phrase is present in the prompt text |

## Stryker comparison

Config: `packages/opencode/stryker.hzoccoli.config.json` runs only `bun test test/session/hint.property.test.ts` and mutates the hint paths in `reminders.ts` (apply block + `bumpedHintLevel`/`label`) and the hint permission `fromConfig` block in `agent.ts`. Reports: `mutants/hzoccoli/mutation-initial.html` (first run, before strengthening) and `mutants/hzoccoli/mutation.html` (final).

**Seed:** `fc.configureGlobal({ seed: 42 })` at the top of `hint.property.test.ts`.

**Initial mutation score:** 64.81% (35 killed, 19 survived, 54 mutants). Most `agent.ts` survivors existed because R4 did not load the real hint agent. Several `reminders.ts` survivors emptied `setMetadata(...)` or flipped `agent.name === "hint"` to `true`, which the properties never noticed.

**Final mutation score (Stryker):** 96.00% (48 killed, 2 survived, 50 mutants). After narrowing the agent mutate range to the permission block and strengthening properties, 4 of 5 agent permission mutants and almost all reminder mutants are killed.

**Final mutation score with equivalent mutants excluded:** 97.96% (48 killed / 49 non-equivalent). One of the two survivors is equivalent (below); the other is not equivalent but sits outside R1–R7’s oracle.

### Which hand-written mutants did Stryker never generate? Why not?

Stryker never generated **H1**, **H2**, **H3**, or **H5** as written. It only flips operators, empties strings/objects, or replaces conditions with `true`/`false`. It does not invent “drop the cap entirely” (H1), delete a whole early-return block (H2), change a floor from `0` to `1` before bumping (H3), or edit the `hint.txt` prompt file (H5 is outside Stryker’s JS/TS mutators). It **did** generate the same idea as **H4** (`edit: "deny"` → something that is not deny, including `""`), which is why strengthening R4 to read `agent.ts` mattered for both H4 and the Stryker permission survivors.

### Which Stryker survivors would I never have thought of? Are any plausible?

- **`question: "allow"` → `""`.** I would not have written that by hand. It does not break R4’s edit/bash/task checks. A real developer could typo a permission value; students would not notice in hint mode unless they use the question tool.
- **`typeof current === "number" && current >= 1` → `true && current >= 1`.** Plausible “simplify the guard” refactor. Under the invariant that `hintLevel` is only ever stored as a number (or absent), it behaves the same — see equivalent argument below.
- Earlier (before strengthening): emptying `setMetadata({...})` while still assigning `session.metadata` in memory, and `if (agent.name === "hint")` → `if (true)`. Those are realistic review misses; the strengthened save assertion and build-agent property kill them now.

### What does each approach find that the other doesn’t?

Hand-written mutants encode requirement-level mistakes from the interviews (cap, same-message guard, reset floor, real deny flag, prompt withholding). They exposed the weak R4 oracle (H4) and would not all appear in Stryker’s catalog. Stryker exhaustively probes syntax near the code we mutate: it found the `setMetadata` / agent-name blind spots and the redundant `typeof` check. It does not edit `hint.txt`, so it cannot replace H5, and it rarely deletes whole control-flow blocks the way H2 does.

### Equivalent mutants

- **`typeof current === "number" && current >= 1` → `true && current >= 1`** in `bumpedHintLevel`. Whenever the same-message branch runs, `hintLevel` was written by this function (or leave-mode wrote `0`). It is always a number when present, so `typeof current === "number"` is always true in that branch. The mutant then reduces to `current >= 1`, which is exactly what the second half of the original guard checks. For every session shape the production code actually writes, behavior is identical, so no property can kill it without inventing illegal non-number metadata the schema does not store.

### Strengthening (properties only)

- **R4** now samples user permission configs and loads `Agent.get("hint")` from production `agent.ts` (kills H4 and edit/bash/task Stryker mutants).
- **`applyHint`** asserts `setMetadata` received `hintLevel` / `hintMessageID` (kills emptied save payloads).
- **Build-agent property** asserts no hint climb / hint prompt (kills `=== "hint"` → `true`).
- **Fresh sessions without a `metadata` field** and **label() with missing metadata** kill optional-chaining mutants.
- **Same message id after reset to 0** kills same-id guards that ignore `current >= 1`.

Non-equivalent survivor left: `question: "allow"` → `""`. No requirement talks about the question tool in hint mode, so I did not add a property for it; it remains in the raw 96% score.

## Agent failure case

**Property:** the original R4 invariant in `hint.property.test.ts` (P4 commit `1cc74c8`), drafted with Cursor for “hint denies win over any user edit/bash/task allow”.

**Transcript:** see `mutants/hzoccoli/agent-failure-transcript.md` (prompt + agent response that inlined the deny map). The weak property as committed:
https://github.com/CMU-313/fall-26-opencode-sashimi/blob/1cc74c8/packages/opencode/test/session/hint.property.test.ts
(A reproducible copy is also in `mutants/hzoccoli/agent-failure-weak-r4.test.ts`.)

### Mutant it let survive

**H4** — `packages/opencode/src/agent/agent.ts`: hint agent `edit: "deny"` → `edit: "allow"` (`mutants/hzoccoli/H4.patch`).

With H4 applied, the weak R4 still passed (100 generated cases, 0 failures). The strengthened R4 in the same tree failed immediately (`Expected: "deny" / Received: "allow"`).

### Why the property was too weak

It was an **always-passing restatement of the intended merge**, not a check of production code. The test rebuilt `hintDenies` with hard-coded `edit/bash/task: "deny"` and merged that with the generated user config. That oracle is true for every user config **by construction**, whether or not `agent.ts` still contains those denies. Flipping the real hint agent to `edit: "allow"` (H4) never touched the test’s local `hintDenies` object, so R4 could not disagree with the bug. Classic agent failure mode: looks thorough (200 runs, merge order comment “same as agent.ts”) but never reads the module under test.

### Strengthened version and evidence it kills H4

R4 now samples user permission configs (seed 42) and, for each sample, boots a temp instance and loads **`Agent.get("hint")`** from production `agent.ts`, then asserts edit/bash/task are deny and write/apply_patch stay disabled:

```ts
const hint = yield* Agent.Service.use((svc) => svc.get("hint"))
expect(Permission.evaluate("edit", "*", hint.permission).action).toBe("deny")
// ... bash, task, disabled([...])
```

Evidence (H4 applied, then reverted):

| Property | Result with H4 |
|---|---|
| Weak R4 (`agent-failure-weak-r4.test.ts`) | **Survived** — 1 pass, 0 fail |
| Strengthened R4 (`hint.property.test.ts`) | **Killed** — `edit` was `allow`, expected `deny` |
