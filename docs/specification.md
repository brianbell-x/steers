# Steers specification

Version 0.1

This document defines the portable Steers format and the behavior required from
a Steers-compatible harness.

## Steer directory

A steer is a directory that contains a file named exactly `STEER.md`.

```text
steer-name/
└── STEER.md
```

The standard defines the contents of a steer directory. It does not require an
installation location or distribution system.

Version 0.1 defines and exposes only `STEER.md`. Other files in the directory
are not part of the evaluator input, and a steer MUST NOT depend on them.

## `STEER.md` format

`STEER.md` MUST contain YAML frontmatter followed by a Markdown policy body.

### Frontmatter fields

| Field | Required | Constraints |
| --- | --- | --- |
| `name` | Yes | 1–64 characters. Lowercase ASCII letters, numbers, and single hyphens only. It MUST match the parent directory name. |
| `description` | Yes | 1–1024 characters. It describes the policy and when it applies. |
| `trigger` | Yes | `turn_end` or `run_end`. |
| `mode` | Yes | `blocking` or `async`. |
| `compatibility` | No | 1–500 characters. It names every additional requirement the installer must align. |
| `license` | No | A license name or a reference to a bundled license file. |
| `metadata` | No | A mapping of string keys to string values. |

Unknown fields MAY be present. A harness MUST ignore unknown fields that it does
not support. Extensions SHOULD use namespaced keys under `metadata`.

When present, `compatibility` MUST identify applicable constraints such as the
harness or SDK name and version, native event mapping, model capability, tool or
command, and environment variable names or required values. It SHOULD avoid
generic claims such as "requires a compatible harness." Omit it when the steer
has no requirements beyond this specification.

The machine-readable [frontmatter schema](steer-frontmatter.schema.json)
captures these field constraints. Directory-name matching and the Markdown body
require checks outside JSON Schema.

### Name rules

`name` MUST:

- contain only `a-z`, `0-9`, and `-`;
- not start or end with `-`;
- not contain `--`;
- match the directory that contains `STEER.md`.

### Policy body

The Markdown body MUST be non-empty. It tells the evaluator when to intervene
and what correction to produce. The standard does not prescribe section names.

The policy SHOULD define the violation, exclusions, required correction, and
resolution evidence.

### Minimal example

```markdown
---
name: verify-tests
description: Finds code changes that lack relevant verification.
trigger: run_end
mode: blocking
---

Intervene when the agent changes executable behavior but provides no test or
other direct verification for that behavior.
```

## Lifecycle

### Discovery

A harness MUST discover `STEER.md` files before it evaluates them. It MUST parse
and validate the required fields. It SHOULD surface invalid files as diagnostics
without disabling valid steers.

When two discovered steers have the same name, the harness MUST apply a
documented deterministic precedence rule. For filesystem discovery, a project
steer SHOULD override a user steer.

### Triggers

`turn_end` occurs after the assistant completes one turn and before the next
turn begins.

`run_end` occurs when the agent run would otherwise finish and before the
harness returns the final result to its caller or user.

A harness MUST map its native events to these semantic points. Native event
names do not need to match the standard names.

### Evaluation context

For each matching steer, the harness MUST provide the evaluator with:

- a replacement system message containing the evaluator instructions followed
  by the complete policy body; and
- one user message containing the relevant user messages, assistant messages,
  tool calls, and tool results.

For `turn_end`, include the conversation and tool activity relevant to the
completed turn. For `run_end`, include the complete run or a lossless equivalent
available to the harness.
The evaluator request MUST NOT retain another system message. It MUST NOT add
the trigger name, mode, run ID, turn index, model metadata, or other lifecycle
event data to the user message. The harness uses that data to select the steer;
the evaluator does not need it.

The standard does not require a specific evaluator. A harness may use its
current model, a separate model, deterministic code, or a composition of these.

### Verdict

Every completed evaluation MUST normalize to this logical object:

```json
{
  "shouldSteer": true,
  "message": "Add a migration for the new status column and show the rollback."
}
```

`shouldSteer` MUST be a boolean. When it is `true`, `message` MUST be a
non-empty string. When it is `false`, `message` MUST be `null`.

An invalid or failed evaluation MUST NOT deliver a correction. The harness
SHOULD record or expose the failure.

When the evaluator API supports structured output, the harness MUST supply the
verdict JSON Schema or an equivalent forced tool definition. Otherwise it MUST
request one JSON object, parse it once, and validate it against the same logical
contract. It MUST NOT extract a verdict from prose.

### Delivery

When `shouldSteer` is `true`, the harness MUST send `message` back through the
same control path that user steering uses. The correction MUST be available
before the first model request that starts after the verdict is ready.

A `blocking` steer makes the lifecycle handler wait for evaluation and delivery.
An `async` steer allows the harness to continue while the verdict is pending.
When the verdict becomes ready, the harness MUST queue the correction for the
next model request.

## Security and trust

Steers can influence agent behavior. A harness SHOULD apply its normal
project-trust boundary before loading project steers.

## Compatibility

A runtime is Steers-compatible when it:

1. Discovers and parses the format defined here.
2. Supports both standard triggers and both execution modes.
3. Supplies the required evaluator messages.
4. Normalizes evaluations to the verdict contract.
5. Delivers corrections before the first model request that starts after the verdict is ready.

Product-specific discovery locations, interfaces, diagnostics, and audit logs
do not affect compatibility.
