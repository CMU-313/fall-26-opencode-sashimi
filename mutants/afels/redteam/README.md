# Red team attack: Learning Mode (Tutor agent), slaman

Target: Sara Laman's Learning Mode properties, `CMU-313/fall-26-opencode-team-berry-fresh` PR #35, branch `slaman/properties`.
All three patches change `packages/opencode/src/agent/agent.ts`. Apply with `git apply <file>` from the repo root, then run `bun test test/learning-mode` in `packages/opencode`.

## A1: `.env.local` and other `.env.*` files no longer ask before Tutor reads them (targets R2)

**Change:** removes the `"*.env.*": "ask"` line from the shared `read` rules, as if someone "simplified" the `.env` patterns thinking `*.env` already covers env files.

**Requirement broken:** R2's acceptance criteria say reading `config.env.local` evaluates to ask. With A1 it evaluates to allow, so Tutor reads secret files like `.env.local` and `.env.production` without asking.

**Which property it should slip past, and why:** R2's property uses Build's read rules as its oracle (`tutor read == build read`). After the P4 fix, Build and Tutor share the same `read` constant, so this change breaks both agents in exactly the same way and the comparison still passes. The second R2 check only uses `projectPath`, which never generates a `.env` file. Nothing checks the actual `ask` result for a secret path.

## A2: Tutor may run "read-only" git commands (targets R3)

**Change:** the final Tutor override keeps `edit: "deny"` but turns `bash: "deny"` into `"*": "deny"` plus allows for `git log*`, `git diff*`, `git show*`, `git status*`, with a comment saying it lets Tutor explain recent changes.

**Requirement broken:** R3 says Tutor must not run any shell commands, including git commands. With A2, `git log -5` evaluates to allow for Tutor.

**Which property it should slip past, and why:** R3 has no property. The properties that touch `bash` are R4 and R5. R4's `shellCommand` generator only produces `ls`, `bun test`, `git push`, `git commit -m x`, `rm -rf .`, or `git commit -m` / `git push` / `echo` / `cat` followed by random text, so it never produces `git log`, `git diff`, `git show`, or `git status`. R5 only checks `bash` with the literal pattern `"*"`, which doesn't match `git log*`. R1 only checks `edit`/`write`/`apply_patch`.

## A3: the "global config can't loosen Tutor" guard only applies when the config uses `"*": "allow"` (targets R4)

**Change:** the final `{ edit: "deny", bash: "deny" }` override is only added when `cfg.permission?.["*"] === "allow"`, with a comment claiming Tutor's own `"*": "deny"` already wins otherwise.

**Requirement broken:** R4's acceptance criteria use `{"permission": {"bash": "allow", "edit": "allow"}}`, which has no `"*"`. With A3, the guard is skipped and the user's `bash: "allow"` and `edit: "allow"` come last, so Tutor can edit files and run shell commands.

**Which property it should slip past, and why:** R4's property only ever runs with one fixed config, `{ "*": "allow", bash: "allow", edit: "allow", grep: "deny" }`, which happens to include `"*": "allow"`, so the guard is still applied in the only case it tests. The generator varies the file and the command but never the config. R1 and R5 run with no user config, where Tutor's own `"*": "deny"` still denies `edit` and `bash`.

## How I checked

I couldn't install the target repo's full test environment, so I copied their `Wildcard.match` and `Permission.evaluate`/`fromConfig`/`disabled` logic and their four properties (same generators) into a small script and ran it against the real rules and each mutant. All three mutants pass R1, R2, R4 and R5, while breaking the acceptance criteria above (`config.env.local` read → allow, `git log -5` → allow, `bash`/`edit` with `{"bash":"allow","edit":"allow"}` → allow). Please confirm by applying each patch and running the real tests.
