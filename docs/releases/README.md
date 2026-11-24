<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# Releases

How Alethia is versioned, which branch owns each version number, and how a platform release note is
written. User-facing material lives in the docs changelog section
(`apps/docs/content/docs/changelog/`); this file is the contributor half.

## Two kinds of version

| What | Versioned by | Lives where |
|---|---|---|
| **Components**: the CLI (`apps/cli`) and the runner (`apps/runner`) | release-please, from conventional commits | `.release-please-manifest.json` and each component's `CHANGELOG.md` **on `main`**; tags `cli-vX.Y.Z` and `runner-vX.Y.Z` |
| **Platform**: one console build plus the CLI and runner versions it is tested with | a person, at a release candidate | a platform release note, written from [`TEMPLATE.md`](./TEMPLATE.md) |

The console, the docs and the other web apps have no semver of their own. They deploy from `main`
and are identified by the commit SHA they were built from. A platform release note pins that SHA
(and the image digest) next to the CLI and runner versions, so a self-hoster can install one
coherent set.

Version policy for the public beta (spec `release-and-billing.md` §4.7, *Versioning*): stay on
`0.x`; at the release candidate cut the CLI and the runner at one shared number with a `Release-As:`
footer; reserve `1.0.0` for general availability; name the platform release `YYYY.MM-beta`
(`2027.01-beta` for the first).

## Why `dev` and `main` disagree on the manifest, and why that is correct

On 2026-11-23 the two branches read:

| Branch | `apps/cli` | `apps/runner` |
|---|---|---|
| `main` | 0.11.1 | 0.11.0 |
| `dev` | 0.6.1 | 0.6.0 |

`main` is right. Its values match the newest `cli-v*` and `runner-v*` tags.

**Why they differ.** release-please runs only on `main` (`.github/workflows/release-please.yml`,
`on: push: branches: [main]`). Each release PR it opens targets `main`, and merging one writes the
manifest and the component `CHANGELOG.md` **on `main` only**. Nothing carries those commits back to
`dev`: a promotion goes the other way (`release/<sha>` → `main`, `.github/workflows/promote.yml`),
and there is no back-merge. So `dev`'s copy stays wherever it last was.

**Why `dev` reads 0.6.x rather than 0.2.x.** `dev`'s copy moved exactly once by accident. Dependabot
PR #4382 (2026-09-09, a gRPC bump) was built on a branch that already held `main`'s release commits
for runner 0.3.0 through cli 0.6.1. Its squash merge carried them into `dev` with it. That is
the only manifest change on `dev` since release 0.3.0 / 0.2.0
(`git log origin/dev -- .release-please-manifest.json`).

**Why the stale copy is harmless.** Nothing reads `dev`'s manifest:

- release-please reads the manifest of the branch it releases, which is `main`. A manual
  `workflow_dispatch` of the workflow still targets the repository's default branch.
- `scripts/news/draft-changelog.mjs` reads the manifest at `--ref`, which defaults to `origin/main`,
  and `news-changelog-draft.yml` passes `origin/main` explicitly.
- A promotion merge is three-way. The merge base is the previously promoted `dev` commit, whose
  manifest is the same 0.6.x, so `dev` has not changed the file and `main`'s value wins with no
  conflict. The component changelogs behave the same way.

**Why `dev` is not hand-synced to `main`.** A one-off edit on `dev` to `main`'s values buys no
behaviour, does not stay true, and adds a way to break a promotion:

1. It stops being true at `main`'s next release, because release commits never flow back.
2. If `main` releases between the sync landing on `dev` and the next promotion merging, both sides
   have changed the same two adjacent lines differently. The promotion PR then has a merge conflict.
   Because a `release/<sha>` head is never moved, the conflict has to be resolved by hand.
   Reproduced with `git merge-file`: base 0.6.1, `dev` 0.11.1, `main` 0.12.0 → conflict. Without
   the sync, the same merge is clean.

So the rule is: **`main` is the only source of truth for component versions. Do not edit
`.release-please-manifest.json` or a component `CHANGELOG.md` on `dev`.** To read the released
version from a `dev` checkout:

```bash
git fetch origin main
git show origin/main:.release-please-manifest.json
```

To force a version (the release-candidate cut), put a `Release-As: X.Y.Z` footer in a commit that
touches the component and let release-please propose it on `main`. Do not edit the manifest.

## Writing a platform release note

1. Copy [`TEMPLATE.md`](./TEMPLATE.md) to `apps/docs/content/docs/changelog/<release>.mdx`, for
   example `2027.01-beta.mdx`, and add the file to that folder's `meta.json`, newest first after
   `index`.
2. Fill every field from `main` at the commit being released: the console image digest, the CLI and
   runner versions from `main`'s manifest, and the commit SHA.
3. Open the PR into `dev` like any docs change. The note reaches the site with the next promotion.
