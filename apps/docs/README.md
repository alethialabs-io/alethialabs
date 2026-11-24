# apps/docs

Alethia's user-facing documentation — Next.js 16 + Fumadocs + fumadocs-mdx. Content lives in
`apps/docs/content/docs/`, routed by `apps/docs/app/(docs)/[[...slug]]/page.tsx`.

The docs site runs on the sandbox box like everything else (`pnpm env:up`); see
[`CLAUDE.md`](../../CLAUDE.md). The prose bar below is enforced by the
`Docs prose (Vale · Diátaxis + plain-language)` required check, so read it before writing.

## Writing docs (the style bar)

Docs follow **Diátaxis** for structure and a plain-language style guide for prose. The
`alethia-docs` skill (`.claude/skills/alethia-docs`) is the authoring/review companion; this
section is the human summary.

### Structure — pick the Diátaxis type

Every page is one of four kinds, and they don't mix:

| Type            | Answers                       | Folder under `content/docs/`               |
| --------------- | ----------------------------- | ------------------------------------------ |
| **Tutorial**    | "teach me, start to finish"   | `tutorials/`                               |
| **How-to**      | "help me do X"                | `guides/`                                  |
| **Reference**   | "tell me the facts"           | `reference/` (CLI, API, config, catalog)   |
| **Explanation** | "help me understand"          | `concepts/`                                |

The top-level folders are the four types, plus `get-started/` (the one onboarding path),
`self-host/` and `agents/` (how-to pages for operators and for AI clients), `troubleshooting/`
and `editions/`. A page's folder is its type. There is one sidebar over all of them; the order
and the groups live in `content/docs/meta.json`, and no section is a `root` folder.

### Page types — a fixed shape and a length

Every page has the shape of its type, so a reader always knows where to look and a reviewer can
check a page against it. Words are prose words: frontmatter and fenced code are not counted.

| Type | Folders | Sections, in order | Cap |
| --- | --- | --- | --- |
| Quickstart | `get-started/` | Before you begin · numbered steps, each with the result to expect · Clean up · Next steps | 1,500 |
| Tutorial | `tutorials/` | What you build · Before you begin · steps · Clean up | 2,500 |
| How-to | `guides/`, `self-host/`, `agents/` | The goal in one line · Before you begin · Steps · Check that it worked · Related | 1,000 |
| Concept | `concepts/` | What it is, in two sentences · one diagram · How it works · What it does not do · Related | 1,200 |
| Reference | `reference/` | Synopsis · options table · one example · errors | none (moving to generated pages) |
| Troubleshooting | `troubleshooting/` | One block per problem: Symptom · Cause · Fix | none |

`pnpm -F docs check:page-length` enforces the caps (CI runs it). Pages that were over their cap
when the guard landed are listed in `page-length-ledger.json` with their word count then: each may
only shrink, and its line must be lowered or deleted when it does. A long page is split by task
or by concept, never trimmed until it is vague: every sentence still has to say something the
reader needs. Material about how the code is built (schema tables, CI
pipelines, internal runbooks) is not user documentation: it goes in the repository's
[`docs/contributing/`](../../docs/contributing/). When you move a page, add the old → new pair to
`redirects.mjs`.

### Prose — plain language (STE-informed)

- Active voice, present tense.
- One instruction per numbered step; imperative mood for procedures.
- Short sentences (aim under ~25 words).
- One term = one meaning; use the canonical product spellings (Kubernetes not k8s, OpenTofu
  not Open Tofu, ArgoCD not Argo CD).
- Required frontmatter: `title` + `description`. Register new pages in the section `meta.json`.

### Lint it before you PR

Prose is linted by [Vale](https://vale.sh) — Google's dev-docs style plus a small Alethia
delta (`styles/Alethia/`). Vale checks prose only; it ignores fenced code, code spans, URLs,
and JSX components.

```bash
brew install vale          # macOS; see vale.sh/docs for other OSes
npm i -g mdx2vast          # the MDX preprocessor Vale needs on $PATH
pnpm -F docs lint:prose    # runs `vale content`
```

The `docs-prose` CI job runs the same lint on any `apps/docs/**` change. It **fails only on
error-level alerts** — a wrong product name (the `Alethia.Terminology` rule, which includes
`k8s`/`K8s` in prose) or a drifted spelling of "bring-your-own IaC" (`Alethia.BringYourOwnIaC`).
It also fails on `Alethia.Connector` ("provider integration" or "integrations page" for what the
console calls Connectors). Plain-language
swaps and "avoid *will*/*we*" surface as non-blocking warnings; long-sentence nudges are
suggestions (hidden by default — see them with `vale --minAlertLevel=suggestion content`).

Links are checked too, by the same job:

```bash
pnpm -F docs check:links   # node only, no install needed: node scripts/check-links.mjs
```

It fails on an internal link to a page or `#anchor` that does not exist, a relative link
(`./x` — write `/section/x`), a link starting `/docs/` (the basePath is added for you), and a
page missing from its section's `meta.json`. Anchors are slugged as fumadocs does: an em dash
in a heading leaves a **double** hyphen (`## Step 1 — Apply` → `#step-1--apply`). External URLs
are not checked.

## Learn More

To learn more about Next.js and Fumadocs, take a look at the following
resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js
  features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.
- [Fumadocs](https://fumadocs.dev) - learn about Fumadocs
