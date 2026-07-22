# Steers

**A portable standard for correcting agents while they work.**

Steers is a lightweight, open format for policy-driven intervention in AI agent
runs. A steer is disposable oversight: it spawns when a lifecycle event ends,
evaluates the agent's work against its policy, and — only when the policy is
violated — fires a specific correction back into the run. Then it is gone.
No dashboards, no daemons, no watchers. Just policy that corrects agents
mid-run, at the exact moment correction still matters.

At its core, a steer is a folder that contains a `STEER.md` file:

```text
defensive-code/
└── STEER.md          # Metadata and evaluation policy
```

```markdown
---
name: defensive-code
description: Finds defensive code that the task or cited documentation does not require.
trigger: run_end
mode: blocking
---

## What counts as a violation

Intervene when the agent adds validation, retries, fallbacks, or guardrails that
the task did not request and that available code or documentation does not
require.

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

Effective steers define the violation precisely, demand visible corrective
action, and state what transcript evidence proves resolution. This prevents an
agent from satisfying a steer with an unsupported prose justification. See
[Create a steer](docs/creating-steers.md) for a reusable authoring template.

## Why Steers?

Agent harnesses can execute complex work, but most quality controls run either
before the task as static instructions or after it as offline evaluation.
Steers makes corrective policy portable and active inside the run.

- **Inline correction** — Intervene before weak work becomes the final answer.
- **Portable policy** — Write a steer once and use it in any compatible harness.
- **Auditable behavior** — Keep the policy, trigger, verdict, and delivery path explicit.
- **Local ownership** — Version company, team, and project policy beside the work.

## How Steers work

1. **Trigger** — A lifecycle event ends (for example `turn_end`), and each matching steer spawns a one-shot evaluation.
2. **Evaluate** — The harness applies each matching policy to the relevant conversation and tool activity.
3. **Deliver** — A positive verdict sends the correction through the harness, before the next model request. Nothing persists between events.

The format does not require a specific model provider, programming language, or
agent product. Harness authors choose how they collect context and deliver a
correction while preserving the standard behavior.

## Get started

**Early-development note:** placing a steer in `.agents/steers/` does not make
it run automatically. A harness must explicitly implement Steers discovery,
lifecycle mapping, evaluation, and delivery. Support for other files under
`.agents/` does not imply support for Steers.

- [Create a steer](docs/creating-steers.md)
- [Read the specification](docs/specification.md)
- [Add Steers support to a harness](docs/implementing-steers.md)
- [Run the Pi reference integration](implementations/pi/README.md)
- [Browse the examples](examples)

## Repository map

```text
docs/               # Format documentation and frontmatter schema
examples/           # Portable steer examples
implementations/    # Product-specific harness integrations
└── pi/             # Pi reference integration
```

Pi is an integration target, not the definition of Steers. The portable
contract lives in `STEER.md` and in the specification.
