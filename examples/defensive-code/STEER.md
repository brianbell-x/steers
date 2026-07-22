---
name: defensive-code
description: Finds validation, retries, fallbacks, and guardrails that lack a stated requirement.
trigger: run_end
mode: blocking
---

## Violation

Intervene when the agent adds defensive code that the task did not request.
This includes validation beyond an API requirement, startup try/catch wrappers,
retries, fallbacks, and cost or step guardrails added "just in case."

Code that the request or documentation in the run explicitly requires is not a
violation.

## Correction

Require:

1. A numbered list of every defensive construct, with its file and line.
2. A citation from the request or available documentation for each construct.
3. Deletion of each construct that lacks a citation.

## Resolved when

The run shows edits that remove each unsupported construct or a quoted source
that requires it. A prose-only justification is not resolution.

