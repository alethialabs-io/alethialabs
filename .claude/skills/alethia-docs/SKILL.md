---
name: alethia-docs
description: Author or review Alethia's user-facing docs (apps/docs, Fumadocs MDX) to a consistent bar — Diátaxis structure, plain-language prose (STE-informed), canonical terminology, and the Vale lint. Use when writing a new docs page, rewriting an existing one, or when the "document it" working-discipline rule routes here.
license: MIT
metadata:
  adapted-for: alethia
  version: "1.0.0"
---

# Alethia docs

User-facing docs live in `apps/docs/content/docs/` (Fumadocs MDX). "Documented properly" means
two things: the page is the **right shape** for what it's doing (Diátaxis), and the prose is
**plain and consistent** (a style guide, borrowing the good parts of Simplified Technical English).
A Vale lint enforces the terminology floor in CI.

> We deliberately did **not** adopt ASD-STE100 literally: it's a proprietary/licensed spec built for
> aerospace *maintenance procedures* — wrong register for conceptual dev docs, and not redistributable
> in the open skills repo. We take its non-copyrightable principles instead.

## 1. Classify the page (Diátaxis)

Pick exactly one — don't blend a tutorial into a reference.

| Type            | Purpose                          | Shape                                                        | Alethia home                         |
| --------------- | -------------------------------- | ----------------------------------------------------------- | ------------------------------------ |
| **Tutorial**    | teach a beginner, end to end     | a guaranteed-to-work lesson; concrete, no digressions       | a first-project walkthrough          |
| **How-to**      | help a competent user do a task  | numbered steps toward one goal; assumes context             | `cli/`, `self-hosting/`              |
| **Reference**   | state the facts                  | dry, exhaustive, consistently structured; describe, not teach | config keys, `elench/control-catalog` |
| **Explanation** | build understanding              | discursive; the *why*, trade-offs, connections              | `concepts/` (pipeline, domain model) |

If a page is trying to do two of these, split it.

## 2. Write plain, STE-informed prose

- **Active voice, present tense.** "The runner claims the job", not "the job will be claimed".
- **One instruction per numbered step.** Imperative mood for procedures ("Run", "Open", "Set").
- **Short sentences** — aim under ~25 words; split anything over ~30.
- **One term = one meaning.** Don't alternate "cluster" / "environment" / "deployment" for the same thing.
- **Define an acronym on first use** (except the house-canonical ones below).
- **Prefer plain words:** use (not utilize), to (not in order to), can (not is able to), before (not prior to).

### Canonical terminology (the enforced floor)

These are the only **error-level** rules — a wrong product name blocks CI. Broader guidance is
just guidance:

| Write            | Not                        |
| ---------------- | -------------------------- |
| Kubernetes       | k8s, K8s (in prose)        |
| OpenTofu         | Open Tofu                  |
| ArgoCD           | Argo CD                    |
| GitHub / GitLab  | Github / Gitlab            |

Source of truth for spelling + case is `apps/docs/styles/Alethia/` (the Vale style) and
`apps/docs/styles/config/vocabularies/Alethia/accept.txt` (the vocab). Add new product terms
there, not in prose exceptions.

## 3. Fumadocs mechanics

- **Frontmatter:** `title` + `description` are required (the description feeds search + social cards).
- **Register the page:** add it to the section's `meta.json` order, or it won't appear in the nav.
- **Components:** `<Callout type="info|warn">` for asides, `<Steps>`/`<Step>` for procedures.
- **Code fences carry a language** (` ```bash `, ` ```ts `) — Vale skips them, and they get highlighting.
- **Cross-links are absolute paths:** `/concepts/provisioning-pipeline`, not a relative `../`.
- **Diagrams** live under `apps/docs/public/docs/diagrams/<section>/` and are referenced with an `<img>`.

## 4. Lint before you PR

Prose is linted by [Vale](https://vale.sh) — Google's dev-docs style + the small Alethia delta.
It checks prose only (fenced code, code spans, URLs, and JSX are ignored).

```bash
brew install vale && npm i -g mdx2vast   # one-time; mdx2vast must be on $PATH for .mdx
pnpm -F docs lint:prose                   # runs `vale content` from apps/docs
```

CI runs the same lint (`docs-prose` job, path-gated to `apps/docs/**`). It **fails only on
error-level** alerts (terminology). Plain-language swaps + "avoid *will*/*we*" are non-blocking
warnings worth clearing; long-sentence nudges are suggestions (`vale --minAlertLevel=suggestion`).

## When invoked

- **Authoring:** classify the page (§1) → follow that type's shape → write to §2 → wire up §3 →
  run the lint (§4). Land it in the right `content/docs/<section>/` and its `meta.json`.
- **Reviewing/rewriting:** identify the Diátaxis type it *should* be, fix structure first, then
  tighten prose to §2, then lint. Don't just fix words if the page is the wrong shape.

Related: this is what the `CLAUDE.md` working-discipline "document it → `apps/docs/`" rule routes to.
For anything user-facing, the docs are the deliverable, not `management/spec`.
