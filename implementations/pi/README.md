# Steers for Pi

This directory is the reference integration between the Steers standard and
the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent).
Steers itself is harness-independent; this adapter only maps Pi's APIs to the
standard lifecycle.

Compatibility: Pi `0.80.x`, Node.js `22.19` or newer, and an evaluator provider
supported by Pi. No environment variables are required beyond Pi's provider
credentials.

## Event mapping

| Steers trigger | Pi event |
| --- | --- |
| `turn_end` | `turn_end` |
| `run_end` | `agent_end` |

Blocking steers await the evaluator. Async steers continue immediately. A
positive verdict uses Pi's `deliverAs: "steer"` message path.

## Try it from this repository

Use Node.js 22.19 or newer. Install the integration dependencies:

```powershell
npm --prefix ./implementations/pi install
```

Add an example to the shared project location:

```text
<project>/.agents/steers/defensive-code/STEER.md
```

Then load the extension:

```powershell
pi -e ./implementations/pi/steers.ts
```

The adapter scans project policy before user policy:

1. `<project>/.agents/steers/`
2. `<project>/.pi/steers/`
3. `~/.agents/steers/`
4. `~/.pi/steers/`

The `.pi/steers/` locations are Pi-specific. The `.agents/steers/` locations
are the portable convention. They work here only while this adapter is loaded;
another harness that uses `.agents/` will ignore them unless it implements
Steers explicitly.

An optional `SYSTEM.md` beside the steer directories can replace the adapter's
default judge prompt. The adapter appends each steer policy to that replacement
system message. This file is a Pi integration feature, not part of the Steers
format.

## Verify the integration

```powershell
npm --prefix ./implementations/pi test
npm --prefix ./implementations/pi run typecheck
```
