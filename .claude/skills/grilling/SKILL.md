---
name: grilling
description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.
license: MIT
metadata:
  source: mattpocock/skills (MIT) — see .claude/skills/NOTICE
  adapted-for: alethia
---

Interview me relentlessly about every aspect of this until we reach a shared understanding. Walk down each branch of the decision tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

Ask the questions one at a time, waiting for feedback on each question before continuing. Asking multiple questions at once is bewildering.

If a *fact* can be found by exploring the environment (filesystem, tools, etc.), look it up rather than asking me. The *decisions*, though, are mine — put each one to me and wait for my answer.

Do not act on it until I confirm we have reached a shared understanding.

## Alethia notes

- Write the resolved **decisions + terminology** into the plan you're grilling — the relevant
  `management/spec/features/*.md` wave/feature doc, or a memory file (project/reference type) — as they
  crystallise. Don't batch them; capture each the moment it's settled.
- This is the discipline the `CLAUDE.md` "Working discipline" rule routes to: **grill any non-trivial plan
  or spec before building it.** In plan mode, `AskUserQuestion` is the natural vehicle for putting a decision
  to the user one at a time.
