# Add Steers support to an agent harness

Steers support is a small adapter around lifecycle events that most agent
harnesses already expose. The adapter discovers policies, collects relevant
conversation and tool activity, evaluates each matching policy, and returns
corrections through the harness steering path.

Read the [specification](specification.md) before implementing this guide.

## 1. Discover steer folders

For a local harness, scan these shared locations at session start:

| Scope | Recommended path |
| --- | --- |
| Project | `<project>/.agents/steers/` |
| User | `~/.agents/steers/` |

These are recommended discovery paths only. A `.agents/` directory has no
automatic execution semantics. Users must enable an implementation that
explicitly discovers and runs Steers, even when their harness already reads
other files from `.agents/`.

You may also scan product-specific, organization, registry, or bundled
locations. Apply a deterministic precedence rule. Project policy should
override user policy with the same name.

Within each location, inspect child directories that contain `STEER.md`. Parse
the YAML frontmatter, validate the standard fields, and retain the Markdown body
and steer root path.

Do not let one invalid file disable the other steers. Collect diagnostics and
surface them through the harness log, debug command, or UI.

## 2. Map native lifecycle events

Map behavior, not event labels:

| Standard trigger | Required semantic point |
| --- | --- |
| `turn_end` | The assistant has completed one turn. The next turn has not started. |
| `run_end` | The run would otherwise finish. The final result has not been handed off. |

This is the integration's critical correctness boundary. Lifecycle events and
their timing commonly differ across harnesses and SDKs. An event with a similar
name may fire before tools finish, after another model request starts, or after
the final result is already committed. Trace the native agent loop and test the
actual timing; do not map events by name alone.

For example, the Pi integration maps Pi's `turn_end` event directly and maps
Pi's `agent_end` event to `run_end` after verifying their semantic timing.

## 3. Build the evaluation context

Build a fresh evaluator request. Its system message replaces any system message
that would otherwise be used for the evaluator. Append the complete policy body
to that system message.

Require the evaluator system prompt to be configured explicitly. Do not use a
built-in or default prompt as a fallback. If the configured source is missing
or emptyâ€”for example, an implementation expects `SYSTEM.md` but cannot find
itâ€”show a non-blocking error in the harness UI that identifies the missing
configuration and states that no steers will run. Skip all steer evaluations
until the prompt is available.

```text
System: Decide whether this policy requires a correction.

Policy:
<the STEER.md body>

User: <relevant user messages, assistant messages, tool calls, and tool results>
```

For `turn_end`, include the conversation and tool activity relevant to the
completed turn. For `run_end`, use the complete run when the harness retains it.
Preserve tool inputs and results that the policy may need as evidence. Do not
include the trigger, mode, event payload, run ID, model, turn index, or other
lifecycle metadata; it is routing data, not evaluation evidence.

## 4. Normalize the verdict

Require a structured result:

```json
{
  "shouldSteer": false,
  "message": null
}
```

Use provider-native JSON schemas or forced tool calls whenever the evaluator API
supports them. Otherwise request one JSON object and parse it once. Validate the
result before delivery; do not search prose or Markdown fences for JSON. Treat
invalid responses and provider failures as evaluation failures, not as negative
verdicts.

The evaluator can be a model, deterministic code, or both. That choice does not
change the standard contract.

## 5. Enforce mode

Await `blocking` evaluations inside the lifecycle handler. Start `async`
evaluations without delaying the handler, but retain and report their failures.

## 6. Deliver through the steering path

Do not append a correction to an audit-only channel. Send it through the same
path that makes a human steering message available before the first model
request that starts after the verdict is ready.

If the harness is busy, enqueue the correction ahead of the next model call. If
it is idle at `run_end`, the correction should resume the same run or start the
continuation mechanism that the harness uses for human steering.

## 7. Preserve trust and observability

Treat project steers like other repository-controlled agent instructions. Load
them only after the project passes the harness trust check.

An audit record should identify the steer, trigger, mode, evaluator request,
raw response, normalized verdict, delivery outcome, and latency. Audit logs are
recommended but are not part of format compatibility.

Document the implementation's compatibility boundary: harness and SDK name and
version, exact native event mapping, supported evaluator providers, discovery
locations, and any required configuration or environment variables and values.

## Compatibility checklist

- [ ] Discover `STEER.md` from at least one documented source.
- [ ] Validate required metadata and the policy body.
- [ ] Support `turn_end` and `run_end`.
- [ ] Verify native event timing against both semantic lifecycle points.
- [ ] Support `blocking` and `async`.
- [ ] Require an explicit evaluator system prompt; if it is unavailable, report a non-blocking error and run no steers.
- [ ] Replace the evaluator system message, append the policy, and send relevant conversation and tool activity as one user message.
- [ ] Use a native verdict schema or forced tool when available, then validate the result.
- [ ] Deliver corrections before the first model request that starts after the verdict is ready.
- [ ] Isolate invalid files and expose diagnostics.
- [ ] Apply the harness trust boundary.
- [ ] Document harness, SDK, event, provider, configuration, and environment compatibility requirements.
