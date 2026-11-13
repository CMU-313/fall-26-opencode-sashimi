# Traceability: Steven Mao (smao2)

**Target feature:** <feature, and the main source files it lives in>

## Requirements

| ID | Interview evidence | Requirement | Acceptance Criteria | Changed in P4? | Property (kind) | Test |
|---|---|---|---|---|---|---|
| R1 | S-7: “Something concrete to test would be to test the length, which is simpler.” |
When a title is generated, assert that the length is < 5 words.|
UNCHANGED|
INVARIANT| | |

| R2 |S-8: “That could work, a lot of techniques pre LLMs use that in order to test, so it could work, I think that’s a good one.” |
When a title is generated, have at least one word be in the conversation history.|
UNCHANGED|
INVARIANT| | |

| R3 | O-4: If I rename and then run autoname again, it should not change it back to its original title, because it should assume that the user didn’t find the title satisfactory. |
When the title is generated, save it then generate another title, and make sure they are not the same.|
UNCHANGED|
ALGEBRAIC| | |

| R4 | O-3: When using /autoname, I wouldn’t expect the chat to change, the UI shouldn’t change, if it breaks the UI then it is not functional, it shouldn’t change the agent that I’m using. |
Assert that all the message history is the same, and that the model is the same before and after the command.|
UNCHANGED|
INVARIANT| | |

| R5 |  S-1: I, like many people, have heard a lot of rogue AIs, so I would like to have fine grained permissions so it doesn’t touch what it doesn’t have to and also tells me what it will do before it does it so I can verify. | 
Permissions for the AI should be restricted while the autoname command is being run, and the flags unrelated to title should be denied edit access.
|NOT IMPLEMENTED| | | |

Properties written or suggested by opencode or another AI tool: <list by requirement ID, or "none">:<"none">

## Requirement changes

| ID | Original requirement (P3) | Revised requirement | Why it changed |
|R2||When a title is generated, assert that the length is < 5 words.|When a title is generated, assert that the length is <= 5 words.|

This was a misunderstanding of my previous requirements, the title should be 2-5 words long, which includes 5.

## P5: Hand-written mutants
## P5: Hand-written mutants

Patches live in `mutants/smao2/H*.patch`, created by modifying the `/autoname` implementation in `packages/opencode/src/session/prompt.ts`, saving each change with `git diff > mutants/smao2/Hn.patch`, and restoring the original code with `git restore` or `git apply -R`. Predictions were made before running the mutants. Each mutant was applied independently and tested using `bun test test/command/autoname.property.test.ts` from `packages/opencode`.

| ID | Requirement | Change | Predicted killer | Actual result |
|---|---|---|---|---|
| H1 | R1: Title length | Changed `.slice(0, 5)` to `.slice(0, 6)`, allowing generated titles to contain six words instead of five. | Title-length invariant, since it checks that saved titles contain fewer than six words. | **Killed** by the title-length invariant. The test received a six-word title when it expected fewer than six. All seven other tests passed. |
| H2 | R1: Title length | Changed `.slice(0, 5)` to `.slice(0, 1)`, truncating generated titles to a single word and violating the two-word minimum. | P2 persistence, since the saved title would no longer match the generated multiword title. | **Killed** by P2 persistence, P3 metamorphic, R3 relevance, and R4 repeated renaming. For example, P2 expected `ntlwn cch jpsefxbvpn` but received `ntlwn`. The title-length invariant survived because it only checks the upper bound, not the two-word minimum. |
| H3 | Response processing | Changed `for (const part of result.parts)` to `for (const part of result.parts.slice(0, -1))`, skipping the final response part. Since the `RENAMED:` output appears at the end, this can prevent the session title from being updated. | P2 persistence, since the command would ignore the generated title and leave the session title unchanged. | **Survived.** All eight tests passed (343 assertions). This suggests the test fixtures do not depend on the final response part being processed. The earlier version that skipped the first part also survived. The original H3, which used `.slice(1)` to skip the first response part, survived all eight tests. This showed that skipping the first part did not affect the title extraction exercised by the tests. |
| H4 | R2: Title relevance | Changed `.slice(0, 5)` to `.slice(1, 5)`, removing the first word of the generated title. This can also remove the only word shared with the conversation history. | P2 persistence and potentially R3 relevance, since the saved title differs from the expected title. | **Killed** by P2 persistence, P3 metamorphic, R3 relevance, and R4 repeated renaming. P2 expected `ntlwn cch jpsefxbvpn` but received `cch jpsefxbvpn`. The relevance test failed on its exact-title assertion. Four tests passed and four failed. |
| H5 | R3: Repeated renaming | Replaced `title: truncatedTitle` with a constant title, `auto generated truncatedTitle`, causing every invocation to save the same title regardless of the model's response. | P2 persistence and R4 repeated renaming, since the saved title does not match the generated title and repeated executions produce the same result. | **Killed** by P2 persistence, P3 metamorphic, R3 relevance, and R4 repeated renaming. P2 expected `ntlwn cch jpsefxbvpn` but received `auto generated truncatedTitle`. Four tests passed and four failed. |

## P5: Stryker run and comparison

Config: `packages/opencode/stryker.smao2.config.json`. Command runner, pointed only at `test/command/autoname.property.test.ts`. Mutated scope: `src/session/prompt.ts` lines 1492–1525, covering the `/autoname` handler, including response processing, title extraction, truncation, and persistence. Coverage analysis was disabled. The run used `concurrency: 2`, `timeoutMS: 60000`, and `timeoutFactor: 2` because the initial run timed out on all mutants. Report: `mutants/smao2/mutation.html`.

### Run 1: before strengthening

37 mutants, 24 killed, 13 survived, score **64.86%** (`prompt.ts` 64.86%).

The first attempt timed out on all 37 mutants because the property tests took approximately 28 seconds per execution and Stryker launched 19 concurrent runners. After increasing the timeout and reducing concurrency to two, all mutants completed successfully in approximately eight minutes, with zero timeouts.

### Run 2: after strengthening

37 mutants, 26 killed, 11 survived, score **70.27%** (`prompt.ts` 70.27%). All nine property tests passed, with 390 assertions.

### What I strengthened

All changes were to property generators and assertions, not example-based tests.

| Property | Weakness Stryker exposed | Change | Survivors it targets |
|---|---|---|---|
| P2 title persistence | The original generator only produced titles separated by single spaces, so changes to whitespace handling were not detected. | Added generators for repeated spaces, tabs, and leading/trailing whitespace. The property now asserts that the persisted title matches the normalized expected title. | Regex whitespace mutations, including `\s+` → `\s` |
| P5 empty-title preservation | The original tests did not generate empty or whitespace-only titles, allowing the `if (truncatedTitle)` → `if (true)` mutant to survive. | Added a property generating whitespace-only model responses and asserting that the original session title remains unchanged. | ConditionalExpression, line 1509 |
| R2 title-length restriction | The original property only checked that the title had at most five words, without checking which words were retained. | Added an exact assertion that the saved title equals the first five generated words. | Incorrect truncation boundaries and dropped words |

The strengthened properties killed two additional Stryker mutants, increasing the mutation score from 64.86% to 70.27%. The remaining survivors primarily concern command isolation, response-part validation, regex matching, redundant trimming, and error logging.

### Agent Failure

| Test | Original implementation | Whitespace mutant |
|---|---|---|
| OpenCode-generated property | PASS | PASS |
| Strengthened P2 property | PASS | FAIL (mutant killed) |

I first ran the OpenCode-generated property against the original implementation. It passed with 1 test passing, 0 failures, and 100 assertions.

I then manually applied the Stryker mutation `.split(/\s+/)` → `.split(/\s/)` and reran the same property. It still passed with 1 test passing, 0 failures, and 100 assertions, demonstrating that the agent-generated property could not detect the mutation.

Finally, I ran my strengthened P2 persistence property against the same mutant. The test failed with the following counterexample:

```text
Expected: "ntlwn cch jpsefxbvpn"
Received: "ntlwn   cch "

0 pass
9 filtered out
1 fail
5 expect() calls
```

The mutant incorrectly preserved consecutive spaces and truncated the generated title. My strengthened property detected the difference because it generates irregular whitespace and checks the exact normalized title.

This demonstrates that the OpenCode-generated property was insufficient because of its restricted generator, whereas the strengthened property successfully killed the mutant.

OpenCode test: PASSED
  it.instance(
    "Property: every valid 2-5 word title is saved verbatim",
    () =>
      Effect.gen(function* () {
        const titles = fc.sample(titleArb, {
          numRuns: 20,
          seed: 707,
        })

        for (const title of titles) {
          const actual = yield* runAutoname(
            `RENAMED: ${title}`,
            ["Discussing code"],
          )

          expect(actual.title).toBe(title)
        }
      }),
    120_000,
  )

✓ /autoname: real command with controlled LLM responses > Property: every valid 2-5 word title is saved verbatim [9959.63ms]

Strengthened test: FAILED
  it.instance(
    "P2 - Persistence: generated titles are saved and whitespace is normalized",
    () =>
      Effect.gen(function* () {
        const cases = fc.sample(
          fc.tuple(renameResponseArb, historyArb),
          { numRuns: 12, seed: 313 },
        )

        for (const [rename, history] of cases) {
          const actual = yield* runAutoname(
            rename.response,
            history,
          )

          expect(actual.title).toBe(rename.expected)
        }
      }),
    120_000,
  )

✗ /autoname: real command with controlled LLM responses > P2 - Persistence: generated titles are saved and whitespace is normalized [4519.72ms]