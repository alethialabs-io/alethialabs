<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Decision: `ee/` stays in this repository

**Status:** decided · **Date:** 2026-09-22 · **Decided by:** the maintainer
**Answers:** [#4923](https://github.com/alethialabs-io/alethialabs/issues/4923) §3

## The question

`ee/` holds source-visible enterprise code under `LicenseRef-Alethia-Commercial`, inside a
repository whose default licence is `AGPL-3.0-only`. §3 of the ownership epic asks whether that
code should stay in this tree or move to a separate private repository, and requires the answer to
be recorded either way.

## The decision

**`ee/` stays in this repository**, source-visible, under its own licence.

## Why this file exists rather than `ee/README.md`

The natural home for this ruling would be `ee/README.md` and `LICENSING.md`. **Both are files that
`scripts/legal/activate-company-ip.mjs` rewrites.** That script carries 11 prose markers across 8
files and requires each to appear **exactly once**; it refuses to run if a marker is missing or
duplicated, because *"zero means the wording drifted and this script no longer knows what it is
rewriting."*

So editing either file by hand, ahead of the founder assignment being signed, risks permanently
disabling the one mechanism built to make the ownership notices true later. Recording the decision
here costs one level of indirection and puts no marker at risk. **Once activation has run,
`ee/README.md` and `LICENSING.md` should link to this file.**

## What the boundary actually guarantees

Stated precisely, because "the guard enforces the boundary" is the sentence a reader turns into
"nothing can cross it".

`scripts/check-open-core-boundary.mjs` runs in the required `Authz / open-core guards` job. It
enforces:

- **No file outside an allowlist may mention `@alethia/ee` as a quoted string.** The rule is
  deliberately **broad** — any quoted occurrence, not import syntax — and it must stay that way.
  `apps/console/lib/enterprise.ts` loads the package through a *variable*
  (`const pkg = "@alethia/ee"; createRequire(import.meta.url)(pkg)`) precisely so a bundler cannot
  statically resolve it in a community build. Narrowing the rule to `from` / `require(` / `import(`
  syntax would match **zero** files in this repo — measured, not assumed — and would let the
  codebase's own idiom cross undetected.
- The cost of staying broad is that a file merely *naming* the package trips it. That is what the
  allowlist is for, and it is the cheaper half of the trade.

### What it does NOT guarantee

- It is a **source-level** control, not a distribution one. It says community code does not
  reference enterprise code; it does not by itself prove a community build ships without `ee/`.
- It reasons about a **package specifier**. Logic copied out of `ee/` into a community file, rather
  than imported, is invisible to it.
- It scans **tracked files**. Anything untracked is outside its reach.

## Why in-tree, and what would change the answer

**For staying:**

- The boundary is already mechanised and already required on `dev`, `staging` and `main`. A split
  replaces one enforced control with a process nobody has built yet.
- One tree means one CI graph, one dependency resolution and one version. A split needs a story for
  how `ee/` builds against a moving `packages/core`, and that story is a new class of breakage.
- Source-visible is a deliberate product position, not an accident. The code being readable is
  compatible with it being commercially licensed; `LicenseRef-Alethia-Commercial` is what restricts
  use, not obscurity.

**Against, and honestly:**

- A separate private repository is the stronger boundary, because the proprietary code is not in
  the public history at all. The in-tree control can be defeated by copying rather than importing,
  and no static check catches that.

**What would change the answer:** an enterprise feature that cannot be source-visible — a third
party's licensed code, or something whose disclosure is itself the harm. That is a different
question from the one settled here, and it should reopen this decision rather than be squeezed past
it.

## Related

- `LICENSING.md` — the repository licence map
- `ee/README.md` — what `ee/` contains
- `scripts/check-open-core-boundary.mjs` — the guard, and its allowlist with a reason per entry
- [#4923](https://github.com/alethialabs-io/alethialabs/issues/4923) §3 — the question
