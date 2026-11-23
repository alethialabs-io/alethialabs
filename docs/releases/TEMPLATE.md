---
title: "<release name, e.g. 2027.01-beta>"
description: "Platform release <release name>: the console build, CLI and runner versions that ship together, and what changed."
---

{/*
  PLATFORM RELEASE NOTE TEMPLATE (docs/releases/TEMPLATE.md).
  Copy to apps/docs/content/docs/changelog/<release>.mdx, replace every <placeholder>, delete this
  comment, and list the page in that folder's meta.json. See docs/releases/README.md.
  Every value comes from `main` at the released commit, never from `dev`.
*/}

# <release name>

Released <YYYY-MM-DD>. <One sentence: what this release is for, e.g. "The first public beta.">

## What ships together

| Part | Version | Where to get it |
|---|---|---|
| Console | `<12-char commit SHA>` | `ghcr.io/alethialabs-io/console@sha256:<digest>` |
| Console migrations | `<12-char commit SHA>` | `ghcr.io/alethialabs-io/console-migrate@sha256:<digest>` |
| CLI | `<X.Y.Z>` | [Release notes](https://github.com/alethialabs-io/alethia-cli/releases/tag/v<X.Y.Z>) |
| Runner | `<X.Y.Z>` | `ghcr.io/alethialabs-io/runner:<X.Y.Z>` |

Self-hosters: pin the console images by digest, not by tag. A tag can move; a digest cannot.

## Highlights

{/* Three to five user-visible changes. One line each, present tense, with a docs link. */}

- <Change, in the reader's words.> See [<page title>](/<docs path>).

## Breaking changes and upgrade steps

{/* Write "None." when there are none. Otherwise numbered steps, one instruction per step. */}

None.

## Known issues

{/* Write "None." when there are none. Link the tracking issue for each. */}

None.

## Component changelogs

- CLI: [`apps/cli/CHANGELOG.md`](https://github.com/alethialabs-io/alethialabs/blob/main/apps/cli/CHANGELOG.md),
  `<previous X.Y.Z>` to `<X.Y.Z>`
- Runner: [`apps/runner/CHANGELOG.md`](https://github.com/alethialabs-io/alethialabs/blob/main/apps/runner/CHANGELOG.md),
  `<previous X.Y.Z>` to `<X.Y.Z>`
