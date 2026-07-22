---
name: ste-docs
description: Checks changed prose against the core ASD-STE100 writing rules.
trigger: run_end
mode: blocking
compatibility: Harness must include changed prose in run_end context; this policy does not invoke a licensed STE checker.
---

## Violation

Intervene when changed prose breaks a core ASD-STE100 rule:

- A description sentence exceeds 25 words.
- An instruction sentence exceeds 20 words.
- The writer uses passive voice when the actor is known.
- An instruction is not in the imperative mood.
- The writer uses two terms for one concept or one term for two concepts.
- A noun cluster contains more than three nouns.
- Required articles are missing.
- The writer uses slang, contractions, or undefined jargon.

Code, commands, and quoted output are exempt.

## Correction

Require a numbered list of every violation, the broken rule, and an edit that
rewrites each passage.

## Resolved when

The run shows edits that replace every listed passage with compliant text. A
prose-only acknowledgment is not resolution.
