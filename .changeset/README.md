# Changesets

A changeset is a short note that says which published package a change touches and how much: a
patch, a minor or a major release. The packages listed in `packages/public-packages.json` are
published to npm as `@alethialabs/*`; a PR that changes one of them needs a changeset, and CI fails
without one.

```bash
pnpm changeset
```

Pick the package, the bump and write one line for the changelog. The "Version packages" PR collects
the changesets, bumps the versions and writes the changelogs; the release workflow publishes them
when a promotion carries the bump to `main`. The whole flow is in
`docs/contributing/releasing-packages.md`.
