# .claude/skills

Most skills here are **synced from the source-of-truth repo** [`alethialabs-io/skills`](https://github.com/alethialabs-io/skills)
— **edit them there, not here.** They are committed in this repo so every worktree / autonomous instance
loads them with zero setup (no plugin, no marketplace trust prompt). To pull updates:

```
bash scripts/sync-skills.sh          # from alethialabs-io/skills@main
```

Synced (from `alethialabs-io/skills`): `grilling`, `grill-me`, `research`, `handoff`, `domain-modeling`,
`codebase-design`, `alethia-security-review`, `alethia-design` (+ `NOTICE`, the MIT attribution).

App-only (not from the source repo, edit here): `vercel-microfrontends`, `alethia-docs`
(the `apps/docs` authoring/review companion — Diátaxis + plain-language style + the Vale lint;
promote to `alethialabs-io/skills` if other repos ever want it).

The working-discipline rule that routes to these lives in `CLAUDE.md`; the wayfinder is `.claude/COORDINATION.md`
(our coordination board), not a skill.
