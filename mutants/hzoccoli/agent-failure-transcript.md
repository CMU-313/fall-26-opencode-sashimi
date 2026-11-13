# Agent failure transcript (R4)

Source: Cursor agent session while drafting Project 4 property tests for hint mode
(also reflected in commit `1cc74c8` on `hzoccoli/properties`). The property below
is what landed in `hint.property.test.ts` before Project 5 strengthening.

## Prompt

> Write a fast-check property for requirement R4: Hint mode cannot change the
> project, even if the user’s config allows edits. The hint agent in
> `agent.ts` merges defaults, then user permissions, then denies for
> `edit` / `bash` / `task`. Use an invariant over random user permission
> configs.

## Agent response (excerpt)

> Use an invariant over generated user configs. Rebuild the same merge the
> hint agent uses: defaults (`*`: allow), the user’s config, then the hint
> denies. Assert `edit`, `bash`, and `task` always evaluate to `deny`, and
> that `write` / `apply_patch` stay disabled with `edit`.
>
> ```ts
> test("R4: hint denies win over any user edit/bash/task allow", () => {
>   const runs = 200
>   fc.assert(
>     fc.property(userPermissionConfig, (user) => {
>       const defaults = Permission.fromConfig({ "*": "allow" })
>       const hintDenies = Permission.fromConfig({
>         question: "allow",
>         edit: "deny",
>         bash: "deny",
>         task: "deny",
>       })
>       // Same order as agent.ts: defaults, user, then the hint denies.
>       const merged = Permission.merge(defaults, Permission.fromConfig(user), hintDenies)
>       expect(Permission.evaluate("edit", "*", merged).action).toBe("deny")
>       expect(Permission.evaluate("bash", "*", merged).action).toBe("deny")
>       expect(Permission.evaluate("task", "*", merged).action).toBe("deny")
>       expect(Permission.disabled(["edit", "write", "apply_patch", "bash"], merged)).toEqual(
>         new Set(["edit", "write", "apply_patch", "bash"]),
>       )
>     }),
>     { numRuns: runs },
>   )
> })
> ```

Permalink to that version on the branch (P4 commit):
`https://github.com/CMU-313/fall-26-opencode-sashimi/blob/1cc74c8/packages/opencode/test/session/hint.property.test.ts`

(If you later get an opencode `/share` link for the original chat, paste it here.)
