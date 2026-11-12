# Traceability: Inseo Kim (inseok)

**Target feature:** Tool permission request descriptions and approval dock for read/write/edit requests in the agent permission flow (main source files: `packages/tui/src/routes/session/permission.tsx`, `packages/opencode/src/cli/cmd/run/permission.shared.ts`, `packages/opencode/src/cli/cmd/run/tool.ts`, `packages/opencode/src/tool/write.ts`).

## Requirements

| ID | Interview evidence | Requirement | Acceptance Criteria | Changed in P4? | Property (kind) | Test | Mutants it kills |
|---|---|---|---|---|---|---|---|
| R2 | C-22: “read, write, edit”; S-3: “recognize a read request as distinct from an edit request”; O-12 | The description must state the action type (read, write, or edit) in plain words and must match the permission being requested. | A read request for src/components/Button.tsx displays “Agent wants to read the file src/components/Button.tsx”. A write request for the same path displays a description containing “write” and not “read”. | no | Model / oracle | `permission.shared.test.ts`: For generated read, write, and edit requests and paths, compare displayed action wording with the requested action; `write.test.ts` checks emitted write metadata. | H1 |
| R3 | C-3: “mentioning the file name”; C-18; S-7; O-10 | The description must name the specific file the tool call is requesting. | A request for Button.tsx displays a description containing Button.tsx. A subsequent request for Link.tsx displays a description containing Link.tsx and not Button.tsx. | no | Invariant | `permission.shared.test.ts`: For generated file paths, assert the description contains the requested filename and does not contain a different generated filename. | H2 |
| R4 | S-4; S-7: “only the file name should change in the description”; O-4; O-5 | When only the requested file changes, the rest of the description and the control options (Allow once, Allow always, Reject) must remain identical. | Two read requests that differ only in file path produce descriptions that are identical once the path text is removed, and the dock shows the same three controls in the same order for both. | no | Metamorphic | `permission.shared.test.ts`: Replace a generated read-request path with another path; after removing the path, assert the description is unchanged and verify expected controls in both permission and confirmation stages. | H3 |
| R5 | C-19: “a little unnecessary details”; C-20 | A write description must summarize the content by size (line count or character count) and must not display the content or narrate individual line changes. | A write of a 42-line file to notes.txt displays a description that names notes.txt and states 42 lines. The description contains none of the written text. | no | Invariant | `permission.shared.test.ts`: For generated file contents, assert write descriptions report the correct line count and hide content/diffs; also verify edit descriptions retain their diffs, writes without size metadata do not show misleading content, and titles do not narrate line changes. `write.test.ts` checks emitted line-count metadata. | H4, H6 |
| R6 | S-10; O-12; O-13 | A write-permission explanation must clearly identify whether the operation will create a new file or modify an existing file, and name the target. | A write request for a new target displays “Write new file” and its path. A write request for an existing target displays “Write existing file” and its path. | yes | Metamorphic | `permission.shared.test.ts`: For generated target paths, compare write requests with `exists` false and true; assert the explanation distinguishes new from existing, names the same target, and leaves the approval controls unchanged; `write.test.ts` checks emitted existence metadata. | H5 |

Properties written or suggested by opencode or another AI tool: R2, R3, R4, R5, R6.  Each one was verified by me against the requirements and acceptance criteria.

## Hand-Written Mutants with Predictions

Predictions were recorded before applying or running any mutant.

| ID | Requirement targeted | Change | Predicted killer | Actual result |
|---|---|---|---|---|
| H1 | R2 | `packages/opencode/src/cli/cmd/run/tool.ts`: the edit-permission fallback title says “Write” instead of “Edit”. | R2 property: a generated edit request should no longer have a title beginning with “Edit”. | Killed: the generated edit case fails the action-title assertion (R2); the strengthened R5 edit-preservation property also detects the changed title. |
| H2 | R3 | `packages/opencode/src/cli/cmd/run/tool.ts`: read permission descriptions stop falling back to the requested permission pattern when no input file path is present. | R3 property: a generated read request containing only a pattern should omit its requested filename. | Killed: R3's generated pattern-only request fails to include the requested filename. |
| H3 | R4 | `packages/opencode/src/cli/cmd/run/permission.shared.ts`: the initial approval options are reordered so Reject precedes Allow always. | R4 property: the control labels should no longer be Allow once, Allow always, Reject in that order. | Killed: R4's generated control-order assertion fails. |
| H4 | R5 | `packages/opencode/src/cli/cmd/run/tool.ts`: displayed write line count is one less than the supplied line count. | R5 property: the generated expected content-size summary should differ from the displayed count. | Killed: R5's generated line-count oracle fails. |
| H5 | R6 | `packages/opencode/src/cli/cmd/run/tool.ts`: the existence check labels existing files as new and new files as existing. | R6 property: the generated new/existing requests should receive the opposite operation descriptions. | Killed: R6's generated new/existing title assertions fail. |
| H6 | R5 | `packages/opencode/src/cli/cmd/run/tool.ts`: for write requests with a line count but no `exists` metadata, append “Changed the first and last lines” to the title. Patch: `mutants/inseok/H6.patch`. | The opencode-generated R5-PRIVACY property was expected to survive because it checks content privacy and summary lines but not title narration. | Survived the original R5-PRIVACY property (11 pass, 0 fail); killed after strengthening it with an exact title assertion (10 pass, 1 fail). |

## Agent Failure Case

Screenshots of the opencode prompt and response:
![alt text](<Pasted Graphic 5.png>)
![alt text](<Pasted Graphic 6.png>)
![alt text](<Pasted Graphic 7.png>)

![alt text](<Pasted Graphic 8.png>)
![alt text](<Pasted Graphic 9.png>)
![alt text](<Pasted Graphic 4.png>)

Opencode share link: https://opncd.ai/share/BLss7GBN

**Prompt excerpt:**

> Please add one fast-check property ... for R5: “A write description must summarize the content by size (line count or character count) and must not display the content or narrate individual line changes.” For this property, focus specifically on the privacy part: generated write content must not appear in the permission description, and the write diff must not be exposed. Use generated inputs and `fc.assert`; do not add fixed example-based tests.

**Opencode response excerpt:**

> “The property verifies that the line count summary is still correctly displayed in the `lines` array (`Content: X lines`)” and “doesn't validate that descriptions don't include narrative descriptions of line-by-line changes.”

The generated R5-PRIVACY property checked that write content and its diff were hidden and that `info.lines` equaled the expected content-size summary. It did not check the title for unrelated line-change narration, so H6 could append such narration while all of the generated assertions still passed. H6 is a plausible R5 regression: its title says individual lines changed even though the requirement asks for a size summary instead of narrating edits.

The response also claimed the property “doesn't validate that the size information is presented correctly.” That description was inaccurate: the generated code asserted the exact `Content: N line(s)` summary, which is why it killed H4.

**H4 result:** I applied `mutants/inseok/H4.patch` and ran only `cd packages/opencode && bun test test/cli/run/permission.shared.test.ts`. The run had **9 passing tests and 2 failing tests**; fast-check shrank the R5 counterexample to `lines = ["AAAAA"]`, `name = "a.tsx"` (seed 42). Both the existing R5 property and R5-PRIVACY failed because both assert the exact line-count summary, so H4 was already killed; it is not the surviving mutant used for this agent failure case. I reverted H4 after the run.

**Mutant the generated property let survive:** H6 is the agent failure mutant for R5. With H6 applied before strengthening, the focused test command passed **11 tests with 0 failures**, demonstrating that the generated property allowed the extra title narration.

**Strengthened property:** The R5-PRIVACY property now also asserts `info.title` equals `Write existing file ${filepath}` for its generated write request. This checks that the title identifies the operation and target without appending line-by-line narration. Reapplying H6 and running the same focused command then produced **10 passing tests and 1 failing test**; the R5-PRIVACY property failed with seed 42 and shrank to `lines = ["AAAAA"]`, `name = "a.tsx"`. H6 was reverted after this run. The strengthened property and passing control behavior are in `packages/opencode/test/cli/run/permission.shared.test.ts`, and the reproducible mutant is saved as `mutants/inseok/H6.patch`.

## Stryker Run & Comparison

The property test uses fast-check seed **42** via `fc.configureGlobal({ seed: 42 })`. Stryker 10.1.1 was run from `packages/opencode` with `bunx stryker run stryker.inseok.config.json`; the command runner ran only `bun test test/cli/run/permission.shared.test.ts`, and the mutation scope was limited to the permission formatter and option-list source ranges in that package. The final run used a 15-second mutant timeout to avoid scheduling-related timeouts. The HTML report is saved at `mutants/inseok/mutation.html`.

The initial score was **66.67% (44 killed, 22 survived, out of 66 mutants)**. After strengthening the properties, the latest Stryker score is **74.24% (49 killed, 17 survived, 0 timeouts, out of 66 mutants)**. I do not classify any surviving mutant as equivalent: each changes observable output for at least one input, even when the changed behavior does not violate the current requirements. Therefore the score with equivalent mutants excluded is also **74.24% (49 killed out of 66 non-equivalent mutants)**. 

### Strengthening

R4 now checks generated path changes against both permission-stage controls and confirmation-stage controls, which detects stage-selection mutants while retaining the path metamorphic check. R5 now varies edit diffs, checks that writes without a line count do not show misleading size text or diffs, keeps write content hidden, and asserts the title contains only the operation and target rather than line-change narration. H1–H5 were applied individually and killed by the focused property tests; H6 was first allowed by the opencode-generated property, then killed by its strengthened title assertion.

### Comparison

- **Hand-written mutants Stryker did not generate:** Stryker did not generate any of H1–H6 as the exact same change. H1's action-label replacement, H2's removal of only the pattern fallback, H3's option reorder, H4's one-line decrement, H5's flipped existence check, and H6's appended line-change narration require edits its mutation operators did not produce. Stryker generated related smaller mutations, such as changing the existence comparison, but not these complete hand-written changes.
- **Stryker survivors I would not have designed:** The 17 survivors include icon changes, home-directory path-rendering changes, a no-path fallback string, and variations in read-path lines and edit-diff handling. These outputs are observable, but several are outside the current requirement examples or only differ for inputs the properties do not generate (such as absolute paths under the home directory). I do not claim these are equivalent; they indicate untested input or behavior dimensions.
- **What each approach finds:** The hand-written mutants encode requirement-level mistakes, including a deliberate action-label change, path fallback removal, option reorder, off-by-one count, reversed create/modify labels, and line-change narration; H1–H6 were killed by the strengthened property suite. Stryker explores smaller syntax-level changes and shows untested output variations, but does not generate every plausible multi-token edit or array reorder. The current report, rerun with the title assertion, is saved at `mutants/inseok/mutation.html`.

## Requirement changes

| ID | Original requirement (P3) | Revised requirement | Why it changed |
|---|---|---|---|
| R6 | A tool call that requires permission must remain paused while the description is displayed and must execute only after the user selects Allow once or Always allow. | A write-permission explanation must clearly identify whether the operation will create a new file or modify an existing file, and name the target. | The original requirement is outside the scope of the feature, which is explaining tool actions before approval, thus it is not feasibile to implement the properties for this requirement. The revised requirement reflects interview evidence about distinguishing file creation from editing, and is within the feature's scope. |

R2-R5 are kept as written because they are in scope and have checkable acceptance criteria. R6 required an addition to the tool test confirming that write requests include the file-existence and line-count metadata the descriptions use. The CLI formatter and TUI display were updated to show those descriptions and avoid displaying write diffs.