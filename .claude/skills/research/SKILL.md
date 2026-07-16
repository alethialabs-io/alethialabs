---
name: research
description: Investigate a single question against high-trust primary sources and capture the findings as one cited Markdown file. Use for a quick, delegable primary-source dig (docs, source code, specs, first-party APIs). For a heavy multi-source fan-out with adversarial verification, use the deep-research skill instead.
license: MIT
metadata:
  source: mattpocock/skills (MIT) — see .claude/skills/NOTICE
  adapted-for: alethia
---

Spin up a **background agent** to do the research, so you keep working while it reads.

Its job:

1. Investigate the question against **primary sources** — official docs, source code, specs, first-party APIs — not a secondary write-up of them. Follow every claim back to the source that owns it.
2. Write the findings to a single Markdown file, citing each claim's source.
3. Save it where the repo already keeps such notes; match the existing convention, and if there is none, put it somewhere sensible and say where.

## Alethia notes

- **Scope vs `deep-research`:** this skill is the *light* variant — one question, one background agent, one
  cited file. When the task needs a broad multi-modal sweep with adversarial verification of each claim, use
  the heavier `deep-research` skill (the fan-out harness) instead.
- **Where notes go:** durable findings that inform a wave/feature belong in `management/spec/features/` (next
  to the design they inform) or as a `reference`-type memory; throwaway digs go in the scratchpad directory.
  State where you saved it.
- This is what the `CLAUDE.md` "Working discipline" rule routes to for unknowns / new-library / API-behavior
  questions: **research the primary source, never guess.**
