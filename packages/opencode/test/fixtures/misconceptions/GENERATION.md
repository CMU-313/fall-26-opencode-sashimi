# Synthetic student session generation: shared spec

You are generating realistic `opencode export` session files for a software-engineering course (CMU 17-313, students
work on NodeBB, a TypeScript/Node.js forum, in teams, with git, GitHub Actions CI, tests, code review). Each session is
a conversation between a student and an AI coding assistant. The sessions are test data for a tool that finds student
misconceptions, so each session must contain EXACTLY the misconceptions assigned to it, shown by the student, and no
others. Questions that are not misconceptions are fine and encouraged (a student asking how something works is not a
misconception; a student asserting or acting on a wrong belief is).

## Format
Copy the exact structure of `/Users/mattdarin/CMU/17313/fall-26-opencode-sashimi/packages/opencode/test/fixtures/misconceptions/template.json`
(read it first). Rules:
- `messages[]` alternate user / assistant, each with `info` (same fields as the template) and `parts`.
- Part types: `text`, `reasoning`, `tool` (status `completed`, with `input`, `output`, `title`, `metadata`, `time`;
  tools: bash, read, edit, grep), `step-start`, `step-finish`. Assistant turns usually include tool calls around text.
- Unique ids per file, increasing timestamps, one consistent sessionID per file. Every file must be valid JSON.
- Student voice: lowercase, casual, sometimes typos; vary the voice between students (some polite, some blunt, some
  verbose, some terse). Assistant: helpful, concise, corrects misconceptions clearly.
- The assistant's reply must NOT re-state a misconception as if it were true. The misconception must be visible in a
  STUDENT message (an assertion, a plan, or an action), except in "terse" sessions (see below).

## Misconception catalog (use these ids and EXACT descriptions in labels)
M01 Believes 100% test coverage means the code has no bugs
M02 Believes git pull only downloads changes without merging them
M03 Believes rebasing and force-pushing a shared branch is harmless
M04 Resolves merge conflicts by taking one side wholesale, believing a conflict means someone made a mistake
M05 Thinks adding an already-committed file to .gitignore untracks it
M06 Thinks async/await runs code on separate threads and forgets to await promises
M07 Concludes CI is broken because the tests pass on their own machine
M08 Thinks a flaky test should be retried until it passes
M09 Cannot tell unit from integration tests and mocks every dependency in an integration test
M10 Believes TypeScript types are checked at runtime and reject bad input
M11 Thinks a clean linter run means the code has no bugs
M12 Writes user stories as implementation tasks, confusing requirements with design
M13 Assumes a major version bump is backward compatible under semantic versioning
M14 Thinks a caret range like ^2.1.0 pins the exact version
M15 Thinks CI runs on their own laptop
M16 Thinks git commit sends changes to GitHub, confusing commit with push
M17 Treats code review as a formality and approves without reading the diff
M18 Thinks switching git branches permanently discards uncommitted work
M19 Thinks committing secrets or .env files is fine because the repository is private
M20 Writes a test that asserts on a mock of the function under test instead of the function itself

## Severity (depth) definitions for labels
- mild: a brief slip the student corrects themselves or accepts after a one-line correction
- moderate: the assistant had to explain it and the student then accepted
- severe: the student repeats or defends it across 2+ messages, or wrote code / ran commands based on it

## Session kinds
- normal: 10–20 messages
- short: 6–10 messages
- long: 50–70 messages, several sub-tasks in one session
- very-long: 100+ messages, the conversation drifts across 3+ topics; misconceptions appear far apart
- clean: NO misconceptions at all. A competent student asks real questions, makes decisions, maybe says "oh i see"
  to new information. Do not include wrong beliefs. These test false positives.
- terse: every STUDENT message is at most 12 words (e.g. "wait what", "so it merged??", "ok", "why red"). The
  misconception is only understandable from the assistant's reply that explains what the student got wrong. Still
  label it on the student's message that shows it.

## Labels
Alongside each session file, append to your labels file (JSON object keyed by file name) entries like:
```json
"student-17.json": [
  { "id": "M03", "description": "<exact catalog description>", "depth": "severe", "messageIndex": 4 }
]
```
`messageIndex` is the 0-based position in `messages` of the student message that best shows it. Clean sessions get
an empty array `[]`. Use the catalog description verbatim.

## Validation
From `/Users/mattdarin/CMU/17313/fall-26-opencode-sashimi/packages/opencode`, run:
```
bun -e 'import {shrink} from "./src/cli/cmd/misconceptions"; for (const f of process.argv.slice(1)) { const t = shrink(await Bun.file(f).text()); console.log(f.split("/").pop(), t ? t.length + " turns" : "INVALID") }' <your files>
```
Fix any INVALID file. Do not edit other files. Do not commit.
