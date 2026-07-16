---
name: handoff
description: Compact the current conversation into a handoff document for another agent/instance to pick up. Use when transferring context to a fresh session or to another instance working the coordination board.
argument-hint: "What will the next session be used for?"
disable-model-invocation: true
license: MIT
metadata:
  source: mattpocock/skills (MIT) — see .claude/skills/NOTICE
  adapted-for: alethia
---

Write a handoff document summarising the current conversation so a fresh agent can continue the work. Save to the temporary directory of the user's OS (the scratchpad directory) — not the current workspace.

Include a "suggested skills" section in the document, which suggests skills that the agent should invoke.

Do not duplicate content already captured in other artifacts (specs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead.

Redact any sensitive information, such as API keys, passwords, or personally identifiable information.

If the user passed arguments, treat them as a description of what the next session will focus on and tailor the doc accordingly.

## Alethia notes

- **Multi-instance transfer:** when handing a claimed board unit to another instance, reference the GitHub
  issue number and the worktree/branch — the next instance re-hydrates from the issue + `.claude/COORDINATION.md`,
  not a re-explanation. Don't restate what the issue, the wave design doc, or the diff already says.
- **Redaction matters here:** this repo's whole posture is "hold zero keys" — never let a token, a cloud
  credential, or a customer secret into a handoff doc (see the `alethia-security-review` skill for the leak
  surfaces).
