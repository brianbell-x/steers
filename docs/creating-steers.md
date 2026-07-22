# Create a steer

A steer packages one corrective policy in a portable folder. Create a directory
whose name matches the steer name, then add `STEER.md`.

## Example

Use this template when creating a steer:

```markdown
---
name: <steer-name>
description: <short description of the required outcome>
trigger: run_end
mode: blocking
---

## What counts as a violation

Define the prohibited behavior precisely. Draw a clear line between a real
violation and legitimate implementation work. Include examples where useful.

## What the steer must demand

Require visible, verifiable action from the agent:

1. Identify every violation.
2. Cite the user requirement, repository evidence, or fetched documentation
   that permits it.
3. Correct or remove every violation it cannot support.

Assertions from memory and unsupported justification do not count as evidence.

## What counts as resolved

Define resolution using evidence visible in the transcript.

Resolution requires concrete citations, relevant tool calls, or edits that
correct the violations. A prose-only acknowledgment or justification is not
compliance.
```

For example, a steer against unjustified defensive code could use:

```markdown
---
name: unjustified-defensive-code
description: Removes or doc-justifies guardrails the task did not request.
trigger: run_end
mode: blocking
---

## What counts as a violation

The agent added validation, error handling, fallbacks, compatibility behavior,
or other guardrails that the user did not request and that available code or
documentation does not require.

## What the steer must demand

Require the agent to:

1. List each defensive construct with its file and line.
2. Cite fetched documentation or an explicit user requirement that justifies
   it. Assertions from memory do not count.
3. Delete every construct it cannot cite.

## What counts as resolved

The transcript contains concrete citations supporting each retained construct
and edit tool calls removing every unsupported construct.

Justification prose without citations or edits is not compliance.
```

## Choose the lifecycle point

Use `turn_end` when the policy must inspect each completed assistant turn. Use
`run_end` when the policy should inspect the completed agent run before the
harness hands control back to the user.

## Choose the execution mode

Use `blocking` when later work must wait for the verdict. Use `async` when the
harness can continue while the evaluation runs.

## Write an actionable policy

A useful policy states:

1. The evidence that constitutes a violation.
2. The cases that do not constitute a violation.
3. The exact correction to send.
4. The evidence that resolves the correction.

Keep one concern in each steer. Version 0.1 passes only the `STEER.md` policy to
the evaluator, so the policy must not depend on neighboring files.

## Declare compatibility requirements

Use `compatibility` when the policy depends on a particular harness or SDK,
native lifecycle mapping, model capability, tool, command, environment variable,
or required value. Name the dependency precisely enough that an installer can
decide whether the steer will work. Omit the field when there are no additional
requirements.

## Install it

For local harnesses, the recommended shared locations are:

```text
<project>/.<agent>/steers/<steer-name>/STEER.md
~/.<agent>/steers/<steer-name>/STEER.md
```

These paths are conventions, not an activation mechanism. A harness must add
Steers support explicitly; using `.agents/` for another feature does not make it
discover or run steers. A harness may also support product-specific or remote
locations. The file format stays the same.

See the [complete specification](specification.md) for every field and
constraint.
